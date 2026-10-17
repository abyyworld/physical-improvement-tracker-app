// Linked browsers: the Arise extension records the sites the Player visits, their searches and
// their time on each site, seals it for this Arise, and hands it over when Arise is open in the
// same browser. Here: linking a browser, opening what it sends, handing it to the life log, and
// unlinking. The screens are in browser-ui.js; the extension is in extension/.
//
// The key: Arise makes a key pair for each linked browser (ECDH P-256) and gives the extension
// only the public half, so the extension can seal but never open what it saved
// (extension/src/lib/seal.ts). The private half stays here: signed in, it's sealed with the
// account's data key (so it opens only while this device is signed in to that account, and could
// later go to the account's other devices, for a server inbox); signed out, it's kept on this
// device as a key that can be used but never read out.
//
// Delivery v1 is through the page: the extension's content script runs on Arise's own pages and
// passes messages (extension/src/content.ts). `ingest` doesn't care how batches arrive, so a
// server inbox for when no Arise tab is open can use it as it is.

import { fromB64, open as openSealed, seal as sealText, toB64, type Sealed } from '../lib/crypto';
import { type HelloReply, NS, type PageRequest, commitment, newLinkId, newNonce, pairCode, parsePull, type Note } from '../../extension/src/lib/pairing';
import { type SealedBatch, newKeyPair, openBatch } from '../../extension/src/lib/seal';
import { lifeStore, type LifeStore } from './store-port';
import type { LifeEvent } from './types';

const CURVE = { name: 'ECDH', namedCurve: 'P-256' } as const;
const DAY = 86_400_000;
// What came in lately, by id, so "forget the last hour" can find it. A forget note covers the hour
// before it was made, and every pull brings all the notes made by then, so after a pull only what
// happened in the last hour or so can still be asked for: 3 hours leaves room to spare.
const RECENT_FOR = 3 * 3_600_000;
const DELIVER_EVERY = 5 * 60_000;
// The extension waits 10 minutes for "They match" (extension/src/lib/recorder.ts), counted from a
// little after this page started: a minute more here, so both have given up by then.
const PAIRING_FOR = 11 * 60_000;

export interface LinkRecord {
  id: string;
  name: string; // "Chrome on macOS"
  state: 'pending' | 'linked';
  pub: string;
  createdAt: number;
  linkedAt?: number;
  lastDelivery?: number;
  received: number; // things added to the life log from it
  key: { local: CryptoKey } | { wrapped: Sealed & { uid: string } };
  recent?: [string, number][];
}

export class LinkError extends Error {
  constructor(
    readonly code: 'no-extension' | 'refused' | 'busy',
    message: string,
  ) {
    super(message);
  }
}

// ---------- talking to the extension (through its content script on this page)

export type Incoming = { t: string; link?: string };
export interface Transport {
  ask(msg: PageRequest, timeout?: number): Promise<unknown>;
  onPush(fn: (p: Incoming) => void): void;
}

export function windowTransport(win: Window = window): Transport {
  const waiting = new Map<string, (r: unknown) => void>();
  const pushes: ((p: Incoming) => void)[] = [];
  win.addEventListener('message', (e: MessageEvent) => {
    if (e.source !== win || e.origin !== win.location.origin) return;
    const d = e.data as { ns?: string; from?: string; re?: string; reply?: unknown; push?: Incoming };
    if (!d || d.ns !== NS || d.from !== 'ext') return;
    if (typeof d.re === 'string') waiting.get(d.re)?.(d.reply);
    else if (d.push && typeof d.push.t === 'string') for (const fn of pushes) fn(d.push);
  });
  let n = 0;
  return {
    ask(msg, timeout = 4000) {
      const id = `${Date.now().toString(36)}-${++n}`;
      return new Promise((resolve) => {
        const done = (r: unknown) => {
          clearTimeout(timer);
          waiting.delete(id);
          resolve(r);
        };
        const timer = setTimeout(() => done(null), timeout);
        waiting.set(id, done);
        win.postMessage({ ns: NS, from: 'page', id, msg }, win.location.origin);
      });
    },
    onPush: (fn) => void pushes.push(fn),
  };
}

// ---------- where the links are kept (this device only)

const DB = 'arise-browser-links';
const STORE = 'links';
const memory = new Map<string, LinkRecord>(); // without IndexedDB (tests, private browsing)

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDB();
  try {
    return await new Promise<T>((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } finally {
    db.close();
  }
}

const hasIDB = () => typeof indexedDB !== 'undefined';

async function readAll(): Promise<LinkRecord[]> {
  if (hasIDB()) {
    try {
      return ((await tx('readonly', (s) => s.getAll())) as LinkRecord[]).filter((r) => r && typeof r.id === 'string');
    } catch {}
  }
  return [...memory.values()];
}
async function put(r: LinkRecord) {
  memory.set(r.id, r);
  if (hasIDB()) await tx('readwrite', (s) => s.put(r, r.id)).catch(() => {});
}
async function drop(id: string) {
  memory.delete(id);
  if (hasIDB()) await tx('readwrite', (s) => s.delete(id)).catch(() => {});
}

// ---------- state, for the screens

let transport: Transport | null = null;
let hooks = {
  // The signed-in account's data key on this device, if any (see app.js).
  accountKey: async (): Promise<{ uid: string; key: CryptoKey } | null> => null,
  render: () => {},
  now: () => Date.now(),
};

export const status = {
  checked: false, // asked the extension at least once
  hello: null as HelloReply | null, // its answer (null: no extension here)
  pairing: null as { id: string; code: string[]; at: number } | null,
  busy: false,
  error: '',
  logReady: false, // the life log is there to take things
  links: [] as LinkRecord[],
  locked: [] as string[], // links whose key needs the account (signed out)
};

// Reads the links again, and redraws when anything shown changed.
let shown = '';
async function refresh() {
  const links = (await readAll()).sort((a, b) => b.createdAt - a.createdAt);
  const locked: string[] = [];
  for (const r of links) if ('wrapped' in r.key && !(await unlock(r))) locked.push(r.id);
  status.links = links;
  status.locked = locked;
  const now = JSON.stringify([
    links.map((r) => [r.id, r.state, r.name, r.lastDelivery, r.received]),
    locked,
    status.checked,
    status.hello?.linked ?? !!status.hello,
    status.pairing?.id,
    status.error,
    status.busy,
    status.logReady,
  ]);
  if (now !== shown) {
    shown = now;
    try {
      hooks.render();
    } catch {} // (a redraw that can't happen, say the page is gone, doesn't stop the refresh)
  }
}

// The screen is being drawn: whether the account's key is here may have changed (signed in or
// out), so that's checked again, at most once a second.
let lastCheck = 0;
export function recheck() {
  if (hooks.now() - lastCheck < 1000) return;
  lastCheck = hooks.now();
  void refresh();
}

// ---------- the private key

const keyLabel = (uid: string, id: string) => `arise/browser-key/v1/${uid}/${id}`;

async function protect(privateKey: CryptoKey, id: string, acct: { uid: string; key: CryptoKey } | null): Promise<LinkRecord['key']> {
  if (!acct) return { local: privateKey };
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', privateKey);
  return { wrapped: { uid: acct.uid, ...(await sealText(acct.key, toB64(pkcs8), keyLabel(acct.uid, id))) } };
}

async function unlock(r: LinkRecord): Promise<CryptoKey | null> {
  if ('local' in r.key) return r.key.local;
  const acct = await hooks.accountKey().catch(() => null);
  if (!acct || acct.uid !== r.key.wrapped.uid) return null;
  try {
    const pkcs8 = fromB64(await openSealed(acct.key, r.key.wrapped, keyLabel(acct.uid, r.id)));
    return await crypto.subtle.importKey('pkcs8', pkcs8, CURVE, false, ['deriveBits']);
  } catch {
    return null;
  }
}

// ---------- linking

const asHello = (r: unknown): HelloReply | null => {
  const h = r as HelloReply;
  return h && h.ok === true && typeof h.browser === 'string' ? { ...h, browser: h.browser.slice(0, 60), linked: typeof h.linked === 'string' ? h.linked : null } : null;
};

// Whether the extension is in this browser (and what it's linked to).
export async function detect(): Promise<HelloReply | null> {
  status.hello = transport ? asHello(await transport.ask({ t: 'hello' }, 1500)) : null;
  status.checked = true;
  return status.hello;
}

// Starts linking this browser. Returns the 4 words to compare with the extension's window.
export async function startLink(): Promise<string[]> {
  if (status.pairing) await cancelLink();
  const hello = await detect();
  if (!hello || !transport) throw new LinkError('no-extension', "The Arise extension isn't in this browser yet, or this page needs a reload after adding it.");
  const acct = await hooks.accountKey().catch(() => null);
  const { pub, privateKey } = await newKeyPair(!!acct);
  const id = newLinkId();
  const rec: LinkRecord = { id, name: hello.browser || 'This browser', state: 'pending', pub, createdAt: hooks.now(), received: 0, key: await protect(privateKey, id, acct) };
  await put(rec);
  const pageNonce = newNonce();
  const offer = (await transport.ask({ t: 'offer', link: id, pub, commit: await commitment(pageNonce) })) as { ok?: boolean; nonce?: string } | null;
  const revealed = offer?.ok && typeof offer.nonce === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(offer.nonce) ? ((await transport.ask({ t: 'reveal', link: id, nonce: pageNonce })) as { ok?: boolean } | null) : null;
  if (!revealed?.ok) {
    await drop(id);
    throw new LinkError('refused', "The extension didn't answer. Reload this page and try again.");
  }
  const code = await pairCode(id, pub, pageNonce, offer!.nonce!);
  status.pairing = { id, code, at: rec.createdAt };
  await refresh();
  watchPairing(id);
  return code;
}

// The extension may say "paired" while this page wasn't listening: it's asked too. Once the
// extension has stopped waiting for "They match", the words shown here go.
function watchPairing(id: string) {
  let asking = false;
  const t = setInterval(async () => {
    if (status.pairing?.id !== id || !transport) return clearInterval(t);
    if (asking) return;
    asking = true;
    try {
      const s = (await transport.ask({ t: 'status', link: id })) as { ok?: boolean; linked?: boolean } | null;
      if (s?.ok && s.linked) {
        clearInterval(t);
        await linked(id);
      } else if (status.pairing?.id === id && hooks.now() - status.pairing.at > PAIRING_FOR) {
        clearInterval(t);
        status.pairing = null;
        status.error = 'Linking ran out of time. Press "Link this browser" to try again.';
        await drop(id);
        await refresh();
      }
    } finally {
      asking = false;
    }
  }, 2000);
}

async function linked(id: string) {
  const r = (await readAll()).find((x) => x.id === id);
  if (status.pairing?.id === id) status.pairing = null;
  if (!r) return;
  if (r.state !== 'linked') await put({ ...r, state: 'linked', linkedAt: hooks.now() });
  // The extension seals for one link at a time: an older link in this browser can't bring
  // anything any more, so its key goes.
  const hello = await detect();
  if (hello?.linked === id) for (const old of await readAll()) if (old.id !== id) await drop(old.id);
  await refresh();
  void deliver();
}

export async function cancelLink() {
  const p = status.pairing;
  status.pairing = null;
  if (p) {
    await transport?.ask({ t: 'unlink', link: p.id });
    await drop(p.id);
  }
  await refresh();
}

// Unlinks a browser: its key is deleted here, so nothing it sealed can be opened any more, and
// the extension (if it's this browser's) stops recording and deletes what's waiting.
export async function unlink(id: string) {
  if (status.pairing?.id === id) status.pairing = null;
  await transport?.ask({ t: 'unlink', link: id });
  await drop(id);
  await detect();
  await refresh();
}

// "Erase all data": every linked browser goes.
export async function forgetAll() {
  for (const r of await readAll()) {
    await transport?.ask({ t: 'unlink', link: r.id }, 1500);
    await drop(r.id);
  }
  status.pairing = null;
  await refresh();
}

// ---------- what arrives

const KINDS = new Set(['visit', 'search', 'app']);
const str = (s: unknown, max: number) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const num = (n: unknown) => typeof n === 'number' && Number.isFinite(n);

function cleanUrl(u: unknown): string | undefined {
  if (typeof u !== 'string' || u.length > 2048) return undefined;
  try {
    const p = new URL(u);
    return p.protocol === 'https:' || p.protocol === 'http:' ? p.href : undefined;
  } catch {
    return undefined;
  }
}

// One event from a browser, checked field by field: the extension is the Player's own, but
// nothing that arrives is taken on trust. Searches and browsing are always tier 3.
export function cleanEvent(x: unknown, now = Date.now()): LifeEvent | null {
  const e = x as Record<string, unknown>;
  if (!e || typeof e !== 'object') return null;
  if (typeof e.id !== 'string' || !/^browser:[A-Za-z0-9_-]{8,64}$/.test(e.id)) return null;
  if (e.source !== 'browser' || !KINDS.has(e.kind as string)) return null;
  if (!num(e.at) || (e.at as number) < now - 400 * DAY || (e.at as number) > now + DAY) return null;
  const title = str(e.title, 300);
  if (!title) return null;
  const out: LifeEvent = { id: e.id, source: 'browser', kind: e.kind as LifeEvent['kind'], at: Math.round(e.at as number), title, tier: 3 };
  if (num(e.end) && (e.end as number) >= out.at && (e.end as number) <= out.at + DAY) out.end = Math.round(e.end as number);
  const detail = str(e.detail, 300);
  if (detail) out.detail = detail;
  const url = cleanUrl(e.url);
  if (url) out.url = url;
  if (num(e.value) && (e.value as number) >= 0 && (e.value as number) <= 1e6) out.value = e.value as number;
  const unit = str(e.unit, 12);
  if (unit && out.value !== undefined) out.unit = unit;
  if (e.meta && typeof e.meta === 'object' && !Array.isArray(e.meta)) {
    const meta: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(e.meta as Record<string, unknown>).slice(0, 16)) {
      if (!/^[A-Za-z][A-Za-z0-9]{0,23}$/.test(k)) continue;
      if (typeof v === 'string') meta[k] = v.slice(0, 300);
      else if (typeof v === 'boolean' || num(v)) meta[k] = v as number | boolean;
    }
    if (Object.keys(meta).length) out.meta = meta;
  }
  return out;
}

export function cleanEvents(payload: unknown, now = Date.now()): LifeEvent[] {
  const p = payload as { v?: number; events?: unknown[] };
  if (!p || p.v !== 1 || !Array.isArray(p.events)) return [];
  return p.events.map((e) => cleanEvent(e, now)).filter((e): e is LifeEvent => !!e);
}

// The life log may also take things back (for "forget the last hour"), if it offers that.
type Forgetful = LifeStore & { removeIds?: (ids: string[]) => Promise<number> };

export interface Ingested {
  added: number;
  acked: string[]; // batches that can go from the extension
  notes: string[];
}

// Opens batches sealed for `rec`, hands what's in them to the life log, and says which can be
// deleted from the extension. Doesn't care how they came (the page now, a server inbox later).
export async function ingest(rec: LinkRecord, key: CryptoKey, batches: SealedBatch[], notes: Note[], store: Forgetful): Promise<Ingested> {
  const now = hooks.now();
  const out: Ingested = { added: 0, acked: [], notes: [] };
  // Not cut down to the last few hours yet: a note below may have waited in the extension for a
  // day (no Arise open meanwhile), and what it names was kept for it.
  const recent = new Map(rec.recent || []);
  for (const b of batches) {
    if (b.link !== rec.id) {
      out.acked.push(b.id); // sealed for a key this Arise doesn't have: nobody can open it
      continue;
    }
    let events: LifeEvent[];
    try {
      events = cleanEvents(await openBatch(key, b), now);
    } catch {
      out.acked.push(b.id); // damaged: it would never open
      continue;
    }
    out.added += await store.addEvents(events); // if the life log fails, this batch stays in the extension
    for (const e of events) if (e.at > now - RECENT_FOR) recent.set(e.id, e.end ?? e.at);
    out.acked.push(b.id);
  }
  let keepFrom = now - RECENT_FOR;
  for (const n of notes) {
    if (n.t === 'forget') {
      const ids = [...recent].filter(([, t]) => t >= n.from && t <= n.to).map(([id]) => id);
      if (ids.length) {
        if (typeof store.removeIds !== 'function') {
          // This life log can't take things back: the note stays in the extension, and what it
          // names stays known here, until one that can.
          keepFrom = Math.min(keepFrom, n.from);
          continue;
        }
        await store.removeIds(ids);
        for (const id of ids) recent.delete(id);
      }
    }
    out.notes.push(n.id);
  }
  rec.recent = [...recent].filter(([, t]) => t >= keepFrom).slice(-5000);
  return out;
}

// ---------- delivery

let running: Promise<number> | null = null;
let again = false;

// Collects what this browser's extension has waiting. Returns how many new things the life log got.
// Asked again while it's collecting (more was sealed meanwhile), it goes round once more.
export function deliver(): Promise<number> {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    let added = 0;
    do {
      again = false;
      added += await withLock(run);
    } while (again);
    return added;
  })().finally(() => (running = null));
  return running;
}

// One Arise tab at a time collects (the others would only do the same work again).
async function withLock(fn: () => Promise<number>): Promise<number> {
  const locks = (globalThis.navigator as Navigator | undefined)?.locks;
  if (!locks?.request) return fn();
  return (await locks.request('arise-browser-delivery', { ifAvailable: true }, async (lock) => (lock ? fn() : 0))) as number;
}

async function run(): Promise<number> {
  if (!transport) return 0;
  const hello = await detect();
  const rec = hello?.linked ? (await readAll()).find((r) => r.id === hello.linked) : null;
  if (!rec) return 0;
  if (rec.state !== 'linked') await linked(rec.id);
  const key = await unlock(rec);
  if (!key) {
    await refresh(); // signed out: it waits in the extension until this device is signed in again
    return 0;
  }
  const store = (await lifeStore()) as Forgetful;
  let added = 0;
  for (let round = 0; round < 200; round++) {
    const pull = parsePull(await transport.ask({ t: 'pull', link: rec.id }, 20_000));
    if (!pull || (!pull.batches.length && !pull.notes.length)) break;
    let got: Ingested;
    try {
      got = await ingest(rec, key, pull.batches, pull.notes, store);
    } catch {
      break; // the life log couldn't take them: they stay in the extension for next time
    }
    added += got.added;
    const latest = (await readAll()).find((r) => r.id === rec.id);
    if (!latest) break; // unlinked meanwhile
    Object.assign(rec, { ...latest, recent: rec.recent, lastDelivery: hooks.now(), received: (latest.received || 0) + got.added });
    await put(rec);
    await transport.ask({ t: 'ack', link: rec.id, ids: got.acked, notes: got.notes }, 10_000);
    if (!pull.more) break;
  }
  await refresh();
  return added;
}

// ---------- start

export function initBrowserLink(h: Partial<typeof hooks> & { transport?: Transport } = {}) {
  const { transport: t, ...rest } = h;
  hooks = { ...hooks, ...rest };
  transport = t || windowTransport();
  transport.onPush(async (p) => {
    if (p.t === 'here') {
      await detect();
      await refresh();
      return;
    }
    if (!p.link) return;
    // Anything running on this page can post these messages, not only the extension: a key is
    // let go of only once the extension itself, asked again, says the same.
    if (p.t === 'paired') await linked(p.link);
    else if (p.t === 'declined' && status.pairing?.id === p.link) {
      const hello = await detect();
      if (!hello || hello.pairing || status.pairing?.id !== p.link) return;
      status.pairing = null;
      status.error = "The words didn't match, so this browser wasn't linked. Try again.";
      await drop(p.link);
      await refresh();
    } else if (p.t === 'unlinked') {
      const hello = await detect();
      if (hello && hello.linked !== p.link) await drop(p.link);
      await refresh();
    } else if (p.t === 'ready') void deliver();
  });
  void lifeStore().then(() => {
    status.logReady = true;
    void refresh();
  });
  return start();
}

async function start() {
  const hello = await detect();
  // Tidy up: a link the extension no longer has (unlinked there, or never finished) can't bring
  // anything, so its key goes.
  if (hello) {
    for (const r of await readAll()) {
      if (r.id === hello.linked) continue;
      if (r.state === 'linked' || hooks.now() - r.createdAt > 15 * 60_000) await drop(r.id);
    }
  }
  await refresh();
  if (hello?.linked) void deliver();
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && status.hello?.linked) void deliver();
    });
    setInterval(() => {
      if (status.hello?.linked && document.visibilityState === 'visible') void deliver();
    }, DELIVER_EVERY);
  }
}
