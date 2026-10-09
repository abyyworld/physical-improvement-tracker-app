// @vitest-environment jsdom
// Deleting an Arise account and making it again with the same email, done inside the app (the
// recommended route), with the plan kept: the phone that deletes the account still holds the
// plan, so the new account takes it from there, and every other device gets it from the new
// account's (encrypted) cloud copy.
//
// Same harness as sync.test.ts (several simulated devices, each its own storage and its own copy
// of the app's modules, sharing one in-memory cloud that enforces the database rules), with one
// change: every device also gets its own copy of the fake Firebase, so each one has its own
// sign-in, like real devices. (sync.test.ts shares one sign-in between devices; here that would
// let the phone's account deletion sign the laptop out, and the phone's new sign-up sign the
// laptop in to the new account, which no real laptop would see.)

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cloud, resetCloud } from './test/fake-firebase';

vi.mock('./lib/firebase', () => import('./test/fake-firebase'));
// Fewer key-stretching rounds, so the tests run in seconds. The real count is tested in crypto.test.ts.
vi.mock('./lib/crypto', async (orig) => {
  const real = await orig<typeof import('./lib/crypto')>();
  return { ...real, deriveMaster: (p: string, id: string) => real.deriveMaster(p, id, 1000) };
});

type Store = typeof import('./store');
type Sync = typeof import('./sync');
type Fake = typeof import('./test/fake-firebase');
interface Device {
  S: Store;
  SYNC: Sync;
  FB: Fake; // this device's own Firebase (its sign-in)
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
  // This device's own Firebase: its own sign-in, the shared cloud (globalThis.__cloud).
  const spec = `./test/fake-firebase.ts?device=${name}`;
  vi.doMock('./lib/firebase', () => import(/* @vite-ignore */ spec));
  const S = await import('./store');
  const SYNC = await import('./sync');
  const A = await import('./account');
  // Load Firebase now (the app loads it on the first account action), so this device's modules
  // are bound to this device's Firebase, whichever device is made after it.
  await A.load(() => {});
  const FB = (await import('./lib/firebase')) as unknown as Fake;
  await SYNC.initSync({ render: () => {}, changed: () => {}, checkForUpdate: () => {} });
  return { S, SYNC, FB, name };
}

async function on<T>(d: Device, fn: () => Promise<T> | T): Promise<T> {
  use(d.name);
  return fn();
}

const EMAIL = 'me@example.com';
const PW = 'correct horse battery'; // the account that gets deleted
const NEW_PW = 'a whole new long password'; // the account made again
const RECOVERED_PW = 'set with the recovery code';
const session = (id: string, date = '2026-10-01') => ({ id, workout: 'back', date, started: 1, finished: 2, easy: false, items: [{ ex: 'band_row', setup: 'door anchor', sets: [{ r: 10, done: true }, { r: 9, done: true }] }] });
const cloudText = () => JSON.stringify([...cloud.docs.values()]);
const paths = () => [...cloud.docs.keys()].sort();
// The question a device with the deleted account's data gets when it signs in to the account
// made again with that email. Neither answer loses anything.
const ADD = `This device has data from an account that had ${EMAIL} before. Add it to this account?\n\nChoose Cancel to stay signed out. The data stays on this device either way.`;

// Everything of the Player's that syncs: the whole state except what stays on each device (a
// workout in progress, the AI service, notifications, AI usage counts) and the local save time.
const DEVICE_ONLY = ['notify', 'aiProvider', 'aiModel', 'aiBase', 'aiEngine'];
function planOf(d: Device) {
  const s = JSON.parse(JSON.stringify(d.S.state));
  delete s.active;
  delete s.updatedAt;
  delete s.ai.usage;
  for (const k of DEVICE_ONLY) delete s.settings[k];
  return s;
}

// A full plan, built the way the app's screens build it.
function buildPlan(S: Store) {
  // Workout history from a backup first (on an empty device that's a full restore).
  S.importData({ sessions: [session('old1', '2026-09-28'), session('old2', '2026-09-30')], logs: { '2026-09-30': { e: 3, t: 'Tired but did it', at: 5 } } });
  S.saveProfile({ name: 'Anno', goal: 'Get strong', why: 'Feel good every day', onboarded: true });
  // The home workout plan: on (a goal uses it), with settings that aren't the defaults.
  S.setTemplate('weekly');
  Object.assign(S.state.settings, { restBig: 150, restSmall: 45, bar: 'none', remindAt: '06:30', eveningAt: '21:15', sound: false, perWeek: 4 });
  // Device-only settings: they must not travel.
  Object.assign(S.state.settings, { notify: true, aiProvider: 'anthropic', aiEngine: 'own' });
  S.save();
  S.saveGoal({
    id: 'fitness',
    title: 'Get strong',
    category: 'fitness',
    why: 'Feel good every day',
    by: 'June 2027',
    workouts: true,
    quests: [{ id: 'q1', title: 'Stretch', schedule: { kind: 'daily' }, created: '2026-10-01' }],
    measures: [{ id: 'pushups', name: 'Push-ups in a row', unit: 'reps', start: 12, target: 40, better: 'up' }],
    milestones: [
      { id: 'm1', title: 'First pull-up', due: '2026-12-01' },
      { id: 'm2', title: '20 push-ups', due: '2026-11-01' },
    ],
  });
  S.saveGoal({
    id: 'spanish',
    title: 'Learn Spanish',
    category: 'learning',
    why: 'Talk to my in-laws',
    by: '6 months',
    quests: [
      { id: 'q2', title: 'Study', schedule: { kind: 'daily' }, amount: { target: 30, unit: 'min' }, created: '2026-10-01' },
      { id: 'q3', title: 'Conversation class', schedule: { kind: 'weekly', times: 2 }, created: '2026-10-01' },
      { id: 'q4', title: 'Flashcards', schedule: { kind: 'days', days: [0, 2, 4] }, created: '2026-10-01' },
    ],
    measures: [{ id: 'words', name: 'Words known', unit: 'words', start: 100, target: 2000, better: 'up' }],
    milestones: [{ id: 'm3', title: 'Pass the A2 exam', due: '2027-03-01' }],
  });
  S.saveGoal({ id: 'money', title: 'Save $10,000', category: 'money', measures: [{ id: 'savings', name: 'Savings', unit: '$', start: 0, target: 10000, better: 'up' }] });
  S.toggleMilestone('fitness', 'm2');
  // Ticks on a couple of days, measure values.
  S.tick('q1', { done: true }, '2026-10-06');
  S.tick('q2', { done: true, amount: 35 }, '2026-10-06');
  S.tick('q3', { done: true }, '2026-10-06');
  S.tick('q1', { done: true }, '2026-10-07');
  S.tick('q2', { done: false, amount: 10 }, '2026-10-07');
  S.tick('q4', { done: true }, '2026-10-07');
  S.logValue('pushups', 21, '2026-10-05');
  S.logValue('words', 340, '2026-10-07');
  S.logValue('savings', 1250.5, '2026-10-07');
  // A finished workout, done the way the workout screen does it.
  S.startWorkout('back', { noBar: true });
  for (const it of S.state.active!.items) for (const set of it.sets) set.done = true;
  S.save();
  const finished = S.finishWorkout()!;
  // The daily log, a weigh-in, a cut phase, a football day, a coach chat.
  S.setLog('2026-10-07', { e: 4, t: 'Felt strong today' });
  S.addBodyEntry({ weight: 82.5, waist: 84 }, '2026-10-05');
  S.setPhase('cut');
  S.toggleFootball('2026-10-04');
  S.state.ai.chat.push({ role: 'user', text: 'How do I get my first pull-up?', at: Date.now() });
  S.save();
  return finished;
}

// The parts a Player would look at, checked one by one (planOf compares everything as well).
function expectSamePlan(d: Device, want: ReturnType<typeof planOf>, finishedId: string) {
  const got = planOf(d);
  expect(got.goals.map((g: { id: string }) => g.id)).toEqual(['fitness', 'spanish', 'money']);
  expect(got.goals).toEqual(want.goals);
  expect(got.goals[1].quests.map((q: { id: string }) => q.id)).toEqual(['q2', 'q3', 'q4']);
  expect(got.goals[0].milestones).toEqual(want.goals[0].milestones);
  expect(got.goals[0].milestones[1].done).toBeTruthy();
  expect(got.goals[1].measures[0]).toMatchObject({ id: 'words', start: 100, target: 2000 });
  expect(got.checks).toEqual(want.checks);
  expect(Object.keys(got.checks).sort()).toEqual(['2026-10-06', '2026-10-07']);
  expect(got.values).toEqual(want.values);
  expect(d.S.workoutsOn()).toBe(true);
  expect(d.S.goalById('fitness')?.workouts).toBe(true);
  expect(got.settings).toEqual(want.settings);
  expect(got.settings).toMatchObject({ template: 'weekly', restBig: 150, restSmall: 45, bar: 'none', remindAt: '06:30', eveningAt: '21:15', sound: false, perWeek: 4, name: 'Anno' });
  expect(got.sessions.map((s: { id: string }) => s.id)).toEqual(['old1', 'old2', finishedId]);
  expect(got.sessions).toEqual(want.sessions);
  expect(got.logs).toEqual(want.logs);
  expect(got.logs['2026-10-07'].t).toBe('Felt strong today');
  expect(got.body).toEqual(want.body);
  expect(got.profile).toEqual(want.profile);
  expect(got.football).toEqual(['2026-10-04']);
  expect(got.ai.chat).toEqual(want.ai.chat);
  // And nothing else differs either (stamps, plan notes, everything that syncs).
  expect(got).toEqual(want);
}

beforeEach(() => {
  resetCloud();
  storage.clear();
  current = '';
  localStorage.clear();
  document.body.innerHTML = '<div id="sheet" hidden><div class="sheet-panel"><button class="sheet-close"></button><div class="sheet-body"></div></div></div><div id="toast"></div><main id="app"></main><nav id="tabs"></nav>';
});

// The phone with the full plan, signed up; the laptop signed in and synced.
async function setup() {
  const phone = await device('phone');
  const finished = buildPlan(phone.S);
  await phone.SYNC.submit('up', { email: EMAIL, password: PW, password2: PW });
  expect(phone.SYNC.status.error).toBe('');
  const oldCode = phone.SYNC.status.pending!.recoveryCode;
  await phone.SYNC.handleAction('sync-code-done');
  const oldUid = phone.SYNC.status.user!.uid;
  const laptop = await device('laptop');
  await laptop.SYNC.submit('in', { id: EMAIL, password: PW });
  expect(laptop.SYNC.status.error).toBe('');
  const plan = planOf(phone);
  expectSamePlan(laptop, plan, finished.id);
  // Device-only settings stayed on the phone.
  expect(laptop.S.state.settings).toMatchObject({ notify: false, aiProvider: '', aiEngine: '' });
  expect(phone.S.state.settings).toMatchObject({ notify: true, aiProvider: 'anthropic', aiEngine: 'own' });
  return { phone, laptop, finished, plan, oldUid, oldCode };
}

// On the phone: Delete my account and cloud copy (More), then Create an account with the same email.
async function deleteAndRecreate(phone: Device) {
  return on(phone, async () => {
    const ask = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await phone.SYNC.submit('delete', { password: PW });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0][0]).toBe('Delete your account and your cloud copy? This cannot be undone. The data on this device stays.');
    ask.mockRestore();
    expect(phone.SYNC.status.error).toBe('');
    expect(phone.SYNC.status.user).toBeNull();
    // The cloud is empty: no documents, no recovery record, no sign-in.
    expect(cloud.docs.size).toBe(0);
    expect(cloud.users.size).toBe(0);
    const afterDelete = planOf(phone);

    // Create the account again. Cancel would be the answer that keeps this device's data if a
    // question came, so a question answered by mistake can't empty the phone in this test.
    const ask2 = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await phone.SYNC.submit('up', { email: EMAIL, password: NEW_PW, password2: NEW_PW });
    const asked = ask2.mock.calls.map((c) => c[0]);
    ask2.mockRestore();
    return { asked, afterDelete };
  });
}

describe('deleting the account in the app and making it again with the same email', () => {
  it('keeps the whole plan on the phone, puts it in the new account, and every device gets it', async () => {
    const { phone, laptop, finished, plan, oldUid, oldCode } = await setup();
    const { asked, afterDelete } = await deleteAndRecreate(phone);

    // Deleting changed nothing on the phone.
    expect(afterDelete).toEqual(plan);
    // No question when making the account again: the phone's data belongs to no account now.
    expect(asked).toEqual([]);
    expect(phone.SYNC.status.error).toBe('');
    expect(phone.SYNC.status.user).toMatchObject({ id: EMAIL, email: EMAIL });
    const newUid = phone.SYNC.status.user!.uid;
    expect(newUid).not.toBe(oldUid); // a new account, same email
    expect(cloud.users.size).toBe(1);
    expect(phone.SYNC.status.pending?.recoveryCode).toMatch(/^([0-9A-Z]{4}-){7}[0-9A-Z]{4}$/);
    expect(phone.SYNC.status.pending!.recoveryCode).not.toBe(oldCode);
    const newCode = phone.SYNC.status.pending!.recoveryCode;
    await on(phone, () => phone.SYNC.handleAction('sync-code-done'));

    // The phone still has the whole plan.
    expectSamePlan(phone, plan, finished.id);
    // And the new account's cloud copy has it, encrypted.
    expect(paths()).toEqual([`recovery/${EMAIL}`, `users/${newUid}/arise/keys`, `users/${newUid}/arise/meta`, `users/${newUid}/arise/part0`]);
    expect(cloud.docs.get(`recovery/${EMAIL}`)).toMatchObject({ uid: newUid });
    expect(cloud.docs.get(`users/${newUid}/arise/meta`)).toMatchObject({ enc: 1, parts: 1 });
    for (const secret of ['Spanish', 'Felt strong', 'Get strong', 'Stretch', 'band_row', 'pull-up', 'Anno', 'weekly', PW, NEW_PW]) expect(cloudText()).not.toContain(secret);
    // The phone is synced with it: nothing waiting to go up.
    const meta = await on(phone, () => JSON.parse(localStorage.getItem('arise-sync')!));
    expect(meta).toMatchObject({ uid: newUid, login: EMAIL, rev: cloud.docs.get(`users/${newUid}/arise/meta`)!.rev });
    expect(meta.joining).toBeUndefined();

    // A brand-new tablet: the old password is gone, the new one brings the whole plan.
    const tablet = await device('tablet');
    const askT = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await tablet.SYNC.submit('in', { id: EMAIL, password: PW });
    expect(tablet.SYNC.status.error).toMatch(/Wrong email/);
    await tablet.SYNC.submit('in', { id: EMAIL, password: NEW_PW });
    expect(askT).not.toHaveBeenCalled();
    askT.mockRestore();
    expect(tablet.SYNC.status.error).toBe('');
    expect(tablet.SYNC.status.user?.uid).toBe(newUid);
    expectSamePlan(tablet, plan, finished.id);
    expect(tablet.S.state.settings).toMatchObject({ notify: false, aiProvider: '', aiEngine: '' }); // device-only stayed on the phone

    // The laptop, still signed in to the deleted account: its next sync signs it out and keeps its data.
    const revBefore = cloud.docs.get(`users/${newUid}/arise/meta`)!.rev;
    await on(laptop, async () => {
      expect(laptop.SYNC.status.user?.uid).toBe(oldUid);
      await laptop.SYNC.syncNow();
      expect(laptop.SYNC.status.user).toBeNull();
      expect(laptop.SYNC.status.error).toMatch(/deleted on another device/);
      expect(laptop.SYNC.status.error).toMatch(/Your data on this device stays/);
      expectSamePlan(laptop, plan, finished.id);
    });
    // It made no cloud copy for the deleted account, and didn't touch the new one.
    expect(paths().filter((p) => p.includes(oldUid))).toEqual([]);
    expect(cloud.docs.get(`users/${newUid}/arise/meta`)!.rev).toBe(revBefore);

    // Meanwhile on the phone: the money goal is deleted and Spanish gets another tick.
    await on(phone, async () => {
      phone.S.deleteGoal('money');
      phone.S.tick('q2', { done: true, amount: 40 }, '2026-10-08');
      await phone.SYNC.syncNow();
      expect(phone.SYNC.status.error).toBe('');
    });
    const planNow = planOf(phone);

    // The laptop signs in to the account made again, with the new password. Its data is the
    // deleted account's, and this account has that account's email now. It's asked whether to
    // add its data to it (OK), or stay signed out (Cancel). Neither loses anything.
    await on(laptop, async () => {
      const ask = vi.spyOn(window, 'confirm').mockReturnValue(true);
      await laptop.SYNC.submit('in', { id: EMAIL, password: NEW_PW });
      expect(ask.mock.calls.map((c) => c[0])).toEqual([ADD]);
      ask.mockRestore();
      expect(laptop.SYNC.status.error).toBe('');
      expect(laptop.SYNC.status.user?.uid).toBe(newUid);
      // The account's plan as the phone has it now: no duplicates, and the deleted goal stays deleted.
      expect(planOf(laptop)).toEqual(planNow);
      expect(laptop.S.state.goals.map((g) => g.id)).toEqual(['fitness', 'spanish']);
      expect(laptop.S.state.sessions.map((s) => s.id)).toEqual(['old1', 'old2', finished.id]);
      expect(laptop.S.state.checks['2026-10-08']?.q2).toMatchObject({ done: true, amount: 40 });
      expect(laptop.S.workoutsOn()).toBe(true);
      expect(laptop.S.state.settings.template).toBe('weekly');
      // A change on the laptop reaches the others.
      laptop.S.tick('q1', { done: true }, '2026-10-08');
      await laptop.SYNC.syncNow();
      expect(laptop.SYNC.status.error).toBe('');
    });
    await on(phone, async () => {
      await phone.SYNC.syncNow();
      expect(phone.SYNC.status.error).toBe('');
      expect(phone.S.state.checks['2026-10-08']?.q1?.done).toBe(true);
      expect(phone.S.state.goals.map((g) => g.id)).toEqual(['fitness', 'spanish']); // the money goal didn't come back
      expect(phone.S.state.sessions.map((s) => s.id)).toEqual(['old1', 'old2', finished.id]);
    });
    await on(tablet, async () => {
      await tablet.SYNC.syncNow();
      expect(planOf(tablet)).toEqual(planOf(phone));
    });
    // Still only the new account in the cloud, still encrypted.
    expect(paths()).toEqual([`recovery/${EMAIL}`, `users/${newUid}/arise/keys`, `users/${newUid}/arise/meta`, `users/${newUid}/arise/part0`]);
    expect(cloudText()).not.toContain('Spanish');

    // The recovery code shown for the new account works on yet another device; the old one doesn't.
    const desktop = await device('desktop');
    await desktop.SYNC.submit('recover', { id: EMAIL, code: oldCode, password: RECOVERED_PW, password2: RECOVERED_PW });
    expect(desktop.SYNC.status.error).toMatch(/recovery code isn't the right one/);
    expect(desktop.SYNC.status.user).toBeNull();
    const askD = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await desktop.SYNC.submit('recover', { id: EMAIL, code: newCode, password: RECOVERED_PW, password2: RECOVERED_PW });
    expect(askD).not.toHaveBeenCalled();
    askD.mockRestore();
    expect(desktop.SYNC.status.error).toBe('');
    expect(desktop.SYNC.status.user?.uid).toBe(newUid);
    expect(planOf(desktop)).toEqual(planOf(phone));
    expect(desktop.S.workoutsOn()).toBe(true);
    // The devices already signed in keep syncing (same data key); signing in now takes the newest password.
    await on(phone, async () => {
      phone.S.setLog('2026-10-09', { e: 5, t: 'Recovered fine' });
      await phone.SYNC.syncNow();
      expect(phone.SYNC.status.error).toBe('');
      expect(phone.SYNC.status.locked).toBe(false);
    });
    await on(desktop, async () => {
      await desktop.SYNC.syncNow();
      expect(desktop.S.state.logs['2026-10-09']?.t).toBe('Recovered fine');
    });
    const other = await device('other');
    await other.SYNC.submit('in', { id: EMAIL, password: NEW_PW });
    expect(other.SYNC.status.error).toMatch(/Wrong email/);
    await other.SYNC.submit('in', { id: EMAIL, password: RECOVERED_PW });
    expect(other.SYNC.status.error).toBe('');
    expect(other.S.state.logs['2026-10-09']?.t).toBe('Recovered fine');
    expect(other.S.state.goals.map((g) => g.id)).toEqual(['fitness', 'spanish']);
  });

  it("gets the plan on a laptop whose sign-in had already run out (Firebase signs a deleted account's sessions out)", async () => {
    const { phone, laptop, finished, oldUid } = await setup();
    await deleteAndRecreate(phone);
    const newUid = phone.SYNC.status.user!.uid;
    const plan = planOf(phone);
    await on(laptop, async () => {
      // Within the hour Firebase notices the account is gone and ends the laptop's session.
      await laptop.FB.signOut();
      expect(laptop.SYNC.status.user).toBeNull();
      // Still the old account's sync info: nothing told this device the account was deleted.
      expect(JSON.parse(localStorage.getItem('arise-sync')!).uid).toBe(oldUid);
      const ask = vi.spyOn(window, 'confirm').mockReturnValue(true);
      await laptop.SYNC.submit('in', { id: EMAIL, password: NEW_PW });
      // The same question: its sync info still names the deleted account, with this email.
      expect(ask.mock.calls.map((c) => c[0])).toEqual([ADD]);
      ask.mockRestore();
      expect(laptop.SYNC.status.error).toBe('');
      expect(laptop.SYNC.status.user?.uid).toBe(newUid);
      expectSamePlan(laptop, plan, finished.id);
    });
    expect(paths().filter((p) => p.includes(oldUid))).toEqual([]);
  });

  it('keeps what the laptop did after the deletion: it goes into the account made again', async () => {
    const { phone, laptop, oldUid } = await setup();
    await deleteAndRecreate(phone);
    const newUid = phone.SYNC.status.user!.uid;
    await on(laptop, async () => {
      // A tick on the laptop that never reached any cloud copy (the account was already gone).
      laptop.S.tick('q4', { done: true }, '2026-10-09');
      await laptop.SYNC.syncNow();
      expect(laptop.SYNC.status.error).toMatch(/deleted on another device/);
      expect(laptop.S.state.checks['2026-10-09']?.q4?.done).toBe(true);
      expect(paths().filter((p) => p.includes(oldUid))).toEqual([]);
      const ask = vi.spyOn(window, 'confirm').mockReturnValue(true);
      await laptop.SYNC.submit('in', { id: EMAIL, password: NEW_PW });
      expect(ask.mock.calls.map((c) => c[0])).toEqual([ADD]);
      ask.mockRestore();
      expect(laptop.SYNC.status.error).toBe('');
      expect(laptop.SYNC.status.user?.uid).toBe(newUid);
      expect(laptop.S.state.checks['2026-10-09']?.q4?.done).toBe(true);
    });
    // And it reaches the phone, with nothing doubled.
    await on(phone, async () => {
      await phone.SYNC.syncNow();
      expect(phone.SYNC.status.error).toBe('');
      expect(phone.S.state.checks['2026-10-09']?.q4?.done).toBe(true);
      expect(phone.S.state.goals.map((g) => g.id)).toEqual(['fitness', 'spanish', 'money']);
      expect(planOf(phone)).toEqual(planOf(laptop));
    });
  });

  it("still asks when the laptop signs in to an account with another email (someone else's, as far as it can tell)", async () => {
    const { phone, laptop, plan, finished } = await setup();
    await deleteAndRecreate(phone);
    const other = await device('other');
    await other.SYNC.submit('up', { email: 'someone@example.com', password: NEW_PW, password2: NEW_PW });
    expect(other.SYNC.status.error).toBe('');
    await on(laptop, async () => {
      await laptop.SYNC.syncNow();
      expect(laptop.SYNC.status.error).toMatch(/deleted on another device/);
      const ask = vi.spyOn(window, 'confirm').mockReturnValue(false);
      await laptop.SYNC.submit('in', { id: 'someone@example.com', password: NEW_PW });
      expect(ask).toHaveBeenCalledTimes(1);
      expect(ask.mock.calls[0][0]).toBe(
        "This device has data from another account. Replace it with the data of someone@example.com? Some of it never reached the other account's cloud copy, so it would be lost. Save a backup first if you want to keep it.",
      );
      ask.mockRestore();
      // Cancel: nothing changes, it stays signed out with its plan.
      expect(laptop.SYNC.status.user).toBeNull();
      expectSamePlan(laptop, plan, finished.id);
    });
  });

  it('finishes a deletion whose reply was lost: the account is gone, the data on the phone stays, and making it again keeps the plan', async () => {
    const { phone, plan, finished, oldUid } = await setup();
    await on(phone, async () => {
      const ask = vi.spyOn(window, 'confirm').mockReturnValue(true);
      // Firebase deletes the login, but the reply never comes: still signed in, and it says so.
      cloud.hook = (op) => (op === 'deleteUser' ? 'lost' : undefined);
      await phone.SYNC.submit('delete', { password: PW });
      cloud.hook = null;
      expect(phone.SYNC.status.error).not.toBe('');
      expect(phone.SYNC.status.user?.uid).toBe(oldUid);
      expect(cloud.users.size).toBe(0);
      expect(JSON.parse(localStorage.getItem('arise-sync')!).deleting).toBe(oldUid);
      // Finishing it, under More, with the password: the login is gone, so nothing can check the
      // password, and there's nothing left to protect. It says what happened, not "wrong password".
      await phone.SYNC.submit('delete', { password: PW });
      ask.mockRestore();
      expect(phone.SYNC.status.error).toBe('');
      expect(document.querySelector('#toast')!.textContent).toBe('Your account was already deleted. The data on this device stays.');
      expect(phone.SYNC.status.user).toBeNull();
      expect(JSON.parse(localStorage.getItem('arise-sync')!)).toEqual({});
      expectSamePlan(phone, plan, finished.id);
    });
    expect(paths()).toEqual([]);

    // Making it again with the same email takes the plan, without a question.
    const ask = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await on(phone, () => phone.SYNC.submit('up', { email: EMAIL, password: NEW_PW, password2: NEW_PW }));
    expect(ask).not.toHaveBeenCalled();
    ask.mockRestore();
    expect(phone.SYNC.status.error).toBe('');
    expectSamePlan(phone, plan, finished.id);
    const tablet = await device('tablet');
    await tablet.SYNC.submit('in', { id: EMAIL, password: NEW_PW });
    expectSamePlan(tablet, plan, finished.id);
  });

  it('finishes a deletion whose reply was lost even with a mistyped password, and says the same', async () => {
    const { phone, oldUid } = await setup();
    await on(phone, async () => {
      const ask = vi.spyOn(window, 'confirm').mockReturnValue(true);
      cloud.hook = (op) => (op === 'deleteUser' ? 'lost' : undefined);
      await phone.SYNC.submit('delete', { password: PW });
      cloud.hook = null;
      expect(phone.SYNC.status.user?.uid).toBe(oldUid);
      await phone.SYNC.submit('delete', { password: 'not the password at all' });
      ask.mockRestore();
      expect(phone.SYNC.status.error).toBe('');
      expect(document.querySelector('#toast')!.textContent).toBe('Your account was already deleted. The data on this device stays.');
      expect(phone.SYNC.status.user).toBeNull();
    });
  });

  it("still says the password isn't right while the account exists", async () => {
    const { phone } = await setup();
    await on(phone, async () => {
      const ask = vi.spyOn(window, 'confirm').mockReturnValue(true);
      cloud.hook = (op, paths) => {
        if (op === 'commit' && paths.includes('keys')) throw Object.assign(new Error('offline'), { code: 'unavailable' });
      };
      await phone.SYNC.submit('delete', { password: PW }); // cut off after the data went, before the login
      cloud.hook = null;
      expect(cloud.users.size).toBe(1);
      await phone.SYNC.submit('delete', { password: 'not the password at all' });
      expect(phone.SYNC.status.error).toBe("That password isn't right.");
      expect(phone.SYNC.status.user).not.toBeNull();
      await phone.SYNC.submit('delete', { password: PW });
      ask.mockRestore();
      expect(phone.SYNC.status.error).toBe('');
      expect(document.querySelector('#toast')!.textContent).toBe('Account and cloud copy deleted.');
      expect(cloud.users.size).toBe(0);
      expect(paths()).toEqual([]);
    });
  });

  it("doesn't take a wrong password for a deleted login after the password was changed on another device", async () => {
    const { phone, laptop, oldUid } = await setup();
    // The laptop changes the password: Firebase ends the phone's session (it can't be renewed).
    await on(laptop, async () => {
      await laptop.SYNC.submit('password', { old: PW, password: NEW_PW, password2: NEW_PW });
      expect(laptop.SYNC.status.error).toBe('');
    });
    const before = paths();
    await on(phone, async () => {
      const ask = vi.spyOn(window, 'confirm').mockReturnValue(true);
      await phone.SYNC.submit('delete', { password: PW }); // the old password
      ask.mockRestore();
      // Renewing the session to check the login signed the phone out. It says so, and nothing went.
      expect(phone.SYNC.status.error).toBe('You were signed out on this device. Sign in again, then try again.');
      expect(phone.SYNC.status.user).toBeNull();
      expect(JSON.parse(localStorage.getItem('arise-sync')!).deleting).toBeUndefined();
    });
    expect(paths()).toEqual(before);
    expect(cloud.users.has(oldUid)).toBe(true);
    expect(cloud.docs.get(`recovery/${EMAIL}`)).toMatchObject({ uid: oldUid });
  });

  it("never deletes the recovery record of the account made again, even if it's made while a deleted login's leftovers go", async () => {
    const { phone, oldUid } = await setup();
    cloud.users.delete(oldUid); // the login is deleted in the Firebase console; its documents stay
    let made = false;
    await on(phone, async () => {
      const ask = vi.spyOn(window, 'confirm').mockReturnValue(true);
      cloud.hook = (op, p) => {
        // Firebase says outright that the signed-in login is gone (no email enumeration protection).
        if (op === 'reauth') throw Object.assign(new Error('user-mismatch'), { code: 'auth/user-mismatch' });
        // Just as the leftover keys and recovery record go, the email's account is made again elsewhere.
        if (op === 'commit' && p.includes('recovery/') && !made) {
          made = true;
          cloud.docs.set(`recovery/${EMAIL}`, { uid: 'uid9', auth: { iv: 'x', ct: 'y' } });
        }
      };
      await phone.SYNC.submit('delete', { password: PW });
      cloud.hook = null;
      ask.mockRestore();
      expect(phone.SYNC.status.error).toBe('');
      expect(document.querySelector('#toast')!.textContent).toBe('Your account was already deleted. The data on this device stays.');
    });
    expect(made).toBe(true);
    expect(cloud.docs.get(`recovery/${EMAIL}`)).toMatchObject({ uid: 'uid9' });
    expect(paths().filter((p) => p.includes(oldUid))).toEqual([]);
  });
});

describe("joining the account made again with a device that holds the deleted account's data", () => {
  it("keeps the laptop's newer goal and setting edits: the newer change wins, as when signing back in", async () => {
    const { phone, laptop } = await setup();
    // On the laptop, offline: a milestone done, a quest added and ticked, two settings changed.
    await on(laptop, () => {
      laptop.S.toggleMilestone('fitness', 'm1');
      const g = laptop.S.goalById('spanish')!;
      laptop.S.saveGoal({ ...g, quests: [...g.quests, { id: 'q9', title: 'Podcast', schedule: { kind: 'daily' }, created: '2026-10-08' }] });
      laptop.S.tick('q9', { done: true }, '2026-10-08');
      Object.assign(laptop.S.state.settings, { restBig: 200, remindAt: '05:45' });
      laptop.S.save();
    });
    await deleteAndRecreate(phone);
    const newUid = phone.SYNC.status.user!.uid;
    const check = (d: Device) => {
      expect(d.S.goalById('fitness')?.milestones.find((m) => m.id === 'm1')?.done).toBeTruthy();
      expect(d.S.goalById('fitness')?.milestones.find((m) => m.id === 'm2')?.done).toBeTruthy();
      expect(d.S.goalById('spanish')?.quests.map((q) => q.id)).toEqual(['q2', 'q3', 'q4', 'q9']);
      expect(d.S.state.checks['2026-10-08']?.q9?.done).toBe(true);
      expect(d.S.state.settings).toMatchObject({ restBig: 200, remindAt: '05:45', template: 'weekly', perWeek: 4 });
      expect(d.S.state.goals.map((g) => g.id)).toEqual(['fitness', 'spanish', 'money']);
    };
    await on(laptop, async () => {
      await laptop.SYNC.syncNow();
      expect(laptop.SYNC.status.error).toMatch(/deleted on another device/);
      const ask = vi.spyOn(window, 'confirm').mockReturnValue(true);
      await laptop.SYNC.submit('in', { id: EMAIL, password: NEW_PW });
      expect(ask.mock.calls.map((c) => c[0])).toEqual([ADD]);
      ask.mockRestore();
      expect(laptop.SYNC.status.error).toBe('');
      expect(laptop.SYNC.status.user?.uid).toBe(newUid);
      check(laptop);
    });
    await on(phone, async () => {
      await phone.SYNC.syncNow();
      expect(phone.SYNC.status.error).toBe('');
      check(phone);
      expect(planOf(phone)).toEqual(planOf(laptop));
    });
  });

  it("doesn't take a laptop that only ever took in the account's data, and fell behind, for the newer copy", async () => {
    const { phone, laptop } = await setup();
    // The phone changes a setting and a goal, and syncs. The laptop doesn't sync before the deletion.
    await on(phone, async () => {
      Object.assign(phone.S.state.settings, { restBig: 200 });
      phone.S.save();
      phone.S.saveGoal({ ...phone.S.goalById('money')!, title: 'Save $20,000' });
      await phone.SYNC.syncNow();
      expect(phone.SYNC.status.error).toBe('');
    });
    await deleteAndRecreate(phone);
    await on(laptop, async () => {
      await laptop.SYNC.syncNow();
      expect(laptop.SYNC.status.error).toMatch(/deleted on another device/);
      const ask = vi.spyOn(window, 'confirm').mockReturnValue(true);
      await laptop.SYNC.submit('in', { id: EMAIL, password: NEW_PW });
      ask.mockRestore();
      expect(laptop.SYNC.status.error).toBe('');
      // Its copy is the one from before those changes: the account's newer one wins.
      expect(laptop.S.state.settings.restBig).toBe(200);
      expect(laptop.S.goalById('money')?.title).toBe('Save $20,000');
      expect(planOf(laptop)).toEqual(planOf(phone));
    });
  });

  it('keeps the newest plan when a device that fell behind joins first (console deletion, account made again on a new device)', async () => {
    const { phone, laptop, oldUid } = await setup();
    // The laptop signs out and falls behind.
    await on(laptop, () => laptop.SYNC.handleAction('sync-out'));
    // The phone carries on: a goal renamed with a new quest, a milestone done, settings and the
    // profile changed. All of it synced.
    await on(phone, async () => {
      const g = phone.S.goalById('spanish')!;
      phone.S.saveGoal({ ...g, title: 'Speak Spanish', quests: [...g.quests, { id: 'q9', title: 'Podcast', schedule: { kind: 'daily' }, created: '2026-10-08' }] });
      phone.S.toggleMilestone('fitness', 'm1');
      phone.S.setTemplate('ab');
      Object.assign(phone.S.state.settings, { restBig: 200, remindAt: '05:45' });
      phone.S.save();
      phone.S.saveProfile({ goal: 'Get strong and speak Spanish' });
      await phone.SYNC.syncNow();
      expect(phone.SYNC.status.error).toBe('');
    });
    const newest = planOf(phone);
    // In the Firebase console: the login and every document deleted. The phone's session ends.
    cloud.users.delete(oldUid);
    cloud.docs.clear();
    await on(phone, () => phone.FB.signOut());
    // A brand-new tablet makes the account again: its cloud copy is blank.
    const tablet = await device('tablet');
    await tablet.SYNC.submit('up', { email: EMAIL, password: NEW_PW, password2: NEW_PW });
    expect(tablet.SYNC.status.error).toBe('');
    await tablet.SYNC.handleAction('sync-code-done');
    // The laptop joins first, then the phone. Both are asked, and both add their data.
    for (const d of [laptop, phone]) {
      await on(d, async () => {
        const ask = vi.spyOn(window, 'confirm').mockReturnValue(true);
        await d.SYNC.submit('in', { id: EMAIL, password: NEW_PW });
        expect(ask.mock.calls.map((c) => c[0])).toEqual([ADD]);
        ask.mockRestore();
        expect(d.SYNC.status.error).toBe('');
      });
    }
    // Every newer edit of the phone's is there, on every device.
    for (const d of [phone, laptop, tablet]) {
      await on(d, async () => {
        await d.SYNC.syncNow();
        expect(d.SYNC.status.error).toBe('');
        expect(d.S.goalById('spanish')?.title).toBe('Speak Spanish');
        expect(d.S.goalById('spanish')?.quests.map((q) => q.id)).toEqual(['q2', 'q3', 'q4', 'q9']);
        expect(d.S.goalById('fitness')?.milestones.find((m) => m.id === 'm1')?.done).toBeTruthy();
        expect(d.S.state.settings).toMatchObject({ restBig: 200, remindAt: '05:45', template: 'ab' });
        expect(d.S.state.profile?.goal).toBe('Get strong and speak Spanish');
        expect(planOf(d)).toEqual(newest);
      });
    }
  });

  it("asks first, since an email says nothing more about who signs in: Cancel keeps the data out of the account and on this device", async () => {
    // A family tablet with Alice's data on smiths@, deleted on her phone (the tablet was told).
    const alice = await device('alice-phone');
    alice.S.saveGoal({ id: 'a1', title: 'Alice: walk daily', category: 'fitness' });
    alice.S.state.ai.chat.push({ role: 'user', text: 'Alice private: my knee hurts', at: Date.now() });
    alice.S.save();
    await alice.SYNC.submit('up', { email: 'smiths@example.com', password: PW, password2: PW });
    await alice.SYNC.handleAction('sync-code-done');
    const tablet = await device('family-tablet');
    await tablet.SYNC.submit('in', { id: 'smiths@example.com', password: PW });
    expect(tablet.S.state.ai.chat).toHaveLength(1);
    await on(alice, async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      await alice.SYNC.submit('delete', { password: PW });
      vi.mocked(window.confirm).mockRestore();
      expect(alice.SYNC.status.error).toBe('');
    });
    await on(tablet, async () => {
      await tablet.SYNC.syncNow();
      expect(tablet.SYNC.status.error).toMatch(/deleted on another device/);
    });
    // Bob makes his own account with that address on his phone (Firebase never asks whose it is).
    const bob = await device('bob-phone');
    bob.S.saveGoal({ id: 'b1', title: 'Bob: lift', category: 'fitness' });
    await bob.SYNC.submit('up', { email: 'smiths@example.com', password: NEW_PW, password2: NEW_PW });
    await bob.SYNC.handleAction('sync-code-done');
    const bobRev = cloud.docs.get(`users/${bob.SYNC.status.user!.uid}/arise/meta`)!.rev;
    // Bob signs in on the tablet: asked, and Cancel leaves everything as it was.
    await on(tablet, async () => {
      const ask = vi.spyOn(window, 'confirm').mockReturnValue(false);
      await tablet.SYNC.submit('in', { id: 'smiths@example.com', password: NEW_PW });
      expect(ask.mock.calls.map((c) => c[0])).toEqual([ADD.replace(EMAIL, 'smiths@example.com')]);
      ask.mockRestore();
      expect(tablet.SYNC.status.error).toBe('');
      expect(tablet.SYNC.status.user).toBeNull();
      expect(tablet.S.state.goals.map((g) => g.id)).toEqual(['a1']);
      expect(tablet.S.state.ai.chat.map((m) => m.text)).toEqual(['Alice private: my knee hurts']);
    });
    expect(cloud.docs.get(`users/${bob.SYNC.status.user!.uid}/arise/meta`)!.rev).toBe(bobRev);
    await on(bob, async () => {
      await bob.SYNC.syncNow();
      expect(bob.S.state.goals.map((g) => g.id)).toEqual(['b1']);
      expect(bob.S.state.ai.chat).toEqual([]);
    });
  });
});
