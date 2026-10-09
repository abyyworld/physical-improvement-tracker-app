// @vitest-environment jsdom
// Scenario B: the owner deletes their Arise login in the Firebase console (not with "Delete my
// account" in the app), then makes the account again with the same email and wants their whole
// plan back in it, on every device.
//
//   B1: only the Auth user is deleted; users/<uid>/arise/{meta,part0,keys} and
//       recovery/<email> are left behind in Firestore.
//   B2: the Auth user and every Firestore doc are deleted.
//   C:  the account is made again first on a brand-new empty device, and the phone that holds
//       the plan is only opened later.
//
// Harness notes:
// - The fake Firebase module is shared by all simulated devices and its rules check the sign-in
//   of the device whose Firebase loaded last. So the device that acts is always the one that
//   loaded last: the laptop makes the account, the phone signs in after it (both then hold the
//   whole plan), and any other device that acts later is "reopened" first.
// - Reopening = fresh copies of the app's modules over the same localStorage, signed out. That
//   is what the real app sees once its Auth user is gone: at start-up the Firebase SDK reloads
//   the saved user, gets user-not-found and clears it; an app left open is signed out the same
//   way when its ID token (1 hour) can't be refreshed. Until then Firestore still accepts the
//   old token, which the "live" steps below use.
// - Timers are faked so the app's 8-second delayed pushes never fire on their own (each sync
//   below is started explicitly, like opening the app does).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cloud, resetCloud } from './test/fake-firebase';

vi.mock('./lib/firebase', () => import('./test/fake-firebase'));
// Fewer key-stretching rounds, so the tests run in seconds. The real count is tested in crypto.test.ts.
vi.mock('./lib/crypto', async (orig) => {
  const real = await orig<typeof import('./lib/crypto')>();
  return { ...real, deriveMaster: (p: string, id: string) => real.deriveMaster(p, id, 1000) };
});

type Store = typeof import('./store');
type Sync = typeof import('./sync');
type Account = typeof import('./account');
type Fake = typeof import('./test/fake-firebase');
interface Device {
  S: Store;
  SYNC: Sync;
  A: Account;
  name: string;
}

const storage = new Map<string, Map<string, string>>();
let current = '';

// Swap localStorage to this device's, and load a fresh copy of the app's modules for it.
function use(name: string) {
  if (current) storage.set(current, new Map(Object.entries({ ...localStorage })));
  localStorage.clear();
  for (const [k, v] of storage.get(name) || []) localStorage.setItem(k, v);
  current = name;
}

async function device(name: string): Promise<Device> {
  use(name);
  vi.resetModules();
  const S = await import('./store');
  const SYNC = await import('./sync');
  const A = await import('./account'); // the same copy sync.ts uses
  await SYNC.initSync({ render: () => {}, changed: () => {}, checkForUpdate: () => {} });
  return { S, SYNC, A, name };
}

// The app on this device is closed and opened again (see the harness notes).
const reopen = (d: Device) => device(d.name);

const PW = 'correct horse battery';
const NEW = 'a different long password';
const EMAIL = 'me@example.com';
const session = (id: string, date = '2026-10-01') => ({ id, workout: 'a', date, started: 1, finished: 2, easy: false, items: [{ ex: 'band_row', setup: '', sets: [{ r: 10, done: true }] }] });

const meta = () => JSON.parse(localStorage.getItem('arise-sync') || '{}');
// What a device with uid1's data is asked when it signs in to the account made again with its
// email. Neither answer loses anything.
const ADD = `This device has data from an account that had ${EMAIL} before. Add it to this account?\n\nChoose Cancel to stay signed out. The data stays on this device either way.`;
const docsOf = (uid: string) => [...cloud.docs.keys()].filter((p) => p.startsWith(`users/${uid}/`)).sort();

// The owner's plan: two goals with quests, a measure with a value, milestones (one done), ticked
// quests, the home workout plan switched on with its settings, a workout and a journal entry.
function buildPlan(S: Store) {
  S.importData({ sessions: [session('s1', '2026-10-05')] });
  S.saveGoal({ id: 'fitness', title: 'Get strong', category: 'fitness', workouts: true, why: 'For my kids', quests: [{ id: 'q1', title: 'Stretch', schedule: { kind: 'daily' }, created: '2026-10-01' }], measures: [{ id: 'm1', name: 'Weight', unit: 'kg', better: 'down', start: 82, target: 75 }] });
  S.saveGoal({ id: 'g2', title: 'Learn Spanish', category: 'learning', quests: [{ id: 'q2', title: 'Study', schedule: { kind: 'daily' }, created: '2026-10-01' }, { id: 'q3', title: 'Flashcards', schedule: { kind: 'weekly', times: 3 }, created: '2026-10-01' }], milestones: [{ id: 'ms1', title: 'Finish A1', due: '2026-12-01' }, { id: 'ms2', title: 'Finish A2' }] });
  S.tick('q1', { done: true }, '2026-10-05');
  S.tick('q2', { done: true }, '2026-10-06');
  S.tick('q3', { done: true }, '2026-10-06');
  S.logValue('m1', 80.5, '2026-10-06');
  S.toggleMilestone('g2', 'ms1');
  S.setTemplate('weekly');
  S.state.settings.perWeek = 4;
  S.state.settings.restBig = 90;
  S.save();
  S.setLog('2026-10-06', { t: 'Felt strong today' });
}

const planOf = (S: Store) => ({
  goals: [...S.state.goals]
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((g) => ({
      id: g.id,
      title: g.title,
      status: g.status,
      workouts: !!g.workouts,
      why: g.why,
      quests: g.quests.map((q) => `${q.id}:${q.title}`),
      measures: g.measures.map((m) => `${m.name} ${m.start}->${m.target} ${m.unit}`),
      milestones: g.milestones.map((m) => `${m.title}:${m.done ? 'done' : 'open'}`),
    })),
  workoutsOn: S.workoutsOn(),
  settings: { template: S.state.settings.template, perWeek: S.state.settings.perWeek, restBig: S.state.settings.restBig },
  checks: Object.fromEntries(Object.entries(S.state.checks).map(([k, day]) => [k, Object.keys(day).filter((q) => day[q].done).sort()])),
  values: Object.fromEntries(Object.entries(S.state.values.m1 || {}).map(([k, v]) => [k, v.v])),
  sessions: S.state.sessions.map((s) => s.id),
  logs: Object.fromEntries(Object.entries(S.state.logs).map(([k, l]) => [k, l.t])),
});

const PLAN = {
  goals: [
    { id: 'fitness', title: 'Get strong', status: 'active', workouts: true, why: 'For my kids', quests: ['q1:Stretch'], measures: ['Weight 82->75 kg'], milestones: [] },
    { id: 'g2', title: 'Learn Spanish', status: 'active', workouts: false, why: '', quests: ['q2:Study', 'q3:Flashcards'], measures: [], milestones: ['Finish A1:done', 'Finish A2:open'] },
  ],
  workoutsOn: true,
  settings: { template: 'weekly', perWeek: 4, restBig: 90 },
  checks: { '2026-10-05': ['q1'], '2026-10-06': ['q2', 'q3'] },
  values: { '2026-10-06': 80.5 },
  sessions: ['s1'],
  logs: { '2026-10-06': 'Felt strong today' },
};
const NOTHING = { goals: [], workoutsOn: false, sessions: [], checks: {}, logs: {} };

// Laptop and phone, both signed in to me@example.com (uid1), both holding the whole plan.
async function bothSignedIn() {
  const laptop = await device('laptop');
  buildPlan(laptop.S);
  expect(planOf(laptop.S)).toEqual(PLAN);
  await laptop.SYNC.submit('up', { email: EMAIL, password: PW, password2: PW });
  expect(laptop.SYNC.status.error).toBe('');
  const oldCode = laptop.SYNC.status.pending!.recoveryCode;
  await laptop.SYNC.handleAction('sync-code-done');
  const phone = await device('phone');
  await phone.SYNC.submit('in', { id: EMAIL, password: PW });
  expect(phone.SYNC.status.error).toBe('');
  expect(phone.SYNC.status.user?.uid).toBe('uid1');
  expect(planOf(phone.S)).toEqual(PLAN);
  expect([...cloud.docs.keys()].sort()).toEqual([`recovery/${EMAIL}`, 'users/uid1/arise/keys', 'users/uid1/arise/meta', 'users/uid1/arise/part0']);
  return { laptop, phone, oldCode };
}

// What the owner does in the Firebase console.
function consoleDeletes(variant: 'B1' | 'B2') {
  cloud.users.delete('uid1'); // Authentication > Users > Delete account
  if (variant === 'B2') for (const p of [...cloud.docs.keys()]) cloud.docs.delete(p); // and every Firestore doc
}

// Every confirm() the app shows; the answer is set per step (false = Cancel, true = OK).
const spyConfirm = () => vi.spyOn(window, 'confirm');
let ask: ReturnType<typeof spyConfirm>;

beforeEach(() => {
  resetCloud();
  storage.clear();
  current = '';
  localStorage.clear();
  document.body.innerHTML = '<div id="sheet" hidden><div class="sheet-panel"><button class="sheet-close"></button><div class="sheet-body"></div></div></div><div id="toast"></div><main id="app"></main><nav id="tabs"></nav>';
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  ask = spyConfirm().mockReturnValue(false);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('B1: only the Auth user is deleted in the console, every Firestore doc stays', () => {
  it("the phone isn't told anything: it keeps syncing into the old folder while its session lasts, then is signed out silently with its plan kept", async () => {
    const { phone, oldCode } = await bothSignedIn();
    consoleDeletes('B1');

    // The app is still open and its ID token still valid: the cloud copy is still there, so
    // nothing looks wrong, and a change goes up into the deleted account's folder.
    phone.S.tick('q1', { done: true }, '2026-10-07');
    const rev = cloud.docs.get('users/uid1/arise/meta')!.rev;
    await phone.SYNC.syncNow();
    expect(phone.SYNC.status.error).toBe('');
    expect(phone.SYNC.status.user?.uid).toBe('uid1');
    expect(cloud.docs.get('users/uid1/arise/meta')!.rev).not.toBe(rev);

    // Reopened (or the token ran out): signed out, no message at all, the plan stays, and the
    // sync info still says the data is uid1's.
    const p = await reopen(phone);
    expect(p.SYNC.status.user).toBeNull();
    expect(p.SYNC.status.error).toBe('');
    expect(p.SYNC.panel()).toContain('data-form="in"');
    expect(p.SYNC.panel()).not.toMatch(/deleted/);
    expect(meta()).toMatchObject({ uid: 'uid1', login: EMAIL });
    expect(planOf(p.S)).toEqual({ ...PLAN, checks: { ...PLAN.checks, '2026-10-07': ['q1'] } });

    // Signing in with the old password: the login is gone.
    await p.SYNC.submit('in', { id: EMAIL, password: PW });
    expect(p.SYNC.status.error).toMatch(/^Wrong email or password/);
    expect(p.SYNC.status.user).toBeNull();
    // "Forgot password" with the old recovery code: the leftover recovery record opens, but the
    // login behind it is gone. The app can't tell that from a password reset by email, so it says
    // it may be either, and how to make the account again.
    await p.SYNC.submit('recover', { id: EMAIL, code: oldCode, password: NEW, password2: NEW });
    expect(p.SYNC.status.error).toBe(
      `The recovery code can't sign in to ${EMAIL}. Maybe its password was set from a reset email. Then sign in with that password and tick the box below. Your recovery code then unlocks your data. Or maybe the account was deleted. Then make it again with "New here? Create an account". The data on this device can go into it.`,
    );
    expect(p.SYNC.status.offerLegacy).toBe(true); // the box below
    expect(p.SYNC.status.user).toBeNull();
    expect(cloud.users.size).toBe(0);
    expect(planOf(p.S).goals).toEqual(PLAN.goals);
  });

  it('making the account again from the phone works over the old recovery record; the whole plan goes in without a question, and every device gets it', async () => {
    const { laptop, phone, oldCode } = await bothSignedIn();
    consoleDeletes('B1');
    const p = await reopen(phone);

    ask.mockReturnValue(true); // OK would be "start empty", if a question came
    await p.SYNC.submit('up', { email: EMAIL, password: NEW, password2: NEW });
    expect(p.SYNC.status.error).toBe('');
    expect(p.SYNC.status.user).toMatchObject({ uid: 'uid2', id: EMAIL });
    // No question: the data here is uid1's, and Firebase only let this email make an account
    // because uid1's login is gone. (Asking would also have said the old account keeps it all,
    // going by the leftover recovery record, when nobody can ever sign in to uid1 again.)
    expect(ask).not.toHaveBeenCalled();
    expect(document.querySelector('#toast')!.textContent).toBe('Account created. Your data is encrypted and backed up.');
    expect(planOf(p.S)).toEqual(PLAN);
    expect(meta()).toMatchObject({ uid: 'uid2', login: EMAIL });
    expect(meta().joining).toBeUndefined();
    const newCode = p.SYNC.status.pending!.recoveryCode;
    expect(newCode).not.toBe(oldCode);

    // createKeys simply overwrote recovery/<email> (the rules allow it: the doc id is the
    // signed-in email and the new uid is the writer's own). The old folder stays behind.
    expect(cloud.docs.get(`recovery/${EMAIL}`)!.uid).toBe('uid2');
    expect(docsOf('uid2')).toEqual(['users/uid2/arise/keys', 'users/uid2/arise/meta', 'users/uid2/arise/part0']);
    expect(docsOf('uid1')).toEqual(['users/uid1/arise/keys', 'users/uid1/arise/meta', 'users/uid1/arise/part0']);
    expect(cloud.users.size).toBe(1);

    // A brand-new device gets the whole plan, without a question.
    const t = await device('tablet');
    await t.SYNC.submit('in', { id: EMAIL, password: NEW });
    expect(t.SYNC.status.error).toBe('');
    expect(ask).not.toHaveBeenCalled();
    expect(planOf(t.S)).toEqual(PLAN);

    // The leftovers don't get in the way: the old account counts as gone, and its folder can't
    // be read by the new one (or anyone).
    expect(await t.A.accountExists(EMAIL, 'uid1')).toBe(false);
    expect(await t.A.accountExists(EMAIL, 'uid2')).toBe(true);
    const F = (await import('./lib/firebase')) as unknown as Fake;
    await expect(F.getDoc(F.doc(null, 'users', 'uid1', 'arise', 'part0'))).rejects.toMatchObject({ code: 'permission-denied' });

    // The laptop, once its old session is over, is signed out silently with its copy of the plan.
    // Signing in to the new account asks whether to add its data (uid1's, whose email the new
    // account has now). OK: it goes into the account, which has the same plan. Nothing doubles.
    const l = await reopen(laptop);
    expect(l.SYNC.status.user).toBeNull();
    expect(l.SYNC.status.error).toBe('');
    expect(planOf(l.S)).toEqual(PLAN);
    await l.SYNC.submit('in', { id: EMAIL, password: NEW });
    expect(ask.mock.calls.map((c) => c[0])).toEqual([ADD]);
    expect(l.SYNC.status.error).toBe('');
    expect(l.SYNC.status.user?.uid).toBe('uid2');
    expect(planOf(l.S)).toEqual(PLAN);

    // Another new device: the old password and the old recovery code no longer work; the new
    // recovery code does, and brings the plan.
    const d = await device('desk');
    await d.SYNC.submit('in', { id: EMAIL, password: PW });
    expect(d.SYNC.status.error).toMatch(/^Wrong email or password/);
    await d.SYNC.submit('recover', { id: EMAIL, code: oldCode, password: 'yet another password', password2: 'yet another password' });
    expect(d.SYNC.status.error).toMatch(/recovery code isn't the right one/);
    await d.SYNC.submit('recover', { id: EMAIL, code: newCode, password: 'yet another password', password2: 'yet another password' });
    expect(d.SYNC.status.error).toBe('');
    expect(d.SYNC.status.user?.uid).toBe('uid2');
    expect(planOf(d.S)).toEqual(PLAN);
  });
});

describe('B2: the Auth user and every Firestore doc are deleted in the console', () => {
  it('a phone that syncs while its session lasts is signed out with "deleted on another device"; making the account again then takes the plan without a question', async () => {
    const { laptop, phone } = await bothSignedIn();
    consoleDeletes('B2');

    await phone.SYNC.syncNow();
    expect(phone.SYNC.status.user).toBeNull();
    expect(phone.SYNC.status.error).toBe('This account was deleted on another device, so this device was signed out. Your data on this device stays.');
    expect(meta()).toEqual({ orphanOf: 'uid1', login: EMAIL, changedAt: expect.any(Number), seenHash: expect.any(String) });
    expect(planOf(phone.S)).toEqual(PLAN);
    expect(cloud.docs.size).toBe(0); // nothing was sent back up

    await phone.SYNC.submit('up', { email: EMAIL, password: NEW, password2: NEW });
    expect(phone.SYNC.status.error).toBe('');
    expect(ask).not.toHaveBeenCalled();
    expect(phone.SYNC.status.user?.uid).toBe('uid2');
    expect(planOf(phone.S)).toEqual(PLAN);
    expect(docsOf('uid2')).toEqual(['users/uid2/arise/keys', 'users/uid2/arise/meta', 'users/uid2/arise/part0']);

    const t = await device('tablet');
    await t.SYNC.submit('in', { id: EMAIL, password: NEW });
    expect(t.SYNC.status.error).toBe('');
    expect(ask).not.toHaveBeenCalled();
    expect(planOf(t.S)).toEqual(PLAN);

    // The laptop (reopened later) is signed out silently. Signing in asks whether to add its data
    // (uid1's, whose email the account has now). OK: nothing doubles.
    const l = await reopen(laptop);
    expect(l.SYNC.status.user).toBeNull();
    expect(l.SYNC.status.error).toBe('');
    ask.mockReturnValue(true);
    await l.SYNC.submit('in', { id: EMAIL, password: NEW });
    expect(ask.mock.calls.map((c) => c[0])).toEqual([ADD]);
    expect(l.SYNC.status.user?.uid).toBe('uid2');
    expect(l.SYNC.status.error).toBe('');
    expect(planOf(l.S)).toEqual(PLAN);
  });

  it('a phone reopened first is signed out silently; making the account again brings the whole plan in without a question', async () => {
    const { phone } = await bothSignedIn();
    consoleDeletes('B2');
    const p = await reopen(phone);
    expect(p.SYNC.status.user).toBeNull();
    expect(p.SYNC.status.error).toBe('');
    expect(meta()).toMatchObject({ uid: 'uid1', login: EMAIL });
    expect(planOf(p.S)).toEqual(PLAN);

    ask.mockReturnValue(true);
    await p.SYNC.submit('up', { email: EMAIL, password: NEW, password2: NEW });
    expect(p.SYNC.status.error).toBe('');
    expect(p.SYNC.status.user?.uid).toBe('uid2');
    expect(ask).not.toHaveBeenCalled();
    expect(planOf(p.S)).toEqual(PLAN);

    const t = await device('tablet');
    await t.SYNC.submit('in', { id: EMAIL, password: NEW });
    expect(t.SYNC.status.error).toBe('');
    expect(planOf(t.S)).toEqual(PLAN);
  });
});

describe.each(['B1', 'B2'] as const)('%s: making the account again with the same email', (variant) => {
  it('never asks "Start your new account empty?", so a wrong answer can\'t wipe the plan', async () => {
    const { phone } = await bothSignedIn();
    consoleDeletes(variant);
    const p = await reopen(phone);
    ask.mockReturnValue(true);
    await p.SYNC.submit('up', { email: EMAIL, password: NEW, password2: NEW });
    expect(ask).not.toHaveBeenCalled();
    expect(p.SYNC.status.error).toBe('');
    expect(p.SYNC.status.user?.uid).toBe('uid2');
    expect(planOf(p.S)).toEqual(PLAN);
    const t = await device('tablet');
    await t.SYNC.submit('in', { id: EMAIL, password: NEW });
    expect(planOf(t.S)).toEqual(PLAN);
    // In B1 the plan is also still in uid1's folder, but no login can ever open it again.
    expect(docsOf('uid1').length).toBe(variant === 'B1' ? 3 : 0);
  });

  it('still asks when the account made is another email: that one is a different account', async () => {
    const { phone } = await bothSignedIn();
    consoleDeletes(variant);
    const p = await reopen(phone);
    ask.mockReturnValue(false); // Cancel = copy this device's data into the new account
    await p.SYNC.submit('up', { email: 'other@example.com', password: NEW, password2: NEW });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0][0]).toMatch(/^This device has data from another account\. Start your new account empty\?/);
    // (In B1 it says the old account keeps all of it: its recovery record is still there, and no
    // app can tell from it that the login was deleted in the console. Only signing up with the
    // same email proves that, and then nothing is asked.)
    expect(ask.mock.calls[0][0]).toMatch(variant === 'B1' ? /keeps all of it/ : /would be lost/);
    expect(planOf(p.S)).toEqual(PLAN);
  });
});

describe.each(['B1', 'B2'] as const)('C (%s): the account is made again first on a brand-new empty device', (variant) => {
  it("the phone signs in, and its plan, settings included, takes the place of the new account's empty copy", async () => {
    const { phone } = await bothSignedIn();
    consoleDeletes(variant);

    const t = await device('tablet');
    await t.SYNC.submit('up', { email: EMAIL, password: NEW, password2: NEW });
    expect(t.SYNC.status.error).toBe('');
    expect(t.SYNC.status.user?.uid).toBe('uid2');
    expect(ask).not.toHaveBeenCalled();
    expect(planOf(t.S)).toMatchObject(NOTHING);
    expect(docsOf('uid2')).toContain('users/uid2/arise/meta'); // the new account's copy: empty
    const emptyRev = cloud.docs.get('users/uid2/arise/meta')!.rev;

    // The phone, opened later: signed out silently, plan kept.
    const p = await reopen(phone);
    expect(p.SYNC.status.user).toBeNull();
    expect(p.SYNC.status.error).toBe('');
    expect(planOf(p.S)).toEqual(PLAN);

    // Signing in asks whether to add the data here: it's uid1's, whose email the new account has
    // now. OK: the account's empty copy says nothing (not even its default settings were chosen),
    // so the phone's copy simply takes its place.
    ask.mockReturnValue(true);
    await p.SYNC.submit('in', { id: EMAIL, password: NEW });
    expect(ask.mock.calls.map((c) => c[0])).toEqual([ADD]);
    expect(p.SYNC.status.error).toBe('');
    expect(p.SYNC.status.user?.uid).toBe('uid2');
    expect(planOf(p.S)).toEqual(PLAN);
    expect(cloud.docs.get('users/uid2/arise/meta')!.rev).not.toBe(emptyRev);
    expect(meta()).toMatchObject({ uid: 'uid2', rev: cloud.docs.get('users/uid2/arise/meta')!.rev });
    expect(meta().joining).toBeUndefined();

    const d = await device('desk');
    await d.SYNC.submit('in', { id: EMAIL, password: NEW });
    expect(d.SYNC.status.error).toBe('');
    expect(planOf(d.S)).toEqual(PLAN);
    // And the tablet that made the account takes it in on its next sync.
    const t2 = await reopen(t);
    await t2.SYNC.submit('in', { id: EMAIL, password: NEW });
    expect(t2.SYNC.status.error).toBe('');
    expect(planOf(t2.S)).toEqual(PLAN);
  });

  it('also through deleting the empty account in the app and making it again from the phone', async () => {
    const { phone } = await bothSignedIn();
    consoleDeletes(variant);

    const t = await device('tablet');
    await t.SYNC.submit('up', { email: EMAIL, password: NEW, password2: NEW });
    expect(t.SYNC.status.user?.uid).toBe('uid2');
    ask.mockReturnValue(true); // "Delete your account and your cloud copy?"
    await t.SYNC.submit('delete', { password: NEW });
    expect(t.SYNC.status.error).toBe('');
    expect(cloud.users.size).toBe(0);
    expect(docsOf('uid2')).toEqual([]);
    expect(cloud.docs.has(`recovery/${EMAIL}`)).toBe(false);

    const p = await reopen(phone);
    ask.mockClear();
    await p.SYNC.submit('up', { email: EMAIL, password: NEW, password2: NEW });
    expect(p.SYNC.status.error).toBe('');
    expect(p.SYNC.status.user?.uid).toBe('uid3');
    expect(ask).not.toHaveBeenCalled(); // the data here is uid1's, whose email this is
    expect(planOf(p.S)).toEqual(PLAN);

    const d = await device('desk');
    await d.SYNC.submit('in', { id: EMAIL, password: NEW });
    expect(d.SYNC.status.error).toBe('');
    expect(planOf(d.S)).toEqual(PLAN);
  });
});
