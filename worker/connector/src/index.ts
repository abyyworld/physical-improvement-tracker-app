// Arise's web connector (a Cloudflare Worker): Arise for AI apps on the web. claude.ai, ChatGPT,
// Gemini and any other app that speaks MCP over HTTP add it by an address made for one app,
// https://<this worker>/mcp/<id>.<key>, and get exactly what the Player picked for that app in
// Arise, the same as the MCP server for desktop apps (mcp/core.mjs, which this runs). The address
// is a page of its own, apart from the app's link: turning the web off empties it for good.
//
// Less private than the rest of Arise, and the app says so before it can be turned on: to answer,
// this Worker opens the link's page for a moment, so it (and Cloudflare) could read what that app
// gets. It keeps none of it. A page only works here when the Player turned the web on for that app
// (the page itself says so, and only their account can write it), until the date they picked.
//
// What it keeps, per page, in a Durable Object: a log of which tools the app used and when, and
// the notes the app added if the Player allowed that, all sealed with a key made from the page's
// key (src/lib/feed.ts), so it stores only ciphertext; and the SHA-256 of the token Arise reads
// them back with, as the page says (only the Player's account writes the page, and the app never
// has the token, so it can't read or wipe the log). Arise takes them, then they're deleted;
// anything left is deleted after 60 days without use. No request logs.

import { createServer } from '../../../mcp/core.mjs';
import { parseMeLink, readMe } from '../../../public/me.js';
import { clientName, feedKey, sealEntry, tokenHash, type FeedEntry, type FeedTool, type SealedEntry } from '../../../src/lib/feed';

export interface Env {
  ALLOWED_ORIGINS: string; // the Arise app's own addresses, comma-separated (for reading the feed back)
  SITE?: string; // Arise's website, for the links search results carry
  PER_LINK: RateLimiter;
  PER_IP: RateLimiter;
  FEEDS: DurableObjectNamespaceLike;
}

export interface RateLimiter {
  limit(o: { key: string }): Promise<{ success: boolean }>;
}
export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(input: string, init?: RequestInit): Promise<Response> };
}
export interface StorageLike {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  deleteAll(): Promise<void>;
  setAlarm(time: number): Promise<void>;
}
export interface StateLike {
  storage: StorageLike;
}

// Tests swap the cloud and the clock.
export interface Deps {
  fetch?: typeof fetch;
  projectId?: string;
  apiKey?: string;
  now?: () => number;
}

export const VERSION = '1.0.0';
const MAX_BODY = 64 * 1024;
const PAGE_MS = 15_000; // a page read is reused this long, so a burst of calls reads it once
const KEEP_MS = 60 * 86_400_000;
export const MAX_ENTRIES = 300;
export const MAX_NOTES = 50; // waiting for Arise to take them

const NOT_ON = 'This Arise link isn\'t turned on for AI apps on the web. In Arise: What Arise knows, Connected apps, this app, then "Use it on the web".';
const ENDED = 'The time the user picked for this app in Arise is over, so it no longer gets anything. They can turn it on again in Arise (What Arise knows, Connected apps).';
const TOO_MANY = 'Too many requests for this link. Try again in a minute.';

// ---------- answers

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });

// Any app may call /mcp (the address is the secret, and nothing is sent with cookies).
const OPEN_CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, GET, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type, accept, authorization, mcp-protocol-version, mcp-session-id, last-event-id',
  'access-control-expose-headers': 'mcp-session-id',
  'access-control-max-age': '86400',
};
function appCors(req: Request, env: Env): Record<string, string> {
  const origin = req.headers.get('origin') || '';
  const allowed = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim());
  return allowed.includes(origin)
    ? { 'access-control-allow-origin': origin, vary: 'origin', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type, authorization', 'access-control-max-age': '86400' }
    : { vary: 'origin' };
}

// ---------- pages, read for a moment

const pages = new Map<string, { at: number; me: Record<string, unknown> & { web?: { notes?: boolean; until?: number; feed?: string } } }>();

async function page(link: string, deps: Deps) {
  const now = (deps.now || Date.now)();
  const hit = pages.get(link);
  if (hit && now - hit.at < PAGE_MS) return hit.me;
  const me = await readMe(link, { ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.projectId ? { projectId: deps.projectId } : {}), ...(deps.apiKey ? { apiKey: deps.apiKey } : {}) });
  if (pages.size > 500) pages.clear();
  pages.set(link, { at: now, me });
  return me;
}
export const forgetPages = () => pages.clear();

// The page, if it's on for the web now. Otherwise an error the app is shown.
async function webPage(link: string, deps: Deps) {
  const me = await page(link, deps);
  const web = me.web;
  if (!web || typeof web !== 'object') throw Object.assign(new Error(NOT_ON), { say: NOT_ON });
  if (typeof web.until === 'number' && (deps.now || Date.now)() > web.until) throw Object.assign(new Error(ENDED), { say: ENDED });
  return me;
}

// ---------- the feed (one Durable Object per link)

const feed = (env: Env, id: string) => env.FEEDS.get(env.FEEDS.idFromName(id));

async function append(env: Env, id: string, hash: string, sealed: { iv: string; ct: string }, note: boolean) {
  const res = await feed(env, id).fetch('https://feed/append', { method: 'POST', body: JSON.stringify({ hash, ...sealed, note }) });
  if (res.status === 429) throw Object.assign(new Error('full'), { say: `There are already ${MAX_NOTES} notes waiting for them to open Arise. Try again after they do.` });
  if (!res.ok) throw new Error(`The log said ${res.status}.`);
}

// ---------- /mcp/<id>.<key>

async function mcp(req: Request, env: Env, ref: { id: string; key: string }, deps: Deps): Promise<Response> {
  if (req.method === 'GET' || req.method === 'DELETE') return new Response(null, { status: 405, headers: { allow: 'POST', ...OPEN_CORS } });
  if (req.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST', ...OPEN_CORS } });
  const ip = req.headers.get('cf-connecting-ip') || '';
  if (!(await env.PER_LINK.limit({ key: ref.id })).success || (ip && !(await env.PER_IP.limit({ key: ip })).success)) {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: TOO_MANY } }, 429, { 'retry-after': '60', ...OPEN_CORS });
  }
  const text = await req.text();
  if (text.length > MAX_BODY) return json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Too big.' } }, 413, OPEN_CORS);
  let msg: unknown;
  try {
    msg = JSON.parse(text);
  } catch {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400, OPEN_CORS);
  }

  const link = `${ref.id}.${ref.key}`;
  const now = deps.now || Date.now;
  const client = clientName(req.headers.get('user-agent'));
  let key: CryptoKey | null = null;
  // The page says whose token reads the log. Without one, nothing is kept (and no notes taken).
  const sealed = async (e: FeedEntry) => {
    const hash = pages.get(link)?.me.web?.feed;
    if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) throw Object.assign(new Error('no log'), { say: "This address can't keep notes. Ask them to turn it off and on again in Arise." });
    key ||= await feedKey(ref.id, ref.key);
    return { hash, sealed: await sealEntry(key, ref.id, e) };
  };
  let noted = false;
  const server = createServer({
    link,
    web: true,
    now,
    site: env.SITE || '',
    read: (l: string) => webPage(l, deps),
    addNote: async (note: string) => {
      const { hash, sealed: s } = await sealed({ at: now(), tool: 'add_note', ok: true, ...(client ? { client } : {}), note });
      await append(env, ref.id, hash, s, true);
      noted = true;
    },
    onCall: async (name: string, ok: boolean) => {
      if (name === 'add_note' && noted) return;
      if (!['about_me', 'my_goals', 'recent_days', 'search', 'fetch', 'add_note'].includes(name)) return;
      // Nothing is logged for a page that isn't on for the web: there's nobody to show it to.
      if (!ok && !pages.get(link)?.me.web) return;
      const { hash, sealed: s } = await sealed({ at: now(), tool: name as FeedTool, ok, ...(client ? { client } : {}) });
      await append(env, ref.id, hash, s, false);
    },
  });

  // (Batches only came with the 2025-03-26 revision, and some clients still send them.)
  const list = Array.isArray(msg) ? msg : [msg];
  if (!list.length) return json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } }, 400, OPEN_CORS);
  const answers = [];
  for (const m of list.slice(0, 20)) {
    const a = await server.handle(m).catch((err: Error) => ({ jsonrpc: '2.0', id: (m as { id?: unknown })?.id ?? null, error: { code: -32603, message: err?.message || 'Internal error' } }));
    if (a) answers.push(a);
  }
  if (!answers.length) return new Response(null, { status: 202, headers: OPEN_CORS });
  return json(Array.isArray(msg) ? answers : answers[0], 200, OPEN_CORS);
}

// ---------- /feed/<id>: Arise reads what its apps did, then lets it go

async function feedRoute(req: Request, env: Env, id: string, rest: string): Promise<Response> {
  const cors = appCors(req, env);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.get('authorization') || '')?.[1];
  if (!token) return json({ error: 'Needs the token.' }, 401, cors);
  const ip = req.headers.get('cf-connecting-ip') || '';
  if (ip && !(await env.PER_IP.limit({ key: ip })).success) return json({ error: TOO_MANY }, 429, { 'retry-after': '60', ...cors });
  const hash = await tokenHash(token);
  if (req.method === 'GET' && rest === '') {
    const res = await feed(env, id).fetch('https://feed/list', { method: 'POST', body: JSON.stringify({ hash }) });
    return json(await res.json(), res.status, cors);
  }
  if (req.method === 'POST' && rest === '/done') {
    let upTo = 0;
    try {
      upTo = Number((await req.json() as { upTo?: unknown }).upTo);
    } catch {}
    if (!Number.isSafeInteger(upTo) || upTo < 1) return json({ error: 'Which entries?' }, 400, cors);
    const res = await feed(env, id).fetch('https://feed/done', { method: 'POST', body: JSON.stringify({ hash, upTo }) });
    return json(await res.json(), res.status, cors);
  }
  return json({ error: 'Not found.' }, 404, cors);
}

// ---------- the Worker

export async function handle(req: Request, env: Env, deps: Deps = {}): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (path === '/' || path === '/health') {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: appCors(req, env) });
    return json({ ok: true, name: 'arise-connector', version: VERSION }, 200, appCors(req, env));
  }
  const m = /^\/mcp\/([^/]+)$/.exec(path);
  if (m) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: OPEN_CORS });
    const ref = parseMeLink(decodeURIComponent(m[1]));
    if (!ref) return json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: "That isn't a whole Arise connector address. Copy it again from Arise." } }, 404, OPEN_CORS);
    return mcp(req, env, ref, deps);
  }
  const f = /^\/feed\/([A-Za-z0-9_-]{22})(\/done)?$/.exec(path);
  if (f) return feedRoute(req, env, f[1], f[2] || '');
  // (No sign-in here: the address is the key. Apps that look for one find none and go on.)
  return json({ error: 'Not found.' }, 404, req.method === 'OPTIONS' ? OPEN_CORS : {});
}

export default {
  fetch: (req: Request, env: Env) => handle(req, env),
};

// One link's log and notes, sealed. Only this Worker reaches it (no public address).
export class Feed {
  constructor(
    private state: StateLike,
    _env?: unknown,
    private now: () => number = Date.now,
  ) {}

  private async entries() {
    return (await this.state.storage.get<(SealedEntry & { note?: boolean })[]>('e')) || [];
  }

  async fetch(req: Request): Promise<Response> {
    const op = new URL(req.url).pathname;
    const body = (await req.json()) as { hash?: string; iv?: string; ct?: string; note?: boolean; upTo?: number };
    if (typeof body.hash !== 'string' || !/^[0-9a-f]{64}$/.test(body.hash)) return json({ error: 'bad' }, 400);
    const st = this.state.storage;
    const hash = await st.get<string>('hash');
    if (op === '/append') {
      // (The hash comes from the page, which only the Player's account writes: a new one there,
      // when they turned the web off and on again, takes over.)
      if (typeof body.iv !== 'string' || typeof body.ct !== 'string' || body.ct.length > 8000) return json({ error: 'bad' }, 400);
      let list = await this.entries();
      if (body.note && list.filter((e) => e.note).length >= MAX_NOTES) return json({ error: 'full' }, 429);
      const n = ((await st.get<number>('n')) || 0) + 1;
      list.push({ n, iv: body.iv, ct: body.ct, ...(body.note ? { note: true } : {}) });
      // The oldest go first, but never a note Arise hasn't taken yet.
      while (list.length > MAX_ENTRIES) {
        const i = list.findIndex((e) => !e.note);
        list = i < 0 ? list.slice(1) : list.filter((_, j) => j !== i);
      }
      if (hash !== body.hash) await st.put('hash', body.hash);
      await st.put('n', n);
      await st.put('e', list);
      await st.setAlarm(this.now() + KEEP_MS);
      return json({ n });
    }
    // Reading and letting go need the token whose hash came with the first entry.
    if (!hash) return json({ entries: [] });
    if (hash !== body.hash) return json({ error: 'not this link' }, 403);
    if (op === '/list') return json({ entries: (await this.entries()).map(({ n, iv, ct }) => ({ n, iv, ct })) });
    if (op === '/done') {
      const upTo = Number(body.upTo);
      const list = (await this.entries()).filter((e) => e.n > upTo);
      await st.put('e', list);
      return json({ left: list.length });
    }
    return json({ error: 'Not found.' }, 404);
  }

  // Unused for 60 days: everything goes, but the count, so Arise never mistakes a new entry for
  // one it already took.
  async alarm() {
    const n = await this.state.storage.get<number>('n');
    await this.state.storage.deleteAll();
    if (n) await this.state.storage.put('n', n);
  }
}
