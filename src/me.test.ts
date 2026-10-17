// @vitest-environment jsdom
// Connected apps, end to end: a device signed in to an account, its memory (What Arise knows), and
// one in-memory cloud that enforces the database rules. What an app's me link holds, keeping it up
// to date, changing what it gets, turning it off, and what happens when the device is erased or
// the account deleted. Read back with the reader app makers use (public/me.js).

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cloud, resetCloud, restFetch } from './test/fake-firebase';
import { readMe } from '../public/me.js';
import { ABOUT_SECTIONS, aboutText, LINK_DEFAULT, SECTIONS } from './lib/me';
import type { LifeFact, LifeSummary } from './lib/validate';

vi.mock('./lib/firebase', () => import('./test/fake-firebase'));
// Fewer key-stretching rounds, so the tests run in seconds. The real count is tested in crypto.test.ts.
vi.mock('./lib/crypto', async (orig) => {
  const real = await orig<typeof import('./lib/crypto')>();
  return { ...real, deriveMaster: (p: string, id: string) => real.deriveMaster(p, id, 1000) };
});

const PW = 'correct horse battery';
const key = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const today = () => key(new Date());
const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return key(d);
};

// What Arise knows on this device: facts of each tier (one no longer true), and day summaries.
// `share`: how private each is to share with an app (memory.ts shareOf).
const FACTS: LifeFact[] = [
  { id: 'f1', text: 'You run before work most days.', since: '2026-09-01', from: 'ai', tier: 1, share: 1, sources: ['2026-09-01', '2026-09-02'], at: 1 },
  { id: 'f2', text: 'You love jazz.', since: '2026-09-03', from: 'ai', tier: 2, share: 2, sources: ['2026-09-03'], at: 1 },
  { id: 'f3', text: 'You look up knee pain most weeks.', since: '2026-09-05', from: 'ai', tier: 3, share: 3, sources: ['2026-09-05'], at: 1 },
  { id: 'f4', text: 'You smoke after lunch.', since: '2026-08-01', until: '2026-09-20', from: 'ai', tier: 2, share: 2, sources: ['2026-08-01'], at: 1 },
];
const sum = (k: string, text: string, tier: 1 | 2 | 3): LifeSummary => ({ id: `d:${k}`, kind: 'day', key: k, text, tier, share: tier, cap: 3, sig: 'x', n: 1, at: 1 });
const SUMMARIES = () => [sum(daysAgo(1), 'You ran 8 km and called your sister.', 3), sum(daysAgo(2), 'You watched Dark.', 2), sum(daysAgo(10), 'You went to the beach.', 2)];

async function putMemory(facts = FACTS, sums = SUMMARIES()) {
  vi.resetModules(); // the life log's database as this test has it, not the last one's
  const { open } = await import('./life/db');
  const db = await open();
  const tx = db.transaction(['facts', 'summaries'], 'readwrite');
  for (const f of facts) tx.objectStore('facts').put(f);
  for (const s of sums) tx.objectStore('summaries').put(s);
  await new Promise((r) => (tx.oncomplete = r));
  db.close();
}

type Device = {
  S: typeof import('./store');
  SYNC: typeof import('./sync');
  ME: typeof import('./me');
  M: typeof import('./life/memory');
  FB: typeof import('./test/fake-firebase');
};

// This device, signed up (or in) to `email`, with its goals: a half marathon (done the last 3
// days, not yet today) and a paused one.
async function device(email = 'me@example.com', { signIn = false } = {}): Promise<Device> {
  vi.resetModules();
  const S = await import('./store');
  const SYNC = await import('./sync');
  const ME = await import('./me');
  const M = await import('./life/memory');
  await SYNC.initSync({ render: () => {}, changed: () => {}, checkForUpdate: () => {} });
  ME.initMe();
  if (signIn) await SYNC.submit('in', { id: email, password: PW });
  else await SYNC.submit('up', { email, password: PW, password2: PW });
  expect(SYNC.status.error).toBe('');
  // (Sync is held back, so only the links' own wait counts.)
  SYNC.status.locked = true;
  const FB = (await import('./lib/firebase')) as unknown as Device['FB'];
  return { S, SYNC, ME, M, FB };
}

function goals(S: Device['S']) {
  S.state.settings.name = 'Sam Lee';
  S.saveGoal({ id: 'g1', title: 'Run a half marathon', category: 'fitness', why: 'Feel strong at 40', by: 'June 2027', created: daysAgo(10), quests: [{ id: 'q1', title: 'Run', how: 'secret how note', schedule: { kind: 'daily' }, created: daysAgo(10) }] });
  S.saveGoal({ id: 'g2', title: 'A paused goal', category: 'money', status: 'paused', created: daysAgo(10), quests: [] });
  for (let i = 1; i <= 3; i++) S.tick('q1', { done: true }, daysAgo(i));
  S.setLog(today(), { t: 'my private journal' });
}

const link = (l: { id: string; key: string }) => `https://abyyworld.github.io/physical-improvement-tracker-app/#me=${l.id}.${l.key}`;
const read = (l: { id: string; key: string }) => readMe(link(l), { fetch: restFetch as typeof fetch, projectId: 'p', apiKey: 'k' });
const page = (l: { id: string }) => cloud.docs.get(`shares/${l.id}`);
const OFF = { v: 1, off: true };
const texts = (me: { facts: { text: string }[] }) => me.facts.map((f) => f.text);

// Lets the cloud and the encryption finish (timers are simulated, so nothing fires by itself):
// until `until` holds (for up to 5 seconds), or for a moment.
const settle = async (until?: () => boolean) => {
  const end = Date.now() + (until ? 5000 : 100);
  while (Date.now() < end && !until?.()) await new Promise((r) => setImmediate(r));
};

beforeEach(() => {
  resetCloud();
  localStorage.clear();
  globalThis.indexedDB = new IDBFactory();
  document.body.innerHTML = '<div id="sheet" hidden><div class="sheet-panel"><button class="sheet-close"></button><div class="sheet-body"></div></div></div><div id="toast"></div><main id="app"></main><nav id="tabs"></nav>';
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  cloud.hook = null;
});

describe('connecting an app', () => {
  it('needs an account', async () => {
    vi.resetModules();
    const ME = await import('./me');
    await expect(ME.connect('Buddy', LINK_DEFAULT)).rejects.toMatchObject({ code: 'signed-out' });
    expect([...cloud.docs.keys()].filter((p) => p.startsWith('shares/'))).toEqual([]);
  });

  it('makes a link whose page holds only what was picked for that app', async () => {
    await putMemory();
    const a = await device();
    goals(a.S);
    const l = await a.ME.connect('  My buddy app ', LINK_DEFAULT);
    expect(a.ME.links()).toEqual([{ id: l.id, key: l.key, app: 'My buddy app', at: l.at, choice: LINK_DEFAULT, sig: expect.any(String), sent: expect.any(Number) }]);
    // The same shape as a shared goal's page, so the database rules take it as it is.
    const doc = page(l)!;
    expect(Object.keys(doc).sort()).toEqual(['ct', 'iv', 'owner', 'updated', 'v']);
    expect(doc).toMatchObject({ owner: a.SYNC.status.user!.uid, v: 1 });

    const me = await read(l);
    expect(me.name).toBe('Sam');
    expect(me.goals).toEqual([{ title: 'Run a half marathon', why: 'Feel strong at 40', streak: 3 }]);
    expect(texts(me)).toEqual(['I run before work most days.', 'I love jazz.']);
    expect(me.about).toContain("What I'm working toward:\n- Run a half marathon. Why: Feel strong at 40.");
    expect(me).not.toHaveProperty('today');
    expect(me).not.toHaveProperty('days');
    const all = JSON.stringify(me);
    for (const secret of ['knee', 'smoke', 'Lee', 'paused', 'secret how', 'journal', 'me@example.com', 'sister', 'Dark']) expect(all, secret).not.toContain(secret);

    // Another app, picked to get everything: sensitive things, today's quests and the last 7 days.
    const two = await a.ME.connect('Claude', { sections: [...SECTIONS], tier: 3 });
    const more = await read(two);
    expect(texts(more)).toEqual(['I run before work most days.', 'I look up knee pain most weeks.', 'I love jazz.']);
    expect(more.today).toEqual({ day: today(), quests: [{ title: 'Run', done: false }] });
    expect(more.days).toEqual([
      { day: daysAgo(1), text: 'I ran 8 km and called my sister.' },
      { day: daysAgo(2), text: 'I watched Dark.' },
    ]);
    expect(a.ME.links().map((x) => x.app)).toEqual(['My buddy app', 'Claude']);
  });

  // The AI reads Arise's own journal, weigh-ins and questions to the coach at tier 1, but what's
  // learned from them is no "goals only" or "nothing sensitive" for another app.
  it('goes by how private things are to share, not by what the AI may read', async () => {
    const fact = (id: string, text: string, share?: 1 | 2 | 3): LifeFact => ({ id, text, since: '2026-09-01', from: 'ai', tier: 1, ...(share ? { share } : {}), sources: ['2026-09-01'], at: 1 });
    const day = (k: string, text: string, share?: 1 | 2 | 3): LifeSummary => ({ id: `d:${k}`, kind: 'day', key: k, text, tier: 1, ...(share ? { share } : {}), cap: 3, sig: 'x', n: 1, at: 1 });
    await putMemory(
      [fact('f1', 'You run before work most days.', 1), fact('f2', 'You journal about long walks.', 2), fact('f3', 'You take sertraline.', 3), fact('f4', 'You have panic attacks before work meetings.')],
      [day(daysAgo(1), 'You ran.', 1), day(daysAgo(2), 'You wrote about a walk.', 2), day(daysAgo(3), 'You weighed in and asked the coach about sertraline.', 3), day(daysAgo(4), 'You felt low.')],
    );
    const a = await device();
    goals(a.S);
    const read3 = async (tier: 1 | 2 | 3) => read(await a.ME.connect(`Tier ${tier}`, { sections: [...SECTIONS], tier }));
    const one = await read3(1);
    expect(texts(one)).toEqual(['I run before work most days.']);
    expect(one.days).toEqual([{ day: daysAgo(1), text: 'I ran.' }]);
    const two = await read3(2);
    expect(texts(two)).toEqual(['I run before work most days.', 'I journal about long walks.']);
    expect(two.days!.map((d: { text: string }) => d.text)).toEqual(['I ran.', 'I wrote about a walk.']);
    for (const me of [one, two]) expect(JSON.stringify(me)).not.toMatch(/sertraline|panic|weighed|low/);
    const three = await read3(3);
    expect(texts(three)).toHaveLength(4);
    expect(three.days).toHaveLength(4);

    // So does the About me text.
    const about = (tier: 1 | 2 | 3) => aboutText(a.ME.sourceNow(), { sections: [...ABOUT_SECTIONS], tier });
    expect(about(2)).not.toMatch(/sertraline|panic/);
    expect(about(3)).toMatch(/sertraline/);
  });

  it("keeps each app's page its owner's: another account can't change it", async () => {
    const a = await device();
    goals(a.S);
    const l = await a.ME.connect('Buddy', LINK_DEFAULT);
    const before = page(l);
    const b = await device('other@example.com');
    await expect(b.FB.setDoc({ path: `shares/${l.id}` }, { owner: b.SYNC.status.user!.uid, iv: 'A'.repeat(16), ct: 'AAAA', v: 1, updated: 1 })).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(b.FB.setDoc({ path: `shares/${l.id}` }, OFF)).rejects.toMatchObject({ code: 'permission-denied' });
    expect(page(l)).toEqual(before);
  });
});

describe('keeping an app up to date', () => {
  it('waits until things are quiet, then sends one update, and only when what the app gets changed', async () => {
    await putMemory();
    const a = await device();
    goals(a.S);
    const l = await a.ME.connect('Buddy', LINK_DEFAULT);
    let writes = 0;
    cloud.hook = (op, path) => {
      if (op === 'commit' && path.includes(`shares/${l.id}`)) writes++;
    };

    // Something Arise learns, or the Player adds.
    await a.M.addFact('You like to stretch after runs.');
    await settle();
    vi.advanceTimersByTime(9000);
    await settle();
    expect(writes).toBe(0);
    vi.advanceTimersByTime(1000);
    await settle(() => writes > 0);
    expect(writes).toBe(1);
    await settle();
    expect(texts(await read(l))).toContain('I like to stretch after runs.');

    // Nothing to send for what the app doesn't get: the journal, a setting, a paused goal.
    a.S.setLog(today(), { t: 'another private note' });
    a.S.state.settings.sound = false;
    a.S.save();
    a.S.saveGoal({ ...a.S.goalById('g2')!, title: 'Renamed paused goal' });
    vi.advanceTimersByTime(60_000);
    await settle();
    expect(writes).toBe(1);

    // A quest done today is: the goal's streak goes up.
    a.S.tick('q1', { done: true });
    vi.advanceTimersByTime(10_000);
    await settle(() => writes > 1);
    expect(writes).toBe(2);
    await settle();
    expect((await read(l)).goals).toEqual([{ title: 'Run a half marathon', why: 'Feel strong at 40', streak: 4 }]);

    // A fact deleted goes from the page too.
    const fact = a.M.allFacts().find((f) => f.text === 'You love jazz.')!;
    await a.M.deleteFact(fact.id);
    vi.advanceTimersByTime(10_000);
    await settle(() => writes > 2);
    await settle();
    expect(texts(await read(l))).not.toContain('I love jazz.');

    // The app opens again: nothing has changed, so nothing is sent.
    const again = await device('me@example.com', { signIn: true });
    await again.ME.refresh();
    expect(writes).toBe(3);
  });

  it('sends nothing while signed out', async () => {
    const a = await device();
    goals(a.S);
    const l = await a.ME.connect('Buddy', LINK_DEFAULT);
    const before = page(l);
    a.SYNC.status.user = null;
    await a.M.addFact('You like mornings.');
    vi.advanceTimersByTime(60_000);
    await settle();
    expect(page(l)).toEqual(before);
  });

  it('changes what an app gets from now on', async () => {
    await putMemory();
    const a = await device();
    goals(a.S);
    const l = await a.ME.connect('Buddy', LINK_DEFAULT);
    expect(await a.ME.setChoice(l.id, { sections: ['goals'], tier: 1 })).toBe(true);
    const me = await read(l);
    expect(me).toEqual({ format: 'arise.me/v1', about: "What I'm working toward:\n- Run a half marathon. Why: Feel strong at 40.", facts: [], goals: [{ title: 'Run a half marathon', why: 'Feel strong at 40', streak: 3 }], updated: expect.any(Number) });
    expect(a.ME.links()[0].choice).toEqual({ sections: ['goals'], tier: 1 });
  });
});

describe('turning a link off', () => {
  it('leaves nothing in its page, for good, and forgets it', async () => {
    const a = await device();
    goals(a.S);
    const l = await a.ME.connect('Buddy', LINK_DEFAULT);
    await a.ME.turnOff(l.id);
    expect(page(l)).toEqual(OFF);
    await expect(read(l)).rejects.toMatchObject({ code: 'off' });
    expect(a.ME.links()).toEqual([]);
  });

  it('makes a new link: the old one stops working, the new one has the same', async () => {
    const a = await device();
    goals(a.S);
    const old = await a.ME.connect('Buddy', LINK_DEFAULT);
    const next = (await a.ME.newLink(old.id))!;
    expect(next.id).not.toBe(old.id);
    expect(page(old)).toEqual(OFF);
    expect((await read(next)).goals[0].title).toBe('Run a half marathon');
    expect(a.ME.links()).toEqual([{ ...old, id: next.id, key: next.key, at: next.at, sig: expect.any(String), sent: expect.any(Number) }]);
  });

  it('forgets a link whose page was turned off somewhere else', async () => {
    const a = await device();
    goals(a.S);
    const l = await a.ME.connect('Buddy', LINK_DEFAULT);
    cloud.docs.set(`shares/${l.id}`, { ...OFF });
    await a.M.addFact('You like mornings.');
    vi.advanceTimersByTime(10_000);
    await settle(() => !a.ME.links().length);
    expect(a.ME.links()).toEqual([]);
    expect(page(l)).toEqual(OFF);
  });

  it('turns every link off before this device is erased, or once its account is back here', async () => {
    const a = await device();
    goals(a.S);
    const one = await a.ME.connect('Buddy', LINK_DEFAULT);
    const two = await a.ME.connect('Claude', LINK_DEFAULT);
    await a.ME.turnOffAll();
    expect([page(one), page(two)]).toEqual([OFF, OFF]);
    expect(a.ME.links()).toEqual([]);

    // Erased while signed out: the link is forgotten here at once, and its page goes off the next
    // time the account is signed in.
    const three = await a.ME.connect('Buddy', LINK_DEFAULT);
    const user = a.SYNC.status.user;
    a.SYNC.status.user = null;
    a.S.resetAll();
    expect(a.ME.links()).toEqual([]);
    expect(page(three)).not.toEqual(OFF);
    a.SYNC.status.user = user;
    await a.ME.refresh();
    expect(page(three)).toEqual(OFF);
    expect(localStorage.getItem('arise-me-off')).toBeNull();
  });

  it("turns every link off when the account is deleted, with the account's other pages", async () => {
    const a = await device();
    goals(a.S);
    const l = await a.ME.connect('Buddy', LINK_DEFAULT);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    a.SYNC.status.locked = false;
    await a.SYNC.submit('delete', { password: PW });
    expect(a.SYNC.status.error).toBe('');
    expect(page(l)).toEqual(OFF);
    expect(JSON.stringify([...cloud.docs])).not.toContain('uid');
  });
});
