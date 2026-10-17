// @vitest-environment jsdom
// The life log syncing between the Player's devices: several simulated devices (each its own copy
// of the app's modules, its own storage and its own life log database) sharing one in-memory cloud
// that enforces the database rules (test/fake-firebase.ts).

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cloud, resetCloud } from '../test/fake-firebase';
import type { LifeEvent } from './types';

// Each device loads the whole app's modules, and one test seals a couple of megabytes: more time
// than the default when every test file runs at once.
vi.setConfig({ testTimeout: 20_000 });

vi.mock('../lib/firebase', () => import('../test/fake-firebase'));
// Fewer key-stretching rounds, so the tests run in seconds. The real count is tested in crypto.test.ts.
vi.mock('../lib/crypto', async (orig) => {
  const real = await orig<typeof import('../lib/crypto')>();
  return { ...real, deriveMaster: (p: string, id: string) => real.deriveMaster(p, id, 1000) };
});
// No AI, unless a test turns on the private one with an answer for summing up a day.
const ai = vi.hoisted(() => ({ engine: null as string | null, answer: null as unknown }));
vi.mock('../ai.js', () => ({ engine: () => ai.engine, isPrivate: () => true, ready: () => !!ai.engine, askMemory: async () => ai.answer, useMemory: () => {} }));

interface Device {
  name: string;
  S: typeof import('../store');
  SYNC: typeof import('../sync');
  LIFE: typeof import('./cloud');
  L: typeof import('./log');
  M: typeof import('./memory');
  P: typeof import('./prefs');
  A: typeof import('../account');
  I: typeof import('./ingest');
  updates: number;
}

const storage = new Map<string, Map<string, string>>();
const databases = new Map<string, IDBFactory>();
let current = '';
const devices: Device[] = [];

// Swap localStorage and IndexedDB to this device's.
function use(name: string) {
  if (current) storage.set(current, new Map(Object.entries({ ...localStorage })));
  localStorage.clear();
  for (const [k, v] of storage.get(name) || []) localStorage.setItem(k, v);
  if (!databases.has(name)) databases.set(name, new IDBFactory());
  globalThis.indexedDB = databases.get(name)!;
  current = name;
}

async function device(name: string): Promise<Device> {
  use(name);
  vi.resetModules();
  const d = {
    name,
    S: await import('../store'),
    SYNC: await import('../sync'),
    LIFE: await import('./cloud'),
    L: await import('./log'),
    M: await import('./memory'),
    P: await import('./prefs'),
    A: await import('../account'),
    I: await import('./ingest'),
    updates: 0,
  };
  await d.SYNC.initSync({ render: () => {}, changed: () => {}, checkForUpdate: () => d.updates++ });
  d.M.initMemory({ delay: -1 });
  devices.push(d);
  return d;
}

async function on<T>(d: Device, fn: () => Promise<T> | T): Promise<T> {
  use(d.name);
  return fn();
}
// Until this device's life log has nothing waiting to go up and no sync on.
const settle = (d: Device) => on(d, () => d.LIFE.whenIdle());
// The app opens again, or comes back to the front: the main data syncs, then the life log.
const reopen = async (d: Device) => {
  await on(d, () => d.SYNC.syncNow());
  await settle(d);
};

const PW = 'correct horse battery';
const EMAIL = 'me@example.com';
async function signUp(d: Device, values: Record<string, string> = {}) {
  await on(d, () => d.SYNC.submit('up', { email: EMAIL, password: PW, password2: PW, ...values }));
  expect(d.SYNC.status.error).toBe('');
  await settle(d);
}
async function signIn(d: Device, id = EMAIL, password = PW) {
  await on(d, () => d.SYNC.submit('in', { id, password }));
  expect(d.SYNC.status.error).toBe('');
  await settle(d);
}

const at = (s: string) => Date.parse(`${s}Z`);
const song = (id: string, when = '2026-10-05T09:00', title = `Listened to song ${id}`): LifeEvent => ({ id: `spotify:${id}`, source: 'spotify', kind: 'listen', at: at(when), title, tier: 2 });
const note = (id: string, when: string, title: string): LifeEvent => ({ id: `manual:${id}`, source: 'manual', kind: 'note', at: at(when), title, tier: 2 });
const add = async (d: Device, events: LifeEvent[]) => {
  await on(d, () => d.L.addEvents(events));
  await settle(d);
};
const titles = (d: Device) => on(d, async () => (await d.L.eventsBetween(0, Infinity)).map((e) => e.title).sort());
const facts = (d: Device) => on(d, async () => (await d.M.reload(), d.M.allFacts().map((f) => f.text).sort()));
// The life log's database fails for a while (as WKWebView's does when the connection to it is
// lost), for every transaction over all of `stores`. Returns how to undo it.
function failDB(stores: string[]) {
  const proto = (globalThis as unknown as { IDBDatabase: { prototype: { transaction: (...a: unknown[]) => unknown } } }).IDBDatabase.prototype;
  const real = proto.transaction;
  proto.transaction = function (this: unknown, names: unknown, ...rest: unknown[]) {
    const list = Array.isArray(names) ? names : [names];
    if (stores.every((n) => list.includes(n))) throw new DOMException('Connection to Indexed Database server lost.', 'UnknownError');
    return real.call(this, names, ...rest);
  };
  return () => {
    proto.transaction = real;
  };
}
const lifeDocs = (uid = 'uid1') => [...cloud.docs.keys()].filter((k) => k.startsWith(`users/${uid}/life/`)).map((k) => k.split('/').pop()!);
const cloudText = () => JSON.stringify([...cloud.docs.values()]);

beforeEach(() => {
  resetCloud();
  storage.clear();
  databases.clear();
  current = '';
  localStorage.clear();
  document.body.innerHTML = '<div id="sheet" hidden><div class="sheet-panel"><button class="sheet-close"></button><div class="sheet-body"></div></div></div><div id="toast"></div><main id="app"></main><nav id="tabs"></nav>';
});

afterEach(() => {
  for (const d of devices.splice(0)) {
    d.SYNC.status.user = null;
    d.LIFE.stop();
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
  ai.engine = null;
});

async function pair(events: LifeEvent[] = [song('1'), song('2'), song('3')]) {
  const a = await device('phone');
  await on(a, () => a.L.addEvents(events));
  await signUp(a);
  const b = await device('laptop');
  await signIn(b);
  return { a, b };
}

describe('the life log between devices', () => {
  it('reaches another device, sealed, in documents whose names say nothing', async () => {
    const a = await device('phone');
    await on(a, async () => {
      await a.L.addEvents([song('1', '2026-10-05T09:00', 'Listened to Daft Punk'), song('2', '2026-11-02T09:00'), note('n1', '2026-10-06T20:00', 'My secret note about Sam')]);
      await a.M.addFact('I live in Leeds.');
    });
    await signUp(a);
    expect(a.LIFE.lines().main).toBe('Synced between your devices, end-to-end encrypted.');
    // The key, the index, and one document for each pack: October, November and the memory.
    const docs = lifeDocs();
    expect(docs).toContain('key');
    expect(docs).toContain('index');
    expect(docs.filter((id) => /^[A-Za-z0-9_-]{43}$/.test(id))).toHaveLength(3);
    for (const id of docs) expect(id).not.toMatch(/2026|mem/);
    for (const secret of ['Daft Punk', 'secret note', 'Leeds', 'spotify', '2026-10', PW]) expect(cloudText()).not.toContain(secret);
    for (const [path, d] of cloud.docs) if (path.includes('/life/')) expect(Object.keys(d).sort()).toEqual(['ct', 'iv', 'updated', 'v']);

    const b = await device('laptop');
    expect(await on(b, () => b.LIFE.lines().main)).toBe('On this device only. Sign in to sync it.');
    await signIn(b);
    expect(await titles(b)).toEqual(['Listened to Daft Punk', 'Listened to song 2', 'My secret note about Sam']);
    expect(await facts(b)).toEqual(['I live in Leeds.']);
  });

  it("keeps what each device added while the other was offline, and doesn't touch the main cloud copy", async () => {
    const { a, b } = await pair();
    const meta = cloud.docs.get('users/uid1/arise/meta')!.rev;
    await on(b, () => b.L.addEvents([note('b1', '2026-10-07T08:00', 'Laptop note')]));
    await add(a, [note('a1', '2026-10-07T09:00', 'Phone note')]);
    await settle(b); // the laptop sends its note: the phone's came first, so it's taken in too
    await reopen(a);
    const all = ['Laptop note', 'Listened to song 1', 'Listened to song 2', 'Listened to song 3', 'Phone note'];
    expect(await titles(a)).toEqual(all);
    expect(await titles(b)).toEqual(all);
    // The life log has its own packs: the main copy (which older versions of Arise read) didn't change.
    expect(cloud.docs.get('users/uid1/arise/meta')!.rev).toBe(meta);
    expect(a.SYNC.SCHEMA).toBe(4); // (4: the new look and the tiers of the coach's replies, in the main copy)
  });

  it('loses nothing when two devices send at the same moment', async () => {
    const { a, b } = await pair();
    await on(a, () => a.L.addEvents([note('a1', '2026-10-07T09:00', 'Phone note')]));
    await on(b, () => b.L.addEvents([note('b1', '2026-10-07T08:00', 'Laptop note')]));
    // Just as the laptop writes, the phone gets its write in first.
    let first = true;
    cloud.hook = async (op: string, path: string) => {
      if (first && op === 'commit' && path.includes('/life/index') && current === 'laptop') {
        first = false;
        await settle(a);
        use('laptop');
      }
    };
    await settle(b);
    cloud.hook = null;
    expect(first).toBe(false);
    await reopen(a);
    for (const d of [a, b]) expect(await titles(d)).toEqual(['Laptop note', 'Listened to song 1', 'Listened to song 2', 'Listened to song 3', 'Phone note']);
  });

  it("keeps what Arise makes from the app's own data on each device, except questions to the coach", async () => {
    const arise = (id: string, kind: LifeEvent['kind'], title: string): LifeEvent => ({ id, source: 'arise', kind, at: at('2026-10-05T09:00'), title, tier: 1 });
    const { b } = await pair([arise('arise:quest:2026-10-05:q1', 'quest', 'Done: Study'), arise('arise:chat:1759654800000', 'message', 'Asked the coach: how do I sleep better?')]);
    expect(await titles(b)).toEqual(['Asked the coach: how do I sleep better?']);
  });
});

describe('deleting', () => {
  it("reaches every device, and a device's older copy doesn't bring it back", async () => {
    const { a, b } = await pair();
    await on(a, () => a.L.removeIds(['spotify:1']));
    await settle(a);
    // The laptop still has song 1, and adds something while offline.
    await on(b, () => b.L.addEvents([note('b1', '2026-10-05T10:00', 'Laptop note')]));
    await settle(b);
    expect(await titles(b)).toEqual(['Laptop note', 'Listened to song 2', 'Listened to song 3']);
    await reopen(a);
    expect(await titles(a)).toEqual(['Laptop note', 'Listened to song 2', 'Listened to song 3']);
    // Added again after it was deleted: it's back everywhere.
    await add(a, [song('1', '2026-10-05T09:00', 'Song 1 again')]);
    await reopen(b);
    expect(await titles(b)).toContain('Song 1 again');
  });

  it('of a whole source reaches every device, even what this device never had, and keeps the rest', async () => {
    const { a, b } = await pair();
    // The laptop has a Spotify song the phone never saw, and a note.
    await on(b, () => b.L.addEvents([song('b', '2026-09-20T09:00'), note('b1', '2026-10-05T10:00', 'Laptop note')]));
    // (Not sent yet: the laptop is offline.)
    await on(b, () => b.LIFE.stop());
    await on(a, async () => {
      const { days } = await a.L.deleteWhereDays({ source: 'spotify' });
      await a.M.forgetDays(days);
    });
    await settle(a);
    await reopen(b);
    expect(await titles(b)).toEqual(['Laptop note']);
    await reopen(a);
    expect(await titles(a)).toEqual(['Laptop note']);
    // A third device sees the same.
    const c = await device('tablet');
    await signIn(c);
    expect(await titles(c)).toEqual(['Laptop note']);
  });

  it("isn't undone by a device that was away for longer than deletions are kept", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-17T10:00:00Z'));
    const { a, b } = await pair();
    vi.setSystemTime(Date.now() + 60_000);
    await on(a, () => a.L.removeIds(['spotify:1']));
    await settle(a);
    // More than 400 days on, the phone changes that month again: its record of the deletion is gone.
    vi.setSystemTime(Date.now() + 401 * 864e5);
    await add(a, [song('4')]);
    // The laptop, away all that time, still has song 1. It doesn't come back.
    await reopen(b);
    const left = ['Listened to song 2', 'Listened to song 3', 'Listened to song 4'];
    expect(await titles(b)).toEqual(left);
    await reopen(a);
    expect(await titles(a)).toEqual(left);
  });

  it("made on a device before it ever synced with the account doesn't delete anything of the account's", async () => {
    const a = await device('phone');
    await on(a, () => a.L.addEvents([song('1')]));
    await signUp(a);
    const b = await device('laptop');
    await on(b, async () => {
      await b.L.addEvents([song('b', '2026-10-06T09:00')]);
      await b.L.deleteWhereDays({ source: 'spotify' });
      await b.L.addEvents([note('n', '2026-10-06T10:00', 'Laptop note')]);
    });
    await signIn(b);
    expect(await titles(b)).toEqual(['Laptop note', 'Listened to song 1']);
    await reopen(a);
    expect(await titles(a)).toEqual(['Laptop note', 'Listened to song 1']);
  });

  it('of everything while signed out is only on this device', async () => {
    const { a, b } = await pair();
    await on(a, () => a.SYNC.handleAction('sync-out'));
    expect(a.LIFE.signedIn()).toBe(false);
    await on(a, () => a.L.eraseAll({ everywhere: a.LIFE.signedIn() })); // as Delete everything does
    expect(await titles(a)).toEqual([]);
    await signIn(a);
    const all = ['Listened to song 1', 'Listened to song 2', 'Listened to song 3'];
    expect(await titles(a)).toEqual(all);
    await reopen(b);
    expect(await titles(b)).toEqual(all);
  });

  it('of a question to the coach stays deleted on every device, though their chats still have it', async () => {
    const { a, b } = await pair([]);
    const asked = at('2026-10-05T09:00');
    const q = 'Asked the coach: How do I sleep better?';
    // Asked on the phone: the chat goes with the main data, and the phone's log takes it in.
    await on(a, async () => {
      a.S.state.ai.chat.push({ role: 'user', text: 'How do I sleep better?', at: asked });
      a.S.save();
      await a.SYNC.syncNow();
      await a.I.ingestNow();
    });
    await settle(a);
    // The laptop's chat has it too, and its log takes it in from the chat before the life log
    // syncs (as when it opens: the main data first).
    cloud.hook = (_op: string, path: string) => {
      if (current === 'laptop' && String(path).includes('/life')) throw Object.assign(new Error('offline'), { code: 'unavailable' });
    };
    await on(b, () => b.SYNC.syncNow());
    await settle(b);
    // Meanwhile the Player deletes it on the phone (Delete from your log).
    await on(a, () => a.I.deleteCoachQuestion(`arise:chat:${asked}`));
    await settle(a);
    await on(b, () => b.I.ingestNow());
    expect(await titles(b)).toEqual([q]);
    cloud.hook = null;
    await reopen(b);
    await reopen(a);
    expect(await titles(b)).toEqual([]);
    expect(await titles(a)).toEqual([]);
    // The laptop opens again: its log doesn't take it in from the chat again.
    const b2 = await device('laptop');
    await on(b2, () => b2.I.ingestNow());
    expect(await titles(b2)).toEqual([]);
    await reopen(b2);
    await reopen(a);
    expect(await titles(a)).toEqual([]);
  });

  it('of everything (Delete everything) empties every device and the cloud', async () => {
    const { a, b } = await pair([song('1', '2026-09-05T09:00'), song('2', '2026-10-05T09:00')]);
    await on(b, () => b.M.addFact('I like jazz.'));
    await settle(b);
    await reopen(a);
    expect(await facts(a)).toEqual(['I like jazz.']);
    await on(a, () => a.L.eraseAll({ everywhere: true }));
    await settle(a);
    // Only the key, the index and the memory's pack (with the wipe) are left in the cloud.
    expect(lifeDocs()).toHaveLength(3);
    await reopen(b);
    expect(await titles(b)).toEqual([]);
    expect(await facts(b)).toEqual([]);
    // Something new afterwards syncs as usual.
    await add(b, [note('n', '2026-10-17T08:00', 'After the wipe')]);
    await reopen(a);
    expect(await titles(a)).toEqual(['After the wipe']);
  });
});

describe('what Arise knows', () => {
  it("brings a day's summary and what the AI learned to the other device, and deleting that day's log takes them away everywhere", async () => {
    const { a, b } = await pair();
    ai.engine = 'private';
    ai.answer = { json: { summary: 'You listened to three songs.', facts: [{ op: 'add', id: '', text: 'You like music in the morning.' }] } };
    // (The day, and its week, which is over.)
    expect(await on(a, () => a.M.learn({ days: ['2026-10-05'] }))).toBeGreaterThanOrEqual(1);
    ai.engine = null;
    await settle(a);
    await reopen(b);
    expect(await on(b, () => b.M.summaryFor('day', '2026-10-05')?.text)).toBe('You listened to three songs.');
    expect(await facts(b)).toEqual(['You like music in the morning.']);
    // The phone deletes Spotify: the songs, that day's summary and the fact learned only from it go.
    await on(a, async () => {
      const { days } = await a.L.deleteWhereDays({ source: 'spotify' });
      await a.M.forgetDays(days);
    });
    await settle(a);
    await reopen(b);
    expect(await titles(b)).toEqual([]);
    expect(await on(b, () => b.M.summaryFor('day', '2026-10-05'))).toBeNull();
    expect(await facts(b)).toEqual([]);
  });

  it("keeps the Player's newest change to a fact, and the choice to stop learning, on every device", async () => {
    const { a, b } = await pair([]);
    await on(a, () => a.M.addFact('I run on Sundays.'));
    await settle(a);
    await reopen(b);
    expect(await facts(b)).toEqual(['I run on Sundays.']);
    // The phone deletes it; the laptop, offline, had edited it after that: the edit wins.
    const id = (await on(a, () => a.M.allFacts()))[0].id;
    await on(a, () => a.M.deleteFact(id));
    await settle(a);
    await new Promise((r) => setTimeout(r, 5));
    await on(b, () => b.LIFE.stop());
    await on(b, () => b.M.editFact(id, 'I run on Saturdays.'));
    await reopen(b);
    await reopen(a);
    expect(await facts(a)).toEqual(['I run on Saturdays.']);
    // Deleted on the laptop now: gone on the phone too.
    await on(b, () => b.M.deleteFact(id));
    await settle(b);
    await reopen(a);
    expect(await facts(a)).toEqual([]);

    await on(a, () => a.P.setPrefs({ paused: true }));
    await settle(a);
    await reopen(b);
    expect(await on(b, () => b.P.prefs().paused)).toBe(true);
    // "Let less private AIs read my life log" stays on each device.
    await on(a, () => a.P.setPrefs({ lessPrivate: true }));
    await settle(a);
    await reopen(b);
    expect(await on(b, () => b.P.prefs().lessPrivate)).toBe(false);
  });
});

describe('what Arise knows, wiped', () => {
  it('on another device stops the learning here, so nothing it was about to write comes back', async () => {
    const { a, b } = await pair();
    ai.engine = 'private';
    // The laptop's AI is summing up a day...
    const answer = { json: { summary: 'You listened to three songs.', facts: [{ op: 'add', id: '', text: 'You like music in the morning.' }] } };
    let reply: ((v: unknown) => void) | null = null;
    ai.answer = { then: (ok: (v: unknown) => void) => (reply ? ok(answer) : (reply = ok)) };
    const learning = on(b, () => b.M.learn({ days: ['2026-10-05'] }));
    await vi.waitFor(() => expect(reply).not.toBeNull());
    // ...when the phone forgets what Arise learned, and the laptop takes that in.
    await on(a, () => a.M.eraseMemory());
    await settle(a);
    await reopen(b);
    reply!(answer);
    await on(b, () => learning);
    ai.engine = null;
    expect(await on(b, () => b.M.summaryFor('day', '2026-10-05'))).toBeNull();
    expect(await facts(b)).toEqual([]);
    await settle(b);
    await reopen(a);
    expect(await facts(a)).toEqual([]);
    expect(await on(a, () => a.M.reload().then(() => a.M.summaryFor('day', '2026-10-05')))).toBeNull();
  });
});

describe('a big month', () => {
  it('goes up in parts of at most 700,000 characters, and fewer parts when it shrinks', async () => {
    const a = await device('phone');
    // Text that hardly compresses, about 1.6 million characters in all: more than one document.
    const noise = (n: number) => Array.from({ length: n }, () => Math.random().toString(36).slice(2)).join('');
    const many = Array.from({ length: 400 }, (_, i) => ({ ...note(`x${i}`, `2026-10-${String(1 + (i % 28)).padStart(2, '0')}T12:00`, `Note ${i}`), detail: noise(380).slice(0, 3900) }));
    await on(a, () => a.L.addEvents(many));
    await signUp(a);
    const parts = () => [...cloud.docs].filter(([p]) => /\/life\/[A-Za-z0-9_-]{43}$/.test(p));
    expect(parts().length).toBeGreaterThanOrEqual(2);
    for (const [, d] of parts()) expect((d.ct as string).length).toBeLessThanOrEqual(700_000);
    const b = await device('laptop');
    await signIn(b);
    expect((await titles(b)).length).toBe(400);
    await on(a, () => a.L.removeIds(many.slice(10).map((e) => e.id)));
    await settle(a);
    expect(parts()).toHaveLength(1); // the extra parts are deleted
    await reopen(b);
    expect((await titles(b)).length).toBe(10);
  });
});

describe('accounts', () => {
  it('sign out: the life log stays here and nothing more goes up; signing back in carries on', async () => {
    const { a, b } = await pair();
    await on(a, () => a.SYNC.handleAction('sync-out'));
    expect(a.LIFE.lines().main).toBe('On this device only. Sign in to sync it.');
    const before = cloudText();
    await add(a, [note('late', '2026-10-08T09:00', 'Written while signed out')]);
    expect(await titles(a)).toContain('Written while signed out');
    expect(cloudText()).toBe(before);
    await signIn(a);
    await reopen(b);
    expect(await titles(b)).toContain('Written while signed out');
  });

  it("on a shared device, another account never gets the life log of the one before", async () => {
    // Alice uses the tablet for her life log only (nothing else in the app), then signs out.
    const t = await device('tablet');
    await on(t, () => t.L.addEvents([note('alice', '2026-10-05T09:00', "Alice's private note")]));
    await signUp(t, { email: 'alice@example.com' });
    await on(t, () => t.SYNC.handleAction('sync-code-done'));
    await on(t, () => t.SYNC.handleAction('sync-out'));
    const bob = await device('phone');
    await on(bob, () => bob.L.addEvents([note('bob', '2026-10-06T09:00', "Bob's note")]));
    await signUp(bob, { email: 'bob@example.com' });

    // Bob signs in on the tablet: he's asked first, and Cancel changes nothing.
    const ask = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await on(t, () => t.SYNC.submit('in', { id: 'bob@example.com', password: PW }));
    expect(ask.mock.calls.map((c) => c[0])).toEqual(['This device has data from another account. Replace it with the data of bob@example.com? The other account keeps all of it in its cloud copy.']);
    expect(t.SYNC.status.user).toBeNull();
    expect(await titles(t)).toEqual(["Alice's private note"]);
    // OK: the tablet has Bob's life log, and none of Alice's goes into his account.
    ask.mockReturnValue(true);
    await signIn(t, 'bob@example.com');
    expect(await titles(t)).toEqual(["Bob's note"]);
    await reopen(bob);
    expect(await titles(bob)).toEqual(["Bob's note"]);
    // Alice's stays in her account.
    const c = await device('laptop');
    await signIn(c, 'alice@example.com');
    expect(await titles(c)).toEqual(["Alice's private note"]);
  });

  it("when the life log can't be removed, nothing else is, and the Player is told", async () => {
    const t = await device('tablet');
    await on(t, () => t.L.addEvents([note('alice', '2026-10-05T09:00', "Alice's private note")]));
    await signUp(t, { email: 'alice@example.com' });
    await on(t, () => t.SYNC.handleAction('sync-code-done'));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    // Sign out and remove the data, just as the life log's database fails.
    const undo = failDB(['events', 'kv', 'tomb']);
    await on(t, () => t.SYNC.handleAction('sync-out-clear'));
    undo();
    expect(t.SYNC.status.error).toMatch(/^Your life log couldn't be removed from this device, so nothing else was either\./);
    expect(t.SYNC.status.user?.id).toBe('alice@example.com');
    expect(await titles(t)).toEqual(["Alice's private note"]);
    // "Erase all data" too.
    const undo2 = failDB(['events', 'kv', 'tomb']);
    await expect(on(t, () => t.SYNC.eraseThisDevice())).rejects.toThrow(/life log couldn't be removed/);
    undo2();
    expect(t.SYNC.status.user?.id).toBe('alice@example.com');
    expect(await titles(t)).toEqual(["Alice's private note"]);
    // Once it works, it all goes.
    await on(t, () => t.SYNC.handleAction('sync-out-clear'));
    expect(t.SYNC.status.user).toBeNull();
    expect(await titles(t)).toEqual([]);
  });

  it("never sends a life log that synced with another account, even when the device has forgotten whose it was", async () => {
    const t = await device('tablet');
    await on(t, () => t.L.addEvents([note('alice', '2026-10-05T09:00', "Alice's private note")]));
    await signUp(t, { email: 'alice@example.com' });
    await on(t, () => t.SYNC.handleAction('sync-code-done'));
    await on(t, () => t.SYNC.handleAction('sync-out'));
    // The main data and whose it was are gone, but the life log stayed (removing it failed with an
    // older version, say).
    await on(t, () => {
      t.S.resetAll();
      localStorage.removeItem('arise-sync');
    });
    const bob = await device('phone');
    await signUp(bob, { email: 'bob@example.com' });
    const uid = bob.SYNC.status.user!.uid;
    const ask = vi.spyOn(window, 'confirm');
    await signIn(t, 'bob@example.com');
    expect(ask).not.toHaveBeenCalled(); // nobody's data, as far as the main data knows
    await reopen(t);
    expect(t.LIFE.status.otherAccount).toBe(true);
    expect(t.LIFE.lines().note).toMatch(/belongs to another account, so it isn't synced/);
    await reopen(bob);
    expect(await titles(bob)).toEqual([]);
    expect(lifeDocs(uid).filter((id) => id !== 'key' && id !== 'index')).toEqual([]);
  });

  it("asks before another account's data takes the place of a life log it can't read", async () => {
    const t = await device('tablet');
    await on(t, () => t.L.addEvents([note('alice', '2026-10-05T09:00', "Alice's private note")]));
    await signUp(t, { email: 'alice@example.com' });
    await on(t, () => t.SYNC.handleAction('sync-code-done'));
    await on(t, () => t.SYNC.handleAction('sync-out'));
    const bob = await device('phone');
    await signUp(bob, { email: 'bob@example.com' });
    const ask = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const undo = failDB(['events', 'summaries', 'facts']);
    await on(t, () => t.SYNC.submit('in', { id: 'bob@example.com', password: PW }));
    undo();
    expect(ask.mock.calls.map((c) => c[0])).toEqual([
      'This device has data from another account. Replace it with the data of bob@example.com? Its life log (Your days and what Arise learned) is only on this device, so that would be deleted for good. The other account keeps the rest in its cloud copy.',
    ]);
    expect(t.SYNC.status.user).toBeNull();
    expect(await titles(t)).toEqual(["Alice's private note"]);
  });

  it("goes into a new account made on this device when the Player copies this device's data into it", async () => {
    const t = await device('tablet');
    await on(t, () => t.L.addEvents([note('alice', '2026-10-05T09:00', "Alice's private note")]));
    await signUp(t, { email: 'alice@example.com' });
    await on(t, () => t.SYNC.handleAction('sync-code-done'));
    await on(t, () => t.SYNC.handleAction('sync-out'));
    // Cancel: "copy this device's data into your new account instead".
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    await signUp(t, { email: 'new@example.com' });
    await reopen(t);
    expect(t.LIFE.status.otherAccount).toBe(false);
    const c = await device('laptop');
    await signIn(c, 'new@example.com');
    expect(await titles(c)).toEqual(["Alice's private note"]);
  });

  it('deleting the account deletes the life log in the cloud too, and nothing goes up again', async () => {
    const { a } = await pair();
    expect(lifeDocs().length).toBeGreaterThan(2);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await on(a, () => a.SYNC.submit('delete', { password: PW }));
    expect(a.SYNC.status.error).toBe('');
    expect(cloud.docs.size).toBe(0);
    await add(a, [note('after', '2026-10-09T09:00', 'After deleting')]);
    await on(a, () => a.LIFE.syncNow());
    expect(cloud.docs.size).toBe(0);
    expect(await titles(a)).toContain('Listened to song 1'); // this device keeps its life log
  });

  it('a device signed out because the account was deleted elsewhere sends nothing up', async () => {
    const { a, b } = await pair();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await on(a, () => a.SYNC.submit('delete', { password: PW }));
    await on(b, () => b.L.addEvents([note('late', '2026-10-09T09:00', 'Late')]));
    await reopen(b);
    expect(b.SYNC.status.user).toBeNull();
    expect(cloud.docs.size).toBe(0);
    expect(await titles(b)).toContain('Late');
  });

  it('"Erase all data" empties the life log here, and the cloud keeps it', async () => {
    const { a } = await pair();
    const before = lifeDocs();
    await on(a, () => a.SYNC.eraseThisDevice());
    expect(await titles(a)).toEqual([]);
    expect(lifeDocs()).toEqual(before);
    const c = await device('tablet');
    await signIn(c);
    expect(await titles(c)).toEqual(['Listened to song 1', 'Listened to song 2', 'Listened to song 3']);
  });

  it('works with Email reset, with an account code, and after a password change', async () => {
    // Email reset: synced, but not end-to-end encrypted (the key is in the cloud), and it says so.
    const a = await device('phone');
    await on(a, () => a.L.addEvents([song('1')]));
    await signUp(a, { way: 'email' });
    expect(a.LIFE.lines().main).toBe('Synced between your devices, encrypted.');
    await on(a, () => a.SYNC.submit('password', { old: PW, password: 'another long password', password2: 'another long password' }));
    const b = await device('laptop');
    await signIn(b, EMAIL, 'another long password');
    expect(await titles(b)).toEqual(['Listened to song 1']);

    // No email: an account code.
    const c = await device('tablet');
    await on(c, () => c.L.addEvents([song('2')]));
    c.SYNC.status.noEmail = true;
    await on(c, () => c.SYNC.submit('up', { password: PW, password2: PW }));
    await settle(c);
    const code = c.SYNC.status.pending!.accountCode!;
    const d = await device('desktop');
    await signIn(d, code);
    expect(await titles(d)).toEqual(['Listened to song 2']);
  });
});

describe('before the new database rules are live', () => {
  it('keeps the life log here, says so in one line, and sends it once the server takes it', async () => {
    const refuse = (_op: string, path: string) => {
      if (String(path).includes('/life/')) throw Object.assign(new Error('permission-denied'), { code: 'permission-denied' });
    };
    cloud.hook = refuse;
    const a = await device('phone');
    await on(a, () => a.L.addEvents([song('1')]));
    await signUp(a);
    expect(cloud.docs.has('users/uid1/arise/meta')).toBe(true); // the rest syncs as before
    expect(lifeDocs()).toEqual([]);
    expect(a.LIFE.status.needsServer).toBe(true);
    expect(a.LIFE.lines().note).toBe('Syncing your life log needs an update on the server.');
    const screens = await on(a, () => import('./screens.js'));
    expect(screens.settingsPanel()).toContain('Syncing your life log needs an update on the server.');
    expect(await on(a, () => a.LIFE.unsynced('uid1'))).toBe(true);
    expect(await titles(a)).toEqual(['Listened to song 1']);
    // Trying again doesn't change that, until the rules are live.
    await reopen(a);
    expect(a.LIFE.status.needsServer).toBe(true);
    cloud.hook = null;
    await reopen(a);
    expect(a.LIFE.status.needsServer).toBe(false);
    expect(a.LIFE.lines().note).toBe('');
    const b = await device('laptop');
    await signIn(b);
    expect(await titles(b)).toEqual(['Listened to song 1']);
  });

  it("still deletes the account (there's no life log in the cloud to delete then)", async () => {
    cloud.hook = (_op: string, path: string) => {
      if (String(path).includes('/life')) throw Object.assign(new Error('permission-denied'), { code: 'permission-denied' });
    };
    const a = await device('phone');
    await on(a, () => a.L.addEvents([song('1')]));
    await signUp(a);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await on(a, () => a.SYNC.submit('delete', { password: PW }));
    expect(a.SYNC.status.error).toBe('');
    expect(cloud.docs.size).toBe(0);
  });
});

describe('versions', () => {
  it("leaves a life log synced by a newer version of Arise alone, and updates first", async () => {
    const { a, b } = await pair();
    // A newer version wrote the index (life schema 2).
    const index = await on(a, async () => {
      const seal = await import('./seal');
      const dk = (await a.A.deviceKey('uid1'))!;
      const k = cloud.docs.get('users/uid1/life/key')!;
      const keys = await seal.openLifeKey(dk, 'uid1', { iv: k.iv as string, ct: k.ct as string });
      const old = cloud.docs.get('users/uid1/life/index')!;
      const packs = JSON.parse(await seal.openIndex(keys, 'uid1', { iv: old.iv as string, ct: old.ct as string })).packs;
      const s = await seal.sealIndex(keys, 'uid1', JSON.stringify({ v: 1, schema: 2, packs }));
      return { v: 1, iv: s.iv, ct: s.ct, updated: Date.now() };
    });
    cloud.docs.set('users/uid1/life/index', index);
    const before = cloudText();
    await add(b, [note('n', '2026-10-09T09:00', 'Not sent yet')]);
    await reopen(b);
    expect(b.LIFE.status.newer).toBe(true);
    expect(b.updates).toBeGreaterThan(0);
    expect(b.LIFE.lines().note).toMatch(/newer version of Arise/);
    expect(cloudText()).toBe(before);
    expect(await titles(b)).toContain('Not sent yet');
  });
});
