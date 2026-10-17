// The extension end to end, with a pretend browser: linking, reading the history (the 90 days
// before, then as it happens), sealing, delivering to Arise, pause, "forget the last hour", time
// on site, and unlinking. And what it keeps: nothing readable.

import { beforeEach, describe, expect, it } from 'vitest';
import type { LifeEvent } from '../../../src/life/types';
import { commitment, newLinkId, newNonce, pairCode, type Push } from './pairing';
import * as R from './recorder';
import { newKeyPair, openBatch, type SealedBatch } from './seal';
import { HOUR, MINUTE } from './time';

const ARISE = 'https://abyyworld.github.io/physical-improvement-tracker-app/';
const ORIGIN = 'https://abyyworld.github.io';
const DAY = 24 * HOUR;
const START = new Date(2026, 9, 17, 14, 5).getTime();

interface Page {
  url: string;
  title?: string;
  visits: { visitTime: number; transition?: string; isLocal?: boolean }[];
}

function kv() {
  const data = new Map<string, unknown>();
  const store: R.KV & { data: Map<string, unknown> } = {
    data,
    get: async (keys) => Object.fromEntries(keys.filter((k) => data.has(k)).map((k) => [k, structuredClone(data.get(k))])),
    set: async (items) => {
      for (const [k, v] of Object.entries(items)) data.set(k, structuredClone(v));
    },
    remove: async (keys) => {
      for (const k of keys) data.delete(k);
    },
  };
  return store;
}

let now = START;
let pages: Page[] = [];
let pushes: { p: Push; origin: string }[] = [];
let confirms = 0;
let local: ReturnType<typeof kv>;
let session: ReturnType<typeof kv>;
let env: R.Env;

beforeEach(() => {
  now = START;
  pages = [];
  pushes = [];
  confirms = 0;
  local = kv();
  session = kv();
  env = {
    now: () => now,
    local,
    session,
    history: {
      search: async ({ startTime, endTime }) => pages.filter((p) => p.visits.some((v) => v.visitTime >= startTime && v.visitTime <= endTime)).map((p) => ({ url: p.url, title: p.title })),
      getVisits: async ({ url }) => structuredClone(pages.find((p) => p.url === url)?.visits ?? []),
    },
    browser: 'Chrome on macOS',
    version: '1.0.0',
    arise: [ARISE],
    allowed: (o) => o === ORIGIN,
    push: async (p, origin) => void pushes.push({ p, origin }),
    openConfirm: async () => void confirms++,
  };
});

const visit = (url: string, t: number, title = '', extra: Partial<Page['visits'][number]> = {}) => {
  const p = pages.find((x) => x.url === url) || (pages.push({ url, title, visits: [] }), pages[pages.length - 1]);
  if (title) p.title = title;
  p.visits.push({ visitTime: t, transition: 'link', ...extra });
};

// Links the extension the way Arise's page does, and the person presses "They match".
async function link() {
  const { pub, privateKey } = await newKeyPair(false);
  const id = newLinkId();
  const pageNonce = newNonce();
  const offer = (await R.pageRequest(env, { t: 'offer', link: id, pub, commit: await commitment(pageNonce) }, ORIGIN)) as { ok: boolean; nonce: string };
  expect(offer.ok).toBe(true);
  expect(await R.pageRequest(env, { t: 'reveal', link: id, nonce: pageNonce }, ORIGIN)).toEqual({ ok: true });
  const code = await pairCode(id, pub, pageNonce, offer.nonce);
  const state = (await R.popupRequest(env, { t: 'state' })) as R.PopupState;
  expect(state.pairing).toEqual({ link: id, code }); // the same 4 words as the page shows
  await R.popupRequest(env, { t: 'confirm', link: id });
  return { id, privateKey };
}

// What Arise would get now: every waiting batch opened. `ack` deletes them from the extension.
async function collect(l: { id: string; privateKey: CryptoKey }, { ack = true } = {}) {
  const events: LifeEvent[] = [];
  const batches: SealedBatch[] = [];
  for (;;) {
    const r = (await R.pageRequest(env, { t: 'pull', link: l.id }, ORIGIN)) as { ok: boolean; batches: SealedBatch[]; more: boolean; notes: unknown[] };
    expect(r.ok).toBe(true);
    batches.push(...r.batches);
    for (const b of r.batches) events.push(...((await openBatch(l.privateKey, b)) as { events: LifeEvent[] }).events);
    if (ack) await R.pageRequest(env, { t: 'ack', link: l.id, ids: r.batches.map((b) => b.id), notes: [] }, ORIGIN);
    if (!ack || !r.more) break;
  }
  return { events: events.sort((a, b) => a.at - b.at), batches };
}
const titles = (es: LifeEvent[]) => es.map((e) => e.title);

describe('linking', () => {
  it('records nothing until linked', async () => {
    visit('https://example.org/a', START - HOUR, 'A');
    expect(await R.tick(env, 'https://example.org/a')).toBe(0);
    await R.observe(env, 'https://example.org/a');
    expect(local.data.size).toBe(0);
    expect(await R.pageRequest(env, { t: 'pull', link: newLinkId() }, ORIGIN)).toEqual({ ok: false, error: 'not-linked' });
  });

  it('shows the code, opens its window, and links only after "They match"', async () => {
    const l = await link();
    expect(confirms).toBe(1);
    expect(pushes).toEqual([{ p: { t: 'paired', link: l.id }, origin: ORIGIN }]);
    expect(await R.pageRequest(env, { t: 'hello' }, ORIGIN)).toMatchObject({ ok: true, browser: 'Chrome on macOS', linked: l.id, pairing: false });
    expect(await R.pageRequest(env, { t: 'status', link: l.id }, ORIGIN)).toMatchObject({ ok: true, linked: true });
    // What it keeps: Arise's public key only.
    expect(JSON.stringify(local.data.get('link'))).not.toMatch(/"d"|private|pkcs8/);
  });

  it('turns away the wrong number, other sites, and a request that ran out of time', async () => {
    const { pub } = await newKeyPair(false);
    const id = newLinkId();
    const n = newNonce();
    expect(await R.pageRequest(env, { t: 'hello' }, 'https://evil.example')).toEqual({ ok: false, error: 'not-arise' });
    await R.pageRequest(env, { t: 'offer', link: id, pub, commit: await commitment(n) }, ORIGIN);
    expect(await R.pageRequest(env, { t: 'reveal', link: id, nonce: newNonce() }, ORIGIN)).toEqual({ ok: false, error: 'bad-nonce' });
    expect(((await R.popupRequest(env, { t: 'state' })) as R.PopupState).pairing).toBeNull();
    // A good one, but "They match" pressed too late.
    await R.pageRequest(env, { t: 'offer', link: id, pub, commit: await commitment(n) }, ORIGIN);
    await R.pageRequest(env, { t: 'reveal', link: id, nonce: n }, ORIGIN);
    now += 11 * MINUTE;
    expect(await R.popupRequest(env, { t: 'confirm', link: id })).toMatchObject({ ok: false });
    expect(((await R.popupRequest(env, { t: 'state' })) as R.PopupState).linked).toBe(false);
  });

  it('says so when the words don’t match', async () => {
    const { pub } = await newKeyPair(false);
    const id = newLinkId();
    const n = newNonce();
    await R.pageRequest(env, { t: 'offer', link: id, pub, commit: await commitment(n) }, ORIGIN);
    await R.pageRequest(env, { t: 'reveal', link: id, nonce: n }, ORIGIN);
    await R.popupRequest(env, { t: 'decline', link: id });
    expect(pushes).toEqual([{ p: { t: 'declined', link: id }, origin: ORIGIN }]);
    expect(((await R.popupRequest(env, { t: 'state' })) as R.PopupState).linked).toBe(false);
  });
});

describe('reading the history', () => {
  it('reads the 90 days before linking, leaving out what is never recorded', async () => {
    visit('https://www.nytimes.com/2026/10/10/health/sleep.html?smid=share', START - 7 * DAY, 'How Sleep Builds Muscle');
    visit('https://www.google.com/search?q=protein+bars&oq=protein', START - 2 * DAY, 'protein bars - Google Search');
    visit('https://old.example/from-long-ago', START - 95 * DAY, 'Too old');
    visit('https://secure.chase.com/dashboard', START - DAY, 'Chase');
    visit('https://example.org/reloaded', START - DAY, 'Reloaded', { transition: 'reload' });
    visit('https://abyyworld.github.io/physical-improvement-tracker-app/#today', START - DAY, 'Arise');
    const l = await link();
    await R.tick(env, null);
    const { events } = await collect(l);
    expect(titles(events)).toEqual(['How Sleep Builds Muscle', 'Searched "protein bars"']);
    expect(events[0]).toMatchObject({ source: 'browser', kind: 'visit', url: 'https://www.nytimes.com/2026/10/10/health/sleep.html', tier: 3 });
    expect(events[1]).toMatchObject({ kind: 'search', url: 'https://www.google.com/search?q=protein%20bars', meta: { engine: 'google', query: 'protein bars' } });
    expect(((await R.popupRequest(env, { t: 'state' })) as R.PopupState).backfilling).toBe(false);
  });

  it('then reads new visits as they happen, each once', async () => {
    const l = await link();
    await R.tick(env, null);
    expect((await collect(l)).events).toEqual([]);
    now += 30_000;
    visit('https://example.org/new', now - 5000, 'New page');
    await R.tick(env, null);
    now += 60_000;
    await R.tick(env, null); // read again (the looks overlap): not twice
    const { events } = await collect(l);
    expect(titles(events)).toEqual(['New page']);
    expect(pushes.some((x) => x.p.t === 'ready')).toBe(true);
  });

  it('picks up visits browser sync brings in late, marked as from another device', async () => {
    const l = await link();
    await R.tick(env, null);
    await collect(l);
    now += 10 * MINUTE;
    visit('https://example.org/on-my-phone', now - 5 * HOUR, 'From the phone', { isLocal: false });
    await R.tick(env, null);
    expect((await collect(l)).events).toEqual([]); // not looked that far back yet
    now += HOUR;
    await R.tick(env, null);
    const { events } = await collect(l);
    expect(titles(events)).toEqual(['From the phone']);
    expect(events[0].meta!.otherDevice).toBe(true);
  });

  it('counts the same search again soon after once', async () => {
    const l = await link();
    await R.tick(env, null);
    now += MINUTE;
    visit('https://www.google.com/search?q=squats', now - 50_000);
    visit('https://www.google.com/search?q=squats&start=10', now - 40_000);
    visit('https://www.google.com/search?q=SQUATS&oq=x', now - 30_000);
    visit('https://www.youtube.com/results?search_query=squats', now - 20_000);
    await R.tick(env, null);
    const { events } = await collect(l);
    expect(events.map((e) => `${e.meta!.engine}: ${e.title}`)).toEqual(['google: Searched "squats"', 'youtube: Searched "squats"']);
  });

  it("follows the person's own list of sites to skip", async () => {
    const l = await link();
    await R.popupRequest(env, { t: 'skip', text: 'work.example\nhttps://www.secret.org/x' });
    now += MINUTE;
    visit('https://intranet.work.example/', now - 10_000, 'Work');
    visit('https://secret.org/a', now - 10_000, 'Secret');
    visit('https://public.example/', now - 10_000, 'Public');
    await R.tick(env, null);
    expect(titles((await collect(l)).events)).toEqual(['Public']);
    expect(((await R.popupRequest(env, { t: 'state' })) as R.PopupState).skip).toEqual(['work.example', 'secret.org']);
  });
});

describe('what it keeps', () => {
  it('keeps nothing readable: only sealed batches, ids and times', async () => {
    visit('https://www.google.com/search?q=embarrassing+question', START - DAY, 'embarrassing question - Google Search');
    visit('https://www.nytimes.com/private-reading', START - 2 * DAY, 'A very private article');
    await link();
    await R.observe(env, 'https://www.youtube.com/watch?v=1');
    now += 20 * MINUTE;
    await R.tick(env, 'https://www.youtube.com/watch?v=1');
    now += HOUR;
    await R.tick(env, 'https://www.youtube.com/watch?v=1');
    const stored = JSON.stringify([...local.data.entries()]);
    expect(local.data.get('index')).toHaveLength(3);
    for (const secret of ['embarrassing', 'question', 'nytimes', 'private-reading', 'private article', 'youtube', 'google']) expect(stored).not.toContain(secret);
  });
});

describe('what it keeps, beyond the sealed batches', () => {
  it('keeps the fingerprints of visits with the hour only, and those of searches for an hour', async () => {
    const l = await link();
    await R.tick(env, null);
    now += MINUTE;
    visit('https://example.org/page', now - 20_000, 'Page');
    visit('https://www.google.com/search?q=private+question', now - 10_000);
    await R.tick(env, null);
    const seen = () => Object.entries(local.data.get('seen') as Record<string, number>);
    expect(seen()).toHaveLength(3); // two visits, one search's words
    for (const [k, t] of seen()) if (!k.startsWith('q:')) expect(t % HOUR, k).toBe(0);
    now += 2 * HOUR;
    await R.tick(env, null); // with a look back over the last 2 days: nothing read twice
    expect(seen()).toHaveLength(2);
    expect(seen().some(([k]) => k.startsWith('q:'))).toBe(false);
    expect(titles((await collect(l)).events)).toEqual(['Page', 'Searched "private question"']);
  });
});

describe('delivering', () => {
  it('hands batches over until Arise has them, then deletes them', async () => {
    visit('https://example.org/a', START - DAY, 'A');
    const l = await link();
    await R.tick(env, null);
    const first = await collect(l, { ack: false });
    const again = await collect(l, { ack: false });
    expect(again.batches.map((b) => b.id)).toEqual(first.batches.map((b) => b.id)); // not delivered until acknowledged
    await R.pageRequest(env, { t: 'ack', link: l.id, ids: first.batches.map((b) => b.id), notes: [] }, ORIGIN);
    expect((await collect(l)).batches).toEqual([]);
    const state = (await R.popupRequest(env, { t: 'state' })) as R.PopupState;
    expect(state.waiting).toBe(0);
    expect(state.sent).toEqual({ at: now, n: 1 });
  });

  it('gives batches only to the Arise it was linked with', async () => {
    visit('https://example.org/a', START - DAY, 'A');
    const l = await link();
    await R.tick(env, null);
    expect(await R.pageRequest(env, { t: 'pull', link: newLinkId() }, ORIGIN)).toEqual({ ok: false, error: 'not-linked' });
    expect(await R.pageRequest(env, { t: 'pull', link: l.id }, 'https://evil.example')).toEqual({ ok: false, error: 'not-arise' });
    expect(await R.pageRequest(env, { t: 'ack', link: newLinkId(), ids: [], notes: [] }, ORIGIN)).toEqual({ ok: false, error: 'not-linked' });
  });

  it('answers Arise straight away while it reads the 90 days before', async () => {
    for (let d = 1; d <= 30; d++) visit(`https://example.org/day${d}`, START - d * DAY, `Day ${d}`);
    const l = await link();
    const getVisits = env.history.getVisits;
    env.history.getVisits = async (q) => (await new Promise((r) => setTimeout(r, 40)), getVisits(q)); // a slow history: about 1.2 s for 30 days
    const reading = R.tick(env, null);
    const t0 = Date.now();
    expect(await R.pageRequest(env, { t: 'hello' }, ORIGIN)).toMatchObject({ linked: l.id });
    expect(await R.popupRequest(env, { t: 'state' })).toMatchObject({ backfilling: true });
    expect(Date.now() - t0).toBeLessThan(300);
    // Collecting gets in between two days, not after all of them.
    const pull = (await R.pageRequest(env, { t: 'pull', link: l.id }, ORIGIN)) as { ok: boolean };
    expect(pull.ok).toBe(true);
    expect(Date.now() - t0).toBeLessThan(600);
    await reading;
    expect((await collect(l)).events).toHaveLength(30);
  });

  it('gets over the browser quitting while it deletes what Arise has', async () => {
    for (let d = 1; d <= 30; d++) visit(`https://example.org/day${d}`, START - d * DAY, `Day ${d}`);
    const l = await link();
    await R.tick(env, null);
    const first = (await R.pageRequest(env, { t: 'pull', link: l.id }, ORIGIN)) as { batches: SealedBatch[] };
    expect(first.batches).toHaveLength(25);
    // The data goes, then the browser quits before the list of what's waiting is saved.
    const set = local.set;
    local.set = async () => {
      throw new Error('the browser quit');
    };
    await R.pageRequest(env, { t: 'ack', link: l.id, ids: first.batches.map((b) => b.id), notes: [] }, ORIGIN).catch(() => {});
    local.set = set;
    const next = (await R.pageRequest(env, { t: 'pull', link: l.id }, ORIGIN)) as { batches: SealedBatch[]; more: boolean };
    expect(next.batches).toHaveLength(5);
    expect(next.more).toBe(false);
    await R.pageRequest(env, { t: 'ack', link: l.id, ids: next.batches.map((b) => b.id), notes: [] }, ORIGIN);
    expect(((await R.popupRequest(env, { t: 'state' })) as R.PopupState).waiting).toBe(0);
  });

  it('splits a long history into batches that fit in a message', async () => {
    for (let d = 1; d <= 60; d++) visit(`https://example.org/day${d}`, START - d * DAY, `Day ${d}`);
    const l = await link();
    await R.tick(env, null);
    const r = (await R.pageRequest(env, { t: 'pull', link: l.id }, ORIGIN)) as { batches: SealedBatch[]; more: boolean };
    expect(r.batches.length).toBe(25);
    expect(r.more).toBe(true);
    expect((await collect(l)).events).toHaveLength(60);
  });
});

describe('pause and forget', () => {
  it('records nothing while paused, and never that time later', async () => {
    const l = await link();
    await R.tick(env, null);
    await R.popupRequest(env, { t: 'pause' });
    now += 10 * MINUTE;
    visit('https://example.org/while-paused', now - MINUTE, 'While paused');
    await R.tick(env, 'https://example.org/while-paused');
    await R.popupRequest(env, { t: 'resume' });
    now += 10 * MINUTE;
    visit('https://example.org/after', now - MINUTE, 'After');
    await R.tick(env, null);
    now += 2 * HOUR; // and a look back over the last 2 days
    await R.tick(env, null, { deep: true });
    expect(titles((await collect(l)).events)).toEqual(['After']);
  });

  it('forgets the last hour: waiting batches from then go, older ones in them come back, Arise is told', async () => {
    visit('https://example.org/yesterday', START - DAY, 'Yesterday');
    // Two visits sealed together, one on each side of where the last hour will begin.
    visit('https://example.org/before', START - 33 * MINUTE, 'Before the hour');
    visit('https://example.org/within', START - 27 * MINUTE, 'Within the hour');
    const l = await link();
    await R.tick(env, null);
    now += 30 * MINUTE;
    visit('https://example.org/recent', now - 20 * MINUTE, 'Recent');
    await R.tick(env, null);
    await R.popupRequest(env, { t: 'forget' });
    await R.tick(env, null);
    now += 3 * HOUR;
    await R.tick(env, null, { deep: true }); // the forgotten hour is never read again
    const r = (await R.pageRequest(env, { t: 'pull', link: l.id }, ORIGIN)) as { notes: { t: string; from: number; to: number }[] };
    expect(r.notes).toEqual([{ id: expect.any(String), t: 'forget', from: START + 30 * MINUTE - HOUR, to: START + 30 * MINUTE }]);
    const { events } = await collect(l);
    expect(titles(events)).toEqual(['Yesterday', 'Before the hour']);
  });
});

describe('time on site', () => {
  it('adds up time per site per hour, and sends an hour once it is over', async () => {
    const l = await link();
    const h = new Date(2026, 9, 17, 14).getTime();
    await R.observe(env, 'https://www.youtube.com/watch?v=1');
    for (let i = 0; i < 20; i++) {
      now += MINUTE;
      await R.tick(env, i < 12 ? 'https://www.youtube.com/watch?v=1' : 'https://news.example/story');
    }
    now += 2 * MINUTE;
    await R.observe(env, 'https://secure.chase.com/'); // a bank: no time counted there
    now += 2 * MINUTE;
    await R.observe(env, null); // the browser lost focus
    expect((await collect(l)).events.filter((e) => e.kind === 'app')).toEqual([]); // the hour isn't over
    now = h + HOUR + MINUTE;
    await R.tick(env, null);
    const time = (await collect(l)).events.filter((e) => e.kind === 'app');
    expect(time.map((e) => [e.title, e.at, e.end, e.meta!.seconds])).toEqual([
      ['13 min on youtube.com', h, h + HOUR, 780],
      ['9 min on news.example', h, h + HOUR, 540],
    ]);
  });

  it('seals the hour so far when the browser closes, and the rest of it as its own part', async () => {
    const l = await link();
    await R.observe(env, 'https://example.org/');
    now += 5 * MINUTE;
    await R.flush(env);
    const first = (await collect(l)).events.filter((e) => e.kind === 'app');
    expect(first.map((e) => e.meta!.seconds)).toEqual([180]); // at most 3 minutes without a look
    await R.observe(env, 'https://example.org/');
    now += 2 * MINUTE;
    await R.observe(env, null);
    now = new Date(2026, 9, 17, 15, 1).getTime();
    await R.tick(env, null);
    const second = (await collect(l)).events.filter((e) => e.kind === 'app');
    expect(second.map((e) => e.meta!.seconds)).toEqual([120]);
    expect(second[0].id).not.toBe(first[0].id);
  });

  it('never gives two parts of an hour the same id, even if the browser quits while sealing', async () => {
    const l = await link();
    await R.observe(env, 'https://example.org/');
    now += 2 * MINUTE;
    // The browser quits right after the hour so far is sealed and stored: later writes are lost.
    const set = local.set;
    let quit = false;
    local.set = async (items) => {
      if (quit) throw new Error('the browser quit');
      await set(items);
      if ('index' in items) quit = true;
    };
    await R.flush(env).catch(() => {});
    local.set = set;
    session.data.clear(); // memory goes with the browser
    await R.observe(env, 'https://example.org/');
    now += 2 * MINUTE;
    await R.observe(env, null);
    now = new Date(2026, 9, 17, 15, 1).getTime();
    await R.tick(env, null);
    const time = (await collect(l)).events.filter((e) => e.kind === 'app');
    expect(time.map((e) => e.meta!.seconds)).toEqual([120, 120]);
    expect(new Set(time.map((e) => e.id)).size).toBe(2);
  });

  it("doesn't count time while paused, or what was forgotten", async () => {
    const l = await link();
    await R.observe(env, 'https://example.org/');
    now += 2 * MINUTE;
    await R.popupRequest(env, { t: 'pause' });
    now += 2 * MINUTE;
    await R.tick(env, 'https://example.org/');
    await R.popupRequest(env, { t: 'resume' });
    await R.observe(env, 'https://other.example/');
    now += 2 * MINUTE;
    await R.popupRequest(env, { t: 'forget' });
    now += MINUTE;
    await R.observe(env, null);
    now = new Date(2026, 9, 17, 15, 1).getTime();
    await R.tick(env, null);
    const time = (await collect(l)).events.filter((e) => e.kind === 'app');
    expect(time.map((e) => [e.detail, e.meta!.seconds])).toEqual([['other.example', 60]]);
  });
});

describe('unlinking', () => {
  it('from Arise: stops recording and deletes what was waiting', async () => {
    visit('https://example.org/a', START - DAY, 'A');
    const l = await link();
    await R.tick(env, null);
    await R.pageRequest(env, { t: 'unlink', link: l.id }, ORIGIN);
    expect(pushes.at(-1)).toEqual({ p: { t: 'unlinked', link: l.id }, origin: ORIGIN });
    expect([...local.data.keys()].filter((k) => k.startsWith('b:') || k === 'link' || k === 'index')).toEqual([]);
    now += MINUTE;
    visit('https://example.org/b', now - 1000, 'B');
    expect(await R.tick(env, null)).toBe(0);
  });

  it('from the extension: the same', async () => {
    const l = await link();
    await R.popupRequest(env, { t: 'unlink' });
    expect(await R.pageRequest(env, { t: 'hello' }, ORIGIN)).toMatchObject({ linked: null });
    expect(await R.pageRequest(env, { t: 'pull', link: l.id }, ORIGIN)).toEqual({ ok: false, error: 'not-linked' });
  });

  it('linking again starts over with the new key', async () => {
    visit('https://example.org/a', START - DAY, 'A');
    const first = await link();
    await R.tick(env, null);
    const second = await link();
    await R.tick(env, null);
    expect(await R.pageRequest(env, { t: 'pull', link: first.id }, ORIGIN)).toEqual({ ok: false, error: 'not-linked' });
    expect(titles((await collect(second)).events)).toEqual(['A']);
  });
});
