// The extension's whole job, without the browser: background.ts gives it the browser's storage,
// history and clock (an `Env`), and the tests give it pretend ones.
//
// What it keeps, and where:
//   extension storage (on disk): the link (Arise's public key, never a private one), settings,
//     sealed batches waiting for Arise, how far it has read the history, the times it must leave
//     out (paused, forgotten), and fingerprints of the visits of the last few days it already
//     read. Nothing readable about what was visited: that is only ever sealed.
//   session storage (memory only, gone when the browser closes): the time on each site in the
//     hour that isn't over yet, the site in front right now, a link being made.
//
// Delivery: sealed batches wait here until Arise asks for them (a tab with Arise open in this
// browser, through the content script), and are deleted once Arise says it has them. A server
// inbox for when no Arise tab is open can take the same batches later: `takeBatches` and
// `ackBatches` are all it needs.

import type { LifeEvent } from '../../../src/life/types';
import { randomId } from './bytes';
import { type Context, type Visit, recordable, searchKey, siteOf, siteTimeEvent, visitEvent, visitKey } from './events';
import { type Note, type PageRequest, type Push, commitment, newNonce, pairCode } from './pairing';
import { type BatchMeta, type SealedBatch, sealBatch } from './seal';
import { parseSkipList } from './skip';
import { type Focus, HOUR, MINUTE, type Rollup, dropFrom, hourStart, step, takeHours } from './time';

// ---------- the browser, as the recorder sees it

export interface KV {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

export interface HistoryItem {
  url?: string;
  title?: string;
}
export interface VisitItem {
  visitTime?: number;
  transition?: string;
  isLocal?: boolean;
}
export interface HistoryApi {
  search(q: { text: string; startTime: number; endTime: number; maxResults: number }): Promise<HistoryItem[]>;
  getVisits(d: { url: string }): Promise<VisitItem[]>;
}

export interface Env {
  now(): number;
  local: KV;
  session: KV;
  history: HistoryApi;
  browser: string; // "Chrome on macOS"
  version: string;
  arise: readonly string[]; // Arise's own addresses: never recorded
  allowed(origin: string): boolean; // the pages that may link and collect (Arise's)
  push(p: Push, origin: string): Promise<void>; // tells Arise's open tabs
  openConfirm(): Promise<void>; // shows the window with the 4 words
}

// ---------- what's kept

export interface Link {
  id: string;
  pub: string; // Arise's public key for this browser
  origin: string; // the Arise it was linked with
  at: number;
}
export interface Settings {
  paused: boolean;
  skip: string[];
}
interface Scan {
  cursor: number; // the history is read up to here
  deepAt: number; // the last look back over the last 2 days (for visits browser sync brought in late)
  back: { from: number; next: number } | null; // reading the 90 days before linking, newest first
}
export interface Pairing {
  link: string;
  pub: string;
  commit: string;
  nonce: string; // the extension's
  origin: string;
  at: number;
  code?: string[];
}
type Gap = [number, number]; // [from, to); to = 0 while still paused
interface Indexed extends BatchMeta {
  size: number;
}

const L = { link: 'link', settings: 'settings', scan: 'scan', seen: 'seen', gaps: 'gaps', index: 'index', notes: 'notes', parts: 'parts', install: 'install', sent: 'sent' };
const S = { focus: 'focus', open: 'open', pairing: 'pairing' };
const batchKey = (id: string) => `b:${id}`;

export const DAY = 24 * HOUR;
export const BACKFILL_DAYS = 90;
const OVERLAP = 2 * MINUTE; // each look starts a little before the last one ended
const DEEP_EVERY = HOUR;
const DEEP_SPAN = 2 * DAY;
const SEEN_FOR = 3 * DAY;
const SEARCH_AGAIN = 30 * MINUTE; // the same search again within this is the same search
const PAIRING_FOR = 10 * MINUTE;
const BATCH_MAX = 2000; // things per sealed batch
const PULL_MAX_BATCHES = 25;
const PULL_MAX_BYTES = 4_000_000;
const MAX_VISITS_PER_LOOK = 100_000;

export const DEFAULT_SETTINGS: Settings = { paused: false, skip: [] };

// One change at a time: browser events can arrive together.
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

async function getOne<T>(kv: KV, key: string): Promise<T | undefined> {
  return (await kv.get([key]))[key] as T | undefined;
}

export async function getLink(env: Env): Promise<Link | null> {
  return (await getOne<Link>(env.local, L.link)) || null;
}
export async function getSettings(env: Env): Promise<Settings> {
  const s = await getOne<Settings>(env.local, L.settings);
  return { ...DEFAULT_SETTINGS, ...(s || {}) };
}
async function getIndex(env: Env): Promise<Indexed[]> {
  return (await getOne<Indexed[]>(env.local, L.index)) || [];
}
async function getGaps(env: Env): Promise<Gap[]> {
  return (await getOne<Gap[]>(env.local, L.gaps)) || [];
}
async function install(env: Env): Promise<string> {
  let id = await getOne<string>(env.local, L.install);
  if (!id) await env.local.set({ [L.install]: (id = randomId(12)) });
  return id;
}
const context = (env: Env, s: Settings): Context => ({ own: s.skip, arise: env.arise, browser: env.browser });
const inGap = (t: number, gaps: Gap[]) => gaps.some(([a, b]) => t >= a && (b === 0 || t < b));

// ---------- sealing and the waiting batches

// 10-minute groups for the last few hours (so "forget the last hour" drops little else), whole
// days before that.
function groupOf(t: number, now: number): number {
  if (now - t < 3 * HOUR) return Math.floor(t / (10 * MINUTE)) * 10 * MINUTE;
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

async function seal(env: Env, link: Link, events: LifeEvent[]): Promise<number> {
  if (!events.length) return 0;
  const now = env.now();
  const groups = new Map<number, LifeEvent[]>();
  for (const e of events) {
    const g = groupOf(e.end ?? e.at, now);
    groups.set(g, [...(groups.get(g) || []), e]);
  }
  const index = await getIndex(env);
  const add: Record<string, unknown> = {};
  for (const list of groups.values()) {
    list.sort((a, b) => a.at - b.at);
    for (let i = 0; i < list.length; i += BATCH_MAX) {
      const part = list.slice(i, i + BATCH_MAX);
      const meta: BatchMeta = { id: randomId(16), from: Math.min(...part.map((e) => e.at)), to: Math.max(...part.map((e) => e.end ?? e.at)), n: part.length };
      const sealed = await sealBatch(link.pub, link.id, meta, { v: 1, events: part });
      add[batchKey(meta.id)] = sealed;
      index.push({ ...meta, size: sealed.ct.length });
    }
  }
  await env.local.set({ ...add, [L.index]: index });
  await env.push({ t: 'ready', link: link.id }, link.origin).catch(() => {});
  return events.length;
}

// The batches waiting, oldest first, as many as fit in one message.
export async function takeBatches(env: Env): Promise<{ batches: SealedBatch[]; more: boolean }> {
  const index = await getIndex(env);
  const pick: Indexed[] = [];
  let bytes = 0;
  for (const m of index) {
    if (pick.length && (pick.length >= PULL_MAX_BATCHES || bytes + m.size > PULL_MAX_BYTES)) break;
    pick.push(m);
    bytes += m.size;
  }
  const got = await env.local.get(pick.map((m) => batchKey(m.id)));
  const batches = pick.map((m) => got[batchKey(m.id)] as SealedBatch).filter(Boolean);
  return { batches, more: pick.length < index.length };
}

// Arise has these: they go.
export async function ackBatches(env: Env, ids: string[], noteIds: string[] = []): Promise<number> {
  const index = await getIndex(env);
  const gone = new Set(ids);
  const delivered = index.filter((m) => gone.has(m.id));
  const left = index.filter((m) => !gone.has(m.id));
  await env.local.remove(delivered.map((m) => batchKey(m.id)));
  const notes = ((await getOne<Note[]>(env.local, L.notes)) || []).filter((n) => !noteIds.includes(n.id));
  const sent = (await getOne<{ at: number; n: number }>(env.local, L.sent)) || { at: 0, n: 0 };
  await env.local.set({
    [L.index]: left,
    [L.notes]: notes,
    ...(delivered.length ? { [L.sent]: { at: env.now(), n: sent.n + delivered.reduce((a, m) => a + m.n, 0) } } : {}),
  });
  return left.length;
}

// ---------- reading the history

// Every visit in [from, to) not read yet and not in a paused or forgotten time, as events.
async function readHistory(env: Env, from: number, to: number, ctx: Context, seen: Record<string, number>, gaps: Gap[]): Promise<LifeEvent[]> {
  if (!(to > from)) return [];
  const items = await env.history.search({ text: '', startTime: from, endTime: to, maxResults: MAX_VISITS_PER_LOOK });
  const found: LifeEvent[] = [];
  for (const item of items) {
    if (!item.url || !recordable(item.url, ctx)) continue;
    let visits: VisitItem[] = [];
    try {
      visits = await env.history.getVisits({ url: item.url });
    } catch {
      continue;
    }
    for (const v of visits) {
      const t = v.visitTime;
      if (typeof t !== 'number' || t < from || t >= to || inGap(t, gaps)) continue;
      const visit: Visit = { url: item.url, title: item.title, time: t, transition: v.transition, isLocal: v.isLocal };
      const key = await visitKey(visit);
      if (seen[key]) continue;
      seen[key] = t;
      const e = await visitEvent(visit, ctx);
      if (e) found.push(e);
    }
  }
  found.sort((a, b) => a.at - b.at);
  // The same search again soon after (back to the results, their next page) isn't a new one.
  const out: LifeEvent[] = [];
  for (const e of found) {
    if (e.kind === 'search') {
      const k = `q:${await searchKey(String(e.meta?.engine), String(e.meta?.query))}`;
      const last = seen[k];
      if (last && Math.abs(e.at - last) < SEARCH_AGAIN) continue;
      seen[k] = e.at;
    }
    out.push(e);
  }
  return out;
}

const pruneSeen = (seen: Record<string, number>, now: number) => Object.fromEntries(Object.entries(seen).filter(([, t]) => t > now - SEEN_FOR));

// Reads what's new in the history (and, every hour, the last 2 days again, for visits browser
// sync brought in late).
async function scanNew(env: Env, link: Link, settings: Settings, deep: boolean): Promise<number> {
  const now = env.now();
  const ctx = context(env, settings);
  const got = await env.local.get([L.scan, L.seen, L.gaps]);
  const sc: Scan = (got[L.scan] as Scan) || { cursor: now, deepAt: now, back: null };
  const seen = (got[L.seen] as Record<string, number>) || {};
  const gaps = (got[L.gaps] as Gap[]) || [];
  let added = await seal(env, link, await readHistory(env, sc.cursor - OVERLAP, now, ctx, seen, gaps));
  sc.cursor = now;
  if (deep || now - sc.deepAt >= DEEP_EVERY) {
    added += await seal(env, link, await readHistory(env, now - DEEP_SPAN, now, ctx, seen, gaps));
    sc.deepAt = now;
  }
  await env.local.set({ [L.scan]: sc, [L.seen]: pruneSeen(seen, now) });
  return added;
}

// One more day of the 90 days before linking, newest first. -1 when there's none to read.
async function backfillDay(env: Env): Promise<number> {
  const link = await getLink(env);
  const settings = await getSettings(env);
  const got = await env.local.get([L.scan, L.seen, L.gaps]);
  const sc = got[L.scan] as Scan | undefined;
  if (!link || settings.paused || !sc?.back || !(sc.back.next > sc.back.from)) return -1;
  const now = env.now();
  const seen = (got[L.seen] as Record<string, number>) || {};
  const from = Math.max(sc.back.from, sc.back.next - DAY);
  const added = await seal(env, link, await readHistory(env, from, sc.back.next, context(env, settings), seen, (got[L.gaps] as Gap[]) || []));
  sc.back = from > sc.back.from ? { from: sc.back.from, next: from } : null;
  await env.local.set({ [L.scan]: sc, [L.seen]: pruneSeen(seen, now) });
  return added;
}

// ---------- time on site

async function sealHours(env: Env, link: Link, open: Rollup, all: boolean): Promise<Rollup> {
  const now = env.now();
  const { done, open: left } = takeHours(open, now, { all });
  if (!done.length) return left;
  const parts = (await getOne<Record<string, number>>(env.local, L.parts)) || {};
  const id = await install(env);
  const events = await Promise.all(done.map((h) => siteTimeEvent(h, id, parts[h.hour] || 0, env.browser)));
  await seal(env, link, events);
  if (all) {
    // The rest of this hour, if the browser opens again before it's over, is another part of it.
    const h = hourStart(now);
    parts[h] = (parts[h] || 0) + 1;
  }
  const keep = Object.fromEntries(Object.entries(parts).filter(([h]) => Number(h) > now - 2 * DAY));
  await env.local.set({ [L.parts]: keep });
  return left;
}

// The page in front changed (or nothing is in front: `url` null). Counts the time on the one before.
export function observe(env: Env, url: string | null): Promise<void> {
  return serial(async () => {
    const link = await getLink(env);
    const settings = await getSettings(env);
    const got = await env.session.get([S.open, S.focus]);
    const site = link && !settings.paused && url ? siteOf(url, context(env, settings)) : null;
    const { rollup, focus } = step((got[S.open] as Rollup) || {}, (got[S.focus] as Focus) || null, site, env.now());
    await env.session.set({ [S.open]: link ? rollup : {}, [S.focus]: focus });
  });
}

// Every minute (an alarm), and soon after a visit: the time in hours that are over, and what's new
// in the history, are sealed. Then, while there's time (`budget`), days of the 90 before linking:
// one at a time, so Arise's page isn't kept waiting meanwhile.
export async function tick(env: Env, url: string | null, { deep = false, budget = 20_000 } = {}): Promise<number> {
  let added = await serial(async () => {
    const link = await getLink(env);
    const settings = await getSettings(env);
    const got = await env.session.get([S.open, S.focus]);
    const site = link && !settings.paused && url ? siteOf(url, context(env, settings)) : null;
    const st = step((got[S.open] as Rollup) || {}, (got[S.focus] as Focus) || null, site, env.now());
    if (!link) {
      await env.session.set({ [S.open]: {}, [S.focus]: null });
      return 0;
    }
    const open = await sealHours(env, link, st.rollup, false);
    await env.session.set({ [S.open]: open, [S.focus]: st.focus });
    if (settings.paused) return 0;
    return scanNew(env, link, settings, deep);
  });
  const started = Date.now();
  while (Date.now() - started < budget) {
    const n = await serial(() => backfillDay(env));
    if (n < 0) break;
    added += n;
  }
  return added;
}

// The last window closed: the hour so far is sealed now, since memory goes with the browser.
export function flush(env: Env): Promise<void> {
  return serial(async () => {
    const link = await getLink(env);
    const got = await env.session.get([S.open, S.focus]);
    const st = step((got[S.open] as Rollup) || {}, (got[S.focus] as Focus) || null, null, env.now());
    const open = link ? await sealHours(env, link, st.rollup, true) : {};
    await env.session.set({ [S.open]: open, [S.focus]: null });
  });
}

// ---------- the person's controls (the extension's menu)

// The extension's own pages (its menu, the window with the 4 words) talk to the background with this.
export const POPUP_NS = 'arise-popup';

export type PopupRequest =
  | { t: 'state' }
  | { t: 'confirm'; link: string }
  | { t: 'decline'; link: string }
  | { t: 'pause' }
  | { t: 'resume' }
  | { t: 'forget' }
  | { t: 'skip'; text: string }
  | { t: 'unlink' };

export interface PopupState {
  linked: boolean;
  linkedAt: number;
  arise: string; // where it's linked to
  browser: string;
  version: string;
  paused: boolean;
  skip: string[];
  waiting: number; // things sealed and waiting for Arise
  sent: { at: number; n: number };
  backfilling: boolean;
  pairing: { link: string; code: string[] } | null;
}

async function pairingNow(env: Env): Promise<Pairing | null> {
  const p = await getOne<Pairing>(env.session, S.pairing);
  return p && env.now() - p.at < PAIRING_FOR ? p : null;
}

// Only reads: it doesn't wait for anything else to finish.
export async function popupState(env: Env): Promise<PopupState> {
  const link = await getLink(env);
  const settings = await getSettings(env);
  const index = await getIndex(env);
  const got = await env.local.get([L.sent, L.scan]);
  const p = await pairingNow(env);
  return {
    linked: !!link,
    linkedAt: link?.at || 0,
    arise: link?.origin || '',
    browser: env.browser,
    version: env.version,
    paused: settings.paused,
    skip: settings.skip,
    waiting: index.reduce((a, m) => a + m.n, 0),
    sent: (got[L.sent] as { at: number; n: number }) || { at: 0, n: 0 },
    backfilling: !!(got[L.scan] as Scan | undefined)?.back,
    pairing: p?.code ? { link: p.link, code: p.code } : null,
  };
}

async function unlinkNow(env: Env): Promise<void> {
  const link = await getLink(env);
  const index = await getIndex(env);
  await env.local.remove([L.link, L.index, L.notes, L.scan, L.seen, L.parts, L.sent, ...index.map((m) => batchKey(m.id))]);
  await env.session.set({ [S.open]: {}, [S.focus]: null });
  if (link) await env.push({ t: 'unlinked', link: link.id }, link.origin).catch(() => {});
}

export function popupRequest(env: Env, req: PopupRequest): Promise<PopupState | { ok: false; error: string }> {
  if (req.t === 'state') return popupState(env);
  return serial(async () => {
    const now = env.now();
    switch (req.t) {
      case 'confirm': {
        const p = await pairingNow(env);
        if (!p?.code || p.link !== req.link) return { ok: false, error: 'That link request has expired. Start again in Arise.' };
        await unlinkNow(env); // one Arise at a time: anything sealed for an earlier link goes
        const link: Link = { id: p.link, pub: p.pub, origin: p.origin, at: now };
        const scanState: Scan = { cursor: now, deepAt: now, back: { from: now - BACKFILL_DAYS * DAY, next: now } };
        await env.local.set({ [L.link]: link, [L.scan]: scanState, [L.seen]: {} });
        await env.session.remove([S.pairing]);
        await env.push({ t: 'paired', link: link.id }, link.origin).catch(() => {});
        break;
      }
      case 'decline': {
        const p = await getOne<Pairing>(env.session, S.pairing);
        await env.session.remove([S.pairing]);
        if (p && p.link === req.link) await env.push({ t: 'declined', link: p.link }, p.origin).catch(() => {});
        break;
      }
      case 'pause':
      case 'resume': {
        const settings = await getSettings(env);
        const gaps = await getGaps(env);
        if (req.t === 'pause' && !settings.paused) gaps.push([now, 0]);
        if (req.t === 'resume') for (const g of gaps) if (g[1] === 0) g[1] = now;
        await env.local.set({ [L.settings]: { ...settings, paused: req.t === 'pause' }, [L.gaps]: gaps });
        // The site in front stops counting from now.
        const got = await env.session.get([S.open, S.focus]);
        const st = step((got[S.open] as Rollup) || {}, (got[S.focus] as Focus) || null, null, now);
        await env.session.set({ [S.open]: st.rollup, [S.focus]: null });
        break;
      }
      case 'forget':
        await forgetLastHour(env);
        break;
      case 'skip': {
        const settings = await getSettings(env);
        await env.local.set({ [L.settings]: { ...settings, skip: parseSkipList(req.text) } });
        break;
      }
      case 'unlink':
        await unlinkNow(env);
        break;
    }
    return popupState(env);
  });
}

// Nothing from the last hour goes to Arise: what's sealed and waiting goes, the hour's time on
// sites goes, that hour is never read from the history again, and Arise is asked to delete what
// it already got from then.
async function forgetLastHour(env: Env): Promise<void> {
  const now = env.now();
  const cutoff = now - HOUR;
  const index = await getIndex(env);
  const drop = index.filter((m) => m.to >= cutoff);
  const got = await env.local.get([L.gaps, L.scan, L.seen, L.notes]);
  const gaps = [...((got[L.gaps] as Gap[]) || []), [cutoff, now] as Gap];
  const notes = (got[L.notes] as Note[]) || [];
  const link = await getLink(env);
  if (link) notes.push({ id: randomId(16), t: 'forget', from: cutoff, to: now });
  const patch: Record<string, unknown> = { [L.gaps]: gaps.filter(([, b]) => b === 0 || b > now - (BACKFILL_DAYS + 1) * DAY), [L.notes]: notes, [L.index]: index.filter((m) => m.to < cutoff) };
  // Batches dropped for holding something from the last hour may hold older things too: those
  // are read again from the history.
  const rewind = Math.min(cutoff, ...drop.map((m) => m.from));
  const sc = got[L.scan] as Scan | undefined;
  if (sc && rewind < cutoff) {
    patch[L.scan] = { ...sc, cursor: Math.min(sc.cursor, rewind) };
    patch[L.seen] = Object.fromEntries(Object.entries((got[L.seen] as Record<string, number>) || {}).filter(([, t]) => t < rewind));
  }
  await env.local.remove(drop.map((m) => batchKey(m.id)));
  await env.local.set(patch);
  const s = await env.session.get([S.open, S.focus]);
  const focus = s[S.focus] as Focus | null;
  await env.session.set({ [S.open]: dropFrom((s[S.open] as Rollup) || {}, cutoff), [S.focus]: focus ? { site: focus.site, since: now } : null });
}

// ---------- Arise's page (through the content script)

export async function pageRequest(env: Env, req: PageRequest, origin: string): Promise<unknown> {
  if (!env.allowed(origin)) return { ok: false, error: 'not-arise' };
  // Questions that only read are answered straight away, even while the history is being read.
  if (req.t === 'hello' || req.t === 'status') return answer(env, req, origin);
  return serial(() => answer(env, req, origin));
}

async function answer(env: Env, req: PageRequest, origin: string): Promise<unknown> {
  const now = env.now();
  const link = await getLink(env);
  const mine = !!link && link.origin === origin && 'link' in req && link.id === req.link;
  switch (req.t) {
    case 'hello':
      return { ok: true, version: env.version, browser: env.browser, linked: link && link.origin === origin ? link.id : null, pairing: !!(await pairingNow(env)) };
    case 'offer': {
      const p: Pairing = { link: req.link, pub: req.pub, commit: req.commit, nonce: newNonce(), origin, at: now };
      await env.session.set({ [S.pairing]: p });
      return { ok: true, nonce: p.nonce };
    }
    case 'reveal': {
      const p = await pairingNow(env);
      if (!p || p.link !== req.link || p.origin !== origin || p.code) return { ok: false, error: 'no-offer' };
      if ((await commitment(req.nonce)) !== p.commit) {
        await env.session.remove([S.pairing]);
        return { ok: false, error: 'bad-nonce' };
      }
      p.code = await pairCode(p.link, p.pub, req.nonce, p.nonce);
      await env.session.set({ [S.pairing]: p });
      await env.openConfirm().catch(() => {});
      return { ok: true };
    }
    case 'status': {
      const settings = await getSettings(env);
      return { ok: true, linked: mine, waiting: mine ? (await getIndex(env)).length : 0, paused: settings.paused };
    }
    case 'pull': {
      if (!mine) return { ok: false, error: 'not-linked' };
      const { batches, more } = await takeBatches(env);
      const notes = (await getOne<Note[]>(env.local, L.notes)) || [];
      return { ok: true, batches, notes, more };
    }
    case 'ack':
      if (!mine) return { ok: false, error: 'not-linked' };
      return { ok: true, left: await ackBatches(env, req.ids, req.notes) };
    case 'unlink': {
      // Also a link that's still being made (cancelled in Arise).
      const p = await getOne<Pairing>(env.session, S.pairing);
      if (p && p.link === req.link && p.origin === origin) await env.session.remove([S.pairing]);
      if (mine) await unlinkNow(env);
      return { ok: true };
    }
  }
}
