// Accounts and sync. Optional: the app works fully without them.
//
// The Player's data lives on this device first. Signing in keeps an end-to-end encrypted copy in
// the cloud, so the same history shows up on every device where they sign in. The cloud copy is
// encrypted on the device with a key the server never sees (account.ts, lib/crypto.ts), so
// nobody else can read it. The AI key, the AI service settings, notification settings, AI usage
// counts and a workout in progress stay on each device.
//
// Cloud layout: users/{uid}/arise/meta says which version is current and holds its IV; the
// ciphertext is split across users/{uid}/arise/part0, part1... (a document holds about 1 MB).

import * as S from './store';
import * as A from './account';
import { merge, type CloudCopy } from './lib/merge';
import { seal, open } from './lib/crypto';
import { esc, icon, openSheet, closeSheet, toast } from './ui.js';

export const configured = A.configured;

const META_KEY = 'arise-sync';
const CHUNK = 700_000; // characters of ciphertext per cloud document
const PUSH_DELAY = 8000;
const TIMEOUT = 45_000;
// Bump when the shape of the synced data changes. A device with an older app won't touch data
// saved by a newer one; it updates itself first.
export const SCHEMA = 1;

interface Meta {
  uid?: string;
  rev?: string; // the cloud version this device last saw
  hash?: string; // fingerprint of the data at that point
  at?: number; // when this device last synced
  changedAt?: number; // when this device's synced data last changed
  seenHash?: string; // fingerprint when changedAt was taken
  lastUid?: string;
  deleting?: boolean;
}

let hooks = { render: () => {}, changed: () => {}, checkForUpdate: () => {} };

type Form = 'in' | 'up' | 'recover' | 'reset';
export const status = {
  loading: false,
  user: null as A.User | null,
  busy: false,
  error: '',
  form: 'in' as Form,
  noEmail: false,
  locked: false, // signed in, but this device doesn't have the key yet
  repair: false, // the password works but the key needs the recovery code
  pending: null as A.Setup | null, // codes the Player still has to save
  replacePending: false, // a confirmed "replace this device's data" waiting for the recovery code
  more: '' as '' | 'password' | 'code' | 'delete',
};

const readMeta = (): Meta => {
  try {
    return JSON.parse(localStorage.getItem(META_KEY) || '{}') || {};
  } catch {
    return {};
  }
};
const writeMeta = (m: Meta) => {
  try {
    localStorage.setItem(META_KEY, JSON.stringify(m));
  } catch {}
};
const patchMeta = (p: Partial<Meta>) => writeMeta({ ...readMeta(), ...p });

// ---------- the copy that goes to the cloud

// Everything except what belongs to this device.
function cloudCopy(): CloudCopy {
  const { active: _a, updatedAt: _u, ...rest } = S.state;
  const { notify: _n, aiProvider: _p, aiModel: _m, aiBase: _b, aiEngine: _e, ...settings } = rest.settings;
  const { usage: _usage, ...ai } = rest.ai;
  return { ...rest, settings, ai } as unknown as CloudCopy;
}

// FNV-1a: a quick fingerprint to tell whether anything changed since the last sync.
function hash(str: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}
const currentHash = () => hash(JSON.stringify(cloudCopy()));

// Nothing at all of the Player's own yet: then the cloud copy is simply taken as it is.
const pristine = () => S.isEmpty() && !S.state.football.length && !S.state.rests.length && !S.state.easyWeeks.length && !S.state.customPlan;
// Not even a delete on record: just installed, erased, or the storage couldn't be read. A blank
// copy like this never goes over the cloud copy; it's always replaced by it.
const blank = () => pristine() && !Object.values(S.state.stamps).some((m) => Object.keys(m || {}).length);
// Only what the intro sets up (a goal, a profile, settings) and nothing done yet. On a first
// sign-in the account's own copy is taken instead, so a new phone doesn't overwrite the real goal.
const setupOnly = () => {
  const s = S.state;
  return !s.sessions.length && !Object.keys(s.logs).length && !s.body.entries.length && !Object.keys(s.checks).length && !Object.keys(s.values).length && !s.football.length && !s.rests.length && !s.easyWeeks.length && !s.customPlan && !s.ai.chat.length;
};

let applying = false;

function adopt(data: CloudCopy) {
  applying = true;
  const st = S.state.settings;
  S.adoptState(data, {
    keep: {
      active: S.state.active,
      updatedAt: S.state.updatedAt,
      settings: { ...data.settings, notify: st.notify, aiProvider: st.aiProvider, aiModel: st.aiModel, aiBase: st.aiBase, aiEngine: st.aiEngine },
      ai: { ...data.ai, usage: S.state.ai.usage },
    },
  });
  applying = false;
  hooks.changed();
}

// When this device's synced data last changed. Taken when a change is first noticed (see
// `flush`), so ticking off sets during a workout never makes old settings look new.
function localChangedAt(meta: Meta, h: string) {
  return h === meta.seenHash && meta.changedAt ? meta.changedAt : S.state.updatedAt || Date.now();
}

// ---------- the cloud

interface Remote {
  rev: string;
  parts: number;
  enc?: 1;
  iv?: string;
  schema?: number;
  updatedAt?: number; // only in copies from before encryption
}

interface Payload {
  schema: number;
  changedAt: number;
  data: CloudCopy;
}

const ref = (name: string) => {
  const { fb, db } = A.firebase();
  return fb.doc(db, 'users', status.user!.uid, 'arise', name);
};

async function readRemote(): Promise<Remote | null> {
  const { fb } = A.firebase();
  const snap = await fb.getDoc(ref('meta'));
  return snap.exists() ? (snap.data() as Remote) : null;
}

async function key() {
  const k = await A.deviceKey(status.user!.uid);
  if (!k) throw Object.assign(new Error('locked'), { code: 'locked' });
  return k;
}

// Read every part of the current version and open it. If another device saved in the middle,
// read again. Copies from before encryption are plain JSON; they're re-encrypted straight after.
async function pull(remote: Remote): Promise<{ payload: Payload; remote: Remote; legacy: boolean }> {
  const { fb } = A.firebase();
  for (let attempt = 0; attempt < 3; attempt++) {
    const snaps = await Promise.all(Array.from({ length: remote.parts }, (_, i) => fb.getDoc(ref(`part${i}`))));
    if (snaps.every((s) => s.exists() && s.data().rev === remote.rev)) {
      const parts = snaps.map((s) => s.data()!);
      if (remote.enc === 1) {
        const text = await open(await key(), { iv: remote.iv!, ct: parts.map((p) => p.ct).join('') }, `${status.user!.uid}/${remote.rev}`);
        const payload = JSON.parse(text) as Payload;
        return { payload: { ...payload, data: S.clean(payload.data) }, remote, legacy: false };
      }
      const data = JSON.parse(parts.map((p) => p.text).join(''));
      return { payload: { schema: 0, changedAt: remote.updatedAt || 0, data: S.clean(data) }, remote, legacy: true };
    }
    const again = await readRemote();
    if (!again) break;
    remote = again;
  }
  throw new Error('The cloud copy kept changing while loading. Try again.');
}

// Encrypt and write all parts and the meta document in one go, so nobody ever reads half a
// version. Only if the cloud still holds the version this copy was based on: when another device
// saved in between, nothing is written and sync runs again to take that version in first.
async function push(data: CloudCopy, changedAt: number, remote: Remote | null, gen: number) {
  const { fb, db } = A.firebase();
  const json = JSON.stringify(data);
  const rev = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const sealed = await seal(await key(), JSON.stringify({ schema: SCHEMA, changedAt, data } satisfies Payload), `${status.user!.uid}/${rev}`);
  const parts: string[] = [];
  for (let i = 0; i < sealed.ct.length; i += CHUNK) parts.push(sealed.ct.slice(i, i + CHUNK));
  if (parts.length > 20) throw new Error('Your data is too big to sync. Save a backup instead.');
  if (gen !== generation) return;
  const written = await fb.runTransaction(db, async (tx) => {
    const now = await tx.get(ref('meta'));
    if ((now.exists() ? (now.data() as Remote).rev : null) !== (remote?.rev ?? null)) return false;
    parts.forEach((ct, i) => tx.set(ref(`part${i}`), { rev, ct }));
    for (let i = parts.length; i < (remote?.parts || 0); i++) tx.delete(ref(`part${i}`));
    tx.set(ref('meta'), { rev, parts: parts.length, enc: 1, iv: sealed.iv, schema: SCHEMA });
    return true;
  });
  if (!written) {
    again = true;
    return;
  }
  const h = hash(json);
  if (gen === generation) patchMeta({ uid: status.user!.uid, rev, hash: h, at: Date.now(), changedAt, seenHash: h });
}

// Each run gets a number; signing out or a timeout moves it on, so a stale run stops before it
// takes in or sends anything.
let generation = 0;

async function run({ replaceLocal = false } = {}) {
  const gen = ++generation;
  const meta = readMeta();
  if (meta.deleting) return;
  const uid = status.user!.uid;
  await key();
  const first = meta.uid !== uid;
  let remote = await readRemote();
  if (gen !== generation) return;
  if (!remote && !first && meta.rev && !(await A.hasKeys(uid))) {
    // The account was deleted on another device. Uploading now would make a cloud copy nobody
    // could ever delete, so this device signs out instead and keeps its data.
    if (gen !== generation) return;
    await deletedElsewhere();
    return;
  }
  if ((remote?.schema || 0) > SCHEMA) {
    hooks.checkForUpdate();
    throw new Error('Your data was saved by a newer version of Arise. This app is updating; sync starts again after that.');
  }
  const startHash = currentHash();
  // Sync info from before 2.0 has a fingerprint of a different shape, so there only the time can
  // tell whether anything changed on this device since it last synced.
  const oldMeta = !!meta.hash && !meta.seenHash && !meta.changedAt;
  const localChanged = first || (oldMeta ? (S.state.updatedAt || 0) > (meta.at || 0) : startHash !== meta.hash);
  // A copy from before encryption is always taken in and sent back encrypted.
  const remoteChanged = !!remote && (first || remote.rev !== meta.rev || remote.enc !== 1 || blank());

  if (remote && remoteChanged) {
    const got = await pull(remote);
    if (gen !== generation) return;
    remote = got.remote;
    // Anything saved while the copy downloaded counts as a change on this device.
    const nowHash = currentHash();
    const changedHere = localChanged || nowHash !== startHash;
    if (replaceLocal || !changedHere || pristine() || (first && setupOnly())) {
      adopt(got.payload.data);
      const h = currentHash();
      if (got.legacy) await push(cloudCopy(), got.payload.changedAt || Date.now(), remote, gen);
      else patchMeta({ uid, rev: remote.rev, hash: h, at: Date.now(), changedAt: got.payload.changedAt, seenHash: h });
    } else {
      const localAt = localChangedAt(meta, nowHash);
      // On a first sign-in the account's copy wins wherever both have the same thing (settings,
      // the profile, a goal with the same id); everything only this device has is added to it.
      adopt(merge(cloudCopy(), first ? 0 : localAt, got.payload.data, got.payload.changedAt, Date.now(), { cloudWins: first }));
      await push(cloudCopy(), Math.max(localAt, got.payload.changedAt), remote, gen);
    }
  } else if (localChanged || !remote) {
    if (replaceLocal && !remote) {
      // A new account on a device that had someone else's data: start this account empty.
      applying = true;
      S.resetAll();
      applying = false;
      hooks.changed();
    }
    const h = currentHash();
    await push(cloudCopy(), localChangedAt(meta, h), remote, gen);
  } else {
    patchMeta({ at: Date.now() });
  }
}

let running: Promise<void> | null = null;
let again = false;

export async function syncNow(opts?: { replaceLocal?: boolean }): Promise<void> {
  if (!status.user || status.locked || status.repair) return;
  if (running) {
    again = true;
    return running;
  }
  status.busy = true;
  status.error = '';
  hooks.render();
  running = (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        run(opts),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Syncing took too long. It will try again next time you open the app.')), TIMEOUT);
        }),
      ]);
    } catch (err) {
      if ((err as { code?: string })?.code === 'locked') status.locked = true;
      else status.error = A.friendly(err);
      generation++; // a run that timed out must not take in old data later
    } finally {
      clearTimeout(timer);
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
let timer: ReturnType<typeof setTimeout> | null = null;
let lastSave = 0;
function queue() {
  if (applying) return;
  lastSave = Date.now();
  if (!status.user || status.locked) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(flush, PUSH_DELAY);
}
function flush() {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!status.user) return;
  const meta = readMeta();
  const h = currentHash();
  // Nothing to send if only this device's own things changed (like a workout in progress).
  if (h === meta.hash) return;
  if (h !== meta.seenHash) patchMeta({ changedAt: lastSave || Date.now(), seenHash: h });
  syncNow();
}

const unsynced = () => !!status.user && currentHash() !== readMeta().hash;

// ---------- account actions

function signedIn(result: A.Result, { replaceLocal = false } = {}) {
  status.user = result.user;
  status.locked = false;
  status.repair = 'needsRecovery' in result;
  status.replacePending = status.repair && replaceLocal;
  status.form = 'in';
  if ('setup' in result && result.setup) {
    status.pending = result.setup;
    showCodes(result.setup, 'upgraded' in result && !!result.upgraded);
  }
  if (!status.repair) return syncNow({ replaceLocal });
}

// This device holds data from a different account: don't mix the two.
function otherAccount(uid: string) {
  const before = readMeta();
  const other = (before.uid || before.lastUid) && (before.uid || before.lastUid) !== uid && !S.isEmpty();
  if (other) writeMeta({ lastUid: before.uid || before.lastUid });
  return !!other;
}

type Values = Record<string, string>;

async function enter(kind: 'in' | 'up', values: Values) {
  const v = (name: string) => values[name] ?? '';
  await A.load(onUser);
  if (kind === 'up') {
    if (v('password') !== v('password2')) throw new A.AccountError('mismatch', "The two passwords don't match.");
    const result = await A.signUp({ email: v('email').trim(), password: v('password'), noEmail: status.noEmail });
    // The data here belongs to another account. Starting empty removes it from this device, so
    // only if the Player says so; otherwise it goes into the new account.
    const replace =
      otherAccount(result.user.uid) &&
      confirm("This device has data from another account. Start your new account empty? That removes it from this device; the other account keeps its own cloud copy.\n\nChoose Cancel to copy this device's data into your new account instead.");
    await signedIn(result, { replaceLocal: replace });
    if (!status.error) toast('Account created. Your data is encrypted and backed up.');
    return;
  }
  const result = await A.signIn(v('id').trim(), v('password'));
  const other = otherAccount(result.user.uid);
  if (other && !confirm(`This device has data from another account. Replace it with the data of ${result.user.id}? The other account keeps its own cloud copy.`)) {
    // Signing in may have just encrypted an older account: its new recovery code is shown anyway.
    if ('setup' in result && result.setup) {
      status.pending = result.setup;
      showCodes(result.setup, !!result.upgraded);
    }
    await A.signOut();
    status.user = null;
    return;
  }
  await signedIn(result, { replaceLocal: other });
  if (!status.error && !status.repair) toast('Signed in. Your data is synced.');
}

function onUser(u: A.User | null) {
  status.user = u;
  status.loading = false;
  hooks.render();
}

// Sign out. `clear` also removes the data from this device. Refuses (returns false) if there
// are changes that haven't reached the cloud, unless `force`.
async function leave({ clear, force = false }: { clear: boolean; force?: boolean }): Promise<boolean> {
  if (timer) flush();
  if (running) await running;
  if (clear && !force && unsynced()) {
    await syncNow();
    if (unsynced()) return false;
  }
  generation++;
  const m = readMeta();
  await A.signOut();
  status.user = null;
  status.locked = status.repair = status.replacePending = false;
  status.more = '';
  writeMeta({ lastUid: m.uid || m.lastUid });
  if (clear) {
    applying = true;
    S.resetAll();
    applying = false;
    writeMeta({});
    hooks.changed();
  }
  return true;
}

// "Erase all data" in Settings: everything on this device goes, the cloud copy stays. Returns
// false if the Player chose to keep changes that haven't reached the cloud yet.
export async function eraseThisDevice(): Promise<boolean> {
  if (!status.user) {
    const m = readMeta();
    S.resetAll();
    // Signing in again then counts as a first sign-in, which takes the cloud copy as it is.
    if (m.uid || m.lastUid) writeMeta({ lastUid: m.uid || m.lastUid, ...(m.deleting ? { deleting: true } : {}) });
    return true;
  }
  if (await leave({ clear: true })) return true;
  if (!confirm("Some changes haven't reached the cloud yet (are you offline?). Erase them anyway? They'll be lost.")) return false;
  return leave({ clear: true, force: true });
}

async function deletedElsewhere() {
  generation++;
  if (timer) clearTimeout(timer);
  timer = null;
  const m = readMeta();
  await A.signOut();
  status.user = null;
  status.locked = status.repair = status.replacePending = false;
  status.more = '';
  writeMeta({ lastUid: m.uid || m.lastUid });
  throw new A.AccountError('deleted', 'This account was deleted on another device, so this device was signed out. Your data on this device stays.');
}

async function deleteEverything(password: string) {
  const user = status.user!;
  await A.confirmPassword(user, password);
  // From here on nothing is uploaded again, even if the app closes halfway.
  patchMeta({ deleting: true });
  generation++;
  if (timer) clearTimeout(timer);
  const { fb, db } = A.firebase();
  const remote = await readRemote();
  const batch = fb.writeBatch(db);
  for (let i = 0; i < Math.max(remote?.parts || 0, 1); i++) batch.delete(ref(`part${i}`));
  batch.delete(ref('meta'));
  await batch.commit();
  await A.deleteAccount(user);
  status.user = null;
  status.more = '';
  writeMeta({});
}

// ---------- screens

function showCodes(setup: A.Setup, upgraded: boolean) {
  const text = `Arise account details\n\n${setup.accountCode ? `Account code: ${setup.accountCode}\n` : ''}Recovery code: ${setup.recoveryCode}\n\nKeep this somewhere safe and private. Your data is end-to-end encrypted: if you forget your password, this code is the only way to get it back.`;
  openSheet(`<p class="kicker">${upgraded ? 'Your account is now end-to-end encrypted' : 'Save this now'}</p>
    <h2 class="display sheet-title">${setup.accountCode ? 'Your account details' : 'Your recovery code'}</h2>
    <p>${upgraded ? 'Your cloud copy is now encrypted on your device before it is sent. Nobody else can read it, not even the people who run Arise. ' : ''}If you forget your password, this code is the <b>only</b> way to get your data back. Nobody can reset it for you.</p>
    ${setup.accountCode ? `<p class="label">Account code (you sign in with this)</p><p class="code-box mono">${esc(setup.accountCode)}</p>` : ''}
    <p class="label">Recovery code</p>
    <p class="code-box mono">${esc(setup.recoveryCode)}</p>
    <div class="row">
      <button class="btn ghost small" data-act="sync-code-copy">Copy</button>
      <button class="btn ghost small" data-act="sync-code-save">Save as a file</button>
    </div>
    <p class="muted small">Keep it in a password manager, or write it down. Don't email it to yourself.</p>
    <button class="btn primary block" data-act="sync-code-done">I've saved it</button>`);
  codesText = text;
}
let codesText = '';

const field = (name: string, label: string, type: string, extra = '') =>
  `<label class="field"><span class="k">${label}</span><input name="${name}" type="${type}" ${extra} spellcheck="false" autocapitalize="off"></label>`;

function ago(t?: number) {
  if (!t) return 'not yet';
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(t).toLocaleDateString();
}

const title = `<div class="panel-title">${icon('key')}<span>Account</span></div>`;
const pendingAlert = () =>
  status.pending ? `<div class="alert gold"><div><b>Save your recovery code.</b> It's the only way back in if you forget your password. <button class="link small" data-act="sync-code-show">Show it</button></div></div>` : '';
const PRIVATE = 'Your data is encrypted on this device before it leaves. Nobody else can read the cloud copy: not the people who run Arise, not Google, who host it.';

export function panel(): string {
  if (!configured) return '';
  const u = status.user;
  const err = status.error ? `<p class="small error" role="alert">${esc(status.error)}</p>` : '';
  const busy = status.busy || status.loading;
  if (status.loading && !u) return `<section class="panel" id="accountPanel">${title}<p class="muted">Loading…</p></section>`;

  if (u && status.repair) {
    return `<section class="panel" id="accountPanel">${title}
      <p>Your password works, but your encrypted data needs your <b>recovery code</b> once, because the password was changed somewhere else.</p>
      <form class="stack" data-form="repair">${field('code', 'Recovery code', 'text', 'required autocomplete="off" placeholder="XXXX-XXXX-…"')}${err}
        <button class="btn primary" type="submit" ${busy ? 'disabled' : ''}>${busy ? 'One moment…' : 'Unlock my data'}</button></form>
      <div class="row"><button class="link small" data-act="sync-out">Sign out</button></div></section>`;
  }
  if (u && status.locked) {
    return `<section class="panel" id="accountPanel">${title}
      <p>Signed in as <b>${esc(u.id)}</b>. Enter your password once to unlock your encrypted data on this device.</p>
      <form class="stack" data-form="unlock">${field('password', 'Password', 'password', 'required autocomplete="current-password"')}${err}
        <button class="btn primary" type="submit" ${busy ? 'disabled' : ''}>${busy ? 'Unlocking…' : 'Unlock'}</button></form>
      <div class="row"><button class="link small" data-act="sync-forgot">Forgot password?</button><button class="link small" data-act="sync-out">Sign out</button></div></section>`;
  }
  if (u) {
    const more =
      status.more === 'password'
        ? `<form class="stack" data-form="password">${field('old', 'Current password', 'password', 'required autocomplete="current-password"')}${field('password', 'New password', 'password', `required minlength="${A.MIN_PASSWORD}" autocomplete="new-password"`)}${field('password2', 'New password again', 'password', 'required autocomplete="new-password"')}
            <p class="muted small">You'll get a new recovery code too.</p>
            <button class="btn primary small" type="submit" ${busy ? 'disabled' : ''}>Change password</button></form>`
        : status.more === 'code'
          ? `<form class="stack" data-form="code">${field('password', 'Password', 'password', 'required autocomplete="current-password"')}
            <p class="muted small">The old recovery code stops working.</p>
            <button class="btn primary small" type="submit" ${busy ? 'disabled' : ''}>Make a new recovery code</button></form>`
          : status.more === 'delete'
            ? `<form class="stack" data-form="delete">${field('password', 'Password', 'password', 'required autocomplete="current-password"')}
            <p class="small error">This deletes your account and your cloud copy for good. The data on this device stays.</p>
            <button class="btn ghost small danger" type="submit" ${busy ? 'disabled' : ''}>Delete my account and cloud copy</button></form>`
            : '';
    return `<section class="panel" id="accountPanel">${title}
      <p>Signed in as <b>${esc(u.id)}</b>. Your data is backed up and the same on every device where you sign in.</p>
      <p class="ok small">${icon('check')} End-to-end encrypted. ${PRIVATE}</p>
      ${pendingAlert()}
      <p class="muted small">${status.busy ? 'Syncing…' : `Last synced: ${ago(readMeta().at)}.`}</p>
      ${err}
      <div class="row">
        <button class="btn ghost small" data-act="sync-now" ${status.busy ? 'disabled' : ''}>Sync now</button>
        <button class="btn ghost small" data-act="sync-out">Sign out</button>
      </div>
      <details class="other" ${status.more ? 'open' : ''}><summary>More</summary>
        <div class="stack">
          <button class="link small" data-act="sync-more" data-v="password">Change password</button>
          <button class="link small" data-act="sync-more" data-v="code">Make a new recovery code</button>
          ${more}
          <button class="btn ghost small" data-act="sync-out-clear">Sign out and remove my data from this device</button>
          <button class="btn ghost small danger" data-act="sync-more" data-v="delete">Delete my account and cloud copy</button>
        </div>
      </details>
    </section>`;
  }

  const f = status.form;
  if (f === 'reset') {
    return `<section class="panel" id="accountPanel">${title}
      <p>Accounts made before Arise 2.0 have no recovery code. Their cloud copy isn't end-to-end encrypted yet, so Firebase (who run sign-in for Arise) can email you a link to set a new password. Sign in here with it afterwards and your data gets encrypted.</p>
      <form class="stack" data-form="reset" autocomplete="on">
        ${field('id', 'Email', 'email', 'required inputmode="email" autocomplete="username"')}
        ${err}
        <button class="btn primary" type="submit" ${busy ? 'disabled' : ''}>${busy ? 'One moment…' : 'Email me a reset link'}</button>
      </form>
      <div class="row"><button class="link small" data-act="sync-form" data-v="in">Back to sign in</button></div></section>`;
  }
  if (f === 'recover') {
    return `<section class="panel" id="accountPanel">${title}${pendingAlert()}
      <p>Forgot your password? Your recovery code lets you set a new one. Nobody else can do this for you, because nobody else can open your data.</p>
      <form class="stack" data-form="recover" autocomplete="on">
        ${field('id', 'Email or account code', 'text', 'required autocomplete="username"')}
        ${field('code', 'Recovery code', 'text', 'required autocomplete="off" placeholder="XXXX-XXXX-…"')}
        ${field('password', 'New password', 'password', `required minlength="${A.MIN_PASSWORD}" autocomplete="new-password"`)}
        ${field('password2', 'New password again', 'password', 'required autocomplete="new-password"')}
        ${err}
        <button class="btn primary" type="submit" ${busy ? 'disabled' : ''}>${busy ? 'One moment…' : 'Set new password'}</button>
      </form>
      <div class="row"><button class="link small" data-act="sync-form" data-v="in">Back to sign in</button><button class="link small" data-act="sync-form" data-v="reset">Made your account before Arise 2.0?</button></div></section>`;
  }
  if (f === 'up') {
    return `<section class="panel" id="accountPanel">${title}
      <p>Create a free account to back up your data and have the same history on every device. ${PRIVATE}</p>
      <div class="seg" role="group" aria-label="Kind of account">
        <button class="${status.noEmail ? '' : 'on'}" data-act="sync-kind" data-v="email" aria-pressed="${!status.noEmail}">With email</button>
        <button class="${status.noEmail ? 'on' : ''}" data-act="sync-kind" data-v="code" aria-pressed="${status.noEmail}">No email</button>
      </div>
      <p class="muted small">${status.noEmail ? "No personal details at all: you get an account code to sign in with instead. If you lose it, nobody can tell you what it was." : 'Your email is only used to sign in. Arise never sends you mail.'}</p>
      <form class="stack" data-form="up" autocomplete="on">
        ${status.noEmail ? '' : field('email', 'Email', 'email', 'required inputmode="email" autocomplete="email"')}
        ${field('password', 'Password', 'password', `required minlength="${A.MIN_PASSWORD}" autocomplete="new-password" placeholder="At least ${A.MIN_PASSWORD} characters"`)}
        ${field('password2', 'Password again', 'password', 'required autocomplete="new-password"')}
        <p class="muted small">Your password is the key to your data. If you forget it, only your recovery code (you'll get it next) can get your data back.</p>
        ${err}
        <button class="btn primary" type="submit" ${busy ? 'disabled' : ''}>${busy ? 'Encrypting…' : 'Create account'}</button>
      </form>
      <div class="row"><button class="link small" data-act="sync-form" data-v="in">Already have an account? Sign in</button></div></section>`;
  }
  return `<section class="panel" id="accountPanel">${title}${pendingAlert()}
    <p>Sign in to back up your data and have the same history on every device. ${PRIVATE} Without an account everything stays on this device.</p>
    <form class="stack" data-form="in" autocomplete="on">
      ${field('id', 'Email or account code', 'text', 'required autocomplete="username"')}
      ${field('password', 'Password', 'password', 'required autocomplete="current-password"')}
      ${err}
      <button class="btn primary" type="submit" ${busy ? 'disabled' : ''}>${busy ? 'Unlocking…' : 'Sign in'}</button>
    </form>
    <div class="row">
      <button class="link small" data-act="sync-form" data-v="up">New here? Create an account</button>
      <button class="link small" data-act="sync-form" data-v="recover">Forgot password?</button>
    </div></section>`;
}

export async function handleAction(act: string, el?: HTMLElement): Promise<boolean> {
  if (!act.startsWith('sync-')) return false;
  try {
    switch (act) {
      case 'sync-form':
        status.form = (el?.dataset.v as Form) || 'in';
        status.error = '';
        break;
      case 'sync-kind':
        status.noEmail = el?.dataset.v === 'code';
        break;
      case 'sync-more':
        status.more = status.more === el?.dataset.v ? '' : ((el?.dataset.v as typeof status.more) ?? '');
        status.error = '';
        break;
      case 'sync-now':
        await syncNow();
        if (!status.error) toast('Synced.');
        break;
      case 'sync-out':
        await leave({ clear: false });
        toast('Signed out. Your data stays on this device.');
        break;
      case 'sync-forgot':
        await leave({ clear: false });
        status.form = 'recover';
        status.error = '';
        break;
      case 'sync-out-clear': {
        if (!confirm('Sign out and remove your data from this device? Your encrypted cloud copy stays, so you can sign in again to get it back.')) return true;
        if (!(await leave({ clear: true }))) {
          if (!confirm("Some changes haven't reached the cloud yet (are you offline?). Remove them from this device anyway? They'll be lost.")) return true;
          await leave({ clear: true, force: true });
        }
        toast('Signed out and removed from this device.');
        break;
      }
      case 'sync-code-show':
        if (status.pending) showCodes(status.pending, false);
        return true;
      case 'sync-code-copy':
        await navigator.clipboard?.writeText(codesText);
        toast('Copied.');
        return true;
      case 'sync-code-save': {
        const url = URL.createObjectURL(new Blob([codesText], { type: 'text/plain' }));
        const a = Object.assign(document.createElement('a'), { href: url, download: 'arise-recovery-code.txt' });
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        return true;
      }
      case 'sync-code-done':
        status.pending = null;
        codesText = '';
        closeSheet();
        break;
    }
  } catch (err) {
    status.error = A.friendly(err);
  }
  hooks.render();
  return true;
}

document.addEventListener('submit', (e) => {
  const form = e.target as HTMLFormElement;
  const kind = form.dataset?.form;
  if (!kind || !form.closest('#accountPanel')) return;
  e.preventDefault();
  const values: Values = {};
  for (const [k, v] of new FormData(form)) values[k] = String(v);
  submit(kind, values);
});

// What the account forms do (kept apart from the page so it can be tested on its own).
export async function submit(kind: string, values: Values) {
  const v = (name: string) => values[name] ?? '';
  status.busy = true;
  status.error = '';
  hooks.render();
  try {
    await A.load(onUser);
    if (kind === 'in' || kind === 'up') await enter(kind, values);
    else if (kind === 'recover') {
      if (v('password') !== v('password2')) throw new A.AccountError('mismatch', "The two passwords don't match.");
      const result = await A.recover({ id: v('id').trim(), recoveryCode: v('code'), newPassword: v('password') });
      const other = otherAccount(result.user.uid);
      if (other && !confirm(`This device has data from another account. Replace it with the data of ${result.user.id}? The other account keeps its own cloud copy.`)) {
        await A.signOut();
        status.user = null;
        status.form = 'in';
        toast('New password set. Sign in with it when you want this account on this device.');
      } else {
        await signedIn(result, { replaceLocal: other });
        toast('New password set. Signed in.');
      }
    } else if (kind === 'reset') {
      await A.resetByEmail(v('id').trim());
      status.form = 'in';
      toast('Check your email for a link to set a new password. Then sign in here with it.');
    } else if (kind === 'unlock') {
      await signedIn(await A.unlock(status.user!, v('password')));
    } else if (kind === 'repair') {
      const replaceLocal = status.replacePending;
      await signedIn(await A.repair(v('code')), { replaceLocal });
      toast('Unlocked. Your data is synced.');
    } else if (kind === 'password') {
      if (v('password') !== v('password2')) throw new A.AccountError('mismatch', "The two new passwords don't match.");
      const setup = await A.changePassword(status.user!, v('old'), v('password'));
      status.more = '';
      status.pending = setup;
      showCodes(setup, false);
      toast('Password changed.');
    } else if (kind === 'code') {
      const setup = await A.newRecoveryCode(status.user!, v('password'));
      status.more = '';
      status.pending = setup;
      showCodes(setup, false);
    } else if (kind === 'delete') {
      if (confirm('Delete your account and your cloud copy? This cannot be undone. The data on this device stays.')) {
        await deleteEverything(v('password'));
        toast('Account and cloud copy deleted.');
      }
    }
  } catch (err) {
    status.error = A.friendly(err);
  }
  status.busy = false;
  hooks.render();
}

// ---------- start

export function initSync(h: Partial<typeof hooks>): Promise<void> {
  hooks = { ...hooks, ...h };
  if (!configured) return Promise.resolve();
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
  const meta = readMeta();
  if (!meta.uid && !meta.deleting) return Promise.resolve();
  status.loading = true;
  return A.load(onUser)
      .then(async () => {
        if (!status.user) return;
        if (readMeta().deleting) {
          status.more = 'delete';
          status.error = "Deleting your account didn't finish. Enter your password under More to finish it.";
          hooks.render();
          return;
        }
        status.locked = !(await A.deviceKey(status.user.uid));
        hooks.render();
        await syncNow();
      })
      .catch((err) => {
        status.loading = false;
        status.error = A.friendly(err);
        hooks.render();
      });
}

// For the private AI proxy: proves the request comes from a signed-in Arise account.
export const idToken = () => (status.user ? A.idToken() : Promise.resolve(null));
