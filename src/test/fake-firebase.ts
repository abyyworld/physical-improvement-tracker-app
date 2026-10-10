// An in-memory Firebase (Auth + Firestore lite) for tests. The cloud is shared by every
// simulated device (globalThis.__cloud); sign-in state belongs to each module instance.
//
// Writes are checked against the same document shapes firestore.rules allows, so a test fails if
// the app ever writes something the real rules would refuse (or anything unencrypted).

type Doc = Record<string, unknown>;
interface Cloud {
  docs: Map<string, Doc>;
  users: Map<string, { uid: string; email: string; password: string }>;
  next: number;
  // Runs before each operation; may throw to fail it. Returning 'lost' on a commit (or a
  // deleteUser) applies it and then fails, like a write whose reply never arrived.
  hook: ((op: string, path: string) => Promise<unknown> | unknown) | null;
}
export const cloud: Cloud = ((globalThis as { __cloud?: Cloud }).__cloud ||= { docs: new Map(), users: new Map(), next: 1, hook: null });
export function resetCloud() {
  cloud.docs.clear();
  cloud.users.clear();
  cloud.next = 1;
  cloud.hook = null;
}

const fail = (code: string) => Object.assign(new Error(code), { code });

interface FakeUser {
  uid: string;
  email: string;
  since: string; // the login's password when this session began
  getIdToken: (forceRefresh?: boolean) => Promise<string>;
}
interface FakeAuth {
  currentUser: FakeUser | null;
  cbs: ((u: FakeUser | null) => void)[];
}
let auth: FakeAuth | null = null;

// A session can be renewed while its login exists and still has the password it began with
// (Firebase ends a login's other sessions when its password changes). Otherwise renewing fails
// with user-token-expired and signs the device out, as the real SDK does: it reports a deleted
// login the same way, never as user-not-found.
const userFor = (uid: string, email: string): FakeUser => {
  const user: FakeUser = {
    uid,
    email,
    since: cloud.users.get(uid)?.password ?? '',
    getIdToken: async (forceRefresh = false) => {
      if (forceRefresh && cloud.users.get(uid)?.password !== user.since) {
        if (auth?.currentUser === user) setUser(null);
        throw fail('auth/user-token-expired');
      }
      return `token-${uid}`;
    },
  };
  return user;
};
const setUser = (u: FakeUser | null) => {
  auth!.currentUser = u;
  for (const cb of auth!.cbs) cb(u);
};

export const indexedDBLocalPersistence = {};
export const browserLocalPersistence = {};
export const initializeApp = (cfg: unknown) => ({ cfg });
export function initializeAuth() {
  auth = { currentUser: null, cbs: [] };
  return auth;
}
export function onAuthStateChanged(a: FakeAuth, cb: (u: FakeUser | null) => void) {
  a.cbs.push(cb);
  Promise.resolve().then(() => cb(a.currentUser));
  return () => {};
}

// Test helper: this device is signed in already (a session that outlived the device's key).
export function restoreSession(uid: string) {
  const u = cloud.users.get(uid)!;
  auth!.currentUser = userFor(u.uid, u.email);
}

export async function createUserWithEmailAndPassword(_a: FakeAuth, email: string, password: string) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail('auth/invalid-email');
  if ([...cloud.users.values()].some((u) => u.email === email)) throw fail('auth/email-already-in-use');
  if (password.length < 6) throw fail('auth/weak-password');
  const uid = `uid${cloud.next++}`;
  cloud.users.set(uid, { uid, email, password });
  const user = userFor(uid, email);
  setUser(user);
  return { user };
}
export async function signInWithEmailAndPassword(_a: FakeAuth, email: string, password: string) {
  if (cloud.hook) await cloud.hook('signIn', password);
  const u = [...cloud.users.values()].find((x) => x.email === email && x.password === password);
  if (!u) throw fail('auth/invalid-credential');
  const user = userFor(u.uid, email);
  setUser(user);
  return { user };
}
export async function signOut() {
  setUser(null);
}
// This session carries on with the new password; the login's other sessions end.
export async function updatePassword(user: FakeUser, password: string) {
  if (cloud.hook) await cloud.hook('updatePassword', password);
  cloud.users.get(user.uid)!.password = password;
  user.since = password;
}
// Test helper: Firebase's own reset page (from a reset email) sets this password, as it's typed
// there. Every session of the login ends.
export function setPasswordFromResetPage(email: string, password: string) {
  const u = [...cloud.users.values()].find((x) => x.email === email);
  if (!u) throw new Error(`no login ${email}`);
  u.password = password;
}
export const EmailAuthProvider = { credential: (email: string, password: string) => ({ email, password }) };
export async function reauthenticateWithCredential(user: FakeUser, cred: { email: string; password: string }) {
  if (cloud.hook) await cloud.hook('reauth', cred.password);
  const u = cloud.users.get(user.uid);
  if (!u || u.email !== cred.email || u.password !== cred.password) throw fail('auth/invalid-credential');
  user.since = u.password;
}
// The hook returning 'lost' deletes the login but fails the call, like a reply that never
// arrived: the device stays signed in (its token still works for a while).
export async function deleteUser(user: FakeUser) {
  const lost = cloud.hook ? (await cloud.hook('deleteUser', user.uid)) === 'lost' : false;
  cloud.users.delete(user.uid);
  if (lost) throw fail('unavailable');
  setUser(null);
}
export async function sendPasswordResetEmail(_a: FakeAuth, email: string) {
  if (cloud.hook) await cloud.hook('reset', email);
}

export const getFirestore = () => ({});
export const doc = (_db: unknown, ...path: string[]) => ({ path: path.join('/') });

// ---------- the rules (mirrors firestore.rules)

const str = (v: unknown, max: number) => typeof v === 'string' && v.length <= max;
const only = (d: Doc, keys: string[]) => Object.keys(d).every((k) => keys.includes(k));
const sealed = (v: unknown, max: number) => !!v && typeof v === 'object' && only(v as Doc, ['iv', 'ct']) && str((v as Doc).iv, 24) && str((v as Doc).ct, max);
const rawKey = (v: unknown) => typeof v === 'string' && v.length === 44 && /^[A-Za-z0-9+/]{43}=$/.test(v);
// Firestore refuses a field set to undefined (unless told to drop them, which the app isn't).
const hasUndefined = (v: unknown): boolean => v === undefined || (!!v && typeof v === 'object' && Object.values(v).some(hasUndefined));

function canRead(path: string) {
  const u = auth?.currentUser;
  if (path.startsWith('recovery/')) return true;
  return !!u && path.startsWith(`users/${u.uid}/arise/`);
}

function canWrite(path: string, d: Doc | null) {
  const u = auth?.currentUser;
  if (!u) return false;
  const rec = /^recovery\/(.+)$/.exec(path);
  if (rec) return rec[1] === u.email && (d === null || (only(d, ['uid', 'auth', 'email']) && d.uid === u.uid && sealed(d.auth, 400) && (!('email' in d) || d.email === true)));
  const m = new RegExp(`^users/${u.uid}/arise/(.+)$`).exec(path);
  if (!m) return false;
  if (d === null) return true;
  if (m[1] === 'meta') return only(d, ['rev', 'parts', 'enc', 'iv', 'schema']) && str(d.rev, 32) && Number.isInteger(d.parts) && (d.parts as number) >= 1 && (d.parts as number) <= 20 && d.enc === 1 && str(d.iv, 24) && Number.isInteger(d.schema);
  if (m[1] === 'keys') return only(d, ['v', 'iter', 'byPassword', 'byRecovery', 'byEmail']) && d.v === 1 && Number.isInteger(d.iter) && sealed(d.byPassword, 200) && sealed(d.byRecovery, 200) && (!('byEmail' in d) || rawKey(d.byEmail));
  if (/^part([0-9]|1[0-9])$/.test(m[1])) return only(d, ['rev', 'ct']) && str(d.rev, 32) && str(d.ct, 700000);
  return false;
}

export async function getDoc(ref: { path: string }) {
  if (cloud.hook) await cloud.hook('getDoc', ref.path);
  if (!canRead(ref.path)) throw fail('permission-denied');
  const v = cloud.docs.get(ref.path);
  return { exists: () => v !== undefined, data: () => structuredClone(v) as Doc };
}

export function writeBatch() {
  const ops: [string, string, Doc | null][] = [];
  return {
    set: (r: { path: string }, v: Doc) => {
      if (hasUndefined(v)) throw fail('invalid-argument');
      ops.push(['set', r.path, structuredClone(v)]);
    },
    delete: (r: { path: string }) => ops.push(['del', r.path, null]),
    async commit() {
      const lost = cloud.hook ? (await cloud.hook('commit', ops.map((o) => o[1]).join(','))) === 'lost' : false;
      for (const [, p, v] of ops) if (!canWrite(p, v)) throw fail('permission-denied');
      for (const [op, p, v] of ops) {
        if (op === 'set') cloud.docs.set(p, v!);
        else cloud.docs.delete(p);
      }
      if (lost) throw fail('unavailable');
    },
  };
}
// Like Firestore's: the writes only land if nothing the transaction read changed meanwhile;
// otherwise the function runs again (and gives up after 5 tries).
export async function runTransaction<T>(_db: unknown, fn: (tx: unknown) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const reads = new Map<string, string>();
    const ops: [string, string, Doc | null][] = [];
    const tx = {
      async get(r: { path: string }) {
        const snap = await getDoc(r);
        reads.set(r.path, JSON.stringify(cloud.docs.get(r.path) ?? null));
        return snap;
      },
      set(r: { path: string }, v: Doc) {
        if (hasUndefined(v)) throw fail('invalid-argument');
        ops.push(['set', r.path, structuredClone(v)]);
        return tx;
      },
      delete(r: { path: string }) {
        ops.push(['del', r.path, null]);
        return tx;
      },
    };
    const result = await fn(tx);
    if (cloud.hook) await cloud.hook('commit', ops.map((o) => o[1]).join(','));
    if ([...reads].some(([p, v]) => JSON.stringify(cloud.docs.get(p) ?? null) !== v)) continue;
    for (const [, p, v] of ops) if (!canWrite(p, v)) throw fail('permission-denied');
    for (const [op, p, v] of ops) {
      if (op === 'set') cloud.docs.set(p, v!);
      else cloud.docs.delete(p);
    }
    return result;
  }
  throw fail('aborted');
}

export async function setDoc(r: { path: string }, v: Doc) {
  const b = writeBatch();
  b.set(r, v);
  await b.commit();
}
export async function deleteDoc(r: { path: string }) {
  const b = writeBatch();
  b.delete(r);
  await b.commit();
}
