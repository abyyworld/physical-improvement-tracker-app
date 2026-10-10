// Accounts, with end-to-end encryption. No screens here; sync.ts draws them.
//
// Two kinds of account:
//   - email + password, the familiar kind;
//   - an account code (ARISE-XXXX-XXXX-XXXX-XXXX) + password, for people who want no personal
//     details on the server at all. Firebase still needs an email-shaped login, so the code is
//     turned into one at a domain that can never receive mail (.invalid).
//
// And two ways back in after a forgotten password, for email accounts:
//   - Recovery code (the default, and the only way for an account code): nobody else can ever
//     open the data. Losing both the password and the recovery code means nobody can.
//   - Email reset: Firebase's reset email. For it to open the data, the keys document also holds
//     the data key itself (`byEmail`), which only the database rules protect: Google, and whoever
//     runs the Firebase project, could read the data if they chose to. So could anyone who gets
//     into the account's email. These accounts still get a recovery code too.
//
// Anyone who gets into an account's email can have Firebase's reset page set a password, sign in
// with it and write whatever the rules allow: a `byEmail` of their own, or the recovery record's
// mark for Email reset. So neither is taken on trust (see emailWay and Knows).
//
// Firebase never sees the password itself, only a value derived from it (see lib/crypto.ts),
// except once after a reset email (see signIn), and the cloud only ever holds encrypted data.
//
// Cloud layout:
//   users/{uid}/arise/keys  the data key, wrapped by the password and by the recovery code (and,
//                           with Email reset, as it is)
//   recovery/{login email}  the Firebase password, sealed with the recovery code, and whether the
//                           account uses Email reset. Anyone may read it (it's useless without the
//                           160-bit code); only its account can write it.

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
  byEmail?: string; // Email reset only: the data key as it is (see C.rawKey)
  wasEmail?: true; // this key has been kept for Email reset (now or before): someone may have a copy
}

interface Recovery {
  uid: string;
  auth: C.Sealed;
  email?: true; // the account uses Email reset
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

// The recovery record of the account with this login (anyone may read it, so this works before
// signing in).
async function readRecovery(email: string): Promise<Recovery | null> {
  const snap = await fb!.getDoc(recoveryRef(email));
  return snap.exists() ? (snap.data() as Recovery) : null;
}

// Whether `raw` is this key, which can't be read out: what one seals, the other opens.
async function sameKey(key: CryptoKey, raw: string) {
  try {
    await C.open(await C.keyFromRaw(raw), await C.seal(key, 'arise', 'same key'), 'same key');
    return true;
  } catch {
    return false;
  }
}

// Whether the account uses Email reset: the key kept for it is the account's own (`own`), and the
// recovery record says so too. Anyone who can sign in can write either (after a reset email,
// anyone who gets into the account's email can), and an older version of Arise on another device
// keeps one but not the other. Anything else is a Recovery code account, the more private way,
// and what's left of Email reset goes the next time the keys are written (`off`: there was some).
// `was`: this key has been kept in the cloud (now or before).
function emailWay(user: User, keys: Keys, rec: Recovery | null, own: boolean) {
  const marked = rec?.uid === user.uid && rec.email === true;
  const on = own && marked;
  return { on, off: !on && (!!keys.byEmail || marked), was: own || !!keys.wasEmail };
}
// The same, with the data key itself at hand (extractable).
async function emailWayWith(user: User, keys: Keys, dk: CryptoKey) {
  return emailWay(user, keys, await readRecovery(user.email), keys.byEmail === (await C.rawKey(dk)));
}

// How the signed-in account gets back in after a forgotten password, for the Account panel.
// `wasEmail`: its key has been kept for Email reset (now or before), so someone may have a copy.
// When the keys and the recovery record don't agree (see emailWay), Email reset goes, from both
// in one go: `turnedOff` says so, for the Player to hear about it.
export type Way = 'email' | 'code';
export interface WayInfo {
  way: Way;
  wasEmail: boolean;
  turnedOff: boolean;
}
export async function resetWay(user: User): Promise<WayInfo> {
  const key = await deviceKey(user.uid);
  if (!key) throw new AccountError('state', 'Sign in again first.');
  const look = async (keys: Keys | null, rec: Recovery | null) => {
    if (!keys) throw new AccountError('state', 'Sign in again first.');
    return { keys, rec, ...emailWay(user, keys, rec, !!keys.byEmail && (await sameKey(key, keys.byEmail))) };
  };
  const keys = await readKeys(user.uid);
  // A Recovery code account: nothing more to check. (A mark for Email reset on its recovery
  // record, with no key kept for it, goes the next time the keys are written: see emailWay.)
  if (keys && !keys.byEmail) return { way: 'code', wasEmail: !!keys.wasEmail, turnedOff: false };
  const now = await look(keys, await readRecovery(user.email));
  if (!now.off) return { way: now.on ? 'email' : 'code', wasEmail: now.was, turnedOff: false };
  return fb!.runTransaction(db!, async (tx): Promise<WayInfo> => {
    const ks = await tx.get(keysRef(user.uid));
    const rs = await tx.get(recoveryRef(user.email));
    const { keys, rec, on, off, was } = await look(ks.exists() ? (ks.data() as Keys) : null, rs.exists() ? (rs.data() as Recovery) : null);
    if (!off) return { way: on ? 'email' : 'code', wasEmail: was, turnedOff: false };
    const { byEmail: _b, wasEmail: _w, ...rest } = keys;
    tx.set(keysRef(user.uid), was ? { ...rest, wasEmail: true } : rest);
    if (rec?.uid === user.uid && 'email' in rec) tx.set(recoveryRef(user.email), { uid: rec.uid, auth: rec.auth } satisfies Recovery);
    return { way: 'code', wasEmail: was, turnedOff: true };
  });
}

// Things the Player has to write down, shown once.
export interface Setup {
  recoveryCode: string;
  accountCode?: string;
  byEmail?: boolean; // the account uses Email reset, so the code isn't the only way back
  wasEmail?: boolean; // the key has been kept for Email reset (see WayInfo)
}

// `reset`: Firebase had a password set from a reset email, and now has this one.
// `emailOff`: Email reset was turned off, as what was left of it didn't fit (see emailWay).
// `otherKey`: the key kept for Email reset wasn't used, as it isn't the account's own as far as
// this device can tell (see Knows).
export type Result = { user: User; setup?: Setup; reset?: boolean; emailOff?: boolean } | { user: User; needsRecovery: true; otherKey?: boolean };

// A new data key, wrapped by the password and by a new recovery code. `dataKey` re-wraps an
// existing key instead (a new recovery code for the same data). `byEmail` also keeps the key as
// it is, for Email reset (`dataKey` must be extractable then); without it, any such copy goes.
// `wasEmail`: it was kept so before (the keys say so from then on, see WayInfo).
async function createKeys(user: User, master: C.Master, dataKey?: CryptoKey, { byEmail = false, wasEmail = false } = {}): Promise<Setup> {
  const dk = dataKey || (await C.newDataKey());
  const recoveryCode = C.newRecoveryCode();
  const rk = await C.recoveryKek(recoveryCode);
  const keys: Keys = { v: 1, iter: C.KDF_ITERATIONS, byPassword: await C.wrapKey(dk, master.kek, user.uid), byRecovery: await C.wrapKey(dk, rk, user.uid) };
  if (byEmail) keys.byEmail = await C.rawKey(dk);
  if (byEmail || wasEmail) keys.wasEmail = true;
  const rec: Recovery = { uid: user.uid, auth: await C.seal(rk, master.auth, `recovery/${user.uid}`) };
  if (byEmail) rec.email = true;
  const batch = fb!.writeBatch(db!);
  batch.set(keysRef(user.uid), keys);
  batch.set(recoveryRef(user.email), rec);
  try {
    await batch.commit();
  } catch (err) {
    // The reply can be lost after the keys were saved. If what's there now is exactly this
    // attempt's, it worked (and its recovery code is the one to show).
    const now = await readKeys(user.uid).catch(() => null);
    if (!now || JSON.stringify(now.byRecovery) !== JSON.stringify(keys.byRecovery)) throw err;
  }
  await keep(user, keys, master);
  return { recoveryCode, ...(byEmail ? { byEmail } : {}), ...(keys.wasEmail ? { wasEmail: true } : {}) };
}

// Keep a copy of the data key on this device that can be used but never read out.
async function keep(user: User, keys: Keys, master: C.Master) {
  const key = await C.unwrapKey(keys.byPassword, master.kek, user.uid);
  await K.saveKey({ uid: user.uid, id: user.id, key });
}

export const deviceKey = async (uid: string) => (await K.loadKey(uid))?.key ?? null;

export const isWrongPassword = (err: unknown) => /invalid-credential|invalid-login-credentials|wrong-password|user-not-found/.test(String((err as { code?: string })?.code));

// ---------- sign up, sign in

// `byEmail`: the Player chose Email reset (only for an email account).
export async function signUp({ email, password, noEmail, byEmail }: { email?: string; password: string; noEmail?: boolean; byEmail?: boolean }): Promise<Result> {
  const id = noEmail ? C.newAccountCode() : C.normalizeId(email || '');
  if (!noEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(id)) throw new AccountError('auth/invalid-email', "That email address doesn't look right.");
  checkNewPassword(password, id);
  const master = await C.deriveMaster(password, id);
  const cred = await fb!.createUserWithEmailAndPassword(auth!, loginEmail(id), master.auth);
  const user = userOf(cred.user);
  let setup: Setup;
  try {
    setup = await createKeys(user, master, undefined, { byEmail: !noEmail && !!byEmail });
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
// was set from a reset email that Arise didn't send, or a password change was interrupted). The
// recovery code fixes it.
let repairing: { user: User; master: C.Master } | null = null;

// What this device knows of an account (sync.ts keeps it), for a sign-in after a reset email.
// Anyone who gets into an account's email can set a password and sign in, then mark the account
// for Email reset and put in a key of their own, so that the data goes up under a key they know.
export interface Knows {
  // This device knows the account as a Recovery code account: it never sends a typed password.
  codeOnly(uid: string): boolean;
  // Whether this can be the account's own data key, as far as this device can tell.
  ownKey(uid: string, key: CryptoKey): Promise<boolean>;
}
const NOTHING: Knows = { codeOnly: () => false, ownKey: async () => false };

export const CODE_ONLY =
  "That password didn't work. This device knows your account as one with a recovery code, so it never uses a password set from a reset email. If you set one, use Forgot password? with your recovery code, or sign in on another device first. If you didn't, someone who got into your email may have.";

export async function signIn(id: string, password: string, knows: Knows = NOTHING): Promise<Result> {
  const email = loginEmail(id);
  const master = await C.deriveMaster(password, id);
  let cred;
  let reset = false;
  try {
    cred = await fb!.signInWithEmailAndPassword(auth!, email, master.auth);
  } catch (err) {
    // An Email reset account whose password was just set on Firebase's reset page: Firebase holds
    // that password as it was typed there. Only for those accounts, and only after the usual
    // sign-in failed, is the typed password itself sent to Firebase. Never where this device knows
    // the account uses a recovery code: the recovery record's mark could be someone else's.
    if (!isWrongPassword(err) || C.isAccountCode(id)) throw err;
    const rec = await readRecovery(email).catch(() => null);
    if (rec?.email !== true) throw err;
    if (knows.codeOnly(rec.uid)) throw new AccountError('code-only', CODE_ONLY);
    try {
      cred = await fb!.signInWithEmailAndPassword(auth!, email, password);
    } catch {
      throw err;
    }
    // From here Firebase holds the derived value again, so the typed password is never sent
    // again. If this is cut off, sign out again, so trying again starts from the same place.
    try {
      await fb!.updatePassword(cred.user, master.auth);
    } catch (e) {
      await fb!.signOut(auth!).catch(() => {});
      throw e;
    }
    reset = true;
  }
  const user = userOf(cred.user);
  const keys = await readKeys(user.uid);
  if (!keys) return { user, setup: await createKeys(user, master) }; // sign-up was interrupted
  try {
    await keep(user, keys, master);
  } catch {
    // The password works but doesn't open the key: it was set from a reset email, or a password
    // change was cut off. With Email reset the key is at hand, and is wrapped for this password
    // now. That needs a new recovery code too (see changePassword). Otherwise only the recovery
    // code opens it. The key kept for Email reset is only used if the recovery record says Email
    // reset too, and if this device can't tell it isn't the account's own (see Knows).
    const rec = await readRecovery(email);
    const raw = rec?.uid === user.uid && rec.email === true ? keys.byEmail : undefined;
    const dk = raw ? await C.keyFromRaw(raw, { extractable: true }).catch(() => null) : null;
    if (!dk || !(await knows.ownKey(user.uid, dk))) {
      repairing = { user, master };
      return dk ? { user, needsRecovery: true, otherKey: true } : { user, needsRecovery: true };
    }
    return { user, setup: await createKeys(user, master, dk, { byEmail: true }), reset: true };
  }
  return reset ? { user, reset } : { user };
}

// Signed in already (the session outlived this device's key): the password opens the key again.
export async function unlock(user: User, password: string): Promise<Result> {
  const master = await C.deriveMaster(password, user.id);
  const keys = await readKeys(user.uid);
  if (keys) {
    await keep(user, keys, master); // a wrong password throws 'wrong-key'
    return { user };
  }
  // No keys: making them was interrupted (sign-up). Firebase checks the password first.
  try {
    await fb!.reauthenticateWithCredential(auth!.currentUser!, fb!.EmailAuthProvider.credential(user.email, master.auth));
  } catch (err) {
    if (isWrongPassword(err)) throw new AccountError('wrong-key', "That password isn't right.");
    throw err;
  }
  return { user, setup: await createKeys(user, master) };
}

// Finish a sign-in that needed the recovery code (see `repairing`).
export async function repair(recoveryCode: string): Promise<Result> {
  if (!repairing) throw new AccountError('state', 'Sign in again first.');
  const { user, master } = repairing;
  const rk = await C.recoveryKek(recoveryCode);
  const keys = await readKeys(user.uid);
  if (!keys) throw new AccountError('state', 'Sign in again first.');
  const dk = await C.unwrapKey(keys.byRecovery, rk, user.uid, { extractable: true });
  const emailOff = await rewrap(user, keys, dk, master, rk);
  repairing = null;
  return emailOff ? { user, emailOff } : { user };
}

// The key wrapped for a new password, with the same recovery code, and Email reset as it was if
// it was really on (see emailWay). Returns whether what was left of it went.
async function rewrap(user: User, keys: Keys, dk: CryptoKey, master: C.Master, rk: CryptoKey) {
  const { on, off, was } = await emailWayWith(user, keys, dk);
  const { byEmail: _b, wasEmail: _w, ...rest } = keys;
  const next: Keys = { ...rest, byPassword: await C.wrapKey(dk, master.kek, user.uid) };
  if (on) next.byEmail = keys.byEmail;
  if (was) next.wasEmail = true;
  const rec: Recovery = { uid: user.uid, auth: await C.seal(rk, master.auth, `recovery/${user.uid}`) };
  if (on) rec.email = true;
  const batch = fb!.writeBatch(db!);
  batch.set(keysRef(user.uid), next);
  batch.set(recoveryRef(user.email), rec);
  await batch.commit();
  await keep(user, next, master);
  return off;
}

// ---------- forgotten password

// `emailPassword`: a password set from a reset email. Firebase holds that one then (as it was
// typed there), so the recovery code alone can't sign in. It's sent to Firebase only when the
// Player types it in, and only after the recovery code's sign-in failed.
export async function recover({ id, recoveryCode, newPassword, emailPassword = '' }: { id: string; recoveryCode: string; newPassword: string; emailPassword?: string }): Promise<Result> {
  checkNewPassword(newPassword, id);
  if (!fb) throw new AccountError('not-loaded', 'Sign-in is still loading.');
  const email = loginEmail(id);
  const rk = await C.recoveryKek(recoveryCode);
  const snap = await fb.getDoc(recoveryRef(email));
  if (!snap.exists()) throw new AccountError('no-account', C.isAccountCode(id) ? `There's no account with the code ${id}.` : `There's no account for ${id}.`);
  const rec = snap.data() as Recovery;
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
    if (usesCode(id)) throw new AccountError('reset-elsewhere', `The recovery code can't sign in to ${id}. Maybe the account was deleted. Then make a new one with "New here? Create an account".`);
    const elsewhere = new AccountError(
      'reset-elsewhere',
      `The recovery code can't sign in to ${id}. Maybe its password was set from a reset email. Then type that password in "Password from the reset email" too. Or maybe the account was deleted. Then make it again with "New here? Create an account". The data on this device can go into it.`,
    );
    if (!emailPassword) throw elsewhere;
    try {
      cred = await fb.signInWithEmailAndPassword(auth!, email, emailPassword);
    } catch (e) {
      if (isWrongPassword(e)) throw elsewhere;
      throw e;
    }
  }
  const user = userOf(cred.user);
  const keys = await readKeys(user.uid);
  if (!keys) throw new AccountError('state', "This account's keys are missing. Sign in with your password instead.");
  const dk = await C.unwrapKey(keys.byRecovery, rk, user.uid, { extractable: true });
  const master = await C.deriveMaster(newPassword, user.id);
  // Firebase first; if saving the new wrap fails after this, the recovery code repairs it next time.
  await fb.updatePassword(cred.user, master.auth);
  const emailOff = await rewrap(user, keys, dk, master, rk);
  return emailOff ? { user, emailOff } : { user };
}

// Only for accounts that chose Email reset: their key is kept for it, so the password set from
// the email opens the data again (see signIn). Any other account never gets one from the app,
// because a reset can't open its data.
export async function resetByEmail(id: string) {
  if (!fb) throw new AccountError('not-loaded', 'Sign-in is still loading.');
  const email = loginEmail(id);
  if (C.isAccountCode(id)) throw new AccountError('no-email', 'Accounts with an account code have no email. Use your recovery code.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AccountError('auth/invalid-email', "That email address doesn't look right.");
  const rec = await readRecovery(email);
  if (!rec) throw new AccountError('no-account', `There's no account for ${id}.`);
  // Only the record can tell before signing in, and it may be out of step with the keys (see
  // emailWay), so this doesn't say "end-to-end encrypted". Signing in never uses a key kept for
  // Email reset without the record's mark.
  if (rec.email !== true) throw new AccountError('encrypted', "Your account uses a recovery code, not Email reset, so a reset email can't open your data. Use your recovery code instead.");
  await fb.sendPasswordResetEmail(auth!, email);
}

// ---------- changes while signed in

export async function changePassword(user: User, oldPassword: string, newPassword: string) {
  checkNewPassword(newPassword, user.id);
  const old = await C.deriveMaster(oldPassword, user.id);
  const keys = await readKeys(user.uid);
  if (!keys) throw new AccountError('state', 'Sign in again first.');
  const dk = await C.unwrapKey(keys.byPassword, old.kek, user.uid, { extractable: true });
  const way = await emailWayWith(user, keys, dk);
  const current = auth!.currentUser!;
  await fb!.reauthenticateWithCredential(current, fb!.EmailAuthProvider.credential(user.email, old.auth));
  const master = await C.deriveMaster(newPassword, user.id);
  await fb!.updatePassword(current, master.auth);
  // The recovery record must hold the new Firebase password, but only the old code can seal it,
  // so a password change also issues a new recovery code. Email reset stays as it was.
  return createKeys(user, master, dk, { byEmail: way.on, wasEmail: way.was });
}

export async function newRecoveryCode(user: User, password: string): Promise<Setup> {
  const master = await C.deriveMaster(password, user.id);
  const keys = await readKeys(user.uid);
  if (!keys) throw new AccountError('state', 'Sign in again first.');
  const dk = await C.unwrapKey(keys.byPassword, master.kek, user.uid, { extractable: true });
  // Firebase checks it too: a login deleted elsewhere can still write for a while with this
  // device's session, and must never write over the recovery record of its email's new account.
  await reauthenticate(user, master);
  const way = await emailWayWith(user, keys, dk);
  return createKeys(user, master, dk, { byEmail: way.on, wasEmail: way.was });
}

// Switches how the account gets back in after a forgotten password. To Email reset: the key is
// kept as it is too, and the recovery code stays. To Recovery code: that copy of the key is
// deleted, and there's a new recovery code to save (returned), as it's now the only way back.
// The data key itself stays the same, so from then on the keys say it was kept (see WayInfo).
export async function setResetWay(user: User, password: string, way: Way): Promise<Setup | null> {
  if (way === 'email' && usesCode(user.id)) throw new AccountError('no-email', 'Accounts with an account code have no email, so they use a recovery code.');
  const master = await C.deriveMaster(password, user.id);
  const keys = await readKeys(user.uid);
  if (!keys) throw new AccountError('state', 'Sign in again first.');
  const dk = await C.unwrapKey(keys.byPassword, master.kek, user.uid, { extractable: true });
  await reauthenticate(user, master); // see newRecoveryCode
  if (way === 'code') return createKeys(user, master, dk, { wasEmail: (await emailWayWith(user, keys, dk)).was });
  const rec = await readRecovery(user.email);
  // No recovery record of this account's to mark (it was never saved): a new code makes one.
  if (rec?.uid !== user.uid) return createKeys(user, master, dk, { byEmail: true });
  const batch = fb!.writeBatch(db!);
  batch.set(keysRef(user.uid), { ...keys, byEmail: await C.rawKey(dk), wasEmail: true } satisfies Keys);
  batch.set(recoveryRef(user.email), { uid: rec.uid, auth: rec.auth, email: true } satisfies Recovery);
  await batch.commit();
  return null;
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

// Deletes the account's keys (with any copy kept for Email reset) and recovery record (sync.ts
// deletes the data first), then the account.
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
