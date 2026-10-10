// @vitest-environment jsdom
// Sharing a goal's progress with a friend, end to end: simulated devices (each its own copy of the
// app's modules and its own storage) and one in-memory cloud that enforces the database rules,
// shares/ included. What the page holds, the link's flows, keeping it up to date, and the rules.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cloud, resetCloud, restFetch } from './test/fake-firebase';
import * as C from './lib/crypto';
import * as L from './lib/share';

vi.mock('./lib/firebase', () => import('./test/fake-firebase'));
// Fewer key-stretching rounds, so the tests run in seconds. The real count is tested in crypto.test.ts.
vi.mock('./lib/crypto', async (orig) => {
  const real = await orig<typeof import('./lib/crypto')>();
  return { ...real, deriveMaster: (p: string, id: string) => real.deriveMaster(p, id, 1000) };
});

type FB = typeof import('./test/fake-firebase');
interface Device {
  S: typeof import('./store');
  SYNC: typeof import('./sync');
  SHARE: typeof import('./share');
  FB: FB; // this device's Firebase, as signed in on it
  name: string;
}

const storage = new Map<string, Map<string, string>>();
let current = '';
const devices: Device[] = [];

function use(name: string) {
  if (current) storage.set(current, new Map(Object.entries({ ...localStorage })));
  localStorage.clear();
  for (const [k, v] of storage.get(name) || []) localStorage.setItem(k, v);
  current = name;
}

// A device signed up (or signed in) to `email`.
async function device(name: string, email: string, { signIn = false } = {}): Promise<Device> {
  use(name);
  vi.resetModules();
  const S = await import('./store');
  const SYNC = await import('./sync');
  const SHARE = await import('./share');
  await SYNC.initSync({ render: () => {}, changed: () => {}, checkForUpdate: () => {} });
  SHARE.initSharing();
  if (signIn) await SYNC.submit('in', { id: email, password: PW });
  else await SYNC.submit('up', { email, password: PW, password2: PW });
  expect(SYNC.status.error).toBe('');
  const FB = (await import('./lib/firebase')) as unknown as FB;
  const d = { S, SYNC, SHARE, FB, name };
  devices.push(d);
  return d;
}
const on = async <T>(d: Device, fn: () => Promise<T> | T): Promise<T> => {
  use(d.name);
  return fn();
};

const PW = 'correct horse battery';
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// Learn Spanish (shared), with two daily quests, a measure, milestones; and a goal that isn't.
function spanish(S: Device['S']) {
  S.saveGoal({
    id: 'g1',
    title: 'Learn Spanish',
    category: 'learning',
    why: 'My partner is from Madrid',
    by: 'June 2027',
    created: daysAgo(40),
    quests: [
      { id: 'q1', title: 'Study', schedule: { kind: 'daily' }, created: daysAgo(40), how: 'secret how note' },
      { id: 'q2', title: 'Flashcards', schedule: { kind: 'daily' }, created: daysAgo(40) },
    ],
    measures: [{ id: 'm1', name: 'Test score', unit: '%', target: 90, better: 'up' }],
    milestones: [
      { id: 's1', title: 'Pass A2', done: daysAgo(3) },
      { id: 's2', title: 'Pass B1', due: '2027-01-01' },
    ],
  });
  S.saveGoal({ id: 'g2', title: 'Hidden other goal', category: 'money', created: daysAgo(40), quests: [{ id: 'q9', title: 'Secret quest', schedule: { kind: 'daily' }, created: daysAgo(40) }] });
  for (let i = 1; i <= 5; i++) {
    S.tick('q1', { done: true }, daysAgo(i));
    S.tick('q2', { done: i !== 2 }, daysAgo(i));
    S.tick('q9', { done: true }, daysAgo(i));
  }
  S.logValue('m1', 72, daysAgo(1));
}

// The page in the cloud, opened as the friend opens it.
async function page(ref: { id: string; key: string }) {
  const sealed = await L.fetchShare(ref.id, { projectId: 'p', apiKey: 'k' }, restFetch as typeof fetch);
  return sealed && L.openSnapshot(ref, sealed);
}
// The same, before any checking: exactly what was sent.
async function raw(ref: { id: string; key: string }) {
  const d = cloud.docs.get(`shares/${ref.id}`) as { iv: string; ct: string };
  return C.open(await C.linkKey(ref.key), d, `share/${ref.id}`);
}
// What a page becomes once its link is off: nothing in it, for good.
const off = (ref: { id: string }) => cloud.docs.get(`shares/${ref.id}`);
const OFF = { v: 1, off: true };
const unavailable = () => Object.assign(new Error('unavailable'), { code: 'unavailable' });
// A page someone else seals with a link's key, as if it were the Player's.
const forged = (owner: string, sealed: C.Sealed) => ({ owner, iv: sealed.iv, ct: sealed.ct, v: 1, updated: Date.now() });
const fake = (): L.Snapshot => ({ v: 1, title: 'I gave up', area: 'Learning', status: 'active', name: 'Akbar', streak: 0, quests: [], from: today(), days: 't', measures: [], milestones: [], milestonesOf: 0, updated: Date.now() });

// Lets the cloud and the encryption finish (timers are simulated, so nothing fires by itself):
// until `until` holds (for up to 5 seconds), or for a moment.
const settle = async (until?: () => boolean) => {
  const end = Date.now() + (until ? 5000 : 100);
  while (Date.now() < end && !until?.()) await new Promise((r) => setImmediate(r));
};

beforeEach(() => {
  resetCloud();
  storage.clear();
  current = '';
  localStorage.clear();
  document.body.innerHTML = '<div id="sheet" hidden><div class="sheet-panel"><button class="sheet-close"></button><div class="sheet-body"></div></div></div><div id="toast"></div><main id="app"></main><nav id="tabs"></nav>';
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  for (const d of devices.splice(0)) d.SYNC.status.user = null;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('what a friend sees', () => {
  it("holds only this goal's progress: never the journal, the chat, other goals, body data or the account", async () => {
    const a = await device('phone', 'me@example.com');
    spanish(a.S);
    a.S.setLog(daysAgo(1), { t: 'my secret journal entry' });
    a.S.state.ai.chat.push({ role: 'user', text: 'a secret chat with the coach', at: 1 });
    a.S.addBodyEntry({ weight: 83.4, waist: 91.2 });
    a.S.state.settings.name = 'Akbar Juraev';
    a.S.save();

    const ref = (await a.SHARE.start('g1'))!;
    const doc = cloud.docs.get(`shares/${ref.id}`)!;
    expect(Object.keys(doc).sort()).toEqual(['ct', 'iv', 'owner', 'updated', 'v']);
    expect(doc).toMatchObject({ owner: 'uid1', v: 1 });
    // The server can't read it.
    expect(JSON.stringify(doc)).not.toContain('Spanish');

    const text = await raw(ref);
    const snap = JSON.parse(text);
    expect(Object.keys(snap).every((k) => (L.SNAPSHOT_FIELDS as readonly string[]).includes(k))).toBe(true);
    for (const secret of ['secret journal', 'secret chat', 'Hidden other goal', 'Secret quest', 'q9', '83.4', '91.2', 'me@example.com', 'uid1', 'Madrid', 'June 2027', 'secret how note', 'Akbar', 'Juraev', 'Pass B1', ref.key]) {
      expect(text, secret).not.toContain(secret);
    }
    expect(snap).toMatchObject({
      v: 1,
      title: 'Learn Spanish',
      area: 'Learning',
      status: 'active',
      quests: [
        { title: 'Study', when: 'every day', streak: 5 },
        { title: 'Flashcards', when: 'every day', streak: 1 },
      ],
      measures: [{ name: 'Test score', unit: '%', value: 72, on: daysAgo(1), target: 90 }],
      milestones: [{ title: 'Pass A2', done: daysAgo(3) }],
      milestonesOf: 2,
    });
    expect(snap.name).toBeUndefined();
    // The last 28 days, for this goal: Flashcards was missed two days ago, today isn't over.
    expect(snap.from).toBe(daysAgo(27));
    expect(snap.days).toHaveLength(28);
    expect(snap.days.slice(-6)).toBe('dddmdt');
    expect(snap.days.slice(0, 22)).toBe('m'.repeat(22));
    expect(snap.streak).toBe(a.S.currentStreak());
  });

  it('shows the first name only, and only when the Player chooses to', async () => {
    const a = await device('phone', 'me@example.com');
    spanish(a.S);
    a.S.state.settings.name = '  Akbar Juraev ';
    a.S.save();
    const ref = (await a.SHARE.start('g1', { name: true }))!;
    expect((await page(ref))!.name).toBe('Akbar');
    expect(await a.SHARE.showName('g1', false)).toBe(true);
    expect((await page(ref))!.name).toBeUndefined();
    expect(a.S.goalById('g1')!.share).toEqual({ id: ref.id, key: ref.key, at: ref.at });
  });

  it("says the name is off only once the page says so, and what went wrong when it couldn't", async () => {
    const a = await device('phone', 'me@example.com');
    spanish(a.S);
    a.S.state.settings.name = 'Akbar';
    a.S.save();
    const ref = (await a.SHARE.start('g1', { name: true }))!;
    // Offline: the choice is saved, but the page still shows the name, and the caller hears why.
    cloud.hook = (_op, path) => {
      if (String(path).includes('shares/')) throw unavailable();
    };
    await expect(a.SHARE.showName('g1', false)).rejects.toMatchObject({ message: "Couldn't reach the cloud. Check your internet connection and try again." });
    expect(a.S.goalById('g1')!.share!.name).toBeUndefined();
    expect(a.SHARE.note(ref.id).error).toBe("Couldn't reach the cloud. Check your internet connection and try again.");
    cloud.hook = null;
    expect((await page(ref))!.name).toBe('Akbar');
    // Online again: trying again takes it off, and the error goes.
    expect(await a.SHARE.updatePage('g1')).toBe(true);
    expect((await page(ref))!.name).toBeUndefined();
    expect(a.SHARE.note(ref.id).error).toBeUndefined();
    // A link turned off meanwhile on another device: nothing to update, and nothing claimed.
    await a.FB.setDoc(a.FB.doc({}, 'shares', ref.id), OFF);
    expect(await a.SHARE.showName('g1', true)).toBe(false);
    expect(a.S.goalById('g1')!.share).toBeUndefined();
  });

  it("starts with a new goal's first day, not 28 days back", async () => {
    const a = await device('phone', 'me@example.com');
    a.S.saveGoal({ id: 'g1', title: 'Read more', category: 'mind', created: daysAgo(2), quests: [{ id: 'q1', title: 'Read', schedule: { kind: 'daily' }, created: daysAgo(2) }] });
    a.S.tick('q1', { done: true }, daysAgo(2));
    a.S.tick('q1', { done: true }, today());
    const ref = (await a.SHARE.start('g1'))!;
    expect(await page(ref)).toMatchObject({ from: daysAgo(2), days: 'dmd' });
  });
});

describe('sharing, step by step', () => {
  it('needs an account', async () => {
    use('phone');
    vi.resetModules();
    const S = await import('./store');
    const SHARE = await import('./share');
    spanish(S);
    await expect(SHARE.start('g1')).rejects.toMatchObject({ code: 'signed-out' });
    expect(S.goalById('g1')!.share).toBeUndefined();
    expect([...cloud.docs.keys()].filter((p) => p.startsWith('shares/'))).toEqual([]);
  });

  it('makes a link whose page any device of the account keeps up to date', async () => {
    const a = await device('phone', 'me@example.com');
    spanish(a.S);
    const ref = (await a.SHARE.start('g1'))!;
    expect(a.S.goalById('g1')!.share).toEqual(ref);
    await a.SYNC.syncNow();

    // The laptop gets the link with the goal, and its changes reach the page soon after it syncs.
    const b = await device('laptop', 'me@example.com', { signIn: true });
    expect(b.S.goalById('g1')!.share).toEqual(ref);
    const before = cloud.docs.get(`shares/${ref.id}`)!.updated;
    b.S.tick('q1', { done: true });
    b.S.tick('q2', { done: true });
    await b.SYNC.syncNow();
    vi.advanceTimersByTime(1500);
    await settle(() => cloud.docs.get(`shares/${ref.id}`)!.updated !== before);
    await settle();
    expect((await page(ref))!.days.slice(-1)).toBe('d');

    // And the phone, once it has synced, has them too and keeps the page as it is.
    await on(a, async () => {
      await a.SYNC.syncNow();
      expect(a.S.goalById('g1')!.share).toEqual(ref);
      await a.SHARE.refresh();
    });
    expect((await page(ref))!.days.slice(-1)).toBe('d');
  });

  it('stops: the page is turned off for good, the link stops working, and every device forgets it', async () => {
    const a = await device('phone', 'me@example.com');
    spanish(a.S);
    const ref = (await a.SHARE.start('g1'))!;
    await a.SYNC.syncNow();
    const b = await device('laptop', 'me@example.com', { signIn: true });
    expect(b.S.goalById('g1')!.share?.id).toBe(ref.id);

    await on(a, () => a.SHARE.stop('g1'));
    expect(off(ref)).toEqual(OFF);
    expect(await page(ref)).toBeNull();
    expect(a.S.goalById('g1')!.share).toBeUndefined();
    await on(a, () => a.SYNC.syncNow());
    await on(b, () => b.SYNC.syncNow());
    expect(b.S.goalById('g1')!.share).toBeUndefined();
  });

  it("a device that hasn't heard yet never brings a stopped link back, and forgets it", async () => {
    const a = await device('phone', 'me@example.com');
    spanish(a.S);
    const ref = (await a.SHARE.start('g1'))!;
    await a.SYNC.syncNow();
    const b = await device('laptop', 'me@example.com', { signIn: true });
    await on(a, async () => {
      await a.SHARE.stop('g1');
      await a.SYNC.syncNow();
    });
    // The laptop ticks something before it syncs: its page update finds the page gone.
    await on(b, async () => {
      b.S.tick('q1', { done: true });
      await b.SHARE.refresh();
      expect(off(ref)).toEqual(OFF);
      expect(b.S.goalById('g1')!.share).toBeUndefined();
      await b.SYNC.syncNow();
    });
    await on(a, () => a.SYNC.syncNow());
    expect(a.S.goalById('g1')!.share).toBeUndefined();
    expect(off(ref)).toEqual(OFF);
  });

  it('makes a new link: the old one stops working, the new one shows the same page', async () => {
    const a = await device('phone', 'me@example.com');
    spanish(a.S);
    a.S.state.settings.name = 'Akbar';
    const old = (await a.SHARE.start('g1', { name: true }))!;
    const ref = (await a.SHARE.newLink('g1'))!;
    expect(ref.id).not.toBe(old.id);
    expect(ref.key).not.toBe(old.key);
    expect(ref.name).toBe(true);
    expect(off(old)).toEqual(OFF);
    expect(await page(old)).toBeNull();
    expect(await page(ref)).toMatchObject({ title: 'Learn Spanish', name: 'Akbar' });
    expect(a.S.goalById('g1')!.share).toEqual(ref);
    // The old key can't open the new page either.
    await expect(page({ id: ref.id, key: old.key })).rejects.toMatchObject({ code: 'bad-data' });
  });

  it('turns the link off when the goal is deleted, and when the account is', async () => {
    const a = await device('phone', 'me@example.com');
    spanish(a.S);
    const one = (await a.SHARE.start('g1'))!;
    const two = (await a.SHARE.start('g2'))!;
    await a.SHARE.stop('g1');
    a.S.deleteGoal('g1');
    expect(off(one)).toEqual(OFF);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await a.SYNC.submit('delete', { password: PW });
    expect(a.SYNC.status.error).toBe('');
    expect(off(two)).toEqual(OFF);
    // All that's left of the account: the two empty pages, which keep its links off.
    expect([...cloud.docs.keys()].sort()).toEqual([`shares/${one.id}`, `shares/${two.id}`].sort());
    expect(JSON.stringify([...cloud.docs])).not.toContain('uid1');
  });

  it("turns off every page of the account when it's deleted, even ones this device never heard of", async () => {
    const a = await device('phone', 'me@example.com');
    spanish(a.S);
    await a.SYNC.syncNow();
    // The laptop makes a link and syncs; the phone hasn't synced since.
    const b = await device('laptop', 'me@example.com', { signIn: true });
    const fromLaptop = (await b.SHARE.start('g1'))!;
    await b.SYNC.syncNow();
    // Another account's page stays as it is.
    const c = await device('other', 'someone@example.com');
    spanish(c.S);
    const theirs = (await c.SHARE.start('g1'))!;
    await on(a, async () => {
      expect(a.S.goalById('g1')!.share).toBeUndefined();
      a.FB.restoreSession('uid1'); // (one sign-in for every simulated device: see two() below)
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      await a.SYNC.submit('delete', { password: PW });
      expect(a.SYNC.status.error).toBe('');
    });
    expect(off(fromLaptop)).toEqual(OFF);
    expect(await page(fromLaptop)).toBeNull();
    expect(await page(theirs)).toMatchObject({ title: 'Learn Spanish' });
    expect(JSON.stringify([...cloud.docs])).not.toContain('uid1');
  });

  it("doesn't delete the account while its pages can't be turned off", async () => {
    const a = await device('phone', 'me@example.com');
    spanish(a.S);
    const ref = (await a.SHARE.start('g1'))!;
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    cloud.hook = (op) => {
      if (op === 'getDocs') throw unavailable();
    };
    await a.SYNC.submit('delete', { password: PW });
    expect(a.SYNC.status.error).toBe("Couldn't reach the cloud, so deleting your account may not have finished. When you're online, enter your password again to finish it.");
    expect(cloud.users.has('uid1')).toBe(true);
    expect(await page(ref)).toMatchObject({ title: 'Learn Spanish' });
    // Online again, the password again: done.
    cloud.hook = null;
    await a.SYNC.submit('delete', { password: PW });
    expect(a.SYNC.status.error).toBe('');
    expect(cloud.users.has('uid1')).toBe(false);
    expect(off(ref)).toEqual(OFF);
  });
});

describe('keeping the page up to date', () => {
  it('waits until things are quiet, then sends one update with the latest', async () => {
    const a = await device('phone', 'me@example.com');
    spanish(a.S);
    const ref = (await a.SHARE.start('g1'))!;
    // (Sync is held back here, so only sharing's own wait counts.)
    a.SYNC.status.locked = true;
    let writes = 0;
    cloud.hook = (op, path) => {
      if (op === 'commit' && path.includes(`shares/${ref.id}`)) writes++;
    };

    a.S.tick('q1', { done: true });
    await settle();
    vi.advanceTimersByTime(9000);
    await settle();
    expect(writes).toBe(0);
    // Each change starts the wait again.
    a.S.tick('q2', { done: true });
    vi.advanceTimersByTime(9000);
    await settle();
    expect(writes).toBe(0);
    vi.advanceTimersByTime(1000);
    await settle(() => writes > 0);
    expect(writes).toBe(1);
    await settle();
    expect((await page(ref))!.days.slice(-1)).toBe('d');

    // Nothing to send for a change that isn't on the page: the journal, a setting, another goal's
    // measure.
    a.S.setLog(today(), { t: 'a note for me only' });
    a.S.state.settings.sound = false;
    a.S.save();
    a.S.saveGoal({ ...a.S.goalById('g2')!, measures: [{ id: 'm9', name: 'Saved', unit: '$', better: 'up' }] });
    a.S.logValue('m9', 500);
    vi.advanceTimersByTime(60_000);
    await settle();
    expect(writes).toBe(1);
    // But a change to this goal is.
    a.S.logValue('m1', 80);
    vi.advanceTimersByTime(10_000);
    await settle(() => writes > 1);
    expect(writes).toBe(2);
    expect((await page(ref))!.measures[0]).toMatchObject({ value: 80, on: today() });
  });

  it('waits, when asked, for a round that has the latest change', async () => {
    const a = await device('phone', 'me@example.com');
    spanish(a.S);
    const ref = (await a.SHARE.start('g1'))!;
    a.S.tick('q1', { done: true });
    a.S.tick('q2', { done: true });
    // This round read the goal before the next change, so asking again waits for one after it.
    const first = a.SHARE.refresh();
    a.S.logValue('m1', 95);
    await a.SHARE.refresh();
    expect((await page(ref))!.measures[0]).toMatchObject({ value: 95, on: today() });
    expect((await page(ref))!.days.slice(-1)).toBe('d');
    await first;
  });

  it('sends nothing while signed out', async () => {
    const a = await device('phone', 'me@example.com');
    spanish(a.S);
    const ref = (await a.SHARE.start('g1'))!;
    const before = cloud.docs.get(`shares/${ref.id}`)!.updated as number;
    a.S.tick('q1', { done: true });
    a.SYNC.status.user = null;
    vi.advanceTimersByTime(60_000);
    await settle();
    expect(cloud.docs.get(`shares/${ref.id}`)!.updated).toBe(before);
  });
});

describe('the database rules for shares', () => {
  // A page made by uid1, and a second account (uid2). The simulated Firebase has one sign-in for
  // every device, so `as` picks who is signed in for each request (null: nobody).
  async function two() {
    const a = await device('phone', 'me@example.com');
    spanish(a.S);
    const ref = (await a.SHARE.start('g1'))!;
    const b = await device('other', 'someone@example.com');
    const FB = a.FB;
    const as = async (uid: string | null) => (uid ? FB.restoreSession(uid) : FB.signOut());
    return { a, b, ref, FB, as, doc: cloud.docs.get(`shares/${ref.id}`)! };
  }
  const denied = expect.objectContaining({ code: 'permission-denied' });

  it('let anyone fetch one by its id, without signing in, but nobody list them', async () => {
    const { ref, FB, as } = await two();
    for (const uid of ['uid1', 'uid2', null]) {
      await as(uid);
      await expect(FB.getDocs(FB.collection({}, 'shares')), String(uid)).rejects.toEqual(denied);
      expect((await FB.getDoc(FB.doc({}, 'shares', ref.id))).exists()).toBe(true);
    }
    // And a browser that has never signed in at all, as a friend's.
    expect(await page(ref)).toMatchObject({ title: 'Learn Spanish' });
  });

  it('let only the account that made one change or delete it', async () => {
    const { ref, doc, FB, as } = await two();
    const r = FB.doc({}, 'shares', ref.id);
    await as('uid2');
    await expect(FB.setDoc(r, { ...doc, owner: 'uid2' })).rejects.toEqual(denied);
    await expect(FB.setDoc(r, { ...doc, ct: 'AAAA' })).rejects.toEqual(denied);
    await expect(FB.deleteDoc(r)).rejects.toEqual(denied);
    await as(null);
    await expect(FB.setDoc(r, doc)).rejects.toEqual(denied);
    await expect(FB.deleteDoc(r)).rejects.toEqual(denied);
    await expect(FB.setDoc(FB.doc({}, 'shares', 'D'.repeat(22)), doc)).rejects.toEqual(denied);
    expect(cloud.docs.get(`shares/${ref.id}`)).toEqual(doc);
  });

  it("don't let its owner give it to another account, or make one in another's name", async () => {
    const { ref, doc, FB, as } = await two();
    await as('uid1');
    await expect(FB.setDoc(FB.doc({}, 'shares', ref.id), { ...doc, owner: 'uid2' })).rejects.toEqual(denied);
    await expect(FB.setDoc(FB.doc({}, 'shares', 'B'.repeat(22)), { ...doc, owner: 'uid2' })).rejects.toEqual(denied);
    // The owner can update it, and turn it off, but never delete it.
    await FB.setDoc(FB.doc({}, 'shares', ref.id), { ...doc, updated: (doc.updated as number) + 1 });
    await expect(FB.deleteDoc(FB.doc({}, 'shares', ref.id))).rejects.toEqual(denied);
    await FB.setDoc(FB.doc({}, 'shares', ref.id), OFF);
    expect(off(ref)).toEqual(OFF);
  });

  it("never let a link that's off come back, with anyone's page behind it", async () => {
    // The Player shares with their name on, makes a new link, then stops sharing. Someone who
    // kept an old link makes an account of their own and seals a page with its key, to show
    // under the Player's name.
    const a = await device('phone', 'me@example.com');
    spanish(a.S);
    a.S.state.settings.name = 'Akbar';
    const first = (await a.SHARE.start('g1', { name: true }))!;
    const second = (await a.SHARE.newLink('g1'))!;
    await a.SHARE.stop('g1');
    await device('mallory', 'mallory@example.com');
    // (One sign-in for every simulated device: restoreSession picks who asks.)
    const FB = a.FB;
    for (const old of [first, second]) {
      const r = FB.doc({}, 'shares', old.id);
      const sealed = await L.sealSnapshot(old, fake());
      FB.restoreSession('uid2');
      await expect(FB.setDoc(r, forged('uid2', sealed))).rejects.toEqual(denied);
      await expect(FB.deleteDoc(r)).rejects.toEqual(denied);
      // Nor can the Player's own account bring it back, or free its id.
      FB.restoreSession('uid1');
      await expect(FB.setDoc(r, forged('uid1', sealed))).rejects.toEqual(denied);
      await expect(FB.deleteDoc(r)).rejects.toEqual(denied);
      await expect(FB.setDoc(r, OFF)).rejects.toEqual(denied);
      expect(off(old)).toEqual(OFF);
      expect(await page(old)).toBeNull();
    }
    // Where there never was a page, hers goes up: it's the page that's off that stops her.
    FB.restoreSession('uid2');
    const fresh = await L.newShareRef();
    await FB.setDoc(FB.doc({}, 'shares', fresh.id), forged('uid2', await L.sealSnapshot(fresh, fake())));
    expect(await page(fresh)).toMatchObject({ title: 'I gave up' });
  });

  it('let an account list only its own pages, and nobody list them all', async () => {
    const { ref, FB, as } = await two();
    const mine = (uid: string) => FB.getDocs(FB.query(FB.collection({}, 'shares'), FB.where('owner', '==', uid)));
    await as('uid1');
    expect((await mine('uid1')).docs.map((d) => d.id)).toEqual([ref.id]);
    await expect(mine('uid2')).rejects.toEqual(denied);
    await as(null);
    await expect(mine('uid1')).rejects.toEqual(denied);
  });

  it('only take the encrypted shape, within the size cap', async () => {
    const { doc, FB, as } = await two();
    await as('uid1');
    const r = FB.doc({}, 'shares', 'C'.repeat(22));
    for (const bad of [
      { ...doc, title: 'Learn Spanish' },
      { ...doc, v: 2 },
      { ...doc, ct: 'x'.repeat(20001) },
      { ...doc, iv: 'x'.repeat(25) },
      { ...doc, updated: 'today' },
      { owner: doc.owner, iv: doc.iv, ct: doc.ct, v: 1 },
      // Only base64: no plain text to host, and an IV of 12 bytes.
      { ...doc, ct: 'Learn Spanish, in plain text for anyone' },
      { ...doc, ct: `${doc.ct}\n` },
      { ...doc, iv: (doc.iv as string).slice(1) },
      { ...doc, iv: `${doc.iv}A` },
      // Off is empty: nothing else in it.
      { ...OFF, owner: doc.owner },
      { ...OFF, ct: doc.ct },
      { v: 1, off: false },
    ]) {
      await expect(FB.setDoc(r, bad), JSON.stringify(Object.keys(bad))).rejects.toEqual(denied);
    }
    await expect(FB.setDoc(FB.doc({}, 'shares', 'short'), doc)).rejects.toEqual(denied);
    await FB.setDoc(r, { ...doc, ct: 'x'.repeat(20000) });
    expect(cloud.docs.has(`shares/${'C'.repeat(22)}`)).toBe(true);
  });

  it('leave a page made by another account alone when its data joins this one', async () => {
    const { a, b, ref, doc, as } = await two();
    // The other account has this goal's link in its data now (say, from a backup): it may not
    // update the page, so it forgets the link, and the page stays as its owner left it.
    await as('uid2');
    const goal = a.S.goalById('g1');
    await on(b, async () => {
      b.S.importData({ sessions: [], goals: [goal] });
      expect(b.S.goalById('g1')!.share?.id).toBe(ref.id);
      b.S.tick('q1', { done: true });
      await b.SHARE.refresh();
      expect(b.S.goalById('g1')!.share).toBeUndefined();
    });
    expect(cloud.docs.get(`shares/${ref.id}`)).toEqual(doc);
    // Its "stop sharing" only forgets it too.
    await on(b, async () => {
      b.S.saveGoal({ ...b.S.goalById('g1')!, share: ref });
      await b.SHARE.stop('g1');
      expect(b.S.goalById('g1')!.share).toBeUndefined();
    });
    expect(cloud.docs.get(`shares/${ref.id}`)).toEqual(doc);
  });
});
