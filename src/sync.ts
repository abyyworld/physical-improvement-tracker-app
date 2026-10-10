// Accounts and sync. Optional: the app works fully without them.
//
// The Player's data lives on this device first. Signing in keeps an end-to-end encrypted copy in
// the cloud, so the same history shows up on every device where they sign in. The cloud copy is
// encrypted on the device with a key the server never sees (account.ts, lib/crypto.ts), so
// nobody else can read it. (Unless the Player chose Email reset: then the key is kept in the
// cloud too, see account.ts.) The AI key, the AI service settings, notification settings, AI
// usage counts and a workout in progress stay on each device.
//
// Cloud layout: users/{uid}/arise/meta says which version is current and holds its IV; the
// ciphertext is split across users/{uid}/arise/part0, part1... (a document holds about 1 MB). The
// pages of goals shared with a link are shares/{id} (share.ts).

import * as S from './store';
import * as A from './account';
import { merge, type CloudCopy } from './lib/merge';
import { seal, open, type Sealed } from './lib/crypto';
import { SHARE_OFF } from './lib/share';
import { esc, icon, openSheet, closeSheet, toast } from './ui.js';

export const configured = A.configured;

// This device is signed in to an account whose data is still on its way: no intro then.
export const hasAccount = () => {
  const m = readMeta();
  return configured && !!m.joining && !!m.uid;
};

const META_KEY = 'arise-sync';
const CHUNK = 700_000; // characters of ciphertext per cloud document
const PUSH_DELAY = 8000;
const TIMEOUT = 45_000;
// Bump when the shape of the synced data changes. A device with an older app won't touch data
// saved by a newer one; it updates itself first. 2: settings.dayOff (2.2). 3: a goal's share
// link (1.3), which an older app would drop, leaving its page with no way to turn it off.
export const SCHEMA = 3;

interface Meta {
  uid?: string;
  rev?: string; // the cloud version this device last saw
  hash?: string; // fingerprint of the data at that point
  schema?: number; // the SCHEMA it was taken under (none: 1)
  at?: number; // when this device last synced
  changedAt?: number; // when this device's synced data last changed
  seenHash?: string; // fingerprint when changedAt was taken
  lastUid?: string; // signed out: whose data this is (rev, hash etc. still describe it)
  login?: string; // that account's sign-in email (to check it still exists)
  orphanOf?: string; // the data's account was deleted on another device
  asking?: boolean; // a sign-in is waiting for the Player's answer about this device's data
  joining?: boolean; // signed in to this account, but no sync has finished yet (signed out: see leave)
  joinHash?: string; // while joining: the fingerprint of the data when it signed in
  prev?: Meta; // while joining: the sync info from before, for this device's data if it signs out
  afresh?: string[]; // the data here joined an account made again that started afresh (see run), not sent up yet: its own goals
  deleting?: string; // the account whose deletion hasn't finished
  way?: A.Way; // how that account gets back in after a forgotten password, as this device last knew
  check?: Sealed; // sealed with that account's data key, to know the key again (see knows)
  email?: string; // only in sync info written by Arise 1.x
}

let hooks = { render: () => {}, changed: () => {}, checkForUpdate: () => {} };
// Told after each sync that went through (share.ts brings shared goals' pages up to date then).
const synced: (() => void)[] = [];
export const onSynced = (fn: () => void) => synced.push(fn);

type Form = 'in' | 'up' | 'recover' | 'reset';
export const status = {
  loading: false,
  user: null as A.User | null,
  busy: false,
  error: '',
  form: 'in' as Form,
  noEmail: false,
  byEmail: false, // the sign-up choice: Email reset rather than Recovery code
  way: '' as '' | A.Way, // how the signed-in account gets back in after a forgotten password ('': not known yet)
  wasEmail: false, // it used Email reset before, so someone may have a copy of its key
  emailPassword: false, // the recovery code couldn't sign in: also ask for a password set from a reset email
  locked: false, // signed in, but this device doesn't have the key yet
  repair: false, // the password works but the key needs the recovery code
  otherKey: false, // (with repair) the key kept for Email reset wasn't used: see A.Knows
  notice: '', // something to know about the signed-in account, shown in its panel until signing out
  pending: null as A.Setup | null, // codes the Player still has to save
  pendingFor: '', // whose codes they are
  more: '' as '' | 'password' | 'code' | 'way' | 'delete',
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
const patchMeta = (p: Partial<Meta>) => {
  const m = readMeta();
  // Arise 1.x's mark belongs to its own account only.
  if (p.uid && m.uid !== p.uid) delete m.email;
  writeMeta({ ...m, ...p });
};

// ---------- the copy that goes to the cloud

// Everything except what belongs to this device. (The app lock isn't in the saved data at all: see
// lib/lock.ts.)
function cloudCopy(state: S.State = S.state): CloudCopy {
  const { active: _a, updatedAt: _u, ...rest } = state;
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
// A cloud copy with nothing at all in it: what a device that was never used sends up (the intro
// skipped at most, and what the app writes by itself: the System's message of the day, reminder
// texts). Not even its settings or profile were chosen by anyone.
function blankCopy(data: CloudCopy) {
  const bare = (c: CloudCopy) => JSON.stringify({ ...c, profile: null, ai: { ...c.ai, daily: {}, nudges: null } });
  const profile = Object.keys(data.profile || {}).every((k) => ['onboarded', 'skipped', 'updated'].includes(k));
  return profile && bare(cloudCopy(data as S.State)) === bare(cloudCopy(S.blank()));
}

const hasGoal = (c: CloudCopy, id: string) => c.goals.some((g) => g.id === id) || id in (c.stamps.goals || {});
// The account made again started afresh on another device: nothing done in its copy yet (the
// intro at most; weigh-ins don't count, as an intro saves one and another device's intro may have
// added its own, see S.withIntroWeighIn), and none of this device's goals in it, not even as
// deleted. Its copy is the newer one, but this device has the history.
function freshStart(account: CloudCopy, here: CloudCopy) {
  return S.nothingDone({ ...account, body: { ...account.body, entries: [] } }) && !here.goals.some((g) => hasGoal(account, g.id));
}
// Joined the way that other device's first sign-in to this device's data would join them: this
// device's settings, profile and plan win, and that device's goals are added after its own. (A
// goal both have, as when this is done again after the first try didn't go up, or by a device of
// that fresh start that hadn't seen it: the one changed last, but the workout plan stays with
// this device's goal.)
function joinFreshStart(here: CloudCopy, hereAt: number, account: CloudCopy, now: number): CloudCopy {
  const plan = here.goals.find((g) => g.workouts)?.id;
  const newer = (g: S.Goal): S.Goal => {
    const x = account.goals.find((a) => a.id === g.id && a.updated > g.updated);
    if (!x || !x.workouts || !plan || plan === x.id) return x || g;
    const { workouts: _w, ...rest } = x;
    return { ...rest, updated: now };
  };
  const joined = merge(account, 0, { ...here, goals: here.goals.map(newer) }, hereAt, now, { cloudWins: true });
  const at = (id: string) => {
    const i = here.goals.findIndex((g) => g.id === id);
    return i < 0 ? here.goals.length : i;
  };
  return { ...joined, goals: [...joined.goals].sort((a, b) => at(a.id) - at(b.id)) };
}
// When a fresh start was joined (see run), as a stamp every copy since then carries.
const joinedAt = (c: CloudCopy) => c.stamps.plan?.afresh || 0;
function markJoined(c: CloudCopy, at: number): CloudCopy {
  const { afresh: _a, ...plan } = c.stamps.plan || {};
  return { ...c, stamps: { ...c.stamps, plan: at ? { ...plan, afresh: at } : plan } };
}

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
  S.notePlanAfterSync();
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
}

interface Payload {
  schema: number;
  changedAt: number;
  data: CloudCopy;
}

const ref = (name: string, uid = status.user!.uid) => {
  const { fb, db } = A.firebase();
  return fb.doc(db, 'users', uid, 'arise', name);
};

async function readRemote(uid?: string): Promise<Remote | null> {
  const { fb } = A.firebase();
  const snap = await fb.getDoc(ref('meta', uid));
  return snap.exists() ? (snap.data() as Remote) : null;
}

async function key() {
  const k = await A.deviceKey(status.user!.uid);
  if (!k) throw Object.assign(new Error('locked'), { code: 'locked' });
  return k;
}

// Read every part of the current version of an account's cloud copy and open it with the key `k`
// gives. If another device saved in the middle, read again.
async function fetchCopy(uid: string, remote: Remote, k: () => Promise<CryptoKey>): Promise<{ text: string; remote: Remote }> {
  const { fb } = A.firebase();
  for (let attempt = 0; attempt < 3; attempt++) {
    const snaps = await Promise.all(Array.from({ length: remote.parts }, (_, i) => fb.getDoc(ref(`part${i}`, uid))));
    if (snaps.every((s) => s.exists() && s.data().rev === remote.rev)) {
      const parts = snaps.map((s) => s.data()!);
      return { text: await open(await k(), { iv: remote.iv!, ct: parts.map((p) => p.ct).join('') }, `${uid}/${remote.rev}`), remote };
    }
    const again = await readRemote(uid);
    if (!again) break;
    remote = again;
  }
  throw new Error('The cloud copy kept changing while loading. Try again.');
}

async function pull(remote: Remote): Promise<{ payload: Payload; remote: Remote }> {
  const got = await fetchCopy(status.user!.uid, remote, key);
  const payload = JSON.parse(got.text) as Payload;
  return { payload: { ...payload, data: S.clean(payload.data) }, remote: got.remote };
}

// ---------- what this device knows of an account

// Its sync info, while the data here is that account's (or was, before another account began
// joining here).
function knownAs(uid: string): Meta | null {
  const m = readMeta();
  return [m, m.prev].find((x): x is Meta => !!x && (x.uid || x.lastUid) === uid) ?? null;
}
const checkLabel = (uid: string) => `${uid}/check`;
const opensCheck = (k: CryptoKey, check: Sealed, uid: string) => open(k, check, checkLabel(uid)).then(
  () => true,
  () => false,
);

// For a sign-in after a reset email (see A.Knows). Anyone who gets into an account's email can
// set a password and sign in, then mark the account for Email reset and put in a key of their
// own. This device's data must never go up under such a key.
const knows: A.Knows = {
  codeOnly: (uid) => knownAs(uid)?.way === 'code',
  async ownKey(uid, k) {
    const m = knownAs(uid);
    // The data here was synced with this account: only the key it was synced with (see run).
    if (m?.check) return opensCheck(k, m.check, uid);
    // Synced before this device kept a check (an older version, before Email reset): no key it
    // can't tell is the account's own.
    if (m?.rev) return false;
    // Never synced here: the key must open the account's cloud copy, if there is one. (Someone
    // who put in their own key may have put in a copy of their own too: so a sign-in after a reset
    // email says plainly that the account uses Email reset, see AFTER_RESET.)
    const remote = await readRemote(uid);
    if (!remote) return true;
    try {
      await fetchCopy(uid, remote, async () => k);
      return true;
    } catch (err) {
      if ((err as { code?: string })?.code === 'bad-data') return false;
      throw err;
    }
  },
};
const OTHER_KEY =
  "Your account's key isn't the one this device synced with, so nothing is synced. Your data on this device stays as it is. Someone who got into your email may have changed the key. To be safe, delete this account under More, then make a new one: the data on this device goes into it.";

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
  if (gen !== generation || waitingForAnswer()) return;
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
  if (gen === generation) patchMeta({ uid: status.user!.uid, login: status.user!.email, rev, hash: h, schema: SCHEMA, at: Date.now(), changedAt, seenHash: h, joining: undefined, joinHash: undefined, prev: undefined, afresh: undefined });
}

// Each run gets a number; signing out or a timeout moves it on, so a stale run stops before it
// takes in or sends anything.
let generation = 0;

async function run() {
  const gen = ++generation;
  const stored = readMeta();
  const uid = status.user!.uid;
  if (stored.deleting === uid) throw new A.AccountError('deleting', "Deleting your account didn't finish, so nothing is synced. Enter your password under More to finish it.");
  const k = await key();
  // The data here is this account's (or is joining it): only ever with one key. It's noted the
  // first time, and if the account's key is another one later, nothing goes in or out (see knows).
  if (stored.uid === uid && stored.check) {
    if (!(await opensCheck(k, stored.check, uid))) throw new A.AccountError('other-key', OTHER_KEY);
  } else if (stored.uid === uid) {
    const check = await seal(k, 'arise', checkLabel(uid));
    // (Only while the data here is still this account's: another window may have signed in meanwhile.)
    const now = readMeta();
    if (now.uid === uid && !now.check) patchMeta({ check });
  }
  // What this device knows about this account's cloud copy; nothing if it held another one's.
  const meta: Meta = stored.uid === uid || (!stored.uid && stored.lastUid === uid) ? stored : {};
  // Never synced with this account: a first sign-in. (A device signed out by Arise 1.x knows the
  // account but not its version: its data is still the account's own, so it isn't treated as new.)
  const first = !meta.rev;
  const fresh = first && (stored.lastUid !== uid || !!stored.joining);
  // Whose data this device held before this account signed in, if another account's (see signedIn).
  const prev: Meta = stored.joining ? stored.prev || {} : {};
  const prevUid = prev.uid || prev.lastUid || prev.orphanOf;
  const others = !!prevUid && prevUid !== uid;
  // That account had this email: it was deleted and made again, and its data goes into this one
  // (see otherAccount). The same history then, so not a first sign-in: the newer change wins,
  // going by when the data here last changed as that account's.
  const remade = others && prev.login === status.user!.email;
  const known = remade ? prev : meta;
  let remote = await readRemote();
  if (gen !== generation) return;
  if (!remote && !first && !(await A.hasKeys(uid))) {
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
  // Sync info from before 2.0, or from before the shape of the data last changed, has a
  // fingerprint of a different shape, so there only the time can tell whether anything changed
  // on this device since it last synced.
  const oldMeta = !!meta.hash && ((!meta.seenHash && !meta.changedAt) || (meta.schema || 1) < SCHEMA);
  const localChanged = first || (oldMeta ? (S.state.updatedAt || 0) > (meta.at || 0) : startHash !== meta.hash);
  const remoteChanged = !!remote && (first || remote.rev !== meta.rev);

  if (remote && remoteChanged) {
    const got = await pull(remote);
    if (gen !== generation || waitingForAnswer()) return;
    remote = got.remote;
    // Anything saved while the copy downloaded counts as a change on this device.
    const nowHash = currentHash();
    const changedHere = localChanged || nowHash !== startHash;
    // Joining the account made again with this device's data: the Player chose to add it, so
    // only a copy where nothing was chosen has nothing to add. Otherwise, with nothing of the
    // Player's own here (see pristine), the account's copy is taken as it is.
    const join = fresh && remade;
    const nothing = join ? blankCopy(cloudCopy()) : pristine();
    // The intro gives way to the account's goals (its weigh-in stays): on a first sign-in, and on
    // joining the account made again when the intro's goal is all this device has.
    const giveWay = fresh && S.introOnly() && got.payload.data.goals.length > 0 && (!join || S.state.goals.length > 0);
    if (!changedHere || nothing || giveWay) {
      const data = giveWay ? S.withIntroWeighIn(got.payload.data) : got.payload.data;
      adopt(data);
      joined(stored);
      const h = currentHash();
      if (data !== got.payload.data) await push(cloudCopy(), got.payload.changedAt || Date.now(), remote, gen);
      else patchMeta({ uid, login: status.user!.email, rev: remote.rev, hash: h, schema: SCHEMA, at: Date.now(), changedAt: got.payload.changedAt, seenHash: h, joining: undefined, joinHash: undefined, prev: undefined, afresh: undefined });
    } else if (fresh && blankCopy(got.payload.data) && (!others || remade)) {
      // The account's copy has nothing in it (a device that was never used made it, before any
      // other got there). It says nothing, so it doesn't win anything: this device's copy, its
      // settings and profile included, takes its place as it is. (Another account's data only
      // adds to it, as below, unless that account had this email.)
      await push(cloudCopy(), localChangedAt(known, nowHash), remote, gen);
    } else {
      const localAt = localChangedAt(known, nowHash);
      // On a first sign-in the account's copy wins wherever both have the same thing (settings,
      // the profile, a goal with the same id); everything only this device has is added to it.
      // Signing back in to the same account isn't a first sign-in, nor is joining it made again
      // (`remade`): there the newer change wins, unless the account made again started afresh.
      const cloudWins = fresh && !remade;
      const here = cloudCopy();
      const account = got.payload.data;
      const now = Date.now();
      // (Joined so already, but another device saved before that went up, and the account's copy
      // is still that fresh start's: no join in it, none of this device's own goals. The same
      // again with that copy, whatever was done there meanwhile.)
      const own = join ? freshStart(account, here) && here.goals.map((g) => g.id) : Array.isArray(meta.afresh) && !joinedAt(account) && !meta.afresh.some((id) => hasGoal(account, id)) && meta.afresh;
      // The account's copy joined a fresh start this device hadn't seen yet, while this device
      // held that fresh start's copy (it never saw a join): the join was made over what this
      // device last sent or took in, so what was done here meanwhile is added to it and doesn't
      // undo it. Its settings, profile and plan stay, as on the device that joined it.
      const theirs = !fresh && !own && !joinedAt(here) && joinedAt(account) > 0;
      let data: CloudCopy;
      if (own) data = join ? markJoined(joinFreshStart(here, localAt, account, now), now) : joinFreshStart(here, localAt, account, now);
      else if (theirs) data = joinFreshStart(account, got.payload.changedAt, here, now);
      else {
        data = merge(here, cloudWins ? 0 : localAt, account, got.payload.changedAt, now, { cloudWins });
        // A join of this device's that never went up isn't one: the account's copy says what it is.
        if (meta.afresh) data = markJoined(data, joinedAt(account));
      }
      adopt(data);
      // This device now holds the account's copy plus what it adds to it. Noted before sending it
      // up: if that doesn't land, the next sync sends it (or merges it with a newer one, the
      // newer change winning) rather than taking it for a first sign-in again. (After a fresh
      // start, what the copy wins by is the device's that had the history, as old as it is.)
      const changedAt = own ? localAt : theirs ? got.payload.changedAt : Math.max(localAt, got.payload.changedAt);
      const h = currentHash();
      patchMeta({ uid, login: status.user!.email, rev: remote.rev, hash: undefined, schema: SCHEMA, changedAt, seenHash: h, joining: undefined, joinHash: undefined, prev: undefined, afresh: own || undefined });
      await push(cloudCopy(), changedAt, remote, gen);
    }
  } else if (localChanged || !remote) {
    const h = currentHash();
    await push(cloudCopy(), localChangedAt(known, h), remote, gen);
  } else {
    // Nothing to do, but this device is signed in to this account again (after signing out). An
    // old-shaped fingerprint is taken again, now that the data is known to match the cloud copy.
    patchMeta({ uid, login: status.user!.email, at: Date.now(), ...(oldMeta ? { hash: startHash, seenHash: startHash, schema: SCHEMA } : {}), joining: undefined, prev: undefined });
  }
}

// Once the account's copy has been taken in, this device's data is that account's, even if
// sending it back up fails: it's no longer only "joining".
function joined(stored: Meta) {
  if (stored.joining) patchMeta({ joining: undefined, joinHash: undefined, prev: undefined });
}

let running: Promise<void> | null = null;
let again = false;
let deciding = false; // between signing in and the Player's answer about this device's data
// A sign-in, in this window of the app or another (they share the sign-in and the data), is
// waiting for the Player's answer about this device's data: nothing goes in or out until then.
const waitingForAnswer = () => deciding || !!readMeta().asking;

export async function syncNow(): Promise<void> {
  // Not while the Player is deciding whether this device's data goes into the account.
  if (!status.user || status.locked || status.repair || waitingForAnswer()) return;
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
        run(),
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
  if (!status.error && !status.locked && status.user) for (const fn of synced) fn();
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

function signedIn(result: A.Result, { replaced = false } = {}) {
  doneDeciding();
  // From now on this device is signed in to this account (so a restart stays signed in, even
  // before the first sync). Back to the account it had: what it knew about it stays. Another
  // account is only "joining" until a sync finishes: signing out before that leaves this
  // device's data as it was (or nobody's, if it was replaced). Not before a recovery code that's
  // still needed has worked.
  const m = readMeta();
  const uid = result.user.uid;
  if (m.uid !== uid && !('needsRecovery' in result)) {
    if (m.lastUid === uid && !m.joining) writeMeta({ ...m, uid, login: result.user.email });
    else {
      const before = m.joining ? m.prev : m;
      writeMeta({ uid, login: result.user.email, joining: true, joinHash: currentHash(), ...(replaced || !before ? {} : { prev: before }), ...(m.deleting ? { deleting: m.deleting } : {}) });
    }
  }
  if (status.user?.uid !== result.user.uid) status.way = status.notice = '';
  status.user = result.user;
  status.locked = false;
  status.repair = 'needsRecovery' in result;
  status.otherKey = 'otherKey' in result && !!result.otherKey;
  status.form = 'in';
  status.byEmail = status.emailPassword = false;
  const setup = 'setup' in result ? result.setup : undefined;
  if (setup) {
    keepCodes(setup, result.user.uid);
    const reset = 'reset' in result && !!result.reset;
    showCodes(setup, reset ? NEW_CODE_AFTER_RESET : '', reset && setup.byEmail ? AFTER_RESET : '');
    noteWay(setup.byEmail ? 'email' : 'code', !!setup.wasEmail); // just saved so
  } else if (status.pendingFor !== result.user.uid) status.pending = null;
  if (!status.repair) return Promise.all([syncNow(), status.way ? null : loadWay()]).then(() => {});
}

// How the signed-in account gets back in after a forgotten password, for the Account panel. Noted
// in the sync info too, so a sign-in here later knows it (see knows).
function noteWay(way: A.Way, wasEmail: boolean) {
  status.way = way;
  status.wasEmail = wasEmail;
  if (status.user && readMeta().uid === status.user.uid) patchMeta({ way });
}
async function loadWay() {
  const user = status.user;
  if (!user) return;
  try {
    const { way, wasEmail, turnedOff } = await A.resetWay(user);
    if (status.user?.uid === user.uid) {
      noteWay(way, wasEmail);
      if (turnedOff) status.notice = EMAIL_OFF;
    }
  } catch {
    // Not known yet ('' says so). Opening it under More asks again.
  }
  hooks.render();
}

// The Player chose to replace this device's data with the account's (or to start a new account
// empty): done here and now, so it can't be repeated later over anything done since.
function replaceHere() {
  applying = true;
  S.resetKeepingDevice();
  applying = false;
  // What's left belongs to nobody: the previous account's sync info no longer describes it (so
  // its owner signing in later takes their cloud copy, never sends this empty one over it).
  const m = readMeta();
  writeMeta(m.deleting ? { deleting: m.deleting } : {});
  hooks.changed();
}

// Codes the Player still has to save, and whose they are (never shown to another account).
function keepCodes(setup: A.Setup, uid: string) {
  status.pending = setup;
  status.pendingFor = uid;
}

// Whose data this device holds, and whether all of it is in that account's cloud copy (so
// replacing it here loses nothing). Checked before signing in: nothing may wait between the
// sign-in and the Player's answer, or a sync could start in between. `id`: the email or account
// code being signed in (or up) with.
async function holder(id = '') {
  const meta = readMeta();
  // An account that signed in but never finished a sync here doesn't own this data (yet), unless
  // it signed out after something was done here (see leave).
  const m: Meta = meta.joining && meta.uid ? meta.prev || {} : meta;
  const owner = m.uid || m.lastUid || m.orphanOf || '';
  // The data's account signs in with this same email or code: signing back in to it needs no
  // answer, and nor does that email's account made again (see otherAccount). No check either.
  const same = !!id && !!m.login && A.loginEmail(id) === m.login;
  const synced = !same && !!owner && owner !== m.orphanOf && !!m.hash && !!m.seenHash && currentHash() === m.hash && !!m.login && (await A.accountExists(m.login, owner));
  const orphan = !!owner && owner === m.orphanOf;
  // Arise 2.2.0 didn't note the email of an account deleted on another device.
  return { owner, orphan, unknown: orphan && !m.login, same, synced };
}

// Before signing in to an account that may get a question about this device's data. Until the
// Player answers, no sync runs; and if the app is closed with the question open, that sign-in is
// undone the next time (see dropUnanswered).
function startDeciding() {
  deciding = true;
  patchMeta({ asking: true });
}
function doneDeciding() {
  deciding = false;
  const { asking, ...m } = readMeta();
  if (asking) writeMeta(m);
}
async function dropUnanswered() {
  if (!readMeta().asking) return;
  await A.signOut();
  status.user = null;
  doneDeciding();
}

// This device holds data from a different account: don't mix the two. The data of an account
// deleted on another device belongs to nobody: a new account takes it without asking.
// The account that has the data's email now, when it's another account than the data's, is that
// email's account deleted and made again (Firebase lets an email have only one). Most likely by
// the same person, but the email shows no more than that the old login is gone. So signing in to
// it asks first (`remade`), and neither answer loses anything: OK adds this device's data to it
// (the newer change winning, see run), Cancel stays signed out. A new account made here with that
// email takes the data without asking, like a new account takes the data of a deleted one:
// making an account on a device backs up what's on it, and it has nothing to mix with yet.
// (Anything saved here during the sign-in isn't in the other account's cloud copy: checked again.)
// Any data of the Player's own counts, a chat or a profile answer too (see S.hasOwnData), so
// none of one person's data goes into another's account without a question. The question about
// the account made again comes even when there is none: the settings would still go into it,
// the newer winning (see run).
// The data of an account deleted on another device under Arise 2.2.0 has no email noted, so
// whether this is that account made again can't be told: asked the same way, without naming
// one, rather than offering to replace data that belongs to nobody. OK adds it as the data of
// that account made again (see run).
function otherAccount(uid: string, h: Awaited<ReturnType<typeof holder>>, { signUp = false } = {}) {
  const none = { other: false, remade: false, deleted: false, synced: false };
  if (!h.owner || h.owner === uid || (signUp && (h.orphan || h.same))) return none;
  if (h.same) return { ...none, remade: true };
  if (!S.hasOwnData()) return none;
  if (h.unknown) return { ...none, remade: true, deleted: true };
  return { ...none, other: true, synced: h.synced && currentHash() === readMeta().hash };
}
const lostText = (synced: boolean) =>
  synced ? " The other account keeps all of it in its cloud copy." : " Some of it never reached the other account's cloud copy, so it would be lost. Save a backup first if you want to keep it.";
const replaceText = (id: string, synced: boolean) => `This device has data from another account. Replace it with the data of ${id}?${lostText(synced)}`;
const keptText = '\n\nChoose Cancel to stay signed out. The data stays on this device either way.';
const addText = (id: string) => `This device has data from an account that had ${id} before. Add it to this account?${keptText}`;
const addDeletedText = (id: string) => `This device has data from an account that was deleted. Add it to ${id}?${keptText}`;

type Values = Record<string, string>;

async function enter(kind: 'in' | 'up', values: Values) {
  const v = (name: string) => values[name] ?? '';
  await A.load(onUser);
  if (kind === 'up') {
    status.byEmail = !status.noEmail && v('way') === 'email';
    if (v('password') !== v('password2')) throw new A.AccountError('mismatch', "The two passwords don't match.");
    startDeciding();
    const h = await holder(status.noEmail ? '' : v('email'));
    const result = await A.signUp({ email: v('email').trim(), password: v('password'), noEmail: status.noEmail, byEmail: status.byEmail });
    // The data here belongs to another account. Starting empty removes it from this device, so
    // only if the Player says so; otherwise it goes into the new account. With nothing of the
    // Player's own in it (that account's settings at most, and what the app wrote by itself),
    // nothing is lost: the new account starts without it, and no question.
    const { other, synced } = otherAccount(result.user.uid, h, { signUp: true });
    const leftover = !!h.owner && !h.orphan && !h.same && !S.hasOwnData();
    const replaced = leftover || (other && confirm(`This device has data from another account. Start your new account empty?${lostText(synced)}\n\nChoose Cancel to copy this device's data into your new account instead.`));
    if (replaced) replaceHere();
    await signedIn(result, { replaced });
    if (!status.error) toast('Account created. Your data is encrypted and backed up.');
    return;
  }
  startDeciding();
  const h = await holder(v('id'));
  const result = await A.signIn(v('id').trim(), v('password'), knows);
  // The password was set from a reset email (Email reset): Firebase has this one now.
  const reset = 'reset' in result && !!result.reset;
  const { other, remade, deleted, synced } = otherAccount(result.user.uid, h);
  if ((other && !confirm(replaceText(result.user.id, synced))) || (remade && !confirm((deleted ? addDeletedText : addText)(result.user.id)))) {
    // Signing in may have just made a new recovery code (after a reset email): it's shown once
    // anyway (it isn't kept, as this device belongs to someone else). Signing in later can
    // always make a new one.
    if ('setup' in result && result.setup) showCodes(result.setup, reset ? NEW_CODE_AFTER_RESET : '', reset && result.setup.byEmail ? AFTER_RESET : '');
    await A.signOut();
    status.user = null;
    if (reset) toast('Password changed. Sign in with it when you want this account on this device.');
    return;
  }
  if (other) replaceHere();
  // The Player says the deleted account's data is this one's: noted as that account's email, so
  // it joins as the account made again (see run).
  if (deleted) {
    const m = readMeta();
    writeMeta(m.joining && m.uid ? { ...m, prev: { ...m.prev, login: result.user.email } } : { ...m, login: result.user.email });
  }
  await signedIn(result, { replaced: other });
  if (!status.error && !status.repair) toast(reset ? "Password changed. You're signed in." : 'Signed in. Your data is synced.');
}

function onUser(u: A.User | null) {
  if (u?.uid !== status.user?.uid) status.way = status.notice = '';
  status.user = u;
  status.loading = false;
  hooks.render();
}

// Something was done on this device while its account was joining (or it isn't known).
const changedWhileJoining = (m: Meta) => currentHash() !== m.joinHash;

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
  status.way = status.notice = '';
  status.locked = status.repair = status.otherKey = false;
  status.more = '';
  status.pending = null;
  // What this device knows about the account's cloud copy stays, so signing back in later
  // carries on where it left off. An account that never finished a sync here leaves the data as
  // it was before it signed in, unless something was done here since: that's this account's
  // data now, so another account signing in here is asked about it, and this one signing back
  // in carries on joining.
  if (m.joining) {
    const kept = changedWhileJoining(m) ? { lastUid: m.uid, login: m.login, joining: true, prev: m.prev } : m.prev || {};
    writeMeta({ ...kept, ...(m.deleting ? { deleting: m.deleting } : {}) });
  } else {
    const { uid: _u, email: _e, ...known } = m;
    writeMeta({ ...known, lastUid: m.uid || m.lastUid });
  }
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
    // Nothing of any account is left here: signing in again is a first sign-in, which takes the
    // cloud copy as it is.
    writeMeta(m.deleting ? { deleting: m.deleting } : {});
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
  const { uid, email } = status.user!;
  const { changedAt, seenHash } = readMeta();
  await A.signOut();
  status.user = null;
  status.way = status.notice = '';
  status.locked = status.repair = status.otherKey = false;
  status.more = '';
  status.pending = null;
  // The account is gone, so this data belongs to nobody now: a new account can simply take it.
  // Its email stays known, for the account made again with it (see otherAccount), and so does
  // when the data last changed (see run).
  writeMeta({ orphanOf: uid, login: email, changedAt, seenHash });
  throw new A.AccountError('deleted', 'This account was deleted on another device, so this device was signed out. Your data on this device stays.');
}

// Every page this account shared a goal through is turned off (firestore.rules lets an account
// list its own), in batches within Firestore's 500 writes.
async function turnOffShares(uid: string) {
  const { fb, db } = A.firebase();
  const pages = await fb.getDocs(fb.query(fb.collection(db, 'shares'), fb.where('owner', '==', uid)));
  for (let i = 0; i < pages.docs.length; i += 400) {
    const batch = fb.writeBatch(db);
    for (const p of pages.docs.slice(i, i + 400)) batch.set(fb.doc(db, 'shares', p.id), SHARE_OFF);
    await batch.commit();
  }
}

// Returns false when the account turned out to be deleted already.
async function deleteEverything(password: string): Promise<boolean> {
  const user = status.user!;
  // The login is gone already: a deletion went through although its reply never came (or the
  // account was deleted elsewhere). No password can be checked then, and there's nothing to
  // protect: whatever this device can still reach of the account goes, and it signs out.
  let gone = false;
  try {
    await A.confirmPassword(user, password);
  } catch (err) {
    if ((err as { code?: string })?.code !== 'gone') throw err;
    gone = true;
  }
  // Checking took a moment. If this device's sign-in went to another account meanwhile (in
  // another window of the app), nothing is deleted, of either account.
  if (A.currentUid() && A.currentUid() !== user.uid) throw new A.AccountError('signed-out', 'You were signed out on this device. Sign in again, then try again.');
  // From here on nothing is uploaded again, even if the app closes halfway.
  patchMeta({ deleting: user.uid });
  generation++;
  if (timer) clearTimeout(timer);
  try {
    const { fb, db } = A.firebase();
    const remote = await readRemote(user.uid);
    const batch = fb.writeBatch(db);
    for (let i = 0; i < Math.max(remote?.parts || 0, 1); i++) batch.delete(ref(`part${i}`, user.uid));
    batch.delete(ref('meta', user.uid));
    // The pages of goals shared with a link are turned off first, so no link outlives the account.
    // All of the account's, as the cloud lists them, not only the ones this device's goals know
    // of: a link made on a device that hasn't synced here, or kept by a goal deleted while signed
    // out, goes too. They're turned off for good rather than deleted, as Stop sharing does
    // (share.ts), so nothing of the account is left in them.
    await turnOffShares(user.uid);
    await batch.commit();
    await A.deleteAccount(user, { gone });
  } catch (err) {
    // (Once the login is gone, the cloud soon stops letting this device in.) Otherwise it has to
    // be done again: not "it will sync" when the cloud can't be reached.
    if (!gone && /unavailable|network|deadline/.test(String((err as { code?: string })?.code))) {
      throw new A.AccountError('deleting', "Couldn't reach the cloud, so deleting your account may not have finished. When you're online, enter your password again to finish it.");
    }
    if (!gone) throw err;
  }
  // Meanwhile another window of the app may have signed in to another account, whose data this
  // device holds now: that sign-in and its sync info stay as they are.
  const elsewhere = () => !!A.currentUid() && A.currentUid() !== user.uid;
  if (gone && !elsewhere()) await A.signOut();
  if (!elsewhere()) {
    status.user = null;
    status.way = status.notice = '';
  }
  status.more = '';
  // The account is gone, so this device's data belongs to nobody now, as when an account is
  // deleted on another device (see deletedElsewhere): its email and when it last changed stay
  // known, for the account made again with that email (see otherAccount and run). Data that
  // never finished joining the account is as it was before, unless something was done here
  // since (see leave).
  const m = readMeta();
  if (m.uid && m.uid !== user.uid) {
    // Another account's now (see above): only the mark of this deletion goes.
    if (m.deleting === user.uid) {
      const { deleting: _d, ...rest } = m;
      writeMeta(rest);
    }
  } else if (m.joining && !changedWhileJoining(m)) writeMeta(m.prev || {});
  else writeMeta({ orphanOf: user.uid, login: user.email, changedAt: m.changedAt, seenHash: m.seenHash });
  return !gone;
}

// ---------- screens

// `note`: why there's a new code, said first. `warn`: something to know, said after.
function showCodes(setup: A.Setup, note = '', warn = '') {
  const why = setup.byEmail
    ? "If you forget your password, we can email you a reset link. This code is a second way back in, for example if you can't get into your email."
    : 'If you forget your password, this code is the <b>only</b> way to get your data back. Nobody can reset it for you.';
  const keepText = setup.byEmail
    ? 'If you forget your password, this code gets you back in, as a reset email does.'
    : 'Your data is end-to-end encrypted: if you forget your password, this code is the only way to get it back.';
  const text = `Arise account details\n\n${setup.accountCode ? `Account code: ${setup.accountCode}\n` : ''}Recovery code: ${setup.recoveryCode}\n\nKeep this somewhere safe and private. ${keepText}`;
  openSheet(`<p class="kicker">Save this now</p>
    <h2 class="display sheet-title">${setup.accountCode ? 'Your account details' : 'Your recovery code'}</h2>
    <p>${note ? `${esc(note)} ` : ''}${why}</p>
    ${warn ? `<p class="small">${esc(warn)}</p>` : ''}
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
const NEW_CODE_AFTER_RESET = 'Your password changed, so your old recovery code stopped working. This is your new one.';
// After a reset email opened the data: said plainly, so someone who never chose Email reset
// notices (see knows).
const AFTER_RESET =
  "Your account uses Email reset. That's how a reset email could open your data. If you didn't choose it, someone who got into your email may have, and could read your data. Then secure your email, delete this account under More, and make a new one: the data on this device goes into it.";
// What's left of Email reset didn't fit, so it went (see A.WayInfo).
const EMAIL_OFF =
  "Email reset is now off for your account, because it wasn't set up right. An older version of Arise on another device can do that, or someone who got into your email. If you forget your password, your recovery code is the way back in. You can turn Email reset on again under More.";
const NEW_CODE_ONLY_WAY = 'Your old recovery code stopped working. This is your new one.';

// "Learn more" at sign-up, and under More: the two ways back in side by side, in plain words.
function waysHTML() {
  return `<p class="kicker">Account</p>
    <h2 class="display sheet-title">If you forget your password</h2>
    <p>Either way, your data is encrypted on your device before it's sent, and you sign in with your email and password. What changes is how you get back in if you forget your password, and who else could open your data.</p>
    <h3 class="sub">Recovery code (most private)</h3>
    <p class="small"><b>Who can read your data:</b> Nobody but you. Not the people who run Arise, not Google (who host it), and not anyone who asks either of them for it.</p>
    <p class="small"><b>If you forget your password:</b> You set a new one with your recovery code. You get it when you make your account, and you keep it somewhere safe. If you lose both, nobody can get your cloud copy back. The data on your devices stays.</p>
    <h3 class="sub">Email reset (easier)</h3>
    <p class="small"><b>Who can read your data:</b> Your account keeps a copy of its key in the cloud. Only you can fetch it when you sign in. But Google (who host it) and the people who run Arise could read your data if they chose to, or if someone made them. ${INBOX}</p>
    <p class="small"><b>If you forget your password:</b> We email you a link to set a new one. You also get a recovery code, as a second way back in.</p>
    <h3 class="sub">Changing your mind</h3>
    <p class="small">You can switch any time in Settings, Account, More. Switching to Recovery code deletes the copy of your key from the cloud. Your key stays the same, though, so that can't undo a copy someone may have taken while it was there.</p>
    <p class="small">Accounts with an account code (no email) always use a recovery code.</p>
    <button class="btn primary block" data-act="sheet-close">Got it</button>`;
}

const field = (name: string, label: string, type: string, extra = '') =>
  `<label class="field"><span class="k">${label}</span><input name="${name}" type="${type}" ${extra} spellcheck="false" autocapitalize="off"></label>`;

function ago(t?: number) {
  if (!t) return 'not yet';
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(t).toLocaleDateString();
}

const title = `<div class="panel-title">${icon('key')}<span>Account</span></div>`;
// With Email reset the code isn't the only way back, so it's only offered.
function pendingAlert() {
  if (!status.pending || status.pendingFor !== status.user?.uid) return '';
  const show = '<button class="link small" data-act="sync-code-show">Show it</button>';
  if (status.pending.byEmail) return `<p class="muted small">Your recovery code is a second way back in. ${show}</p>`;
  return `<div class="alert gold"><div><b>Save your recovery code.</b> It's the only way back in if you forget your password. ${show}</div></div>`;
}
const ENCRYPTED = 'Your data is encrypted on this device before it leaves.';
const PRIVATE = `${ENCRYPTED} Nobody else can read the cloud copy: not the people who run Arise, not Google, who host it.`;
const KEY_IN_CLOUD = 'so Google (who host it) and the people who run Arise could read your data if they chose to.';
const INBOX = 'Anyone who can get into your email could also set a new password and read your data.';
const EMAIL_WAY = `If you forget your password, we email you a link. To make that work, your account keeps a copy of its key in the cloud, ${KEY_IN_CLOUD} ${INBOX}`;
const WAS_EMAIL = 'Your account used Email reset before, and its key stays the same, so anyone who took a copy of it then could still read your data.';
const CODE_WAY = 'If you forget your password, only your recovery code gets your data back. Nobody else can read it, not even the people who run Arise.';
// The same for an account that used Email reset before (see A.WayInfo).
const CODE_WAY_WAS = `If you forget your password, only your recovery code gets your data back. ${WAS_EMAIL}`;
const RESET_SENT = "Check your email for a link to set a new password. If nothing arrives in a few minutes, check spam, and check it's the email you made the account with. Then sign in here with the new password.";

export function panel(): string {
  if (!configured) return '';
  const u = status.user;
  const err = status.error ? `<p class="small error" role="alert">${esc(status.error)}</p>` : '';
  const busy = status.busy || status.loading;
  if (status.loading && !u) return `<section class="panel" id="accountPanel">${title}<p class="muted">Loading…</p></section>`;

  if (u && status.repair) {
    return `<section class="panel" id="accountPanel">${title}
      ${
        status.otherKey
          ? "<p>Your password works, but this device can't tell that the key kept for Email reset is your account's own, so it isn't used. Someone who got into your email may have changed it. Your <b>recovery code</b> unlocks your data.</p>"
          : '<p>Your password works, but your encrypted data needs your <b>recovery code</b> once, because the password was changed somewhere else.</p>'
      }
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
          : status.more === 'way'
            ? wayForm(busy)
          : status.more === 'delete'
            ? `<form class="stack" data-form="delete">${field('password', 'Password', 'password', 'required autocomplete="current-password"')}
            <p class="small error">This deletes your account and your cloud copy for good, and turns off every link to a goal you shared. The data on this device stays.</p>
            <button class="btn ghost small danger" type="submit" ${busy ? 'disabled' : ''}>Delete my account and cloud copy</button></form>`
            : '';
    return `<section class="panel" id="accountPanel">${title}
      <p>Signed in as <b>${esc(u.id)}</b>. Your data is backed up and the same on every device where you sign in.</p>
      ${
        status.way === 'email'
          ? `<p class="small">${icon('check')} Encrypted, with Email reset. ${ENCRYPTED} Your account also keeps a copy of its key in the cloud, ${KEY_IN_CLOUD} ${INBOX}</p>`
          : status.way === 'code' && status.wasEmail
            ? `<p class="small">${icon('check')} Encrypted, with a recovery code. ${ENCRYPTED} ${WAS_EMAIL}</p>`
            : status.way === 'code'
              ? `<p class="ok small">${icon('check')} End-to-end encrypted. ${PRIVATE}</p>`
              : `<p class="small">${icon('check')} ${ENCRYPTED}</p>`
      }
      ${status.notice ? `<div class="alert gold"><div>${esc(status.notice)}</div></div>` : ''}
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
          ${A.usesCode(u.id) ? '' : '<button class="link small" data-act="sync-more" data-v="way">How you get back in if you forget your password</button>'}
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
      <p>Does your account use <b>Email reset</b>? We email you a link to set a new password. Then sign in here with it, and your data opens as before.</p>
      <form class="stack" data-form="reset" autocomplete="on">
        ${field('id', 'Email', 'email', 'required inputmode="email" autocomplete="username"')}
        ${err}
        <button class="btn primary" type="submit" ${busy ? 'disabled' : ''}>${busy ? 'One moment…' : 'Email me a reset link'}</button>
      </form>
      <div class="row"><button class="link small" data-act="sync-form" data-v="in">Back to sign in</button><button class="link small" data-act="sync-form" data-v="recover">Use my recovery code instead</button></div></section>`;
  }
  if (f === 'recover') {
    return `<section class="panel" id="accountPanel">${title}
      <p>Forgot your password? Your recovery code lets you set a new one.</p>
      <p class="small">Does your account use Email reset? <button class="link small" data-act="sync-form" data-v="reset">Email me a reset link</button></p>
      <form class="stack" data-form="recover" autocomplete="on">
        ${field('id', 'Email or account code', 'text', 'required autocomplete="username"')}
        ${field('code', 'Recovery code', 'text', 'required autocomplete="off" placeholder="XXXX-XXXX-…"')}
        ${status.emailPassword ? field('emailPassword', 'Password from the reset email', 'password', 'required autocomplete="off"') : ''}
        ${field('password', 'New password', 'password', `required minlength="${A.MIN_PASSWORD}" autocomplete="new-password"`)}
        ${field('password2', 'New password again', 'password', 'required autocomplete="new-password"')}
        ${err}
        <button class="btn primary" type="submit" ${busy ? 'disabled' : ''}>${busy ? 'One moment…' : 'Set new password'}</button>
      </form>
      <div class="row"><button class="link small" data-act="sync-form" data-v="in">Back to sign in</button></div></section>`;
  }
  if (f === 'up') {
    return `<section class="panel" id="accountPanel">${title}
      <p>Create a free account to back up your data and have the same history on every device. ${status.noEmail ? PRIVATE : ENCRYPTED}</p>
      <div class="seg" role="group" aria-label="Kind of account">
        <button class="${status.noEmail ? '' : 'on'}" data-act="sync-kind" data-v="email" aria-pressed="${!status.noEmail}">With email</button>
        <button class="${status.noEmail ? 'on' : ''}" data-act="sync-kind" data-v="code" aria-pressed="${status.noEmail}">No email</button>
      </div>
      <p class="muted small">${status.noEmail ? "No personal details at all: you get an account code to sign in with instead. If you lose it, nobody can tell you what it was." : 'Your email is only used to sign in. Arise never sends you mail.'}</p>
      <form class="stack" data-form="up" autocomplete="on">
        ${status.noEmail ? '' : field('email', 'Email', 'email', 'required inputmode="email" autocomplete="email"')}
        ${field('password', 'Password', 'password', `required minlength="${A.MIN_PASSWORD}" autocomplete="new-password" placeholder="At least ${A.MIN_PASSWORD} characters"`)}
        ${field('password2', 'Password again', 'password', 'required autocomplete="new-password"')}
        ${
          status.noEmail
            ? `<p class="muted small">Your password is the key to your data. If you forget it, only your recovery code (you'll get it next) can get your data back.</p>`
            : `<p class="muted small">Your password is the key to your data, so make it one you don't use anywhere else.</p>${waysChoice()}`
        }
        ${err}
        <button class="btn primary" type="submit" ${busy ? 'disabled' : ''}>${busy ? 'Encrypting…' : 'Create account'}</button>
      </form>
      <div class="row"><button class="link small" data-act="sync-form" data-v="in">Already have an account? Sign in</button></div></section>`;
  }
  return `<section class="panel" id="accountPanel">${title}
    <p>Sign in to back up your data and have the same history on every device. ${ENCRYPTED} Without an account everything stays on this device.</p>
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

// At sign-up with an email: how to get back in after a forgotten password. Radio buttons, so
// choosing doesn't redraw the form (and lose what's typed).
function waysChoice() {
  const way = (v: A.Way, name: string, tag: string, text: string) =>
    `<label class="way"><input type="radio" name="way" value="${v}" ${status.byEmail === (v === 'email') ? 'checked' : ''}><span class="way-text"><span class="engine-head"><b>${name}</b>${tag}</span><small>${text}</small></span></label>`;
  return `<fieldset class="ways"><legend class="k">If you forget your password</legend>
      ${way('code', 'Recovery code (most private)', '<span class="tag gold">Default</span>', `You get a recovery code to save. ${CODE_WAY}`)}
      ${way('email', 'Email reset (easier)', '<span class="tag">Less private</span>', EMAIL_WAY)}
      <button class="learn-more" type="button" data-act="sync-learn">Learn more: which one is right for me?</button>
    </fieldset>`;
}

// Under More: switch how the account gets back in. The password is needed either way.
function wayForm(busy: boolean) {
  if (!status.way) return `<p class="small">Couldn't check how your account gets back in. Try again when you're online.</p>`;
  const toEmail = status.way === 'code';
  return `<form class="stack" data-form="way">
      <p class="small">Now: <b>${toEmail ? 'Recovery code (most private)' : 'Email reset (easier)'}</b>. ${toEmail ? (status.wasEmail ? CODE_WAY_WAS : CODE_WAY) : EMAIL_WAY}</p>
      <p class="small">${
        toEmail
          ? `Switch to <b>Email reset (easier)</b>: ${EMAIL_WAY} Your recovery code keeps working too.`
          : "Switch to <b>Recovery code (most private)</b>: the copy of your key is deleted from the cloud, and you get a new recovery code to save. It's then the only way back in. Your key stays the same, though, so this can't undo a copy someone may have taken."
      }</p>
      <button class="learn-more" type="button" data-act="sync-learn">Learn more</button>
      <input type="hidden" name="way" value="${toEmail ? 'email' : 'code'}">
      ${field('password', 'Password', 'password', 'required autocomplete="current-password"')}
      <button class="btn primary small" type="submit" ${busy ? 'disabled' : ''}>${toEmail ? 'Switch to Email reset' : 'Switch to Recovery code'}</button></form>`;
}

export async function handleAction(act: string, el?: HTMLElement): Promise<boolean> {
  if (!act.startsWith('sync-')) return false;
  try {
    switch (act) {
      case 'sync-form':
        status.form = (el?.dataset.v as Form) || 'in';
        status.error = '';
        status.emailPassword = false;
        break;
      case 'sync-kind':
        status.noEmail = el?.dataset.v === 'code';
        break;
      case 'sync-more':
        status.more = status.more === el?.dataset.v ? '' : ((el?.dataset.v as typeof status.more) ?? '');
        status.error = '';
        if (status.more === 'way' && !status.way) await loadWay();
        break;
      case 'sync-learn':
        openSheet(waysHTML());
        return true;
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
        if (status.pending && status.pendingFor === status.user?.uid) showCodes(status.pending);
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
  let before: string | null = null;
  try {
    await A.load(onUser);
    await dropUnanswered();
    // A sign-in left over from before (the app closed before it could finish) isn't this
    // device's account: undo it rather than let a failed attempt now carry on with it.
    if (['in', 'up', 'recover', 'reset'].includes(kind) && A.currentUid() && A.currentUid() !== readMeta().uid) {
      await A.signOut();
      status.user = null;
    }
    before = A.currentUid();
    if (kind === 'in' || kind === 'up') await enter(kind, values);
    else if (kind === 'recover') {
      if (v('password') !== v('password2')) throw new A.AccountError('mismatch', "The two passwords don't match.");
      startDeciding();
      const h = await holder(v('id'));
      const result = await A.recover({ id: v('id').trim(), recoveryCode: v('code'), newPassword: v('password'), emailPassword: v('emailPassword') });
      const { other, remade, synced } = otherAccount(result.user.uid, h);
      if ((other && !confirm(replaceText(result.user.id, synced))) || (remade && !confirm(addText(result.user.id)))) {
        await A.signOut();
        status.user = null;
        status.form = 'in';
        toast('New password set. Sign in with it when you want this account on this device.');
      } else {
        if (other) replaceHere();
        await signedIn(result, { replaced: other });
        if ('emailOff' in result && result.emailOff) status.notice = EMAIL_OFF;
        toast('New password set. Signed in.');
      }
    } else if (kind === 'reset') {
      await A.resetByEmail(v('id').trim());
      status.form = 'in';
      toast(RESET_SENT);
    } else if (kind === 'unlock') {
      await signedIn(await A.unlock(status.user!, v('password')));
    } else if (kind === 'repair') {
      const result = await A.repair(v('code'));
      await signedIn(result);
      if ('emailOff' in result && result.emailOff) status.notice = EMAIL_OFF;
      toast('Unlocked. Your data is synced.');
    } else if (kind === 'password') {
      if (v('password') !== v('password2')) throw new A.AccountError('mismatch', "The two new passwords don't match.");
      const setup = await A.changePassword(status.user!, v('old'), v('password'));
      status.more = '';
      keepCodes(setup, status.user!.uid);
      showCodes(setup);
      toast('Password changed.');
    } else if (kind === 'code') {
      const setup = await A.newRecoveryCode(status.user!, v('password'));
      status.more = '';
      keepCodes(setup, status.user!.uid);
      showCodes(setup);
    } else if (kind === 'way') {
      const way: A.Way = v('way') === 'email' ? 'email' : 'code';
      if (way === 'code' || confirm(`Switch to Email reset? ${EMAIL_WAY}`)) {
        const setup = await A.setResetWay(status.user!, v('password'), way);
        noteWay(way, way === 'email' || !!setup?.wasEmail);
        status.more = status.notice = '';
        toast(way === 'email' ? 'Switched to Email reset.' : 'Switched to Recovery code.');
        if (setup) {
          keepCodes(setup, status.user!.uid);
          showCodes(setup, way === 'code' ? NEW_CODE_ONLY_WAY : '');
        }
      }
    } else if (kind === 'delete') {
      if (confirm('Delete your account and your cloud copy? This cannot be undone. The data on this device stays.')) {
        const deleted = await deleteEverything(v('password'));
        toast(deleted ? 'Account and cloud copy deleted.' : 'Your account was already deleted. The data on this device stays.');
      }
    }
  } catch (err) {
    // A sign-in cut off partway (after Firebase let it in) is undone, so this device's data can't
    // go into that account without the question; trying again starts from the same place.
    status.error = A.friendly(err);
    if (deciding && A.currentUid() && A.currentUid() !== before) {
      await A.signOut().catch(() => {});
      status.user = null;
      status.locked = false;
    }
    if (deciding && !A.currentUid() && /unavailable|network|offline|took too long/i.test(`${(err as { code?: string })?.code} ${status.error}`)) {
      status.error = "Couldn't reach the cloud, so you weren't signed in. Try again when you're online.";
    }
    doneDeciding();
    // The recovery code can't sign in after a reset email: with that password too, it can. (An
    // account code never gets a reset email.)
    if ((err as { code?: string })?.code === 'reset-elsewhere') status.emailPassword = !A.usesCode(v('id'));
  }
  doneDeciding();
  status.busy = false;
  hooks.render();
}

// ---------- start

export function initSync(h: Partial<typeof hooks>): Promise<void> {
  hooks = { ...hooks, ...h };
  if (!configured) return Promise.resolve();
  // This device's data couldn't be read and starts blank: forget which cloud version it had, so
  // the next sync takes the cloud copy instead of sending the blank one over it.
  if (S.storageProblem() === 'corrupt') {
    const { rev: _r, hash: _h, seenHash: _s, changedAt: _c, ...rest } = readMeta();
    // Its account's data is on its way again (so no intro meanwhile).
    writeMeta(rest.uid ? { ...rest, joining: true } : rest);
  }
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
  if (!meta.uid && !meta.deleting && !meta.asking) return Promise.resolve();
  status.loading = true;
  return A.load(onUser)
      .then(async () => {
        await dropUnanswered();
        if (!status.user) return;
        if (readMeta().deleting === status.user.uid) {
          status.more = 'delete';
          status.error = "Deleting your account didn't finish. Enter your password under More to finish it.";
          hooks.render();
          return;
        }
        status.locked = !(await A.deviceKey(status.user.uid));
        hooks.render();
        await Promise.all([syncNow(), status.locked ? null : loadWay()]);
      })
      .catch((err) => {
        status.loading = false;
        status.error = A.friendly(err);
        hooks.render();
      });
}

// For the private AI proxy: proves the request comes from a signed-in Arise account.
export const idToken = () => (status.user ? A.idToken() : Promise.resolve(null));
