// @vitest-environment jsdom
// Turning the app lock on and off in Settings, "Forgot your passcode?", and that the lock never
// reaches another device through the account.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cloud, resetCloud } from './test/fake-firebase';

vi.mock('./lib/firebase', () => import('./test/fake-firebase'));
// Fewer key-stretching rounds for the account, so the tests run in seconds.
vi.mock('./lib/crypto', async (orig) => {
  const real = await orig<typeof import('./lib/crypto')>();
  return { ...real, deriveMaster: (p: string, id: string) => real.deriveMaster(p, id, 1000) };
});

type Store = typeof import('./store');
type Lock = typeof import('./lib/lock');
type Sync = typeof import('./sync');

const PW = 'correct horse battery';
const session = (id: string, date = '2026-10-01') => ({ id, workout: 'a', date, started: 1, finished: 2, easy: false, items: [{ ex: 'band_row', setup: '', sets: [{ r: 10, done: true }] }] });
const HTML = '<nav id="tabs"></nav><main id="app"></main><div id="restbar" hidden></div><div id="sheet" hidden><div class="sheet-backdrop"></div><div class="sheet-panel"><button class="sheet-close"></button><div class="sheet-body"></div></div></div><div id="toast"></div><input type="file" id="importFile" hidden>';

// Starts the app on `view` with this saved data, and the app lock on (passcode 1234) if asked.
async function boot(view: string, data: object, lock = false) {
  vi.resetModules();
  localStorage.clear();
  localStorage.setItem('pit-data-v1', JSON.stringify(data));
  localStorage.setItem('arise-version-seen', (await import('./update')).VERSION); // no What's new
  document.body.innerHTML = HTML;
  history.replaceState(null, '', `#${view}`);
  const L: Lock = await import('./lib/lock');
  if (lock) await L.turnOn('1234', { away: 1 });
  const S: Store = await import('./store');
  await import('./app.js');
  const SYNC: Sync = await import('./sync');
  return { S, L, SYNC };
}

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;
const lockEl = () => document.getElementById('lock');
const locked = () => !!lockEl() && !lockEl()!.hidden;
const waitFor = (fn: () => void) => vi.waitFor(fn, { timeout: 5000, interval: 20 });
const fill = (sel: string, v: string) => (($(sel) as HTMLInputElement).value = v);

let asked: string[] = [];
let answers: boolean[] = [];

beforeEach(() => {
  resetCloud();
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  asked = [];
  answers = [];
  window.confirm = (m?: string) => {
    asked.push(String(m));
    return answers.shift() ?? false;
  };
});

describe('App lock in Settings', () => {
  it('is off at first, needs the passcode twice to turn on, and the passcode to turn off', async () => {
    const { L } = await boot('settings', { sessions: [], profile: { onboarded: true } });
    expect(L.isOn()).toBe(false);
    const panel = $('#lockPanel');
    expect(panel.textContent).toContain("The lock keeps people out of the app. It doesn't encrypt what's saved on this device.");
    expect($('[data-act="lock-toggle"]').getAttribute('aria-pressed')).toBe('false');

    $('[data-act="lock-toggle"]').click();
    await waitFor(() => expect($('#lockNew')).not.toBe(null));
    fill('#lockNew', '12');
    fill('#lockNew2', '12');
    $('[data-act="lock-on"]').click();
    await waitFor(() => expect($('#lockErr').textContent).toBe('The passcode needs 4 to 8 digits.'));
    fill('#lockNew', '2580');
    fill('#lockNew2', '2589');
    $('[data-act="lock-on"]').click();
    await waitFor(() => expect($('#lockErr').textContent).toBe("The two passcodes don't match."));
    expect(L.isOn()).toBe(false);
    fill('#lockNew2', '2580');
    $('[data-act="lock-on"]').click();
    await waitFor(() => expect(L.isOn()).toBe(true));
    expect(L.read()).toMatchObject({ digits: 4, away: 1, bio: '' });
    await waitFor(() => expect($('#toast').textContent).toBe('App lock is on.'));
    expect($('#sheet').hidden).toBe(true);

    // How long away before it asks again.
    expect([...document.querySelectorAll('[data-act="lock-away"]')].map((b) => b.textContent)).toEqual(['Right away', '1 min', '5 min', '15 min']);
    $('[data-act="lock-away"][data-v="15"]').click();
    await waitFor(() => expect(L.read()!.away).toBe(15));

    // Off needs the passcode.
    $('[data-act="lock-toggle"]').click();
    await waitFor(() => expect($('#lockOld')).not.toBe(null));
    fill('#lockOld', '1111');
    $('[data-act="lock-off"]').click();
    await waitFor(() => expect($('#lockErr').textContent).toBe('Wrong passcode.'));
    expect(L.isOn()).toBe(true);
    fill('#lockOld', '2580');
    $('[data-act="lock-off"]').click();
    await waitFor(() => expect(L.isOn()).toBe(false));
    expect(localStorage.getItem(L.KEY)).toBe(null);
  });
});

describe('Forgot your passcode?', () => {
  it("not signed in: says the data will be lost and can't be saved first, and erases it all only when sure", async () => {
    const { S, L } = await boot('today', { sessions: [session('s1')], profile: { onboarded: true } }, true);
    expect(locked()).toBe(true);

    // Cancelled: nothing happens.
    ($('#lock [data-k="forgot"]') as HTMLElement).click();
    await waitFor(() => expect(asked).toHaveLength(1));
    expect(asked[0]).toContain("You're not signed in, so your data is only on this device.");
    expect(asked[0]).toContain("A backup can't be saved while Arise is locked.");
    expect(locked()).toBe(true);
    expect(S.state.sessions).toHaveLength(1);

    // Yes, then not sure after all: still nothing.
    answers = [true, false];
    ($('#lock [data-k="forgot"]') as HTMLElement).click();
    await waitFor(() => expect(asked).toHaveLength(3));
    expect(asked[2]).toContain('Everything in Arise on this device will be lost.');
    expect(locked()).toBe(true);
    expect(S.state.sessions).toHaveLength(1);

    answers = [true, true];
    ($('#lock [data-k="forgot"]') as HTMLElement).click();
    await waitFor(() => expect(locked()).toBe(false));
    expect(S.state.sessions).toEqual([]);
    expect(L.isOn()).toBe(false);
    // A fresh start: the intro, with the app behind it inert.
    expect(document.body.classList.contains('onboarding')).toBe(true);
    expect($('#app').hasAttribute('inert')).toBe(true);
    expect($('#onboard').hasAttribute('inert')).toBe(false);
  });

  it('signed in: signs out and erases this device, and the data stays in the account', async () => {
    const { S, L, SYNC } = await boot('today', { sessions: [session('s1')], profile: { onboarded: true } }, true);
    await SYNC.submit('up', { email: 'me@example.com', password: PW, password2: PW });
    expect(SYNC.status.user).not.toBe(null);
    answers = [true];
    ($('#lock [data-k="forgot"]') as HTMLElement).click();
    await waitFor(() => expect(locked()).toBe(false));
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('Your data stays in your account, end-to-end encrypted. Sign in again to get it back.');
    expect(SYNC.status.user).toBe(null);
    expect(S.state.sessions).toEqual([]);
    expect(L.isOn()).toBe(false);
    expect([...cloud.docs.keys()]).toContain('users/uid1/arise/part0');

    // Signing in again brings the data back, with no lock.
    await SYNC.submit('in', { id: 'me@example.com', password: PW });
    expect(S.state.sessions.map((s) => s.id)).toEqual(['s1']);
    expect(L.isOn()).toBe(false);
  });

  it('turns the lock off with "Erase all data" too', async () => {
    const { L } = await boot('settings', { sessions: [session('s1')], profile: { onboarded: true } });
    await L.turnOn('1234');
    answers = [true, true];
    $('[data-act="reset"]').click();
    await waitFor(() => expect(L.isOn()).toBe(false));
  });
});

describe('another device', () => {
  const storage = new Map<string, Map<string, string>>();
  let current = '';
  const devices: Sync[] = [];
  // This device's own storage and a fresh copy of the modules (see sync.test.ts).
  async function device(name: string) {
    if (current) storage.set(current, new Map(Object.entries({ ...localStorage })));
    localStorage.clear();
    for (const [k, v] of storage.get(name) || []) localStorage.setItem(k, v);
    current = name;
    vi.resetModules();
    document.body.innerHTML = HTML;
    const S: Store = await import('./store');
    const SYNC: Sync = await import('./sync');
    const L: Lock = await import('./lib/lock');
    await SYNC.initSync({ render: () => {}, changed: () => {}, checkForUpdate: () => {} });
    devices.push(SYNC);
    return { S, SYNC, L };
  }
  afterEach(() => {
    for (const d of devices.splice(0)) d.status.user = null;
  });

  it("doesn't get the lock through the account", async () => {
    const phone = await device('phone');
    await phone.L.turnOn('1234', { away: 0 });
    phone.S.importData({ sessions: [session('s1')] });
    await phone.SYNC.submit('up', { email: 'me@example.com', password: PW, password2: PW });
    expect(phone.L.isOn()).toBe(true);

    const laptop = await device('laptop');
    await laptop.SYNC.submit('in', { id: 'me@example.com', password: PW });
    expect(laptop.S.state.sessions.map((s) => s.id)).toEqual(['s1']);
    expect(laptop.L.isOn()).toBe(false);
    expect(localStorage.getItem('arise-lock')).toBe(null);
    expect(JSON.stringify(laptop.S.state)).not.toMatch(/lock/i);
  });
});
