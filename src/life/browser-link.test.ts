// @vitest-environment jsdom
// Linked browsers, Arise's side, end to end: the real extension logic (extension/src/lib/recorder.ts)
// with a pretend browser on one end, a pretend life log on the other. Linking with the 4 words,
// opening what arrives and handing it to the life log, keys sealed with the account's data key,
// what's refused, "forget the last hour", and unlinking.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LifeEvent } from './types';
import type { LifeStore } from './store-port';
import type { Incoming, Transport } from './browser-link';
import * as C from '../lib/crypto';
import * as R from '../../extension/src/lib/recorder';
import { parseRequest } from '../../extension/src/lib/pairing';
import { newKeyPair, sealBatch } from '../../extension/src/lib/seal';

const ARISE = 'https://abyyworld.github.io/physical-improvement-tracker-app/';
const ORIGIN = 'https://abyyworld.github.io';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const START = new Date(2026, 9, 17, 14, 5).getTime();

type BL = typeof import('./browser-link');
type Page = { url: string; title?: string; visits: { visitTime: number; transition?: string; isLocal?: boolean }[] };

function kv(): R.KV & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async (keys) => Object.fromEntries(keys.filter((k) => data.has(k)).map((k) => [k, structuredClone(data.get(k))])),
    set: async (items) => {
      for (const [k, v] of Object.entries(items)) data.set(k, structuredClone(v));
    },
    remove: async (keys) => {
      for (const k of keys) data.delete(k);
    },
  };
}

// The life log, pretend: keeps events by id, like the real one.
function fakeLog({ removable = true, failing = false } = {}) {
  const events = new Map<string, LifeEvent>();
  const store: LifeStore & { events: Map<string, LifeEvent>; removeIds?: (ids: string[]) => Promise<number> } = {
    events,
    async addEvents(list) {
      if (failing) throw new Error('full');
      let n = 0;
      for (const e of list) if (!events.has(e.id)) (events.set(e.id, e), n++);
      return n;
    },
  };
  if (removable) store.removeIds = async (ids) => ids.filter((id) => events.delete(id)).length;
  return store;
}

let now = START;
let pages: Page[];
let env: R.Env;
let local: ReturnType<typeof kv>;
let extensionHere = true;
let account: { uid: string; key: CryptoKey } | null = null;
let BLM: BL;
let log: ReturnType<typeof fakeLog>;
const listeners: ((p: Incoming) => void)[] = [];

// The content script, pretend: requests go straight to the extension's logic, and what the
// extension tells Arise's tabs comes back as pushes.
const transport: Transport = {
  async ask(msg) {
    if (!extensionHere) return null;
    const req = parseRequest(msg);
    return req ? structuredClone(await R.pageRequest(env, req, ORIGIN)) : { ok: false, error: 'bad' };
  },
  onPush: (fn) => void listeners.push(fn),
};

const visit = (url: string, t: number, title = '') => {
  const p = pages.find((x) => x.url === url) || (pages.push({ url, title, visits: [] }), pages[pages.length - 1]);
  p.visits.push({ visitTime: t, transition: 'link' });
};
const flush = () => new Promise((r) => setTimeout(r, 0));

async function boot({ store = fakeLog() } = {}) {
  vi.resetModules();
  BLM = await import('./browser-link');
  const port = await import('./store-port');
  log = store;
  port.setLifeStore(log);
  await BLM.initBrowserLink({ transport, accountKey: async () => account, now: () => now });
}

// The person presses "They match" in the extension's window.
async function pressMatch() {
  const s = (await R.popupRequest(env, { t: 'state' })) as R.PopupState;
  expect(s.pairing).not.toBeNull();
  await R.popupRequest(env, { t: 'confirm', link: s.pairing!.link });
  await flush();
  await vi.waitFor(() => expect(BLM.status.links.some((r) => r.state === 'linked')).toBe(true));
  return s.pairing!.code;
}

beforeEach(() => {
  now = START;
  pages = [];
  extensionHere = true;
  account = null;
  listeners.length = 0;
  local = kv();
  env = {
    now: () => now,
    local,
    session: kv(),
    history: {
      search: async ({ startTime, endTime }) => pages.filter((p) => p.visits.some((v) => v.visitTime >= startTime && v.visitTime <= endTime)).map((p) => ({ url: p.url, title: p.title })),
      getVisits: async ({ url }) => structuredClone(pages.find((p) => p.url === url)?.visits ?? []),
    },
    browser: 'Chrome on macOS',
    version: '1.0.0',
    arise: [ARISE],
    allowed: (o) => o === ORIGIN,
    push: async (p) => {
      for (const fn of listeners) fn(structuredClone(p));
    },
    openConfirm: async () => {},
  };
});

describe('linking a browser', () => {
  it('shows the same 4 words as the extension, and links once they match', async () => {
    await boot();
    expect(BLM.status.hello).toMatchObject({ browser: 'Chrome on macOS', linked: null });
    const code = await BLM.startLink();
    expect(BLM.status.pairing?.code).toEqual(code);
    expect(await pressMatch()).toEqual(code);
    const [rec] = BLM.status.links;
    expect(rec).toMatchObject({ name: 'Chrome on macOS', state: 'linked', received: 0 });
    expect(BLM.status.pairing).toBeNull();
    expect(BLM.status.hello?.linked).toBe(rec.id);
  });

  it('keeps the private key on this device, unreadable, when not signed in', async () => {
    await boot();
    await BLM.startLink();
    const rec = BLM.status.links[0];
    expect('local' in rec.key).toBe(true);
    const key = (rec.key as { local: CryptoKey }).local;
    expect(key.type).toBe('private');
    expect(key.extractable).toBe(false);
    // The extension got the public key only.
    expect(JSON.stringify(await env.session.get(['pairing']))).toContain(rec.pub);
  });

  it("seals the private key with the account's data key when signed in", async () => {
    account = { uid: 'uid-1', key: await C.newDataKey() };
    await boot();
    await BLM.startLink();
    await pressMatch();
    const rec = BLM.status.links[0];
    expect('wrapped' in rec.key).toBe(true);
    expect(JSON.stringify(rec.key)).not.toMatch(/"d"|BEGIN/);
    expect((rec.key as { wrapped: { uid: string } }).wrapped.uid).toBe('uid-1');
  });

  it("drops the link when the words don't match", async () => {
    await boot();
    await BLM.startLink();
    const s = (await R.popupRequest(env, { t: 'state' })) as R.PopupState;
    await R.popupRequest(env, { t: 'decline', link: s.pairing!.link });
    await vi.waitFor(() => expect(BLM.status.links).toEqual([]));
    expect(BLM.status.error).toMatch(/didn't match/);
  });

  it('cancelling in Arise cancels in the extension too', async () => {
    await boot();
    await BLM.startLink();
    await BLM.cancelLink();
    expect(BLM.status.links).toEqual([]);
    expect(((await R.popupRequest(env, { t: 'state' })) as R.PopupState).pairing).toBeNull();
  });

  it('says so when the extension is missing', async () => {
    extensionHere = false;
    await boot();
    expect(BLM.status.checked).toBe(true);
    expect(BLM.status.hello).toBeNull();
    await expect(BLM.startLink()).rejects.toMatchObject({ code: 'no-extension' });
  });
});

describe('what arrives', () => {
  it('opens it and hands it to the life log, then the extension deletes it', async () => {
    visit('https://www.nytimes.com/a?utm=1', START - 2 * DAY, 'An article');
    visit('https://www.google.com/search?q=protein+bars', START - DAY, 'protein bars - Google Search');
    visit('https://secure.chase.com/', START - DAY, 'Bank');
    await boot();
    await BLM.startLink();
    await pressMatch();
    await R.tick(env, null); // reads the 90 days before
    await flush();
    await vi.waitFor(() => expect(log.events.size).toBe(2));
    expect([...log.events.values()].sort((a, b) => a.at - b.at).map((e) => [e.kind, e.title, e.tier])).toEqual([
      ['visit', 'An article', 3],
      ['search', 'Searched "protein bars"', 3],
    ]);
    await vi.waitFor(async () => expect(((await R.popupRequest(env, { t: 'state' })) as R.PopupState).waiting).toBe(0));
    const rec = BLM.status.links[0];
    expect(rec.received).toBe(2);
    expect(rec.lastDelivery).toBe(now);
  });

  it('adds each thing once, however often it arrives', async () => {
    visit('https://example.org/a', START - DAY, 'A');
    await boot();
    await BLM.startLink();
    await pressMatch();
    await R.tick(env, null);
    await vi.waitFor(() => expect(log.events.size).toBe(1));
    // The extension reads its history again from scratch (linked again from the same Arise).
    const rec = BLM.status.links[0];
    const key = (rec.key as { local: CryptoKey }).local;
    const [e] = [...log.events.values()];
    const again = await sealBatch(rec.pub, rec.id, { id: 'X'.repeat(22), from: e.at, to: e.at, n: 1 }, { v: 1, events: [e, e] });
    const got = await BLM.ingest(rec, key, [again], [], log);
    expect(got).toEqual({ added: 0, acked: [again.id], notes: [] });
    expect(log.events.size).toBe(1);
  });

  it('waits while signed out when the key needs the account, and delivers once signed in', async () => {
    account = { uid: 'uid-1', key: await C.newDataKey() };
    await boot();
    await BLM.startLink();
    await pressMatch();
    await BLM.deliver(); // what linking started is done
    const signedIn = account;
    account = null; // signed out
    visit('https://example.org/later', now + 1000, 'Later');
    now += 60_000;
    await R.tick(env, null);
    await BLM.deliver();
    expect(log.events.size).toBe(0);
    expect(BLM.status.locked).toEqual([BLM.status.links[0].id]);
    expect(((await R.popupRequest(env, { t: 'state' })) as R.PopupState).waiting).toBe(1);
    account = { uid: 'someone-else', key: await C.newDataKey() };
    expect(await BLM.deliver()).toBe(0);
    account = signedIn;
    expect(await BLM.deliver()).toBe(1);
    expect(BLM.status.locked).toEqual([]);
  });

  it('keeps batches in the extension when the life log can’t take them', async () => {
    visit('https://example.org/a', START - DAY, 'A');
    await boot({ store: fakeLog({ failing: true }) });
    await BLM.startLink();
    await pressMatch();
    await R.tick(env, null);
    await BLM.deliver();
    expect(((await R.popupRequest(env, { t: 'state' })) as R.PopupState).waiting).toBe(1);
  });

  it('drops batches nobody here can open: sealed for another link, or damaged', async () => {
    await boot();
    await BLM.startLink();
    await pressMatch();
    const rec = BLM.status.links[0];
    const key = (rec.key as { local: CryptoKey }).local;
    const stranger = await newKeyPair(false);
    const meta = { id: 'Y'.repeat(22), from: 1, to: 2, n: 0 };
    const otherLink = await sealBatch(stranger.pub, 'Z'.repeat(22), meta, { v: 1, events: [] });
    const wrongKey = await sealBatch(stranger.pub, rec.id, { ...meta, id: 'W'.repeat(22) }, { v: 1, events: [] });
    const got = await BLM.ingest(rec, key, [otherLink, wrongKey], [], log);
    expect(got.acked).toEqual([otherLink.id, wrongKey.id]);
    expect(got.added).toBe(0);
  });

  it('forgets the last hour in the life log when the extension asks, if the life log can', async () => {
    await boot();
    await BLM.startLink();
    await pressMatch();
    now += 10 * 60_000;
    visit('https://example.org/old', START - 3 * DAY, 'Old');
    visit('https://example.org/recent', now - 5 * 60_000, 'Recent');
    await R.tick(env, null);
    await vi.waitFor(() => expect(log.events.size).toBe(2));
    await R.popupRequest(env, { t: 'forget' });
    await BLM.deliver();
    expect([...log.events.values()].map((e) => e.title)).toEqual(['Old']);
    expect(BLM.status.links[0].recent).toEqual([]);
  });
});

describe('checking what arrives', () => {
  const good = { id: 'browser:abcdefghijklmnopqrstuv', source: 'browser', kind: 'visit', at: START, title: 'A page', url: 'https://example.org/a', tier: 3, meta: { site: 'example.org' } };

  it('keeps good events as they are', async () => {
    await boot();
    expect(BLM.cleanEvent(good, START)).toEqual(good);
    expect(BLM.cleanEvents({ v: 1, events: [good, { junk: 1 }] }, START)).toEqual([good]);
    expect(BLM.cleanEvents({ v: 2, events: [good] }, START)).toEqual([]);
    expect(BLM.cleanEvents(null, START)).toEqual([]);
  });

  it("refuses or trims what doesn't fit, and always makes it tier 3", async () => {
    await boot();
    const bad = [
      { ...good, id: 'chrome:abcdefghijklmnop' },
      { ...good, id: 'browser:<script>' },
      { ...good, source: 'arise' },
      { ...good, kind: 'purchase' },
      { ...good, at: 'yesterday' },
      { ...good, at: START + 2 * DAY },
      { ...good, at: START - 500 * DAY },
      { ...good, title: '   ' },
    ];
    for (const b of bad) expect(BLM.cleanEvent(b, START), JSON.stringify(b)).toBeNull();
    const fixed = BLM.cleanEvent(
      { ...good, tier: 1, title: 'x'.repeat(500), url: 'javascript:alert(1)', end: START - 1, value: -5, unit: 'min', meta: { ok: 'y', 'bad key': 1, nested: { a: 1 }, n: 2, b: true, long: 'z'.repeat(400) }, extra: 'dropped' },
      START,
    )!;
    expect(fixed.tier).toBe(3);
    expect(fixed.title).toHaveLength(300);
    expect(fixed.url).toBeUndefined();
    expect(fixed.end).toBeUndefined();
    expect(fixed.value).toBeUndefined();
    expect(fixed.unit).toBeUndefined();
    expect(fixed.meta).toEqual({ ok: 'y', n: 2, b: true, long: 'z'.repeat(300) });
    expect('extra' in fixed).toBe(false);
  });
});

describe('unlinking', () => {
  it('from Arise: the key goes and the extension stops', async () => {
    visit('https://example.org/a', START - DAY, 'A');
    await boot();
    await BLM.startLink();
    await pressMatch();
    const id = BLM.status.links[0].id;
    await BLM.unlink(id);
    expect(BLM.status.links).toEqual([]);
    expect(((await R.popupRequest(env, { t: 'state' })) as R.PopupState).linked).toBe(false);
    expect([...local.data.keys()].some((k) => k.startsWith('b:'))).toBe(false);
  });

  it('from the extension: Arise lets the key go', async () => {
    await boot();
    await BLM.startLink();
    await pressMatch();
    await R.popupRequest(env, { t: 'unlink' });
    await vi.waitFor(() => expect(BLM.status.links).toEqual([]));
  });

  it('"Erase all data" lets every linked browser go', async () => {
    await boot();
    await BLM.startLink();
    await pressMatch();
    await BLM.forgetAll();
    expect(BLM.status.links).toEqual([]);
    expect(((await R.popupRequest(env, { t: 'state' })) as R.PopupState).linked).toBe(false);
  });

  it('tidies up at start: a link the extension no longer has can bring nothing', async () => {
    await boot();
    await BLM.startLink();
    await pressMatch();
    listeners.length = 0; // this page isn't listening any more
    await R.popupRequest(env, { t: 'unlink' });
    expect(BLM.status.links).toHaveLength(1);
    // The same device later (the links are kept in this module's memory in tests, as without IndexedDB).
    await BLM.initBrowserLink({ transport, accountKey: async () => account, now: () => now });
    expect(BLM.status.links).toEqual([]);
  });
});

describe('the page’s messages', () => {
  it('talk to the content script with ids, and ignore other windows and sites', async () => {
    vi.resetModules();
    const { windowTransport } = await import('./browser-link');
    const { NS } = await import('../../extension/src/lib/pairing');
    const win = new EventTarget() as EventTarget & { location: { origin: string }; postMessage: (d: unknown, o: string) => void };
    win.location = { origin: ORIGIN };
    const deliver = (data: unknown, { origin = ORIGIN, source = win as unknown } = {}) => {
      const e = new Event('message');
      Object.defineProperties(e, { data: { value: data }, origin: { value: origin }, source: { value: source } });
      win.dispatchEvent(e);
    };
    const sent: { d: { ns: string; from: string; id: string; msg: unknown }; o: string }[] = [];
    win.postMessage = (d, o) => {
      sent.push({ d: d as never, o });
      const m = d as { from: string; id: string };
      if (m.from !== 'page') return;
      setTimeout(() => {
        deliver({ ns: NS, from: 'ext', re: m.id, reply: { ok: true, from: 'elsewhere' } }, { origin: 'https://evil.example' });
        deliver({ ns: NS, from: 'ext', re: m.id, reply: { ok: true, from: 'another window' } }, { source: {} });
        deliver({ ns: 'other', from: 'ext', re: m.id, reply: { ok: true } });
        deliver({ ns: NS, from: 'ext', re: m.id, reply: { ok: true, from: 'extension' } });
      });
    };
    const t = windowTransport(win as unknown as Window);
    const pushes: unknown[] = [];
    t.onPush((p) => pushes.push(p));
    expect(await t.ask({ t: 'hello' })).toEqual({ ok: true, from: 'extension' });
    expect(sent[0]).toEqual({ d: { ns: NS, from: 'page', id: expect.any(String), msg: { t: 'hello' } }, o: ORIGIN });
    deliver({ ns: NS, from: 'ext', push: { t: 'ready', link: 'L'.repeat(22) } });
    deliver({ ns: NS, from: 'ext', push: { t: 'ready' } }, { origin: 'https://evil.example' });
    expect(pushes).toEqual([{ t: 'ready', link: 'L'.repeat(22) }]);
    // No answer: null after the wait.
    win.postMessage = () => {};
    expect(await t.ask({ t: 'hello' }, 20)).toBeNull();
  });
});
