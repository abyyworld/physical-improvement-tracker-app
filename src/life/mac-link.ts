// Arise and the Mac helper (mac-helper/ in this repo). The helper runs on the Player's Mac, reads
// what macOS and its apps keep there (calls synced from the iPhone, notifications, Messages, Mail,
// Calendar, Safari's and the other browsers' history, which app is in front) and serves it on
// 127.0.0.1 only, to this website only, with a pairing code. While Arise is open on that Mac, it
// pulls what's new, adds it to the life log through lifeStore(), and tells the helper it has it,
// so the helper can let it go. Nothing reaches any server on the way: the life log syncs only
// end-to-end encrypted.
//
// The link (the pairing code and what was last seen) belongs to this browser on this Mac: it's in
// localStorage, never synced and never in backups.
//
// Browsers: Chrome and Edge let an https page reach http://127.0.0.1 (it's this computer). Since
// Chrome 142 they first ask the Player once ("apps on this device"). Safari treats it as insecure
// content and blocks it (WebKit bug 171934), so on Safari the panel says to use Chrome or Edge.

import { lifeStore, type LifeStore } from './store-port';
import type { LifeEvent, LifeKind, LifeTier } from './types';

export const PORT = 47613; // the same as mac-helper/src/config.mjs
export const HELPER = `http://127.0.0.1:${PORT}`;
export const SOURCES = ['calls', 'notifications', 'messages', 'safari', 'apps', 'browsers', 'mail', 'calendar'] as const;
export const SWITCHES = [...SOURCES, 'text'] as const;
export type Source = (typeof SOURCES)[number];
export type Switch = (typeof SWITCHES)[number];

// The one command that installs the helper (or updates it), in Terminal on the Mac.
export const INSTALL_COMMAND =
  'cd "$(mktemp -d)" && curl -fsSL https://github.com/abyyworld/physical-improvement-tracker-app/archive/refs/heads/main.tar.gz | tar xz && bash physical-improvement-tracker-app-main/mac-helper/install.sh';
export const UNINSTALL_COMMAND = 'bash ~/.arise-helper/arise-helper.sh uninstall';
// The program that gets Full Disk Access: the helper's one signed program.
export const HELPER_PATH_HINT = '~/.arise-helper/bin/arise-helper';

// The helper from before it was one signed program: Full Disk Access went to its own Node.js, which
// any program of the user could use. The install command replaces it.
export const isOlderHelper = (st: HelperStatus | null | undefined) => !!st && /\/node\/bin\/node$/.test(st.node);

// The helper build the install command puts in (mac-helper/install.sh).
export const HELPER_BUILD = __APP_HELPER_BUILD__;
// A helper build older than that one (helpers say 'b5' for build 5). The helper can't update
// itself: macOS would take its Full Disk Access away each time, so the install command does it,
// and shows how to give it back.
export function isOutdatedHelper(st: HelperStatus | null | undefined, latest = HELPER_BUILD) {
  const m = st && /^b?(\d+)$/.exec(st.build);
  return !!m && Number(m[1]) < latest;
}

// What each source sends, and how its ids start (mac-helper/src/sources.mjs, PREFIX): two share a
// kind (Safari and the other browsers both send visits, Messages and Mail both messages), so the
// id says which one it came from.
const KIND: Record<Source, readonly LifeKind[]> = {
  calls: ['call'],
  notifications: ['notification'],
  messages: ['message'],
  safari: ['visit'],
  apps: ['app'],
  browsers: ['visit', 'search'],
  mail: ['message'],
  calendar: ['event'],
};
const PREFIX: Record<Source, string> = {
  calls: 'mac:call:',
  notifications: 'mac:note:',
  messages: 'mac:msg:',
  safari: 'mac:safari:',
  apps: 'mac:app:',
  browsers: 'mac:web:',
  mail: 'mac:mail:',
  calendar: 'mac:cal:',
};
// How personal each kind is (src/life/types.ts): app use and the calendar are everyday, the rest
// is sensitive.
const TIER: Partial<Record<LifeKind, LifeTier>> = { call: 3, message: 3, notification: 3, visit: 3, search: 3, app: 2, event: 2 };
// Calendar events come up to two weeks ahead (the helper's calendar.mjs, AHEAD); the rest has happened.
const AHEAD = 15 * 86_400_000;
const KEY = 'arise-mac';
const PAGES = 20;
const EVERY = 2 * 60_000;

export interface SourceStatus {
  state: 'off' | 'waiting' | 'ok' | 'no-access' | 'missing' | 'error';
  found: number;
  last: number | null;
  waiting: number;
}

export interface HelperStatus {
  version: number;
  build: string; // which build ('b5'); '' from the older helper
  node: string; // the program that needs Full Disk Access (its own Node.js, in the older helper)
  fullDiskAccess: boolean | null;
  // Full Disk Access is still on for the older helper's Node.js (null: the helper can't tell).
  olderNodeAccess?: boolean | null;
  settings: Record<Switch, boolean>;
  sources: Record<Source, SourceStatus>;
  // The sources this helper knows: an older one doesn't know the newest (its switch does nothing).
  known: Source[];
  waiting: number;
}

interface Link {
  code: string;
  linkedAt: number;
  lastPull?: number;
  lastNew?: number;
  totals?: Partial<Record<Source, number>>;
  status?: HelperStatus;
  error?: Problem | '';
}

export type Problem = 'unreachable' | 'code' | 'busy' | 'failed' | 'not-ready';

export class HelperError extends Error {
  constructor(readonly problem: Problem) {
    super(problem);
  }
}

// ---------- this browser's link

function read(): Link | null {
  try {
    const l = JSON.parse(localStorage.getItem(KEY) || 'null');
    return l && typeof l.code === 'string' && /^[0-9A-Z]{20}$/.test(l.code) ? l : null;
  } catch {
    return null;
  }
}

function write(l: Link | null) {
  try {
    if (l) localStorage.setItem(KEY, JSON.stringify(l));
    else localStorage.removeItem(KEY);
  } catch {}
}

export const linked = () => !!read();
export const lastStatus = () => read()?.status || null;
export const lastPull = () => read()?.lastPull || 0;
export const lastNew = () => read()?.lastNew || 0;
export const totals = (): Partial<Record<Source, number>> => read()?.totals || {};
export const lastProblem = (): Problem | '' => read()?.error || '';

// As typed: any case, with or without dashes or spaces, O for 0 and I or L for 1 (the helper's
// codes never have I, L, O or U).
export const normalizeCode = (s: string) =>
  String(s ?? '')
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');

// ---------- where this can work

interface Nav {
  userAgent: string;
  maxTouchPoints?: number;
}

// A Mac with a desktop browser (an iPad says "Macintosh" too, but has a touch screen).
export function isMac(nav: Nav = navigator): boolean {
  return /Macintosh|Mac OS X/.test(nav.userAgent) && !(Number(nav.maxTouchPoints) > 1) && !/iPhone|iPad|iPod/.test(nav.userAgent);
}

export function browser(nav: Nav = navigator): 'safari' | 'chromium' | 'firefox' | 'other' {
  const ua = nav.userAgent;
  if (/Chrome\/|Chromium\/|Edg\//.test(ua)) return 'chromium';
  if (/Firefox\//.test(ua)) return 'firefox';
  if (/Safari\//.test(ua)) return 'safari';
  return 'other';
}

// ---------- talking to the helper

type Fetch = typeof fetch;
let fetcher: Fetch = (...a) => fetch(...a);
let base = HELPER;
// For tests: a fake helper, or the real one on another port.
export function useHelper(f: Fetch | null, url = HELPER) {
  fetcher = f || ((...a) => fetch(...a));
  base = url;
}

const enc = new TextEncoder();
const hex = (b: ArrayBuffer | Uint8Array) => Array.from(new Uint8Array(b as ArrayBuffer), (x) => x.toString(16).padStart(2, '0')).join('');
const sha256 = async (s: string) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
async function hmac(code: string, lines: string[]) {
  const key = await crypto.subtle.importKey('raw', enc.encode(code), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(lines.join('\n'))));
}

async function send(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetcher(`${base}${path}`, { ...init, cache: 'no-store', credentials: 'omit' });
  } catch {
    throw new HelperError('unreachable');
  }
}

// Each request proves Arise knows the pairing code without sending it, and each answer has to
// prove it came from the helper with that code (mac-helper/src/auth.mjs has the details). So
// whatever else may be listening on that port while the helper isn't learns nothing it can use,
// and can't hand Arise made-up events.
async function call<T>(code: string, path: string, body?: unknown): Promise<T> {
  const method = body === undefined ? 'GET' : 'POST';
  const text = body === undefined ? '' : JSON.stringify(body);
  for (let tries = 0; ; tries++) {
    const hello = await send('/v1/hello', { method: 'GET' });
    if (hello.status === 429) throw new HelperError('busy');
    const nonce = hello.ok ? ((await hello.json().catch(() => null)) as { nonce?: unknown } | null)?.nonce : null;
    if (typeof nonce !== 'string' || !/^[0-9a-f]{32}$/.test(nonce)) throw new HelperError('failed');
    const cnonce = hex(crypto.getRandomValues(new Uint8Array(16)));
    const mac = await hmac(code, ['arise-helper/1 ask', nonce, cnonce, method, path, await sha256(text)]);
    const headers: Record<string, string> = { Authorization: `Arise ${nonce}.${cnonce}.${mac}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await send(path, { method, headers, body: body === undefined ? undefined : text });
    let reply: string;
    try {
      reply = await r.text();
    } catch {
      throw new HelperError('failed');
    }
    // The helper started again in between: once more.
    if (r.status === 401 && tries === 0 && /"nonce"/.test(reply)) continue;
    if (r.status === 401) throw new HelperError('code');
    if (r.status === 429) throw new HelperError('busy');
    const proof = await hmac(code, ['arise-helper/1 reply', nonce, cnonce, String(r.status), await sha256(reply)]);
    if (r.headers.get('X-Arise-Proof') !== proof || !r.ok) throw new HelperError('failed');
    try {
      return JSON.parse(reply) as T;
    } catch {
      throw new HelperError('failed');
    }
  }
}

// What a problem means, in plain words.
export function problemText(p: Problem | '', nav: Nav = navigator): string {
  switch (p) {
    case 'unreachable':
      if (browser(nav) === 'safari') return "Safari doesn't let websites reach a helper on this Mac. Open Arise in Chrome or Edge on this Mac instead.";
      return "Can't reach the helper on this Mac. To check it's installed and running, run the install command again in Terminal. If the browser asked about apps on this device, choose Allow (to change that, click the icon at the left end of the address bar).";
    case 'code':
      return "That code doesn't match. To see it again, run this in Terminal: bash ~/.arise-helper/arise-helper.sh code";
    case 'busy':
      return 'Too many wrong codes. Wait a minute, then try again.';
    case 'not-ready':
      return "Your life log isn't ready yet. Try again in a moment.";
    case 'failed':
      return 'The helper had a problem. Run the install command again to update it.';
    default:
      return '';
  }
}

function cleanStatus(x: unknown): HelperStatus {
  const s = (x && typeof x === 'object' ? x : {}) as Record<string, any>;
  const settings = {} as Record<Switch, boolean>;
  for (const k of SWITCHES) settings[k] = s.settings?.[k] === true;
  const sources = {} as Record<Source, SourceStatus>;
  const states = ['off', 'waiting', 'ok', 'no-access', 'missing', 'error'];
  for (const k of SOURCES) {
    const v = s.sources?.[k] || {};
    sources[k] = {
      state: states.includes(v.state) ? v.state : 'off',
      found: Number.isFinite(v.found) ? Math.max(0, v.found) : 0,
      last: Number.isFinite(v.last) ? v.last : null,
      waiting: Number.isFinite(v.waiting) ? Math.max(0, v.waiting) : 0,
    };
  }
  return {
    version: Number.isFinite(s.version) ? s.version : 0,
    build: typeof s.build === 'string' ? s.build.slice(0, 20) : '',
    node: typeof s.node === 'string' ? s.node.slice(0, 300) : '',
    fullDiskAccess: typeof s.fullDiskAccess === 'boolean' ? s.fullDiskAccess : null,
    olderNodeAccess: typeof s.olderNodeAccess === 'boolean' ? s.olderNodeAccess : null,
    settings,
    sources,
    known: SOURCES.filter((k) => !!s.sources?.[k] && typeof s.sources[k] === 'object'),
    waiting: Number.isFinite(s.waiting) ? Math.max(0, s.waiting) : 0,
  };
}

// Links this browser to the helper with the code it showed. Throws a HelperError if it can't.
export async function link(typed: string): Promise<HelperStatus> {
  const code = normalizeCode(typed);
  if (code.length !== 20) throw new HelperError('code');
  const status = cleanStatus(await call(code, '/v1/status'));
  write({ code, linkedAt: Date.now(), status, totals: {}, error: '' });
  return status;
}

// Forgets the link here. The helper keeps running until it's uninstalled.
export function unlink() {
  write(null);
}

function update(change: (l: Link) => void) {
  const l = read();
  if (!l) return;
  change(l);
  write(l);
}

// Asks the helper how it's doing (and remembers it for the panel).
export async function refresh(): Promise<HelperStatus | null> {
  const l = read();
  if (!l) return null;
  try {
    const status = cleanStatus(await call(l.code, '/v1/status'));
    update((x) => {
      x.status = status;
      x.error = '';
    });
    return status;
  } catch (e) {
    const p = e instanceof HelperError ? e.problem : 'failed';
    update((x) => (x.error = p));
    throw e;
  }
}

// Turns what the helper reads on or off. The helper keeps the switches, so they're the same in
// any browser on that Mac, and it never reads what's off.
export async function setSwitches(change: Partial<Record<Switch, boolean>>): Promise<HelperStatus> {
  const l = read();
  if (!l) throw new HelperError('code');
  const status = cleanStatus(await call(l.code, '/v1/settings', change));
  update((x) => {
    x.status = status;
    x.error = '';
  });
  return status;
}

// ---------- events

const text = (v: unknown, n: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');

// Which source an event came from, by its id.
const sourceOf = (id: string) => SOURCES.find((s) => id.startsWith(PREFIX[s]));

// One event from the helper, checked field by field, or null. The tier comes from the kind, never
// from the helper. Without message text turned on, messages, notifications and emails keep no words.
export function cleanEvent(x: unknown, withText: boolean, now = Date.now()): LifeEvent | null {
  if (!x || typeof x !== 'object') return null;
  const e = x as Record<string, unknown>;
  const id = text(e.id, 200);
  const kind = e.kind as LifeKind;
  const from = sourceOf(id);
  if (!from || e.source !== 'mac' || !KIND[from].includes(kind)) return null;
  const at = Number(e.at);
  if (!Number.isFinite(at) || at < Date.UTC(2001, 0, 1) || at > now + (kind === 'event' ? AHEAD : 86_400_000)) return null;
  const title = text(e.title, 200);
  if (!title) return null;
  const out: LifeEvent = { id, source: 'mac', kind, at: Math.round(at), title, tier: TIER[kind] || 3 };
  const end = Number(e.end);
  if (e.end !== undefined && Number.isFinite(end) && end >= at && end <= at + (kind === 'event' ? 31 : 2) * 86_400_000) out.end = Math.round(end);
  const detail = text(e.detail, 2000);
  if (detail && (withText || (kind !== 'message' && kind !== 'notification'))) out.detail = detail;
  if (typeof e.url === 'string' && e.url.length <= 2048 && /^https?:\/\//i.test(e.url)) out.url = e.url;
  const value = Number(e.value);
  if (e.value !== undefined && Number.isFinite(value)) out.value = value;
  const unit = text(e.unit, 10);
  if (unit) out.unit = unit;
  if (e.meta && typeof e.meta === 'object' && !Array.isArray(e.meta)) {
    const meta: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(e.meta as Record<string, unknown>).slice(0, 12)) {
      if (!/^\w{1,30}$/.test(k)) continue;
      if (typeof v === 'string') meta[k] = v.slice(0, 200);
      else if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) meta[k] = v;
    }
    if (Object.keys(meta).length) out.meta = meta;
  }
  return out;
}

// A calendar event that's gone (cancelled, deleted, or moved more than two weeks out): its id.
export function goneId(x: unknown): string {
  const e = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
  const id = typeof e.id === 'string' && e.id.length <= 200 ? e.id : '';
  return e.gone === true && e.source === 'mac' && sourceOf(id) === 'calendar' ? id : '';
}

let store: Promise<LifeStore> | null = null;
// The life log, if it's ready within `ms`: the helper's events wait there until it is.
function lifeLog(ms: number): Promise<LifeStore> {
  store ||= lifeStore();
  return Promise.race([store, new Promise<never>((_, no) => setTimeout(() => no(new HelperError('not-ready')), ms))]);
}

let pulling: Promise<number> | null = null;

// Takes everything new from the helper into the life log, page by page, and tells the helper
// after each page is saved, so nothing is lost if this stops halfway. Returns how many were new.
export function pull(): Promise<number> {
  return (pulling ||= (async () => {
    const l = read();
    if (!l) return 0;
    let fresh = 0;
    try {
      const log = await lifeLog(15_000);
      const withText = !!l.status?.settings.text;
      const counts: Partial<Record<Source, number>> = {};
      for (let i = 0; i < PAGES; i++) {
        const page = await call<{ events?: unknown[]; next?: number; more?: boolean }>(l.code, '/v1/events?after=0&limit=500');
        const raw = Array.isArray(page.events) ? page.events : [];
        const events = raw.map((x) => cleanEvent(x, withText)).filter((x): x is LifeEvent => !!x);
        // A calendar event comes again when it moved or changed: it takes its old place. (A life
        // log that can't replace keeps the first.) One that's gone comes out.
        const changing = events.filter((e) => sourceOf(e.id) === 'calendar');
        const rest = events.filter((e) => sourceOf(e.id) !== 'calendar');
        if (rest.length) fresh += await log.addEvents(rest);
        if (changing.length) fresh += log.upsertEvents ? await log.upsertEvents(changing) : await log.addEvents(changing);
        const gone = raw.map(goneId).filter(Boolean);
        if (gone.length && log.removeIds) await log.removeIds(gone);
        for (const ev of events) {
          const s = sourceOf(ev.id);
          if (s) counts[s] = (counts[s] || 0) + 1;
        }
        const next = Number(page.next);
        if (raw.length && Number.isFinite(next) && next > 0) await call(l.code, '/v1/ack', { upTo: next });
        if (!page.more || !raw.length) break;
      }
      update((x) => {
        x.lastPull = Date.now();
        x.lastNew = fresh;
        x.error = '';
        x.totals = { ...x.totals };
        for (const [s, n] of Object.entries(counts) as [Source, number][]) x.totals[s] = (x.totals[s] || 0) + n;
      });
      return fresh;
    } catch (e) {
      update((x) => (x.error = e instanceof HelperError ? e.problem : 'failed'));
      throw e;
    }
  })().finally(() => (pulling = null)));
}

// ---------- while Arise is open on the Mac

export const available = (native = false) => !native && typeof navigator !== 'undefined' && isMac();

let started = false;

// Pulls soon after the app opens, every 2 minutes while it's in front, and when it comes back.
export function initMacLink(hooks: { changed: () => void; native?: boolean }) {
  if (started || !available(hooks.native)) return;
  started = true;
  const go = () => {
    if (!read() || document.visibilityState !== 'visible') return;
    pull().then(hooks.changed, hooks.changed);
  };
  setTimeout(go, 3000);
  setInterval(go, EVERY);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - lastPull() > 30_000) go();
  });
}
