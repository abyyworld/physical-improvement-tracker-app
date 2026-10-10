// @vitest-environment jsdom
// The two kinds of email account, end to end: Recovery code (most private, the default) and
// Email reset (easier: the keys document also holds the data key itself, so a password set from
// Firebase's reset email can open the data). Several simulated devices (each its own copy of the
// app's modules and its own storage) share one in-memory cloud that enforces the database rules.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cloud, resetCloud, setPasswordFromResetPage } from './test/fake-firebase';

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
  F: Fake; // the fake Firebase (its rules check the sign-in of the device that loaded it last)
  name: string;
}

const storage = new Map<string, Map<string, string>>();
let current = '';
const devices: Device[] = [];

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
  const F = (await import('./lib/firebase')) as unknown as Fake;
  await SYNC.initSync({ render: () => {}, changed: () => {}, checkForUpdate: () => {} });
  const d = { S, SYNC, F, name };
  devices.push(d);
  return d;
}

const PW = 'correct horse battery';
const NEW = 'a brand new password';
const EMAIL = 'me@example.com';
const KEYS = 'users/uid1/arise/keys';
const REC = `recovery/${EMAIL}`;
const session = (id: string, date = '2026-10-01') => ({ id, workout: 'a', date, started: 1, finished: 2, easy: false, items: [{ ex: 'band_row', setup: '', sets: [{ r: 10, done: true }] }] });
const journal = { '2026-10-01': { t: 'my secret journal entry', at: 1 } };
const cloudText = () => JSON.stringify([...cloud.docs.values()]);
const doc = (path: string) => cloud.docs.get(path) as Record<string, unknown> | undefined;
const toastText = () => document.querySelector('#toast')!.textContent;
const sheetText = () => document.querySelector('.sheet-body')!.textContent || '';
const button = (v: string) => {
  const b = document.createElement('button');
  b.dataset.v = v;
  return b;
};
const RESET_SENT = "Check your email for a link to set a new password. If nothing arrives in a few minutes, check spam, and check it's the email you made the account with. Then sign in here with the new password.";

// What each sign-in sends to Firebase as the password.
function watchSignIns() {
  const sent: string[] = [];
  cloud.hook = (op, value) => {
    if (op === 'signIn') sent.push(value);
  };
  return sent;
}

async function emailResetAccount() {
  const a = await device('phone');
  a.S.importData({ sessions: [session('s1')], logs: journal });
  await a.SYNC.submit('up', { email: EMAIL, password: PW, password2: PW, way: 'email' });
  expect(a.SYNC.status.error).toBe('');
  return a;
}

beforeEach(() => {
  resetCloud();
  storage.clear();
  current = '';
  localStorage.clear();
  document.body.innerHTML = '<div id="sheet" hidden><div class="sheet-panel"><button class="sheet-close"></button><div class="sheet-body"></div></div></div><div id="toast"></div><main id="app"></main><nav id="tabs"></nav>';
});

afterEach(() => {
  cloud.hook = null;
  for (const d of devices.splice(0)) d.SYNC.status.user = null;
});

describe('signing up', () => {
  it('offers the choice with an email, Recovery code first, and a Learn more that compares them', async () => {
    const a = await device('phone');
    a.SYNC.status.form = 'up';
    const form = a.SYNC.panel();
    expect(form).toMatch(/name="way" value="code" checked/);
    expect(form).toMatch(/name="way" value="email" >/);
    expect(form).toContain('Recovery code (most private)');
    expect(form).toContain('Email reset (easier)');
    expect(form).toContain('If you forget your password, we email you a link. To make that work, your account keeps a copy of its key in the cloud, so Google (who host it) and the people who run Arise could read your data if they chose to.');
    expect(form).toContain('class="learn-more" type="button" data-act="sync-learn"');
    await a.SYNC.handleAction('sync-learn');
    expect(sheetText()).toContain('Recovery code (most private)');
    expect(sheetText()).toContain('Email reset (easier)');
    expect(sheetText()).not.toMatch(/—|–/);
    // A choice that didn't go through stays chosen.
    await a.SYNC.submit('up', { email: EMAIL, password: PW, password2: `${PW}x`, way: 'email' });
    expect(a.SYNC.status.error).toMatch(/don't match/);
    expect(a.SYNC.panel()).toMatch(/name="way" value="email" checked/);
    // No email, no choice.
    a.SYNC.status.noEmail = true;
    expect(a.SYNC.panel()).not.toContain('name="way"');
  });

  it('Recovery code: nothing in the cloud can open the data', async () => {
    const a = await device('phone');
    a.S.importData({ sessions: [session('s1')], logs: journal });
    await a.SYNC.submit('up', { email: EMAIL, password: PW, password2: PW });
    expect(a.SYNC.status.error).toBe('');
    expect(Object.keys(doc(KEYS)!).sort()).toEqual(['byPassword', 'byRecovery', 'iter', 'v']);
    expect(Object.keys(doc(REC)!).sort()).toEqual(['auth', 'uid']);
    expect(a.SYNC.status.pending?.byEmail).toBeUndefined();
    expect(sheetText()).toContain('this code is the only way to get your data back');
    expect(a.SYNC.status.way).toBe('code');
    expect(a.SYNC.panel()).toContain('End-to-end encrypted.');
    expect(a.SYNC.panel()).toContain('Save your recovery code.');
    expect(cloudText()).not.toContain('secret journal');
  });

  it('Email reset: the key is kept in the cloud too, and the recovery record says so', async () => {
    const a = await emailResetAccount();
    const keys = doc(KEYS)!;
    expect(keys.byEmail).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(doc(REC)).toMatchObject({ uid: 'uid1', email: true });
    expect(a.SYNC.status.pending).toMatchObject({ byEmail: true });
    expect(sheetText()).toContain('This code is a second way back in');
    expect(sheetText()).not.toContain('only');
    expect(a.SYNC.status.way).toBe('email');
    const panel = a.SYNC.panel();
    expect(panel).toContain('Encrypted, with Email reset.');
    expect(panel).not.toContain('End-to-end encrypted.');
    expect(panel).not.toContain('Save your recovery code.'); // offered, not pushed
    expect(panel).toContain('Your recovery code is a second way back in.');
    // The data is still encrypted, but the key in the keys document opens it: that's the trade.
    expect(cloudText()).not.toContain('secret journal');
    const C = await import('./lib/crypto');
    const meta = doc('users/uid1/arise/meta')! as { rev: string; iv: string };
    const text = await C.open(await C.keyFromRaw(keys.byEmail as string), { iv: meta.iv, ct: (doc('users/uid1/arise/part0')! as { ct: string }).ct }, `uid1/${meta.rev}`);
    expect(text).toContain('my secret journal entry');
    // Signing in elsewhere is as usual.
    const b = await device('laptop');
    await b.SYNC.submit('in', { id: EMAIL, password: PW });
    expect(b.SYNC.status.error).toBe('');
    expect(b.SYNC.status.way).toBe('email');
    expect(b.S.state.logs['2026-10-01']?.t).toBe('my secret journal entry');
  });

  it('a no-email account always uses a recovery code', async () => {
    const a = await device('phone');
    a.SYNC.status.noEmail = true;
    await a.SYNC.submit('up', { password: PW, password2: PW, way: 'email' });
    expect(a.SYNC.status.error).toBe('');
    const [rec] = [...cloud.docs.keys()].filter((p) => p.startsWith('recovery/'));
    expect(Object.keys(doc(rec)!).sort()).toEqual(['auth', 'uid']);
    expect('byEmail' in doc(KEYS)!).toBe(false);
    a.SYNC.status.more = 'way';
    expect(a.SYNC.panel()).not.toContain('data-v="way"');
  });
});

describe('the database rules', () => {
  it('take a byEmail only as a 256-bit key in base64, and email only as true', async () => {
    const a = await emailResetAccount();
    const { F } = a;
    const keys = doc(KEYS)!;
    const rec = doc(REC)!;
    const keysRef = F.doc(null, 'users', 'uid1', 'arise', 'keys');
    const recRef = F.doc(null, 'recovery', EMAIL);
    const raw = keys.byEmail as string;
    for (const bad of ['short', `${raw}A`, `${raw.slice(0, 43)}!`, raw.replace('=', 'A'), 12345, null, true, { iv: 'x', ct: 'y' }]) {
      await expect(F.setDoc(keysRef, { ...keys, byEmail: bad })).rejects.toMatchObject({ code: 'permission-denied' });
    }
    await expect(F.setDoc(keysRef, { ...keys, other: 'x' })).rejects.toMatchObject({ code: 'permission-denied' });
    for (const bad of ['true', 1, false, null, 'yes']) {
      await expect(F.setDoc(recRef, { ...rec, email: bad })).rejects.toMatchObject({ code: 'permission-denied' });
    }
    await expect(F.setDoc(recRef, { ...rec, email: true, other: 1 })).rejects.toMatchObject({ code: 'permission-denied' });
    // Every other check stays: not without the sealed password, not for another uid.
    await expect(F.setDoc(recRef, { uid: 'uid1', email: true })).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(F.setDoc(recRef, { ...rec, uid: 'uid2' })).rejects.toMatchObject({ code: 'permission-denied' });
    // What the app writes goes through, with or without them.
    await F.setDoc(keysRef, keys);
    await F.setDoc(recRef, rec);
    const { byEmail: _b, ...plain } = keys;
    await F.setDoc(keysRef, plain);
    const { email: _e, ...plainRec } = rec;
    await F.setDoc(recRef, plainRec);
    expect(doc(KEYS)).toEqual(plain);
  });

  it('never let another account, or nobody, read the keys', async () => {
    await emailResetAccount();
    // (The fake's rules check the sign-in of the device whose Firebase loaded last: this one.)
    const b = await device('laptop');
    await b.SYNC.submit('up', { email: 'other@example.com', password: PW, password2: PW });
    expect(b.SYNC.status.user?.uid).toBe('uid2');
    await expect(b.F.getDoc(b.F.doc(null, 'users', 'uid1', 'arise', 'keys'))).rejects.toMatchObject({ code: 'permission-denied' });
    await b.SYNC.handleAction('sync-out');
    await expect(b.F.getDoc(b.F.doc(null, 'users', 'uid1', 'arise', 'keys'))).rejects.toMatchObject({ code: 'permission-denied' });
    // Its recovery record is public, as for every account: it says which kind it is, nothing more.
    expect((await b.F.getDoc(b.F.doc(null, 'recovery', EMAIL))).data()).toMatchObject({ email: true });
  });
});

describe('forgot password, with Email reset', () => {
  it('emails a link; the password set from it opens the data, then Firebase gets the derived value', async () => {
    const a = await emailResetAccount();
    const oldCode = a.SYNC.status.pending!.recoveryCode;
    const before = doc(KEYS)!;

    const b = await device('laptop');
    await b.SYNC.handleAction('sync-form', button('recover')); // "Forgot password?"
    expect(b.SYNC.panel()).toContain('data-act="sync-form" data-v="reset">Email me a reset link');
    await b.SYNC.handleAction('sync-form', button('reset'));
    expect(b.SYNC.panel()).toContain('data-form="reset"');
    const mailed: string[] = [];
    cloud.hook = (op, email) => {
      if (op === 'reset') mailed.push(email);
    };
    await b.SYNC.submit('reset', { id: EMAIL });
    expect(b.SYNC.status.error).toBe('');
    expect(mailed).toEqual([EMAIL]);
    expect(toastText()).toBe(RESET_SENT);
    expect(b.SYNC.status.form).toBe('in');

    // Firebase's own page sets the new password, as it's typed there.
    setPasswordFromResetPage(EMAIL, NEW);
    const sent = watchSignIns();
    await b.SYNC.submit('in', { id: EMAIL, password: NEW });
    expect(b.SYNC.status.error).toBe('');
    expect(b.SYNC.status.repair).toBe(false);
    expect(toastText()).toBe("Password changed. You're signed in.");
    expect(b.S.state.sessions.map((s) => s.id)).toEqual(['s1']);
    expect(b.S.state.logs['2026-10-01']?.t).toBe('my secret journal entry');
    // The typed password went to Firebase once, after the usual sign-in failed; now Firebase
    // holds the value derived from it, as for every other sign-in.
    expect(sent.filter((p) => p === NEW)).toHaveLength(1);
    expect(sent.indexOf(NEW)).toBe(1);
    const C = await import('./lib/crypto');
    expect(cloud.users.get('uid1')!.password).toBe((await C.deriveMaster(NEW, EMAIL)).auth);
    // The same data key, still kept for Email reset; wrapped for the new password, with a new
    // recovery code (the old one can't hold the new Firebase password).
    const after = doc(KEYS)!;
    expect(after.byEmail).toBe(before.byEmail);
    expect(after.byPassword).not.toEqual(before.byPassword);
    expect(after.byRecovery).not.toEqual(before.byRecovery);
    expect(doc(REC)).toMatchObject({ uid: 'uid1', email: true });
    const newCode = b.SYNC.status.pending!.recoveryCode;
    expect(newCode).not.toBe(oldCode);
    expect(b.SYNC.status.pending!.byEmail).toBe(true);
    expect(sheetText()).toContain('Your password changed, so your old recovery code stopped working.');

    // Another device signs in with the new password the usual way: it's never sent again.
    const c = await device('tablet');
    await c.SYNC.submit('in', { id: EMAIL, password: NEW });
    expect(c.SYNC.status.error).toBe('');
    expect(toastText()).toBe('Signed in. Your data is synced.');
    expect(c.S.state.logs['2026-10-01']?.t).toBe('my secret journal entry');
    expect(sent.filter((p) => p === NEW)).toHaveLength(1);
    // The old password doesn't work any more, and the old code doesn't either; the new one does.
    cloud.hook = null;
    const d = await device('desk');
    await d.SYNC.submit('in', { id: EMAIL, password: PW });
    expect(d.SYNC.status.error).toMatch(/^Wrong email/);
    await d.SYNC.submit('recover', { id: EMAIL, code: oldCode, password: 'a third long password', password2: 'a third long password' });
    expect(d.SYNC.status.error).toMatch(/recovery code isn't the right one/);
    await d.SYNC.submit('recover', { id: EMAIL, code: newCode, password: 'a third long password', password2: 'a third long password' });
    expect(d.SYNC.status.error).toBe('');
    expect(d.S.state.logs['2026-10-01']?.t).toBe('my secret journal entry');
    expect(doc(REC)).toMatchObject({ email: true }); // still Email reset
    expect(doc(KEYS)!.byEmail).toBe(before.byEmail);
  });

  it('a wrong password is still wrong', async () => {
    await emailResetAccount();
    setPasswordFromResetPage(EMAIL, NEW);
    const b = await device('laptop');
    const sent = watchSignIns();
    await b.SYNC.submit('in', { id: EMAIL, password: 'not the new one at all' });
    expect(b.SYNC.status.error).toMatch(/^Wrong email/);
    expect(b.SYNC.status.user).toBeNull();
    expect(sent).toHaveLength(2); // the derived value, then as typed
    expect(cloud.users.get('uid1')!.password).toBe(NEW);
  });

  it('a password change cut off after Firebase took it: the key is fixed without the recovery code', async () => {
    await emailResetAccount();
    const C = await import('./lib/crypto');
    cloud.users.get('uid1')!.password = (await C.deriveMaster('the other password', EMAIL)).auth;
    const b = await device('laptop');
    const sent = watchSignIns();
    await b.SYNC.submit('in', { id: EMAIL, password: 'the other password' });
    expect(b.SYNC.status.error).toBe('');
    expect(b.SYNC.status.repair).toBe(false);
    expect(b.S.state.sessions.map((s) => s.id)).toEqual(['s1']);
    expect(sent).not.toContain('the other password');
    const c = await device('tablet');
    await c.SYNC.submit('in', { id: EMAIL, password: 'the other password' });
    expect(c.SYNC.status.error).toBe('');
  });

  it("a Recovery code account still can't be reset by email", async () => {
    const a = await device('phone');
    await a.SYNC.submit('up', { email: EMAIL, password: PW, password2: PW });
    await a.SYNC.handleAction('sync-out');
    const mailed: string[] = [];
    cloud.hook = (op, email) => {
      if (op === 'reset') mailed.push(email);
    };
    await a.SYNC.submit('reset', { id: EMAIL });
    expect(a.SYNC.status.error).toBe('Your account is end-to-end encrypted, so a reset email could never open your data. Use your recovery code instead.');
    expect(mailed).toEqual([]);
  });
});

describe('switching', () => {
  it('from Recovery code to Email reset and back', async () => {
    const a = await device('phone');
    a.S.importData({ sessions: [session('s1')], logs: journal });
    await a.SYNC.submit('up', { email: EMAIL, password: PW, password2: PW });
    const code = a.SYNC.status.pending!.recoveryCode;
    await a.SYNC.handleAction('sync-code-done');
    const before = doc(KEYS)!;
    const rec = doc(REC)!;

    await a.SYNC.handleAction('sync-more', button('way'));
    expect(a.SYNC.panel()).toContain('How you get back in if you forget your password');
    expect(a.SYNC.panel()).toContain('data-form="way"');
    expect(a.SYNC.panel()).toContain('Switch to Email reset');
    // It says what it means first, and Cancel changes nothing.
    const ask = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await a.SYNC.submit('way', { way: 'email', password: PW });
    expect(ask.mock.calls[0][0]).toMatch(/Google \(who host it\) and the people who run Arise could read your data/);
    expect(doc(KEYS)).toEqual(before);
    ask.mockReturnValue(true);
    await a.SYNC.submit('way', { way: 'email', password: 'not my password' });
    expect(a.SYNC.status.error).toMatch(/isn't right/);
    expect(doc(KEYS)).toEqual(before);
    await a.SYNC.submit('way', { way: 'email', password: PW });
    ask.mockRestore();
    expect(a.SYNC.status.error).toBe('');
    expect(toastText()).toBe('Switched to Email reset.');
    expect(a.SYNC.status.way).toBe('email');
    expect(a.SYNC.status.pending).toBeNull(); // the recovery code stays as it was
    expect(doc(KEYS)).toEqual({ ...before, byEmail: expect.stringMatching(/^[A-Za-z0-9+/]{43}=$/) });
    expect(doc(REC)).toEqual({ ...rec, email: true });

    // Now a reset email can be had, and the password set from it works.
    const b = await device('laptop');
    await b.SYNC.submit('reset', { id: EMAIL });
    expect(b.SYNC.status.error).toBe('');
    setPasswordFromResetPage(EMAIL, NEW);
    await b.SYNC.submit('in', { id: EMAIL, password: NEW });
    expect(b.SYNC.status.error).toBe('');
    expect(b.S.state.logs['2026-10-01']?.t).toBe('my secret journal entry');

    // And back: the copy of the key leaves the cloud, and there's a new code to save.
    await b.SYNC.handleAction('sync-code-done');
    await b.SYNC.handleAction('sync-more', button('way'));
    expect(b.SYNC.panel()).toContain('Switch to Recovery code');
    await b.SYNC.submit('way', { way: 'code', password: NEW });
    expect(b.SYNC.status.error).toBe('');
    expect(toastText()).toBe('Switched to Recovery code.');
    expect(b.SYNC.status.way).toBe('code');
    expect('byEmail' in doc(KEYS)!).toBe(false);
    expect(cloudText()).not.toContain('byEmail');
    expect(Object.keys(doc(REC)!).sort()).toEqual(['auth', 'uid']);
    const newCode = b.SYNC.status.pending!.recoveryCode;
    expect(newCode).not.toBe(code);
    expect(b.SYNC.status.pending!.byEmail).toBeUndefined();
    expect(sheetText()).toContain('this code is the only way to get your data back');
    expect(b.SYNC.panel()).toContain('Save your recovery code.');
    // No more reset emails, and a password set from one wouldn't be sent.
    await b.SYNC.submit('reset', { id: EMAIL });
    expect(b.SYNC.status.error).toMatch(/Use your recovery code instead/);
    const c = await device('tablet');
    await c.SYNC.submit('recover', { id: EMAIL, code: newCode, password: 'a third long password', password2: 'a third long password' });
    expect(c.SYNC.status.error).toBe('');
    expect(c.S.state.logs['2026-10-01']?.t).toBe('my secret journal entry');
  });

  it('changing the password keeps Email reset in step', async () => {
    const a = await emailResetAccount();
    const raw = doc(KEYS)!.byEmail;
    await a.SYNC.submit('password', { old: PW, password: NEW, password2: NEW });
    expect(a.SYNC.status.error).toBe('');
    expect(doc(KEYS)!.byEmail).toBe(raw);
    expect(doc(REC)).toMatchObject({ email: true });
    expect(a.SYNC.status.pending!.byEmail).toBe(true);
    // A new recovery code keeps it too.
    await a.SYNC.submit('code', { password: NEW });
    expect(doc(KEYS)!.byEmail).toBe(raw);
    expect(doc(REC)).toMatchObject({ email: true });
    setPasswordFromResetPage(EMAIL, 'set on the reset page');
    const b = await device('laptop');
    await b.SYNC.submit('in', { id: EMAIL, password: 'set on the reset page' });
    expect(b.SYNC.status.error).toBe('');
    expect(b.S.state.sessions.map((s) => s.id)).toEqual(['s1']);
  });

  it('a signed-in device that unlocks learns the way, for the account panel', async () => {
    await emailResetAccount();
    // The app opens again: still signed in, but this device's key is gone.
    use('phone');
    vi.resetModules();
    const A = await import('./account');
    const F = (await import('./lib/firebase')) as unknown as Fake;
    const S = await import('./store');
    const SYNC = await import('./sync');
    await A.load(() => {});
    F.restoreSession('uid1');
    await SYNC.initSync({ render: () => {}, changed: () => {}, checkForUpdate: () => {} });
    devices.push({ S, SYNC, F, name: 'phone' });
    expect(SYNC.status.locked).toBe(true);
    expect(SYNC.status.way).toBe('');
    await SYNC.submit('unlock', { password: PW });
    expect(SYNC.status.error).toBe('');
    expect(SYNC.status.way).toBe('email');
    expect(SYNC.panel()).toContain('Encrypted, with Email reset.');
  });
});

describe('deleting an account', () => {
  it('removes the copy of the key with the keys and the recovery record', async () => {
    const a = await emailResetAccount();
    const ask = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await a.SYNC.submit('delete', { password: PW });
    ask.mockRestore();
    expect(a.SYNC.status.error).toBe('');
    expect([...cloud.docs.keys()]).toEqual([]);
    expect(cloud.users.size).toBe(0);
  });
});
