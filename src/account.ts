// Accounts, with end-to-end encryption. No screens here; sync.ts draws them.
//
// Two kinds of account:
//   - email + password, the familiar kind;
//   - an account code (ARISE-XXXX-XXXX-XXXX-XXXX) + password, for people who want no personal
//     details on the server at all. Firebase still needs an email-shaped login, so the code is
//     turned into one at a domain that can never receive mail (.invalid).
//
// Firebase never sees the password itself, only a value derived from it (see lib/crypto.ts), and
// the cloud only ever holds data encrypted with a key that exists on the Player's devices.
// Losing both the password and the recovery code means the cloud copy can't be opened by anyone.
//
// Cloud layout:
//   users/{uid}/arise/keys  the data key, wrapped by the password and by the recovery code
//   recovery/{login email}  the Firebase password, sealed with the recovery code. Anyone may read
//                           it (it's useless without the 160-bit code); only its account can write it.

import * as C from './lib/crypto';
import * as K from './lib/keystore';
import { FIREBASE } from './firebase-config.js';

type FB = typeof import('./lib/firebase');
type FBUser = import('firebase/auth').User;
type Auth = import('firebase/auth').Auth;
type DB = import('firebase/firestore/lite').Firestore;

export const configured = !!(FIREBASE && FIREBASE.apiKey && FIREBASE.projectId);
export const MIN_PASSWORD = 10;
const CODE_DOMAIN = 'code.arise.invalid';

let fb: FB | null = null;
let auth: Auth | null = null;
let db: DB | null = null;

export interface User {
  uid: string;
  email: string; // the Firebase login
  id: string; // what the Player types: their email, or their account code
}

export class AccountError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

// ---------- ids

export function loginEmail(id: string) {
  const n = C.normalizeId(id);
  return C.isAccountCode(n) ? `${n}@${CODE_DOMAIN}` : n;
}

// Signs in with an account code rather than an email.
export const usesCode = (id: string) => C.isAccountCode(C.normalizeId(id));

export function idOf(email: string) {
  const [local, domain] = String(email || '').split('@');
  return domain === CODE_DOMAIN ? local.toUpperCase() : email;
}

const userOf = (u: FBUser): User => ({ uid: u.uid, email: u.email || '', id: idOf(u.email || '') });

export function checkNewPassword(password: string, id: string) {
  if (password.length < MIN_PASSWORD) throw new AccountError('weak', `Use a password with at least ${MIN_PASSWORD} characters. It's the key to your data, so make it one you don't use anywhere else.`);
  if (C.normalizeId(password) === C.normalizeId(id)) throw new AccountError('weak', "Your password can't be the same as your email or account code.");
}

// ---------- Firebase

const listeners = new Set<(u: User | null) => void>();
let loading: Promise<void> | null = null;

// Loads Firebase (once) and tells `onChange` who is signed in, now and whenever it changes.
export async function load(onChange: (u: User | null) => void): Promise<void> {
  const known = listeners.has(onChange);
  listeners.add(onChange);
  if (!loading) loading = start();
  try {
    await loading;
  } catch (err) {
    loading = null;
    throw err;
  }
  if (!known) onChange(auth!.currentUser ? userOf(auth!.currentUser) : null);
}

async function start() {
  try {
    fb = await import('./lib/firebase');
  } catch {
    throw new AccountError('offline', 'Could not load the sign-in module. Check your internet connection.');
  }
  const app = fb.initializeApp(FIREBASE);
  // No pop-up sign-in, so this works in the iPhone app too.
  auth = fb.initializeAuth(app, { persistence: [fb.indexedDBLocalPersistence, fb.browserLocalPersistence] });
  db = fb.getFirestore(app);
  await new Promise<void>((resolve) => {
    let first = true;
    fb!.onAuthStateChanged(auth!, (u) => {
      if (!first) for (const fn of listeners) fn(u ? userOf(u) : null);
      if (first) {
        first = false;
        resolve();
      }
    });
  });
}

export const firebase = () => {
  if (!fb || !db) throw new AccountError('not-loaded', 'Sign-in is still loading.');
  return { fb, db };
};

export const idToken = () => auth?.currentUser?.getIdToken() ?? Promise.resolve(null);
export const currentUid = () => auth?.currentUser?.uid ?? null;

const keysRef = (uid: string) => fb!.doc(db!, 'users', uid, 'arise', 'keys');
const recoveryRef = (email: string) => fb!.doc(db!, 'recovery', email);

interface Keys {
  v: 1;
  iter: number;
  byPassword: C.Sealed;
  byRecovery: C.Sealed;
}

async function readKeys(uid: string): Promise<Keys | null> {
  const snap = await fb!.getDoc(keysRef(uid));
  return snap.exists() ? (snap.data() as Keys) : null;
}

// False when the account was deleted on another device.
export const hasKeys = async (uid: string) => !!(await readKeys(uid));

// Whether this encrypted account still exists (anyone may check; see the recovery record). An
// account made again later with the same email has another uid. False when unsure.
export async function accountExists(email: string, uid: string) {
  try {
    const snap = await fb!.getDoc(recoveryRef(email));
    return snap.exists() && (snap.data() as { uid?: string }).uid === uid;
  } catch {
    return false;
  }
}

// Every encrypted account has a recovery record; accounts from before encryption (1.x) don't.
const encrypted = async (email: string) => (await fb!.getDoc(recoveryRef(email))).exists();

// Things the Player has to write down, shown once.
export interface Setup {
  recoveryCode: string;
  accountCode?: string;
}

export type Result = { user: User; setup?: Setup; upgraded?: boolean } | { user: User; needsRecovery: true };

// A new data key, wrapped by the password and by a new recovery code. `dataKey` re-wraps an
// existing key instead (a new recovery code for the same data).
async function createKeys(user: User, master: C.Master, dataKey?: CryptoKey): Promise<Setup> {
  const dk = dataKey || (await C.newDataKey());
  const recoveryCode = C.newRecoveryCode();
  const rk = await C.recoveryKek(recoveryCode);
  const keys: Keys = { v: 1, iter: C.KDF_ITERATIONS, byPassword: await C.wrapKey(dk, master.kek, user.uid), byRecovery: await C.wrapKey(dk, rk, user.uid) };
  const batch = fb!.writeBatch(db!);
  batch.set(keysRef(user.uid), keys);
  batch.set(recoveryRef(user.email), { uid: user.uid, auth: await C.seal(rk, master.auth, `recovery/${user.uid}`) });
  try {
    await batch.commit();
  } catch (err) {
    // The reply can be lost after the keys were saved. If what's there now is exactly this
    // attempt's, it worked (and its recovery code is the one to show).
    const now = await readKeys(user.uid).catch(() => null);
    if (!now || JSON.stringify(now.byRecovery) !== JSON.stringify(keys.byRecovery)) throw err;
  }
  await keep(user, keys, master);
  return { recoveryCode };
}

// Keep a copy of the data key on this device that can be used but never read out.
async function keep(user: User, keys: Keys, master: C.Master) {
  const key = await C.unwrapKey(keys.byPassword, master.kek, user.uid);
  await K.saveKey({ uid: user.uid, id: user.id, key });
}

export const deviceKey = async (uid: string) => (await K.loadKey(uid))?.key ?? null;

export const isWrongPassword = (err: unknown) => /invalid-credential|invalid-login-credentials|wrong-password|user-not-found/.test(String((err as { code?: string })?.code));

// ---------- sign up, sign in

export async function signUp({ email, password, noEmail }: { email?: string; password: string; noEmail?: boolean }): Promise<Result> {
  const id = noEmail ? C.newAccountCode() : C.normalizeId(email || '');
  if (!noEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(id)) throw new AccountError('auth/invalid-email', "That email address doesn't look right.");
  checkNewPassword(password, id);
  const master = await C.deriveMaster(password, id);
  const cred = await fb!.createUserWithEmailAndPassword(auth!, loginEmail(id), master.auth);
  const user = userOf(cred.user);
  let setup: Setup;
  try {
    setup = await createKeys(user, master);
  } catch (err) {
    // A half-made account can't be used (an account code was never even shown): remove it, so
    // trying again starts afresh. Only if it's still half-made: another device may have finished
    // it meanwhile (signing in does), or the keys did land after all.
    const finished = await readKeys(user.uid).then(
      (k) => !!k,
      () => true,
    );
    if (!finished) await fb!.deleteUser(cred.user).catch(() => {});
    throw err;
  }
  return { user, setup: { ...setup, ...(noEmail ? { accountCode: user.id } : {}) } };
}

// Pending state when the password works but the data key can't be opened with it (the password
// was reset outside the app, or a password change was interrupted). The recovery code fixes it.
let repairing: { user: User; master: C.Master } | null = null;

// `legacy`: the Player said their account is from before Arise 2.0, or that they set this
// password from a reset email. Only then, and only after the usual sign-in failed, is the typed
// password itself sent to Firebase, because that's what Firebase holds for those accounts.
export async function signIn(id: string, password: string, { legacy = false } = {}): Promise<Result> {
  const email = loginEmail(id);
  const master = await C.deriveMaster(password, id);
  let cred;
  try {
    cred = await fb!.signInWithEmailAndPassword(auth!, email, master.auth);
  } catch (err) {
    if (!legacy || !isWrongPassword(err) || C.isAccountCode(id)) throw err;
    try {
      cred = await fb!.signInWithEmailAndPassword(auth!, email, password);
    } catch {
      throw err;
    }
    // From here Firebase holds the derived value, like every other account. If this is cut off,
    // sign out again, so trying again starts from the same place.
    const user = userOf(cred.user);
    try {
      const keys = await readKeys(user.uid);
      await fb!.updatePassword(cred.user, master.auth);
      if (!keys) return { user, setup: await createKeys(user, master), upgraded: true };
    } catch (e) {
      await fb!.signOut(auth!).catch(() => {});
      throw e;
    }
    // Encrypted already, and the password was reset by email: the recovery code opens the key.
    repairing = { user, master };
    return { user, needsRecovery: true };
  }
  const user = userOf(cred.user);
  const keys = await readKeys(user.uid);
  if (!keys) return { user, setup: await createKeys(user, master) }; // sign-up was interrupted
  try {
    await keep(user, keys, master);
  } catch {
    repairing = { user, master };
    return { user, needsRecovery: true };
  }
  return { user };
}

// Signed in already (the session outlived this device's key, or it's from before encryption):
// the password opens the key again. `legacy`: this device was signed in by Arise 1.x, so the
// account may still have its plain password at Firebase.
export async function unlock(user: User, password: string, { legacy = false } = {}): Promise<Result> {
  const master = await C.deriveMaster(password, user.id);
  const keys = await readKeys(user.uid);
  if (keys) {
    await keep(user, keys, master); // a wrong password throws 'wrong-key'
    return { user };
  }
  const current = auth!.currentUser!;
  const wrong = new AccountError('wrong-key', "That password isn't right.");
  // No keys: either making them was interrupted (sign-up, or an upgrade after Firebase already
  // took the new password), or the account is from before encryption.
  try {
    await fb!.reauthenticateWithCredential(current, fb!.EmailAuthProvider.credential(user.email, master.auth));
    return { user, setup: await createKeys(user, master) };
  } catch (err) {
    if (!isWrongPassword(err)) throw err;
  }
  if (!legacy || C.isAccountCode(user.id) || (await encrypted(user.email))) throw wrong;
  // From before encryption: check the password the old way, then upgrade.
  try {
    await fb!.reauthenticateWithCredential(current, fb!.EmailAuthProvider.credential(user.email, password));
  } catch (err) {
    if (isWrongPassword(err)) throw wrong;
    throw err;
  }
  await fb!.updatePassword(current, master.auth);
  return { user, setup: await createKeys(user, master), upgraded: true };
}

// Finish a sign-in that needed the recovery code (see `repairing`).
export async function repair(recoveryCode: string): Promise<Result> {
  if (!repairing) throw new AccountError('state', 'Sign in again first.');
  const { user, master } = repairing;
  const rk = await C.recoveryKek(recoveryCode);
  const keys = await readKeys(user.uid);
  if (!keys) throw new AccountError('state', 'Sign in again first.');
  const dk = await C.unwrapKey(keys.byRecovery, rk, user.uid, { extractable: true });
  await rewrap(user, keys, dk, master, rk);
  repairing = null;
  return { user };
}

async function rewrap(user: User, keys: Keys, dk: CryptoKey, master: C.Master, rk: CryptoKey) {
  const next: Keys = { ...keys, byPassword: await C.wrapKey(dk, master.kek, user.uid) };
  const batch = fb!.writeBatch(db!);
  batch.set(keysRef(user.uid), next);
  batch.set(recoveryRef(user.email), { uid: user.uid, auth: await C.seal(rk, master.auth, `recovery/${user.uid}`) });
  await batch.commit();
  await keep(user, next, master);
}

// ---------- forgotten password

export async function recover({ id, recoveryCode, newPassword }: { id: string; recoveryCode: string; newPassword: string }): Promise<Result> {
  checkNewPassword(newPassword, id);
  if (!fb) throw new AccountError('not-loaded', 'Sign-in is still loading.');
  const email = loginEmail(id);
  const rk = await C.recoveryKek(recoveryCode);
  const snap = await fb.getDoc(recoveryRef(email));
  if (!snap.exists()) {
    throw new AccountError('no-account', C.isAccountCode(id) ? `There's no account with the code ${id}.` : `There's no account for ${id} with a recovery code. If you made it with the old version of Arise, choose "Email me a reset link" below.`);
  }
  const rec = snap.data() as { uid: string; auth: C.Sealed };
  let oldAuth: string;
  try {
    oldAuth = await C.open(rk, rec.auth, `recovery/${rec.uid}`);
  } catch {
    throw new AccountError('wrong-code', "That recovery code isn't the right one for this account.");
  }
  let cred;
  try {
    cred = await fb.signInWithEmailAndPassword(auth!, email, oldAuth);
  } catch (err) {
    if (!isWrongPassword(err)) throw err;
    // The password was set somewhere else since the code was made (a reset email), or the login
    // was deleted in a way that left its recovery record behind (in the Firebase console). Firebase
    // doesn't say which. (An account code has no email, so no reset email either.)
    throw new AccountError(
      'reset-elsewhere',
      usesCode(id)
        ? `The recovery code can't sign in to ${id}. Maybe the account was deleted. Then make a new one with "New here? Create an account".`
        : `The recovery code can't sign in to ${id}. Maybe its password was set from a reset email. Then sign in with that password and tick the box below. Your recovery code then unlocks your data. Or maybe the account was deleted. Then make it again with "New here? Create an account". The data on this device can go into it.`,
    );
  }
  const user = userOf(cred.user);
  const keys = await readKeys(user.uid);
  if (!keys) throw new AccountError('state', "This account's keys are missing. Sign in with your password instead.");
  const dk = await C.unwrapKey(keys.byRecovery, rk, user.uid, { extractable: true });
  const master = await C.deriveMaster(newPassword, user.id);
  // Firebase first; if saving the new wrap fails after this, the recovery code repairs it next time.
  await fb.updatePassword(cred.user, master.auth);
  await rewrap(user, keys, dk, master, rk);
  return { user };
}

// Accounts from before encryption have no recovery code. Their cloud copy isn't encrypted yet,
// so Firebase's reset email is safe for them: the next sign-in with the new password encrypts
// it. Encrypted accounts never get one, because a reset can't open their data.
export async function resetByEmail(id: string) {
  if (!fb) throw new AccountError('not-loaded', 'Sign-in is still loading.');
  const email = loginEmail(id);
  if (C.isAccountCode(id)) throw new AccountError('no-email', 'Accounts with an account code have no email. Use your recovery code.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AccountError('auth/invalid-email', "That email address doesn't look right.");
  if (await encrypted(email)) throw new AccountError('encrypted', 'Your account is end-to-end encrypted, so a reset email could never open your data. Use your recovery code instead.');
  await fb.sendPasswordResetEmail(auth!, email);
}

// ---------- changes while signed in

export async function changePassword(user: User, oldPassword: string, newPassword: string) {
  checkNewPassword(newPassword, user.id);
  const old = await C.deriveMaster(oldPassword, user.id);
  const keys = await readKeys(user.uid);
  if (!keys) throw new AccountError('state', 'Sign in again first.');
  const dk = await C.unwrapKey(keys.byPassword, old.kek, user.uid, { extractable: true });
  const current = auth!.currentUser!;
  await fb!.reauthenticateWithCredential(current, fb!.EmailAuthProvider.credential(user.email, old.auth));
  const master = await C.deriveMaster(newPassword, user.id);
  await fb!.updatePassword(current, master.auth);
  // The recovery record must hold the new Firebase password, but only the old code can seal it,
  // so a password change also issues a new recovery code.
  return createKeys(user, master, dk);
}

export async function newRecoveryCode(user: User, password: string): Promise<Setup> {
  const master = await C.deriveMaster(password, user.id);
  const keys = await readKeys(user.uid);
  if (!keys) throw new AccountError('state', 'Sign in again first.');
  const dk = await C.unwrapKey(keys.byPassword, master.kek, user.uid, { extractable: true });
  // Firebase checks it too: a login deleted elsewhere can still write for a while with this
  // device's session, and must never write over the recovery record of its email's new account.
  await reauthenticate(user, master);
  return createKeys(user, master, dk);
}

// Checks the password and refreshes the sign-in, which Firebase wants before deleting an account.
// Only reachable with this device's key, so the account is always encrypted by then. Throws
// 'gone' when the login itself no longer exists (its deletion went through, but the reply never
// came), whatever the password.
export async function confirmPassword(user: User, password: string) {
  await reauthenticate(user, await C.deriveMaster(password, user.id));
}

async function reauthenticate(user: User, master: C.Master) {
  try {
    await fb!.reauthenticateWithCredential(auth!.currentUser!, fb!.EmailAuthProvider.credential(user.email, master.auth));
  } catch (err) {
    if (await loginGone(user, err)) throw new AccountError('gone', 'This account no longer exists.');
    // Checking ended this device's session (see loginGone), or it's another account's now (in
    // another window of the app): the way on is to sign in again.
    if (auth!.currentUser?.uid !== user.uid) throw new AccountError('signed-out', 'You were signed out on this device. Sign in again, then try again.');
    if (isWrongPassword(err)) throw new AccountError('wrong-key', "That password isn't right.");
    throw err;
  }
}

// Whether a failed check of the signed-in login's password means the login is gone. Firebase
// says so outright, or (with email enumeration protection on) only "wrong email or password".
// Then renewing this session tells: that fails for a deleted login, and signs this device out.
// It fails the same way after the password was changed on another device, so the recovery
// record decides: deleting an account removes it before the login, a new password rewrites it.
async function loginGone(user: User, err: unknown) {
  const code = (e: unknown) => String((e as { code?: string })?.code);
  // Only about this login while this device is still signed in to it: once another window of the
  // app has signed in to another account, its password doesn't fit that one either.
  if (/user-not-found|user-mismatch/.test(code(err))) return auth!.currentUser?.uid === user.uid;
  if (!isWrongPassword(err)) return false;
  try {
    await auth!.currentUser?.getIdToken(true);
    return false;
  } catch (e) {
    if (!/user-token-expired/.test(code(e))) return false;
  }
  const snap = await fb!.getDoc(recoveryRef(user.email));
  return !snap.exists() || (snap.data() as { uid?: string }).uid !== user.uid;
}

// Deletes the account's keys and recovery record (sync.ts deletes the data first), then the account.
// `gone`: the login was deleted already. Then only what's left goes, and the recovery record only
// while it's still this account's (its email may have a new account by now): checked and deleted
// in one go.
export async function deleteAccount(user: User, { gone = false } = {}) {
  if (gone) {
    await fb!.runTransaction(db!, async (tx) => {
      const rec = await tx.get(recoveryRef(user.email));
      tx.delete(keysRef(user.uid));
      if (rec.exists() && (rec.data() as { uid?: string }).uid === user.uid) tx.delete(recoveryRef(user.email));
    });
  } else {
    const batch = fb!.writeBatch(db!);
    batch.delete(keysRef(user.uid));
    batch.delete(recoveryRef(user.email));
    await batch.commit();
    // Only this login, never one another window of the app signed in to meanwhile.
    const current = auth!.currentUser;
    if (current?.uid !== user.uid) throw new AccountError('signed-out', 'You were signed out on this device. Sign in again, then try again.');
    await fb!.deleteUser(current);
  }
  await K.forgetKey();
}

export async function signOut() {
  repairing = null;
  await K.forgetKey();
  if (auth) await fb!.signOut(auth);
}

// ---------- messages

export function friendly(err: unknown): string {
  const e = err as { code?: string; message?: string };
  const code = String(e?.code || '');
  const map: Record<string, string> = {
    'auth/invalid-email': "That email address doesn't look right.",
    'auth/invalid-credential': 'Wrong email, account code or password.',
    'auth/invalid-login-credentials': 'Wrong email, account code or password.',
    'auth/wrong-password': 'Wrong email, account code or password.',
    'auth/user-not-found': 'Wrong email, account code or password.',
    'auth/missing-password': 'Type your password.',
    'auth/email-already-in-use': "There's already an account with that email. Sign in instead.",
    'auth/weak-password': `Use a password with at least ${MIN_PASSWORD} characters.`,
    'auth/too-many-requests': 'Too many tries. Wait a few minutes and try again.',
    'auth/network-request-failed': 'No internet connection. Try again when you are online.',
    'auth/operation-not-allowed': 'Email sign-in is not switched on in the Firebase project yet.',
    'auth/configuration-not-found': 'Sign-in is not set up in the Firebase project yet.',
    'auth/requires-recent-login': 'For safety, sign out and back in, then try again.',
    'permission-denied': 'The cloud database said no. The Firestore rules in the Firebase project may need updating.',
    'not-found': 'The cloud database has not been created in the Firebase project yet.',
    unavailable: "Couldn't reach the cloud. It will sync when you are back online.",
    'wrong-key': "That password isn't right.",
    'bad-code': "That recovery code doesn't look right. It has 32 letters and numbers.",
  };
  if (/api-key-not-valid/.test(code)) return 'The Firebase settings in the app are wrong.';
  return map[code] || e?.message || 'Something went wrong.';
}
