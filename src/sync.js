// Accounts and sync, using Firebase on its free plan. Optional: the app works fully without it.
//
// Your data still lives on this device first. Signing in with email and password keeps a copy in
// your own private space in the cloud, so the same history shows up on every device where you sign
// in. The database rules (firestore.rules) only let a signed-in person read and write their own
// data. The AI key is never synced, and neither is a workout in progress.
//
// Cloud layout: users/{uid}/arise/meta says which version is current; the data itself is JSON split
// across users/{uid}/arise/part0, part1... (a cloud document holds about 1 MB).

import * as S from './store';
import { FIREBASE } from './firebase-config.js';
import { esc, icon, toast } from './ui.js';

export const configured = !!(FIREBASE && FIREBASE.apiKey && FIREBASE.projectId);

const META_KEY = 'arise-sync'; // { uid, email, rev, hash, at, lastUid }
const CHUNK = 300000; // characters per cloud document
const PUSH_DELAY = 8000;

let fb = null;
let auth = null;
let db = null;
let hooks = { render: () => {}, changed: () => {} };

// What the Settings panel shows.
export const status = { loading: false, user: null, busy: false, error: '', form: 'in' };

const readMeta = () => {
  try {
    return JSON.parse(localStorage.getItem(META_KEY)) || {};
  } catch {
    return {};
  }
};
const writeMeta = (m) => {
  try {
    localStorage.setItem(META_KEY, JSON.stringify(m));
  } catch {}
};

// ---------- the copy that goes to the cloud

// Everything except what belongs to this device: a workout in progress, whether this phone sends
// notifications, and the change time (kept in the meta document instead).
function cloudCopy() {
  const { active, updatedAt, ...rest } = S.state;
  const { notify, ...settings } = rest.settings;
  return { ...rest, settings };
}

// FNV-1a: a quick fingerprint to tell whether anything changed since the last sync.
function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

const isEmpty = (st) => !st.sessions.length && !Object.keys(st.logs).length && !st.profile?.goal && !st.body.entries.length;

// Both devices changed something since they last synced: keep everything from both. Single values
// (settings, profile, plan) come from whichever copy changed last.
function merge(local, localAt, remote, remoteAt) {
  const [newer, older] = localAt >= remoteAt ? [local, remote] : [remote, local];
  const out = structuredClone(newer);
  const byId = new Map((older.sessions || []).map((s) => [s.id, s]));
  for (const s of newer.sessions || []) byId.set(s.id, s);
  out.sessions = [...byId.values()].sort((x, y) => (x.date === y.date ? x.started - y.started : x.date < y.date ? -1 : 1));
  for (const k of ['football', 'easyWeeks', 'rests']) out[k] = [...new Set([...(older[k] || []), ...(newer[k] || [])])].sort();
  out.logs = { ...(older.logs || {}), ...(newer.logs || {}) };
  for (const [k, l] of Object.entries(older.logs || {})) if ((l?.at || 0) > (out.logs[k]?.at || 0)) out.logs[k] = l;
  const entries = new Map((older.body?.entries || []).map((e) => [e.date, e]));
  for (const e of newer.body?.entries || []) entries.set(e.date, { ...entries.get(e.date), ...e });
  out.body = { ...(older.body || {}), ...(newer.body || {}), entries: [...entries.values()].sort((a, b) => (a.date < b.date ? -1 : 1)) };
  out.profile = newer.profile || older.profile || null;
  out.ai = { ...(older.ai || {}), ...(newer.ai || {}), daily: { ...(older.ai?.daily || {}), ...(newer.ai?.daily || {}) } };
  return out;
}

let applying = false;

function adopt(data) {
  applying = true;
  S.adoptState(data, { keep: { active: S.state.active, updatedAt: S.state.updatedAt, settings: { ...data.settings, notify: S.state.settings.notify } } });
  applying = false;
  hooks.changed();
}

// ---------- Firebase

async function load() {
  if (fb) return;
  status.loading = true;
  try {
    fb = await import('./lib/firebase');
  } catch {
    status.loading = false;
    throw new Error('Could not load the sign-in module. Check your internet connection.');
  }
  const app = fb.initializeApp(FIREBASE);
  // No pop-up sign-in, so this works in the iPhone app too.
  auth = fb.initializeAuth(app, { persistence: [fb.indexedDBLocalPersistence, fb.browserLocalPersistence] });
  db = fb.getFirestore(app);
  await new Promise((resolve) => {
    let first = true;
    fb.onAuthStateChanged(auth, (u) => {
      status.user = u ? { uid: u.uid, email: u.email } : null;
      status.loading = false;
      if (first) {
        first = false;
        resolve();
      }
      hooks.render();
    });
  });
}

const ref = (name) => fb.doc(db, 'users', status.user.uid, 'arise', name);

async function readRemote() {
  const snap = await fb.getDoc(ref('meta'));
  return snap.exists() ? snap.data() : null;
}

// Read every part of the current version. If another device saved in the middle, read again.
async function pull(remote) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const snaps = await Promise.all(Array.from({ length: remote.parts }, (_, i) => fb.getDoc(ref(`part${i}`))));
    if (snaps.every((s) => s.exists() && s.data().rev === remote.rev)) return { data: JSON.parse(snaps.map((s) => s.data().text).join('')), remote };
    remote = await readRemote();
    if (!remote) break;
  }
  throw new Error('The cloud copy kept changing while loading. Try again.');
}

// Write all parts and the meta document in one go, so nobody ever reads half a version.
async function push(json, h, remote) {
  const rev = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const parts = [];
  for (let i = 0; i < json.length; i += CHUNK) parts.push(json.slice(i, i + CHUNK));
  const batch = fb.writeBatch(db);
  parts.forEach((text, i) => batch.set(ref(`part${i}`), { rev, text }));
  for (let i = parts.length; i < (remote?.parts || 0); i++) batch.delete(ref(`part${i}`));
  batch.set(ref('meta'), { rev, parts: parts.length, updatedAt: S.state.updatedAt || Date.now(), savedAt: Date.now(), app: 1 });
  await batch.commit();
  writeMeta({ ...readMeta(), uid: status.user.uid, email: status.user.email, rev, hash: h, at: Date.now() });
}

async function run({ replaceLocal = false } = {}) {
  const meta = readMeta();
  const first = meta.uid !== status.user.uid;
  let remote = await readRemote();
  const localJSON = JSON.stringify(cloudCopy());
  const localHash = hash(localJSON);
  const localChanged = first || localHash !== meta.hash;
  const remoteChanged = !!remote && (first || remote.rev !== meta.rev);
  if (remoteChanged) {
    const got = await pull(remote);
    remote = got.remote;
    if (replaceLocal || !localChanged || isEmpty(S.state)) {
      // Only the cloud changed (or this device has nothing yet): take it as it is.
      adopt(got.data);
      writeMeta({ ...meta, uid: status.user.uid, email: status.user.email, rev: remote.rev, hash: hash(JSON.stringify(cloudCopy())), at: Date.now() });
    } else {
      adopt(merge(cloudCopy(), S.state.updatedAt || 0, got.data, remote.updatedAt || 0));
      const json = JSON.stringify(cloudCopy());
      await push(json, hash(json), remote);
    }
  } else if (localChanged || !remote) {
    if (replaceLocal && !remote) {
      // A new account on a device that had someone else's data: start this account empty.
      applying = true;
      S.resetAll();
      applying = false;
      hooks.changed();
    }
    const json = JSON.stringify(cloudCopy());
    await push(json, hash(json), remote);
  } else {
    writeMeta({ ...meta, at: Date.now() });
  }
}

let running = null;
let again = false;

export async function syncNow(opts) {
  if (!status.user) return;
  if (running) {
    again = true;
    return running;
  }
  status.busy = true;
  status.error = '';
  hooks.render();
  running = (async () => {
    try {
      // A stuck connection shouldn't leave "Syncing…" on screen forever.
      await Promise.race([run(opts), new Promise((_, reject) => setTimeout(() => reject(new Error('Syncing took too long. It will try again next time you open the app.')), 30000))]);
    } catch (err) {
      status.error = friendly(err);
    }
  })();
  await running;
  running = null;
  status.busy = false;
  hooks.render();
  if (again) {
    again = false;
    return syncNow();
  }
}

// After a change on this device, send it up once things are quiet for a few seconds.
let timer = null;
function queue() {
  if (applying || !status.user) return;
  clearTimeout(timer);
  timer = setTimeout(flush, PUSH_DELAY);
}
function flush() {
  clearTimeout(timer);
  timer = null;
  // Nothing to send if only this device's own things changed (like a workout in progress).
  if (status.user && hash(JSON.stringify(cloudCopy())) !== readMeta().hash) syncNow();
}

// ---------- account actions

function friendly(err) {
  const code = String(err?.code || '');
  const map = {
    'auth/invalid-email': "That email address doesn't look right.",
    'auth/invalid-credential': 'Wrong email or password.',
    'auth/invalid-login-credentials': 'Wrong email or password.',
    'auth/wrong-password': 'Wrong email or password.',
    'auth/user-not-found': 'Wrong email or password.',
    'auth/missing-password': 'Type your password.',
    'auth/email-already-in-use': "There's already an account with that email. Sign in instead.",
    'auth/weak-password': 'Use a password with at least 6 characters.',
    'auth/too-many-requests': 'Too many tries. Wait a few minutes and try again.',
    'auth/network-request-failed': 'No internet connection. Try again when you are online.',
    'auth/operation-not-allowed': 'Email sign-in is not switched on in the Firebase project yet.',
    'auth/configuration-not-found': 'Sign-in is not set up in the Firebase project yet.',
    'auth/api-key-not-valid': 'The Firebase settings in the app are wrong.',
    'auth/requires-recent-login': 'For safety, sign out and back in, then try again.',
    'permission-denied': 'The cloud database said no. Check the Firestore rules in the Firebase project.',
    'not-found': 'The cloud database has not been created in the Firebase project yet.',
    unavailable: "Couldn't reach the cloud. It will sync when you are back online.",
  };
  if (/api-key-not-valid/.test(code)) return map['auth/api-key-not-valid'];
  return map[code] || err?.message || 'Something went wrong.';
}

async function enter(kind, email, password) {
  await load();
  const before = readMeta();
  const cred = kind === 'up' ? await fb.createUserWithEmailAndPassword(auth, email, password) : await fb.signInWithEmailAndPassword(auth, email, password);
  status.user = { uid: cred.user.uid, email: cred.user.email };
  // This device holds data from a different account: don't mix the two.
  const other = (before.uid || before.lastUid) && (before.uid || before.lastUid) !== cred.user.uid && !isEmpty(S.state);
  if (other && !confirm(`This device has data from another account. Replace it with the data of ${cred.user.email}? The other account keeps its own cloud copy.`)) {
    await fb.signOut(auth);
    status.user = null;
    return;
  }
  if (other) writeMeta({ lastUid: before.uid || before.lastUid });
  await syncNow({ replaceLocal: !!other });
  if (!status.error) toast(kind === 'up' ? 'Account created. Your data is backed up.' : 'Signed in. Your data is synced.');
}

async function leave({ clear }) {
  if (timer) flush();
  if (running) await running;
  const m = readMeta();
  await fb.signOut(auth);
  status.user = null;
  writeMeta({ lastUid: m.uid || m.lastUid });
  if (clear) {
    applying = true;
    S.resetAll();
    applying = false;
    writeMeta({});
    hooks.changed();
  }
}

async function deleteCloud() {
  const remote = await readRemote();
  const batch = fb.writeBatch(db);
  for (let i = 0; i < (remote?.parts || 0); i++) batch.delete(ref(`part${i}`));
  batch.delete(ref('meta'));
  await batch.commit();
}

// ---------- screens

const field = (id, label, type, extra = '') =>
  `<label class="field"><span class="k">${label}</span><input id="${id}" type="${type}" ${extra} autocomplete="${type === 'email' ? 'email' : status.form === 'up' ? 'new-password' : 'current-password'}" spellcheck="false"></label>`;

function ago(t) {
  if (!t) return 'not yet';
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(t).toLocaleDateString();
}

export function panel() {
  if (!configured) return '';
  const u = status.user;
  const err = status.error ? `<p class="small error">${esc(status.error)}</p>` : '';
  if (status.loading && !u) return `<section class="panel" id="accountPanel"><div class="panel-title">${icon('key')}<span>Account</span></div><p class="muted">Loading…</p></section>`;
  if (u) {
    return `<section class="panel" id="accountPanel">
      <div class="panel-title">${icon('key')}<span>Account</span></div>
      <p>Signed in as <b>${esc(u.email)}</b>. Your data is backed up and the same on every device where you sign in.</p>
      <p class="muted small">${status.busy ? 'Syncing…' : `Last synced: ${ago(readMeta().at)}.`}</p>
      ${err}
      <div class="row">
        <button class="btn ghost small" data-act="sync-now" ${status.busy ? 'disabled' : ''}>Sync now</button>
        <button class="btn ghost small" data-act="sync-out">Sign out</button>
      </div>
      <details class="other"><summary>More</summary>
        <div class="stack">
          <button class="btn ghost small" data-act="sync-out-clear">Sign out and remove my data from this device</button>
          <button class="btn ghost small danger" data-act="sync-delete">Delete my account and cloud copy</button>
        </div>
      </details>
    </section>`;
  }
  const up = status.form === 'up';
  return `<section class="panel" id="accountPanel">
    <div class="panel-title">${icon('key')}<span>Account</span></div>
    <p>${up ? 'Create a free account' : 'Sign in'} to back up your data and have the same history on every device. Only you can see it. Without an account everything stays on this device.</p>
    <form id="accountForm" class="stack" autocomplete="on">
      ${field('accEmail', 'Email', 'email', 'inputmode="email" required')}
      ${field('accPass', 'Password', 'password', `minlength="6" required${up ? ' placeholder="At least 6 characters"' : ''}`)}
      ${err}
      <button class="btn primary" type="submit" ${status.busy || status.loading ? 'disabled' : ''}>${status.busy ? 'One moment…' : up ? 'Create account' : 'Sign in'}</button>
    </form>
    <div class="row">
      <button class="link small" data-act="sync-form" data-v="${up ? 'in' : 'up'}">${up ? 'Already have an account? Sign in' : 'New here? Create an account'}</button>
      ${up ? '' : '<button class="link small" data-act="sync-reset">Forgot password?</button>'}
    </div>
  </section>`;
}

export async function handleAction(act) {
  if (!act.startsWith('sync-')) return false;
  try {
    if (act === 'sync-form') {
      status.form = status.form === 'up' ? 'in' : 'up';
      status.error = '';
    } else if (act === 'sync-now') {
      await syncNow();
      if (!status.error) toast('Synced.');
    } else if (act === 'sync-out') {
      await leave({ clear: false });
      toast('Signed out. Your data stays on this device.');
    } else if (act === 'sync-out-clear') {
      if (!confirm('Sign out and remove your data from this device? Your cloud copy stays, so you can sign in again to get it back.')) return true;
      await leave({ clear: true });
      toast('Signed out and removed from this device.');
    } else if (act === 'sync-delete') {
      if (!confirm('Delete your account and your cloud copy? This cannot be undone. The data on this device stays.')) return true;
      await deleteCloud();
      await fb.deleteUser(auth.currentUser);
      status.user = null;
      writeMeta({});
      toast('Account and cloud copy deleted.');
    } else if (act === 'sync-reset') {
      const email = document.getElementById('accEmail')?.value.trim();
      if (!email) {
        status.error = 'Type your email first, then tap Forgot password.';
      } else {
        await load();
        await fb.sendPasswordResetEmail(auth, email);
        status.error = '';
        toast('If that email has an account, a reset link is on its way.');
      }
    }
  } catch (err) {
    status.error = friendly(err);
  }
  hooks.render();
  return true;
}

document.addEventListener('submit', async (e) => {
  if (e.target.id !== 'accountForm') return;
  e.preventDefault();
  const email = document.getElementById('accEmail').value.trim();
  const password = document.getElementById('accPass').value;
  status.busy = true;
  status.error = '';
  hooks.render();
  try {
    await enter(status.form === 'up' ? 'up' : 'in', email, password);
  } catch (err) {
    status.error = friendly(err);
  }
  status.busy = false;
  hooks.render();
});

// ---------- start

export function initSync(h) {
  hooks = { ...hooks, ...h };
  if (!configured) return;
  S.onSave(queue);
  document.addEventListener('visibilitychange', () => {
    if (!status.user) return;
    if (document.visibilityState === 'hidden') {
      if (timer) flush();
    } else {
      syncNow();
    }
  });
  // Only load Firebase at start if this device was signed in before.
  if (readMeta().uid) {
    load()
      .then(() => syncNow())
      .catch((err) => {
        status.error = friendly(err);
        hooks.render();
      });
  }
}
