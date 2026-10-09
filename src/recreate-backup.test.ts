// @vitest-environment jsdom
// Scenario C, the safety net: the owner deletes their Arise account (an email login) and makes it
// again with the same email, and the plan comes back from a backup file (Settings, Backup: "Save
// backup" / "Load backup") rather than from a device that still holds it.
//
// The cloud only ever holds ciphertext, and deleting the account removes even that, so after the
// deletion nothing in the cloud can bring the plan back: it comes back from the file.
//
//   1. The phone deletes the account in the app, is erased, loads the backup BEFORE the account
//      is made again, then makes it: the plan goes up with the sign-up, every device gets it.
//   2. A brand-new device makes the account first and loads the backup AFTER: the plan goes up
//      with the app's delayed push. The old phone (still holding the plan) then joins cleanly.
//   3. What the backup file carries and what it doesn't.
//   4. The trap: finishing the intro on the new device before loading the backup. The device is
//      then not empty, so the backup is only merged in, and some of the plan is lost.
//
// Harness: like recreate-inapp.test.ts (and sync.test.ts): several simulated devices, each with
// its own storage and its own copy of the app's modules, sharing one in-memory cloud that
// enforces the database rules. Each device also gets its own copy of the fake Firebase, so each
// has its own sign-in, like real devices. Timers are faked (setTimeout only), so the app's
// 8-second delayed push only runs when a test moves the clock.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cloud, resetCloud } from './test/fake-firebase';
import { normalizePlan } from './lib/clean';

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
  await A.load(() => {});
  const FB = (await import('./lib/firebase')) as unknown as Fake;
  await SYNC.initSync({ render: () => {}, changed: () => {}, checkForUpdate: () => {} });
  return { S, SYNC, FB, name };
}

async function on<T>(d: Device, fn: () => Promise<T> | T): Promise<T> {
  use(d.name);
  return fn();
}

const EMAIL = 'annolieberto@example.com';
const PW = 'correct horse battery'; // the account that gets deleted
const NEW_PW = 'a whole new long password'; // the account made again
const AI_KEY = 'sk-ant-api03-test-key-not-real-0123456789abcdef';
const session = (id: string, date = '2026-10-01') => ({ id, workout: 'back', date, started: 1, finished: 2, easy: false, items: [{ ex: 'band_row', setup: 'door anchor', sets: [{ r: 10, done: true }, { r: 9, done: true }] }] });
const cloudText = () => JSON.stringify([...cloud.docs.values()]);
const paths = () => [...cloud.docs.keys()].sort();
const metaOf = () => JSON.parse(localStorage.getItem('arise-sync') || '{}');

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
// Loading a backup into an empty device stamps every workout it brings in again (store.ts,
// importData), so those times differ from the phone's; the rest must be exactly the same.
function withoutSessionStamps(p: ReturnType<typeof planOf>) {
  const c = structuredClone(p);
  delete c.stamps.sessions;
  return c;
}

// The AI-made plan the coach's "personalise my plan" would apply (it is normalised the same way).
const CUSTOM_PLAN = normalizePlan({
  mode: 'rotation',
  workouts: {
    upper: { name: 'Upper at home', short: 'Upper', tag: 'Back, chest, arms', legs: false, slots: [{ ex: 'band_row', sets: 4, min: 8, max: 12 }, { ex: 'pike', sets: 3, min: 6, max: 10, note: 'Hips high' }] },
    lower: { name: 'Lower at home', short: 'Lower', tag: 'Legs and core', legs: true, slots: [{ ex: 'bulgarian', sets: 3, cut: 2, min: 8, max: 12 }, { ex: 'calf_raise', sets: 3, min: 12, max: 20 }] },
  },
  order: ['upper', 'lower'],
  perWeek: 4,
  summary: 'Two home sessions in turn, four a week.',
  changes: ['Fewer leg sets while cutting'],
});

// A full plan, built the way the app's screens build it. Returns the finished workout.
function buildPlan(S: Store) {
  // Workout history, an old easy week and when the workout plan was on (it was paused from 29
  // September to 1 October) from an earlier backup first: on an empty device that's a full restore.
  S.importData({
    sessions: [session('old1', '2026-09-28'), session('old2', '2026-09-30')],
    logs: { '2026-09-30': { e: 3, t: 'Tired but did it', at: 5 } },
    easyWeeks: ['2026-08-31'],
    stamps: { planDays: { '2026-09-27': 1, '2026-09-29': -1000, '2026-10-02': 2000 } },
  });
  S.saveProfile({ name: 'Anno', goal: 'Get strong', why: 'Feel good every day', deadline: 'June 2027', pullups: 3, pushups: 12, equipment: ['Resistance bands', 'Door anchor'], tone: ['The System (Solo Leveling)'], onboarded: true });
  // The home workout plan with settings that aren't the defaults.
  S.setTemplate('weekly');
  Object.assign(S.state.settings, { restBig: 150, restSmall: 45, bar: 'none', remindAt: '06:30', eveningAt: '21:15', sound: false, vibrate: false, evening: true, aiDaily: false, perWeek: 4 });
  // Device-only settings, and the AI coach's own key and consent (kept apart from the data).
  Object.assign(S.state.settings, { notify: true, aiProvider: 'anthropic', aiModel: 'claude-sonnet-4-5', aiEngine: 'own' });
  S.save();
  localStorage.setItem('arise-claude-key', AI_KEY);
  localStorage.setItem('arise-ai-consent', 'anthropic');
  // Goals: the fitness one uses the workout plan.
  S.saveGoal({
    id: 'fitness',
    title: 'Get strong',
    category: 'fitness',
    why: 'Feel good every day',
    by: 'June 2027',
    workouts: true,
    quests: [{ id: 'q1', title: 'Stretch', how: 'Hips and shoulders, slowly', schedule: { kind: 'daily' }, created: '2026-10-01' }],
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
      { id: 'q5', title: 'Old podcast', schedule: { kind: 'daily' }, created: '2026-09-20', archived: '2026-10-03' },
    ],
    measures: [{ id: 'words', name: 'Words known', unit: 'words', start: 100, target: 2000, better: 'up' }],
    milestones: [{ id: 'm3', title: 'Pass the A2 exam', due: '2027-03-01' }],
  });
  S.saveGoal({ id: 'money', title: 'Save $10,000', category: 'money', measures: [{ id: 'savings', name: 'Savings', unit: '$', start: 0, target: 10000, better: 'up' }] });
  S.saveGoal({ id: 'reading', title: 'Read 12 books', category: 'mind', status: 'paused', quests: [{ id: 'q6', title: 'Read', schedule: { kind: 'daily' }, amount: { target: 20, unit: 'pages' }, created: '2026-09-25' }] });
  S.saveGoal({ id: 'temp', title: 'A goal deleted again', category: 'other' });
  S.deleteGoal('temp');
  S.toggleMilestone('fitness', 'm2');
  // Ticks on a few days, measure values.
  S.tick('q1', { done: true }, '2026-10-06');
  S.tick('q2', { done: true, amount: 35 }, '2026-10-06');
  S.tick('q3', { done: true }, '2026-10-06');
  S.tick('q1', { done: true }, '2026-10-07');
  S.tick('q2', { done: false, amount: 10 }, '2026-10-07');
  S.tick('q4', { done: true }, '2026-10-07');
  S.tick('q6', { done: true, amount: 25 }, '2026-09-27');
  S.logValue('pushups', 21, '2026-10-05');
  S.logValue('words', 340, '2026-10-07');
  S.logValue('savings', 1250.5, '2026-10-07');
  // A finished workout, done the way the workout screen does it.
  S.startWorkout('back', { noBar: true });
  for (const it of S.state.active!.items) for (const set of it.sets) set.done = true;
  S.save();
  const finished = S.finishWorkout()!;
  // Then the coach's personalised plan.
  S.applyPlan(CUSTOM_PLAN);
  // The daily log, weigh-ins, a cut phase, a football day, a rest day, a snoozed easy week.
  S.setLog('2026-10-07', { e: 4, t: 'Felt strong today' });
  expect(S.addBodyEntry({ weight: 82.5, waist: 84 }, '2026-10-05')).toBe('saved');
  expect(S.addBodyEntry({ weight: 82.1, shoulders: 118 }, '2026-10-08')).toBe('saved');
  S.setPhase('cut');
  S.toggleFootball('2026-10-04');
  expect(S.toggleRest()).toBe(true);
  S.snoozeEasyWeek(7);
  // The coach: a chat, today's System message, nudges, usage counts.
  const now = Date.now();
  S.state.ai.chat.push({ role: 'user', text: 'How do I get my first pull-up?', at: now - 2000 }, { role: 'assistant', text: 'Negatives with the band, three times a week.', at: now - 1000 });
  S.state.ai.daily[S.todayKey()] = { message: 'Anno. The System sees you.', focus: 'Stretch first', at: now };
  S.state.ai.nudges = { messages: ['Stretch before bed'], at: now };
  Object.assign(S.state.ai.usage, { input: 1200, output: 800, calls: 3 });
  S.save();
  return finished;
}

// The parts a Player would look at, checked one by one, then everything else as a whole.
function expectPlan(d: Device, want: ReturnType<typeof planOf>, finishedId: string) {
  const got = planOf(d);
  expect(got.goals.map((g: { id: string }) => g.id)).toEqual(['fitness', 'spanish', 'money', 'reading']);
  expect(got.goals).toEqual(want.goals);
  expect(d.S.goalById('fitness')?.workouts).toBe(true);
  expect(d.S.workoutsOn()).toBe(true);
  expect(d.S.goalById('fitness')?.milestones.find((m) => m.id === 'm2')?.done).toBeTruthy();
  expect(d.S.goalById('fitness')?.quests[0].how).toBe('Hips and shoulders, slowly');
  expect(d.S.goalById('spanish')?.quests.map((q) => q.id)).toEqual(['q2', 'q3', 'q4', 'q5']);
  expect(d.S.goalById('spanish')?.quests[3].archived).toBe('2026-10-03');
  expect(d.S.goalById('reading')?.status).toBe('paused');
  expect(got.checks).toEqual(want.checks);
  expect(got.values).toEqual(want.values);
  expect(got.customPlan).toEqual(want.customPlan);
  expect(d.S.isCustomPlan()).toBe(true);
  expect(Object.keys(d.S.workouts())).toEqual(['upper', 'lower']);
  expect(got.settings).toEqual(want.settings);
  expect(got.settings).toMatchObject({ template: 'weekly', restBig: 150, restSmall: 45, bar: 'none', remindAt: '06:30', eveningAt: '21:15', sound: false, vibrate: false, aiDaily: false, perWeek: 4, name: 'Anno' });
  expect(got.sessions.map((s: { id: string }) => s.id)).toEqual(['old1', 'old2', finishedId]);
  expect(got.sessions).toEqual(want.sessions);
  expect(got.logs).toEqual(want.logs);
  expect(got.body).toEqual(want.body);
  expect(got.profile).toEqual(want.profile);
  expect(got.football).toEqual(['2026-10-04']);
  expect(got.rests).toEqual(want.rests);
  expect(got.easyWeeks).toEqual(['2026-08-31']);
  expect(got.easySnooze).toBe(want.easySnooze);
  expect(got.ai).toEqual(want.ai);
  expect(got.stamps.planDays).toEqual(want.stamps.planDays);
  expect(got.stamps.goals.temp).toBeLessThan(0); // the deleted goal stays deleted
  // Every workout is stamped as present (the times are new: see withoutSessionStamps).
  expect(Object.keys(got.stamps.sessions).sort()).toEqual(['old1', 'old2', finishedId].sort());
  expect(Object.values(got.stamps.sessions).every((t) => (t as number) > 0)).toBe(true);
  expect(withoutSessionStamps(got)).toEqual(withoutSessionStamps(want));
}

// How the plan reads day by day: whether training was asked, and the day's streak status.
function reading(d: Device) {
  const out: [string, boolean, string][] = [];
  for (let k = '2026-09-15'; k <= d.S.todayKey(); k = d.S.addDays(k, 1)) out.push([k, d.S.trainingAsked(k), d.S.dayStatus(k)]);
  return { days: out, streak: d.S.currentStreak(), perWeek: d.S.perWeek() };
}

// Settings, Backup, "Save backup": the file's text (app.js, case 'export').
const saveBackup = (d: Device) => on(d, () => JSON.stringify(d.S.exportData(), null, 2));
// Settings, Backup, "Load backup": the chosen file (app.js, the #importFile change handler).
const loadBackup = (d: Device, text: string) => on(d, () => d.S.importData(JSON.parse(text)));
// The intro's "Skip" (system.js, 'skip-all'). It shows on an empty device and after "Erase all data".
const skipIntro = (d: Device) => on(d, () => d.S.saveProfile({ skipped: true }));

// Account, More, "Delete my account and cloud copy" on the phone.
async function deleteInApp(phone: Device) {
  await on(phone, async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await phone.SYNC.submit('delete', { password: PW });
    vi.mocked(window.confirm).mockRestore();
    expect(phone.SYNC.status.error).toBe('');
    expect(phone.SYNC.status.user).toBeNull();
  });
  // Nothing left in the cloud: no data, no keys, no recovery record, no login.
  expect(cloud.docs.size).toBe(0);
  expect(cloud.users.size).toBe(0);
}

// Settings, "Erase all data" while signed out (app.js, case 'reset': both questions answered OK).
async function eraseAllData(d: Device) {
  await on(d, async () => {
    expect(d.SYNC.status.user).toBeNull();
    expect(await d.SYNC.eraseThisDevice()).toBe(true);
    localStorage.removeItem('arise-claude-key'); // forgetAIKey('')
    localStorage.removeItem('arise-ai-consent'); // AI.forgetConsent()
  });
}

// Account, "Create account" with the same email and a new password. Returns the questions asked.
async function makeAccountAgain(d: Device) {
  return on(d, async () => {
    const ask = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await d.SYNC.submit('up', { email: EMAIL, password: NEW_PW, password2: NEW_PW });
    const asked = ask.mock.calls.map((c) => c[0]);
    ask.mockRestore();
    expect(d.SYNC.status.error).toBe('');
    expect(d.SYNC.status.user).toMatchObject({ id: EMAIL, email: EMAIL });
    expect(d.SYNC.status.pending?.recoveryCode).toMatch(/^([0-9A-Z]{4}-){7}[0-9A-Z]{4}$/);
    await d.SYNC.handleAction('sync-code-done');
    return asked;
  });
}

// Sign in on a device; returns the questions asked (answered `answer`).
async function signIn(d: Device, password: string, answer = false) {
  return on(d, async () => {
    const ask = vi.spyOn(window, 'confirm').mockReturnValue(answer);
    await d.SYNC.submit('in', { id: EMAIL, password });
    const asked = ask.mock.calls.map((c) => c[0]);
    ask.mockRestore();
    return asked;
  });
}

const SECRETS = ['Spanish', 'Felt strong', 'Get strong', 'Stretch', 'band_row', 'Anno', 'pull-up', 'Upper at home', 'The System sees you', PW, NEW_PW, AI_KEY];

// The phone with the full plan and the old account; the laptop signed in to it and synced.
async function setup() {
  const phone = await device('phone');
  const finished = buildPlan(phone.S);
  await phone.SYNC.submit('up', { email: EMAIL, password: PW, password2: PW });
  expect(phone.SYNC.status.error).toBe('');
  await phone.SYNC.handleAction('sync-code-done');
  const oldUid = phone.SYNC.status.user!.uid;
  const laptop = await device('laptop');
  expect(await signIn(laptop, PW)).toEqual([]);
  expect(laptop.SYNC.status.error).toBe('');
  expect(planOf(laptop)).toEqual(planOf(phone));
  return { phone, laptop, finished, oldUid };
}

beforeEach(() => {
  resetCloud();
  storage.clear();
  current = '';
  localStorage.clear();
  document.body.innerHTML = '<div id="sheet" hidden><div class="sheet-panel"><button class="sheet-close"></button><div class="sheet-body"></div></div></div><div id="toast"></div><main id="app"></main><nav id="tabs"></nav>';
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Scenario C: deleting the account and making it again, with the plan in a backup file', () => {
  it('BEFORE: the erased phone loads the backup, then makes the account again; the plan goes up with it and every device gets it', async () => {
    const { phone, laptop, finished, oldUid } = await setup();
    const backup = await saveBackup(phone);
    const plan = planOf(phone); // the plan as the file has it
    // Done after the backup was saved: the file doesn't have it.
    await on(phone, async () => {
      phone.S.tick('q4', { done: true }, '2026-10-08');
      await phone.SYNC.syncNow();
    });

    await deleteInApp(phone);
    await eraseAllData(phone);
    await on(phone, () => {
      expect(phone.S.isEmpty()).toBe(true);
      expect(phone.S.state.goals).toEqual([]);
      expect(phone.S.state.sessions).toEqual([]);
      expect(metaOf()).toEqual({});
    });
    await skipIntro(phone);

    // Load backup.
    expect(await loadBackup(phone, backup)).toBe(3); // "Backup loaded: 3 new workouts added."
    expectPlan(phone, plan, finished.id);
    expect(phone.S.state.checks['2026-10-08']).toBeUndefined(); // the tick made after saving the backup
    // This device's own: the AI service and notifications aren't taken from the file, the key never was in it.
    expect(phone.S.state.settings).toMatchObject({ notify: false, aiProvider: '', aiModel: '', aiEngine: '' });
    await on(phone, () => expect(localStorage.getItem('arise-claude-key')).toBeNull());
    expect(phone.S.state.ai.usage).toMatchObject({ input: 1200, output: 800, calls: 3 }); // usage counts come with the file

    // Create the account again: no question (the data on the phone belongs to no account).
    expect(await makeAccountAgain(phone)).toEqual([]);
    const newUid = phone.SYNC.status.user!.uid;
    expect(newUid).not.toBe(oldUid);
    expectPlan(phone, plan, finished.id);
    // The plan is in the new account's cloud copy, encrypted, and the phone is in step with it.
    expect(paths()).toEqual([`recovery/${EMAIL}`, `users/${newUid}/arise/keys`, `users/${newUid}/arise/meta`, `users/${newUid}/arise/part0`]);
    for (const secret of SECRETS) expect(cloudText()).not.toContain(secret);
    await on(phone, () => {
      const meta = metaOf();
      expect(meta).toMatchObject({ uid: newUid, login: EMAIL, rev: cloud.docs.get(`users/${newUid}/arise/meta`)!.rev });
      expect(meta.joining).toBeUndefined();
    });

    // A brand-new tablet signs in with the new password: the whole plan, no question.
    const tablet = await device('tablet');
    expect(await signIn(tablet, PW)).toEqual([]);
    expect(tablet.SYNC.status.error).toMatch(/Wrong email/);
    expect(await signIn(tablet, NEW_PW)).toEqual([]);
    expect(tablet.SYNC.status.error).toBe('');
    expect(tablet.SYNC.status.user?.uid).toBe(newUid);
    expect(planOf(tablet)).toEqual(planOf(phone));
    expectPlan(tablet, plan, finished.id);

    // The laptop, still holding the deleted account: signed out on its next sync (data kept), then
    // signs in to the account made again; OK to the question gives it the account's plan.
    await on(laptop, async () => {
      await laptop.SYNC.syncNow();
      expect(laptop.SYNC.status.user).toBeNull();
      expect(laptop.SYNC.status.error).toMatch(/deleted on another device/);
    });
    const asked = await signIn(laptop, NEW_PW, true);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/^This device has data from another account\. Replace it with the data of annolieberto@example\.com\?/);
    expect(laptop.SYNC.status.error).toBe('');
    expect(laptop.SYNC.status.user?.uid).toBe(newUid);
    expect(planOf(laptop)).toEqual(planOf(phone));
    expect(paths().filter((p) => p.includes(oldUid))).toEqual([]);

    // And it all keeps syncing: a tick on the tablet reaches the phone and the laptop.
    await on(tablet, async () => {
      tablet.S.tick('q1', { done: true }, '2026-10-09');
      await tablet.SYNC.syncNow();
      expect(tablet.SYNC.status.error).toBe('');
    });
    for (const d of [phone, laptop]) {
      await on(d, async () => {
        await d.SYNC.syncNow();
        expect(d.SYNC.status.error).toBe('');
        expect(d.S.state.checks['2026-10-09']?.q1?.done).toBe(true);
        expect(planOf(d)).toEqual(planOf(tablet));
      });
    }
  });

  it('AFTER: a brand-new device makes the account again, then loads the backup; the delayed push sends the plan up and every device gets it', async () => {
    const { phone, finished, oldUid } = await setup();
    const backup = await saveBackup(phone);
    const plan = planOf(phone);
    await deleteInApp(phone);

    const fresh = await device('newphone');
    await skipIntro(fresh);
    expect(await makeAccountAgain(fresh)).toEqual([]);
    const newUid = fresh.SYNC.status.user!.uid;
    expect(newUid).not.toBe(oldUid);
    // The new account starts with this device's empty copy.
    const blankRev = cloud.docs.get(`users/${newUid}/arise/meta`)!.rev;
    expect(fresh.S.state.goals).toEqual([]);

    // Load backup, while signed in: the device is still empty, so it's a full restore.
    expect(await on(fresh, () => fresh.S.isEmpty())).toBe(true);
    expect(await loadBackup(fresh, backup)).toBe(3);
    expectPlan(fresh, plan, finished.id);
    expect(fresh.S.state.settings).toMatchObject({ notify: false, aiProvider: '', aiEngine: '' });

    // Not in the cloud yet: the app sends changes up once things are quiet for 8 seconds.
    expect(cloud.docs.get(`users/${newUid}/arise/meta`)!.rev).toBe(blankRev);
    await on(fresh, async () => {
      await vi.advanceTimersByTimeAsync(8000);
      await vi.waitFor(() => expect(cloud.docs.get(`users/${newUid}/arise/meta`)!.rev).not.toBe(blankRev), { timeout: 5000 });
      await vi.waitFor(() => expect(fresh.SYNC.status.busy).toBe(false), { timeout: 5000 });
      expect(fresh.SYNC.status.error).toBe('');
      expect(metaOf()).toMatchObject({ uid: newUid, rev: cloud.docs.get(`users/${newUid}/arise/meta`)!.rev });
    });
    expect(paths()).toEqual([`recovery/${EMAIL}`, `users/${newUid}/arise/keys`, `users/${newUid}/arise/meta`, `users/${newUid}/arise/part0`]);
    for (const secret of SECRETS) expect(cloudText()).not.toContain(secret);

    // Another device signs in: the whole plan.
    const tablet = await device('tablet');
    expect(await signIn(tablet, NEW_PW)).toEqual([]);
    expect(tablet.SYNC.status.error).toBe('');
    expect(planOf(tablet)).toEqual(planOf(fresh));
    expectPlan(tablet, plan, finished.id);

    // The old phone, which kept the plan when it deleted the account, signs in too: no question
    // (its data belongs to no account now), and nothing is doubled.
    expect(await signIn(phone, NEW_PW)).toEqual([]);
    expect(phone.SYNC.status.error).toBe('');
    expect(phone.SYNC.status.user?.uid).toBe(newUid);
    expect(phone.S.state.goals.map((g) => g.id)).toEqual(['fitness', 'spanish', 'money', 'reading']);
    expect(phone.S.state.sessions.map((s) => s.id)).toEqual(['old1', 'old2', finished.id]);
    expect(phone.S.state.ai.chat).toHaveLength(2);
    // Its first sign-in splices its record of when the workout plan was on with the account's
    // (lib/merge.ts, splicePlanDays). That adds notes for the two days before the account's first
    // day, which only repeat what the record said already: every day reads the same as before.
    const merged = planOf(phone);
    const account = planOf(fresh);
    expect(Object.entries(merged.stamps.planDays).filter(([k]) => !(k in account.stamps.planDays))).toEqual([
      ['2026-09-19', 1],
      ['2026-09-20', 1],
    ]);
    delete merged.stamps.planDays;
    delete account.stamps.planDays;
    expect(merged).toEqual(account);
    expect(reading(phone)).toEqual(reading(fresh));
    for (const d of [fresh, tablet]) {
      await on(d, async () => {
        await d.SYNC.syncNow();
        expect(d.SYNC.status.error).toBe('');
      });
    }
    expect(planOf(phone)).toEqual(planOf(fresh));
    expect(planOf(tablet)).toEqual(planOf(fresh));
  });

  it('the backup file carries the whole plan; not the AI key, the AI service choice, notifications on/off, or a workout in progress', async () => {
    const phone = await device('phone');
    const finished = buildPlan(phone.S);
    const plan = planOf(phone);
    const usage = structuredClone(phone.S.state.ai.usage);
    // A workout in progress when the backup is saved.
    phone.S.startWorkout('upper');
    expect(phone.S.state.active).toBeTruthy();
    const text = await saveBackup(phone);
    const file = JSON.parse(text);

    // What's in the file: every part of the data except the workout in progress.
    expect(Object.keys(file).sort()).toEqual(['ai', 'app', 'body', 'checks', 'customPlan', 'easySnooze', 'easyWeeks', 'exported', 'football', 'goals', 'logs', 'profile', 'rests', 'sessions', 'settings', 'stamps', 'updatedAt', 'v', 'values']);
    expect(file.app).toBe('physical-improvement-tracker');
    expect(file.active).toBeUndefined();
    expect(file.stamps.planDays).toEqual(plan.stamps.planDays); // when the workout plan was on
    expect(Object.keys(file.stamps.planDays).length).toBeGreaterThan(0);
    expect(file.checks).toEqual(plan.checks); // the check-ins (quest ticks)
    expect(file.ai.chat).toHaveLength(2); // the coach chat
    expect(file.goals).toHaveLength(4);
    // Not in it: the AI key, the account (password, recovery code, sign-in), the sync info.
    expect(text).not.toContain(AI_KEY);
    expect(text).not.toMatch(/recovery|arise-sync|password/i);
    // The device-only settings are in the file, but loading never applies them (see below).
    expect(file.settings).toMatchObject({ notify: true, aiProvider: 'anthropic', aiModel: 'claude-sonnet-4-5', aiEngine: 'own' });

    const tablet = await device('tablet');
    await skipIntro(tablet);
    expect(await loadBackup(tablet, text)).toBe(3);
    expectPlan(tablet, plan, finished.id);
    expect(tablet.S.state.active).toBeNull(); // the workout in progress stayed on the phone
    expect(tablet.S.state.settings).toMatchObject({ notify: false, aiProvider: '', aiModel: '', aiBase: '', aiEngine: '' });
    expect(tablet.S.state.ai.usage).toEqual(usage);
    await on(tablet, () => {
      expect(localStorage.getItem('arise-claude-key')).toBeNull();
      expect(localStorage.getItem('arise-ai-consent')).toBeNull();
    });
    // The streak and each past day read the same as on the phone (the plan-day history came along:
    // no training asked while the plan was paused, 29 September to 1 October).
    expect(reading(tablet)).toEqual(reading(phone));
    expect(reading(tablet).days.filter(([k]) => k >= '2026-09-28' && k <= '2026-10-02').map(([k, asked]) => [k, asked])).toEqual([
      ['2026-09-28', true],
      ['2026-09-29', false],
      ['2026-09-30', false],
      ['2026-10-01', false],
      ['2026-10-02', true],
    ]);
    expect(reading(tablet).perWeek).toBe(4);
  });

  it('the trap: after finishing the intro on the new device, the backup is only merged in and part of the plan is lost', async () => {
    const phone = await device('phone');
    const finished = buildPlan(phone.S);
    const plan = planOf(phone);
    const backup = await saveBackup(phone);

    // A new device: the intro is gone through instead of skipped (fitness, with the workout plan).
    const fresh = await device('newphone');
    await on(fresh, () => {
      const S = fresh.S;
      S.state.settings.perWeek = 5;
      const g = S.saveGoal({ id: S.uid(), title: 'Get strong again', category: 'fitness', why: '', by: '', workouts: true, quests: [{ id: S.uid(), title: 'Walk', schedule: { kind: 'daily' }, amount: { target: 30, unit: 'min' }, created: S.todayKey() }] })!;
      S.markIntroGoal(g);
      S.saveProfile({ name: 'Anno', goal: 'Get strong again', why: '', deadline: '', obstaclesNote: '' });
      expect(S.isEmpty()).toBe(false);
    });
    const introGoal = fresh.S.state.goals[0];

    expect(await loadBackup(fresh, backup)).toBe(3);
    const got = planOf(fresh);
    // What does come in: every goal, workout, tick, value, log, weigh-in, day, and the custom plan.
    expect(got.goals.map((g: { id: string }) => g.id)).toEqual([introGoal.id, 'fitness', 'spanish', 'money', 'reading']);
    expect(got.sessions.map((s: { id: string }) => s.id)).toEqual(['old1', 'old2', finished.id]);
    expect(got.checks).toEqual(plan.checks);
    expect(got.values).toEqual(plan.values);
    expect(got.logs).toEqual(plan.logs);
    expect(got.body.entries).toEqual(plan.body.entries);
    expect(got.body.phase).toBe('cut');
    expect(got.football).toEqual(plan.football);
    expect(got.rests).toEqual(plan.rests);
    expect(got.easyWeeks).toEqual(plan.easyWeeks);
    expect(got.customPlan).toEqual(plan.customPlan);
    expect(fresh.S.goalById('temp')).toBeNull(); // the deleted goal doesn't come back

    // What's lost (store.ts importData keeps "this device's own plan and settings" when it isn't empty):
    // - the workout plan stays on the intro's goal; the real fitness goal comes in without it;
    expect(fresh.S.goalById('fitness')?.workouts).toBeUndefined();
    expect(fresh.S.goalById(introGoal.id)?.workouts).toBe(true);
    // - every setting: rest times, bar, reminder times, sound, the template, sessions a week;
    expect(got.settings).toMatchObject({ restBig: 120, restSmall: 60, bar: 'home', remindAt: '07:00', eveningAt: '20:30', sound: true, vibrate: true, aiDaily: true, template: 'ab', perWeek: 5 });
    expect(got.settings).not.toEqual(plan.settings);
    // - the profile (the why, deadline, numbers and answers from the first intro);
    expect(got.profile.goal).toBe('Get strong again');
    expect(got.profile.why).toBe('');
    expect(got.profile).not.toMatchObject({ deadline: 'June 2027', pullups: 3 });
    // - the coach chat, today's System message and the nudges; the easy-week snooze.
    expect(got.ai.chat).toEqual([]);
    expect(got.ai.daily).toEqual({});
    expect(got.ai.nudges).toBeNull();
    expect(got.easySnooze).toBeNull();
    expect(plan.ai.chat).toHaveLength(2);
    expect(plan.easySnooze).toBeTruthy();
  });
});
