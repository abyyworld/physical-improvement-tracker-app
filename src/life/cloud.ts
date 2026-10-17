// The life log's sync between the Player's devices, encrypted on the device like the rest of their
// data (end-to-end, unless the account uses Email reset: see account.ts). Optional: without an
// account the life log stays on this device.
//
// Cloud layout, in the account's own folder, users/{uid}/life/{id} (firestore.rules):
//   key          the life key, sealed with the account's data key (seal.ts)
//   index        which packs there are, each one's version and number of parts, sealed
//   <43 chars>   one part of one pack (packs.ts): an HMAC of the pack's name, so the ids don't
//                tell which months the Player has anything in
// Every document is { v: 1, iv, ct, updated }: the server only ever holds ciphertext.
//
// When: after each sync of the main data that went through (sync.ts), so everything that guards
// that one guards this too: the question about another account's data on this device, a key that
// isn't the account's own, an account deleted on another device. Then the changed packs are taken
// in, and the ones changed here (journal.ts) go up a few seconds after a change. Writes only land
// if no other device wrote in between (the index is checked in the same transaction), otherwise it
// all starts again with that device's packs taken in first.
//
// Before the owner has put the new database rules live, the cloud refuses all of it: the life log
// stays on this device and tries again next time, and Settings says so in one line.

import type { Firestore } from 'firebase/firestore/lite';
import { cleanLifeIndex, type LifePackInfo } from '../lib/validate';
import type { Sealed } from '../lib/crypto';
import { onDirty } from './journal';
import { onPrefsChange, prefs, takePaused } from './prefs';
import { canonical, cleanContent, emptyContent, isEmpty, LIFE_SCHEMA, MEM, TOMB_KEEP, type Content } from './packs';
import { digest, newLifeKey, newRev, openIndex, openLifeKey, openPack, partId, sealIndex, sealPack, PackError, type LifeKeys } from './seal';
import * as LOCAL from './local';
import { eraseAll } from './log';

type FB = typeof import('../lib/firebase');

export interface Ready {
  uid: string;
  key(): Promise<CryptoKey>; // the account's data key
}
export interface Hooks {
  // Signed in, unlocked, and the main sync went through for this account on this device.
  ready(): Ready | null;
  firebase(): { fb: FB; db: Firestore };
  account(): { signedIn: boolean; e2ee: boolean };
  checkForUpdate(): void;
  render(): void;
}

const PUSH_DELAY = 8000;
const TIMEOUT = 120_000;
const GROUP_CHARS = 9_000_000; // per write to the cloud, which takes up to 10 MB
const GROUP_WRITES = 450; // and up to 500 documents

export const status = {
  busy: false,
  needsServer: false, // the database rules don't let the life log in yet
  newer: false, // a newer version of Arise synced it
  tooBig: false, // a pack is too big to sync
  error: '',
  at: 0, // when it last synced
};

let hooks: Hooks | null = null;
let gen = 0; // moves on when the account signs out or changes: a run from before stops
let running: Promise<void> | null = null;
let again = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let cache: { uid: string; keys: LifeKeys } | null = null;

const codeOf = (err: unknown) => String((err as { code?: string })?.code || '');
const fail = (code: string, message: string) => Object.assign(new Error(message), { code });

export function connect(h: Hooks) {
  const first = !hooks;
  hooks = h;
  if (!first) return;
  onDirty(() => queue());
  // "Stop learning" changed: the memory's pack goes up (it's looked at on every sync anyway).
  onPrefsChange(() => {
    queue();
    LOCAL.markPacks([MEM]).catch(() => {});
  });
}

// Signed in, so the life log syncs (once the account is unlocked here).
export const signedIn = () => !!hooks?.account().signedIn;

// What the life log's screens say about where it's kept.
export function lines(): { main: string; note: string } {
  const a = hooks?.account();
  if (!a) return { main: 'On this device only.', note: '' };
  if (!a.signedIn) return { main: 'On this device only. Sign in to sync it.', note: '' };
  const note = status.needsServer
    ? 'Syncing your life log needs an update on the server.'
    : status.newer
      ? 'A newer version of Arise synced your life log. It syncs again once this app has updated.'
      : status.tooBig
        ? 'Part of your life log is too big to sync, so it stays on this device.'
        : '';
  return { main: a.e2ee ? 'Synced between your devices, end-to-end encrypted.' : 'Synced between your devices, encrypted.', note };
}

// ---------- when

// After a change here: send it once things are quiet for a few seconds.
export function queue(delay = PUSH_DELAY) {
  if (!hooks?.ready()) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    syncNow();
  }, delay);
}

// Send what's waiting now (the app is going to the background, or signing out).
export async function flush(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
    // Not signed in any more: it stays marked, for next time.
    if (!hooks?.ready()) return;
    return syncNow();
  }
  if (running) await running;
}

// Signing out, or another account: nothing more goes in or out for the one before.
export function stop() {
  gen++;
  if (timer) clearTimeout(timer);
  timer = null;
  cache = null;
}

// Syncs now. While a sync is on, asking again runs one more after it; the promise covers both.
export function syncNow(): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  if (!hooks?.ready()) return Promise.resolve();
  if (timer) clearTimeout(timer);
  timer = null;
  running = (async () => {
    do {
      again = false;
      await once();
    } while (again && hooks?.ready());
  })().finally(() => {
    running = null;
  });
  return running;
}

// Done when nothing is waiting to go up and no sync is on.
export async function whenIdle(): Promise<void> {
  while (running || timer) await flush();
}

async function once() {
  const r = hooks?.ready();
  if (!r) return;
  status.busy = true;
  const g = gen;
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        for (let i = 0; i < 5; i++) if (!(await run(r, g))) return;
      })(),
      new Promise((_, reject) => {
        t = setTimeout(() => reject(fail('timeout', 'Syncing the life log took too long.')), TIMEOUT);
      }),
    ]);
    if (g === gen) Object.assign(status, { needsServer: false, newer: false, error: '', at: Date.now() });
  } catch (err) {
    const code = codeOf(err);
    if (code === 'permission-denied') status.needsServer = true;
    else if (code === 'newer') status.newer = true;
    else if (!/unavailable|network|offline|deadline|timeout|locked|not-loaded|blocked|gone/.test(code)) status.error = (err as Error)?.message || 'Something went wrong.';
    if (code === 'timeout') gen++; // that run must not take anything in later
  } finally {
    clearTimeout(t);
    status.busy = false;
    hooks?.render();
  }
}

// ---------- the cloud

interface Doc {
  v: 1;
  iv: string;
  ct: string;
  updated: number;
}
const docOf = (d: unknown): Sealed | null => {
  const x = (d && typeof d === 'object' ? d : {}) as Record<string, unknown>;
  return typeof x.iv === 'string' && typeof x.ct === 'string' ? { iv: x.iv, ct: x.ct } : null;
};

interface Ctx {
  r: Ready;
  fb: FB;
  db: Firestore;
  ref: (id: string) => ReturnType<FB['doc']>;
  account: ReturnType<FB['doc']>; // users/{uid}/arise/keys: there while the account is
}

// The life key: from the cloud, or made now (`create`) if this account has none yet.
async function lifeKeys(c: Ctx, create: boolean): Promise<LifeKeys> {
  const uid = c.r.uid;
  if (cache?.uid === uid) return cache.keys;
  const dk = await c.r.key();
  const read = async () => {
    const snap = await c.fb.getDoc(c.ref('key'));
    const s = snap.exists() ? docOf(snap.data()) : null;
    return s && openLifeKey(dk, uid, s);
  };
  let keys = await read();
  if (!keys) {
    if (!create) throw new PackError('bad-data', "The life log's key is missing from the cloud.");
    const made = await newLifeKey(dk, uid);
    const ours = await c.fb.runTransaction(c.db, async (tx) => {
      const [now, acct] = [await tx.get(c.ref('key')), await tx.get(c.account)];
      if (!acct.exists()) throw fail('gone', 'This account was deleted.');
      if (now.exists()) return false; // another device made one first: that's the one
      tx.set(c.ref('key'), { v: 1, iv: made.sealed.iv, ct: made.sealed.ct, updated: Date.now() } satisfies Doc);
      return true;
    });
    keys = ours ? made.keys : await read();
    if (!keys) throw new PackError('bad-data', "The life log's key is missing from the cloud.");
  }
  cache = { uid, keys };
  return keys;
}

// The parts of a pack, opened. Null when they don't belong together (another device is saving).
async function fetchPack(c: Ctx, keys: LifeKeys, key: string, info: LifePackInfo): Promise<Content | null> {
  const ids = await Promise.all(Array.from({ length: info.n }, (_, i) => partId(keys, key, i)));
  const snaps = await Promise.all(ids.map((id) => c.fb.getDoc(c.ref(id))));
  const docs = snaps.map((s) => (s.exists() ? docOf(s.data()) : null));
  if (docs.some((d) => !d)) return null;
  try {
    const text = await openPack(keys, c.r.uid, key, info.r, docs[0]!.iv, docs.map((d) => d!.ct));
    const raw = JSON.parse(text) as { v?: unknown; k?: unknown };
    if (raw?.k !== key) return null;
    return cleanContent(key, raw);
  } catch (err) {
    if (codeOf(err) === 'bad-data' || err instanceof SyntaxError) return null;
    throw err;
  }
}

interface Write {
  key: string;
  empty: boolean; // nothing left: its documents go
  text: string;
  h: string;
  rev: string;
  iv: string;
  parts: string[];
  ids: string[]; // for every part it has now or had before
}

// One go of pulling and pushing. True: the cloud changed meanwhile, so go again.
async function run(r: Ready, g: number): Promise<boolean> {
  const { fb, db } = hooks!.firebase();
  const uid = r.uid;
  const live = () => g === gen && hooks?.ready()?.uid === uid;
  const c: Ctx = { r, fb, db, ref: (id) => fb.doc(db, 'users', uid, 'life', id), account: fb.doc(db, 'users', uid, 'arise', 'keys') };
  const now = Date.now();

  let st = await LOCAL.readState();
  if (!st || st.uid !== uid) {
    // This device's life log hasn't synced with this account yet: all of it goes in. (Another
    // person's never reaches here: their log is replaced before, see sync.ts.) What was deleted
    // here before doesn't delete anything of the account's, and where both chose whether to stop
    // learning, the account's choice wins, as its settings do on a first sign-in.
    await LOCAL.forget();
    const p = prefs();
    if (p.pausedAt) takePaused(p.paused, 0);
    st = { uid, idx: '', packs: {} };
    await LOCAL.markPacks(await LOCAL.localPacks());
    if (!live()) return false;
    await LOCAL.writeState(st);
  }

  // ---- what the cloud has
  const snap = await c.fb.getDoc(c.ref('index'));
  if (!live()) return false;
  const doc = snap.exists() ? docOf(snap.data()) : null;
  if (snap.exists() && !doc) throw new PackError('bad-data', "The life log's index in the cloud doesn't look right.");
  let index: Record<string, LifePackInfo> = {};
  if (doc && doc.iv === st.idx) for (const [k, p] of Object.entries(st.packs)) index[k] = { r: p.r, n: p.n };
  else if (doc) {
    const idx = cleanLifeIndex(JSON.parse(await openIndex(await lifeKeys(c, false), uid, doc)));
    if (idx.schema > LIFE_SCHEMA) {
      hooks?.checkForUpdate();
      throw fail('newer', 'A newer version of Arise synced the life log.');
    }
    index = idx.packs;
  }
  if (!live()) return false;
  const base = doc?.iv ?? '';

  // ---- take in what changed elsewhere: the memory first, as its wipes apply to every month
  const changed = [...new Set([...Object.keys(index), ...Object.keys(st.packs)])]
    .filter((k) => index[k]?.r !== st!.packs[k]?.r)
    .sort((a, b) => (a === MEM ? -1 : b === MEM ? 1 : a < b ? -1 : 1));
  for (const key of changed) {
    const info = index[key];
    let remote = emptyContent();
    if (info) {
      const got = await fetchPack(c, await lifeKeys(c, false), key, info);
      if (!got) {
        // Being saved by another device right now (start again), or broken.
        const nowSnap = await c.fb.getDoc(c.ref('index'));
        if ((nowSnap.exists() ? docOf(nowSnap.data())?.iv : '') !== base) return true;
        throw new PackError('bad-data', "Part of your life log in the cloud couldn't be opened.");
      }
      remote = got;
    }
    if (!live()) return false;
    const known = st.packs[key];
    // This device's copy was the cloud's at `known.at`. Longer ago than deletions are kept: what
    // it had then and the cloud no longer has was deleted since.
    const staleBefore = known && known.at && now - known.at > TOMB_KEEP ? known.at : 0;
    const res = await LOCAL.applyPack(key, remote, { now, staleBefore });
    if (key === MEM && res.newWipes.length) await LOCAL.applyWipes(res.newWipes);
    // (When this device had more, its copy is the cloud's only once that has gone up.)
    if (info) st.packs[key] = { r: info.r, n: info.n, h: await digest(canonical(key, remote)), at: res.ahead ? known?.at || 0 : now };
    else delete st.packs[key];
    await LOCAL.writeState(st);
  }
  st.idx = base;
  await LOCAL.writeState(st);

  // ---- send what changed here
  const marks = await LOCAL.dirtyMarks();
  const settled: string[] = [];
  const todo: Pick<Write, 'key' | 'empty' | 'text' | 'h'>[] = [];
  for (const key of new Set([MEM, ...marks.keys()])) {
    const content = await LOCAL.buildPack(key, now);
    const known = st.packs[key];
    if (isEmpty(content)) {
      if (known) todo.push({ key, empty: true, text: '', h: '' });
      else settled.push(key);
      continue;
    }
    const text = canonical(key, content);
    const h = await digest(text);
    if (known?.h === h) settled.push(key);
    else todo.push({ key, empty: false, text, h });
  }
  if (!live()) return false;
  await LOCAL.settle(marks, settled);
  if (!todo.length) return false;

  const keys = await lifeKeys(c, true);
  const writes: Write[] = [];
  let tooBig = false;
  for (const w of todo) {
    let sealed = { iv: '', parts: [] as string[] };
    const rev = newRev();
    if (!w.empty) {
      try {
        sealed = await sealPack(keys, uid, w.key, rev, w.text);
      } catch (err) {
        if ((err as PackError)?.code !== 'too-big') throw err;
        tooBig = true; // it stays here, and the rest goes on
        continue;
      }
    }
    const n = Math.max(sealed.parts.length, index[w.key]?.n || 0);
    const ids = await Promise.all(Array.from({ length: n }, (_, i) => partId(keys, w.key, i)));
    writes.push({ ...w, rev, iv: sealed.iv, parts: sealed.parts, ids });
  }
  status.tooBig = tooBig;

  // In groups that fit one write each, every group with the index that lists it.
  const groups: Write[][] = [];
  let size = 0;
  let count = 0;
  for (const w of writes) {
    const chars = w.parts.reduce((s, p) => s + p.length, 0);
    if (!groups.length || size + chars > GROUP_CHARS || count + w.ids.length > GROUP_WRITES) {
      groups.push([]);
      size = 0;
      count = 1;
    }
    groups.at(-1)!.push(w);
    size += chars;
    count += w.ids.length;
  }

  let at = base;
  let cloud = { ...index };
  for (const group of groups) {
    if (!live()) return false;
    const next = { ...cloud };
    for (const w of group) {
      if (w.empty) delete next[w.key];
      else next[w.key] = { r: w.rev, n: w.parts.length };
    }
    const idx = await sealIndex(keys, uid, JSON.stringify({ v: 1, schema: LIFE_SCHEMA, packs: next }));
    const written = await c.fb.runTransaction(c.db, async (tx) => {
      const [cur, acct] = [await tx.get(c.ref('index')), await tx.get(c.account)];
      // The account was deleted on another device: nothing goes up (the main sync signs out).
      if (!acct.exists()) throw fail('gone', 'This account was deleted.');
      if ((cur.exists() ? docOf(cur.data())?.iv : '') !== at) return false;
      const t = Date.now();
      for (const w of group) {
        w.parts.forEach((ct, i) => tx.set(c.ref(w.ids[i]), { v: 1, iv: w.iv, ct, updated: t } satisfies Doc));
        for (let i = w.parts.length; i < (cloud[w.key]?.n || 0); i++) tx.delete(c.ref(w.ids[i]));
      }
      tx.set(c.ref('index'), { v: 1, iv: idx.iv, ct: idx.ct, updated: t } satisfies Doc);
      return true;
    });
    if (!written) return true; // another device saved first: take its packs in, then try again
    at = idx.iv;
    cloud = next;
    for (const w of group) {
      if (w.empty) delete st.packs[w.key];
      else st.packs[w.key] = { r: w.rev, n: w.parts.length, h: w.h, at: now };
    }
    st.idx = at;
    // (Only while this device's log is still this account's.)
    if ((await LOCAL.readState())?.uid !== uid) return false;
    await LOCAL.writeState(st);
    await LOCAL.settle(
      marks,
      group.map((w) => w.key),
    );
  }
  return false;
}

// ---------- accounts (sync.ts)

// Whether this device's life log has changes the account's cloud copy doesn't (or was never
// synced with it, and holds something of the Player's own).
export async function unsynced(uid: string): Promise<boolean> {
  try {
    if ((await LOCAL.dirtyMarks()).size) return true;
    return (await LOCAL.readState())?.uid !== uid && (await LOCAL.holdsOwn());
  } catch {
    return false;
  }
}

// Whether this device's life log holds anything of the Player's own, and whether all of it is in
// the cloud copy of the account `owner`.
export async function holds(owner: string): Promise<{ own: boolean; synced: boolean }> {
  try {
    const own = await LOCAL.holdsOwn();
    return { own, synced: !own || !(await unsynced(owner)) };
  } catch {
    return { own: false, synced: true };
  }
}

// Another person's data replaced this device's, or it was erased: the life log goes from this
// device (its account's cloud copy stays), and so does its "Stop learning".
export async function eraseHere(): Promise<void> {
  stop();
  takePaused(false, 0);
  await eraseAll().catch(() => {});
}

// The account `uid` is gone: what the sync knew of it goes (if this device's life log was that
// account's); the life log itself stays on this device.
export async function forgetAccount(uid: string): Promise<void> {
  stop();
  try {
    if ((await LOCAL.readState())?.uid === uid) await LOCAL.forget();
  } catch {}
}

// "Delete my account and cloud copy": every document of the life log goes. All of them, as the
// cloud lists them, so nothing is left even if the index can't be read. (Under the old database
// rules the cloud refuses the life log entirely, so then there's nothing to delete.)
export async function deleteCloud(uid: string): Promise<void> {
  stop();
  if (!hooks) return;
  const { fb, db } = hooks.firebase();
  let docs: { id: string }[];
  try {
    docs = (await fb.getDocs(fb.collection(db, 'users', uid, 'life'))).docs;
  } catch (err) {
    if (codeOf(err) === 'permission-denied') return;
    throw err;
  }
  for (let i = 0; i < docs.length; i += 400) {
    const batch = fb.writeBatch(db);
    for (const d of docs.slice(i, i + 400)) batch.delete(fb.doc(db, 'users', uid, 'life', d.id));
    await batch.commit();
  }
}
