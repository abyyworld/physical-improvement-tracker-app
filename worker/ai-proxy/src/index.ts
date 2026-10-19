// Arise private AI proxy (a Cloudflare Worker).
//
// The app's private AI runs in Tinfoil's secure enclaves. The app checks the enclave's
// attestation itself, then encrypts every request body to the enclave's key (EHBP), so this
// proxy only ever sees ciphertext. What it does:
//   1. checks that the request comes from a signed-in Arise account (a Firebase ID token),
//   2. limits how much each account (and each IP address) can use,
//   3. swaps the account's token for Arise's Tinfoil API key, which never reaches a phone,
//   4. passes the encrypted body to the enclave and the encrypted answer back, untouched.
// It never logs bodies or tokens. It can't read prompts or answers even if it wanted to.
//
// It also serves the free AI at /free/v1: the same open model (or a smaller one the Player can
// pick) on Cloudflare Workers AI. That one is less private: the body isn't encrypted to an
// enclave, so Cloudflare's servers read it to answer, and so could this Worker (it only picks out
// the allowed fields and passes them on).
// Same sign-in check and limits, with its own daily allowance per account.
//
// And it knows who has Arise Private, the paid plan for the private AI. Everybody signed in gets a
// few private AI questions a day (PRIVATE_FREE_LIMIT); with Arise Private, the full daily
// allowance (DAILY_LIMIT, there for fair use). Lemon Squeezy sells it and tells this Worker about
// each subscription at /billing/lemon (a signed webhook); one small record per account keeps
// whether it has the plan, until when, and the link to manage it. The app asks at /v1/plan.

export interface Env {
  TINFOIL_API_KEY: string;
  FIREBASE_PROJECT_ID: string;
  ALLOWED_ORIGINS: string; // comma-separated, e.g. https://abyyworld.github.io,capacitor://localhost
  DAILY_LIMIT?: string; // private AI requests per account per day (UTC) with Arise Private, default 150
  PRIVATE_FREE_LIMIT?: string; // private AI requests per account per day (UTC) without it, default 5
  FREE_DAILY_LIMIT?: string; // free AI requests per account per day (UTC), default 15
  // Arise Private (Worker secrets, set by scripts/setup-workers.sh; empty until it's on sale):
  LEMON_WEBHOOK_SECRET?: string; // Lemon Squeezy's webhook signing secret
  LEMON_CHECKOUT_MONTHLY?: string; // the checkout link of the Monthly variant
  LEMON_CHECKOUT_YEARLY?: string; // and of the Yearly one
  PER_USER: RateLimiter;
  PER_IP: RateLimiter;
  QUOTA: DurableObjectNamespaceLike;
  PLAN: DurableObjectNamespaceLike;
  AI: AiLike;
}

// Minimal shapes of the Cloudflare bindings used here, so this file needs no extra type package.
export interface RateLimiter {
  limit(o: { key: string }): Promise<{ success: boolean }>;
}
export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(input: string, init?: RequestInit): Promise<Response> };
}
export interface AiLike {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
}

// Tinfoil enclaves live under tinfoil.sh. Anything else is refused, so the proxy can't be used
// to send Arise's API key to another host.
const ENCLAVE_HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.tinfoil\.sh$/;
const PASS_UP = ['content-type', 'accept', 'ehbp-encapsulated-key', 'x-tinfoil-enclave-url'];
const PASS_DOWN = ['content-type', 'ehbp-response-nonce', 'cache-control'];
const PATHS = /^\/v1\/(chat\/completions|models)$/;
const FREE_PATHS = /^\/free\/v1\/(chat\/completions|models)$/;

// The models the free AI may use (the first is the default), and the only request fields passed
// on to them. A model the app asks for that isn't on the list gets the default. Both take the
// OpenAI chat format and answer in it, so the app reads them the same way.
export const FREE_MODELS = ['@cf/openai/gpt-oss-120b', '@cf/openai/gpt-oss-20b'];
const FREE_FIELDS = ['messages', 'stream', 'stream_options', 'response_format', 'max_tokens', 'temperature', 'reasoning_effort'];
const USED_UP = "The free AI has used up today's allowance. It resets at midnight UTC.";
const BUSY = 'The free AI is busy right now. Try again in a few minutes.';
const UNREADABLE = "The free AI couldn't read that request.";
// Everybody shares Workers AI's daily allocation, so one request can't use much of it: at most
// this many characters in, and this many tokens out (also the default, as the app sends none).
const FREE_MAX_BODY = 100_000;
const FREE_MAX_TOKENS = 8000;

const privateLimit = (env: Env) => Number(env.DAILY_LIMIT) || 150;
const privateFreeLimit = (env: Env) => Number(env.PRIVATE_FREE_LIMIT) || 5;
// The checkout links, only when they're real https addresses.
const link = (v: string | undefined) => (/^https:\/\/\S+$/.test(String(v || '').trim()) ? String(v).trim() : '');
const checkoutLinks = (env: Env) => ({ monthly: link(env.LEMON_CHECKOUT_MONTHLY), yearly: link(env.LEMON_CHECKOUT_YEARLY) });
// What the app shows when the free private questions are used up. It comes with `code: 'plan'`,
// so the app can offer Arise Private (or another AI) next to it.
function planMessage(env: Env, limit: number) {
  const used = `You've used today's ${limit} free private question${limit === 1 ? '' : 's'}.`;
  const { monthly, yearly } = checkoutLinks(env);
  return monthly || yearly ? `${used} Arise Private gives you the private AI all day for $5 a month.` : `${used} They start again at midnight UTC.`;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    // Lemon Squeezy's servers, not a browser: no CORS and no sign-in. The signature proves it.
    if (new URL(req.url).pathname === '/billing/lemon') return lemonWebhook(req, env);
    const origin = req.headers.get('origin') || '';
    const allowed = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
    const cors = corsHeaders(allowed.includes(origin) ? origin : '');
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const fail = (status: number, message: string) => json(status, { error: { message } }, cors);

    if (!allowed.includes(origin)) return fail(403, 'This origin may not use the Arise AI.');
    const url = new URL(req.url);
    const free = FREE_PATHS.test(url.pathname);
    const planPath = url.pathname === '/v1/plan';
    if (!free && !planPath && !PATHS.test(url.pathname)) return fail(404, 'Not found.');
    if (!['GET', 'POST'].includes(req.method)) return fail(405, 'Method not allowed.');
    if (free && req.method !== (url.pathname.endsWith('/models') ? 'GET' : 'POST')) return fail(405, 'Method not allowed.');
    if (planPath && req.method !== 'GET') return fail(405, 'Method not allowed.');
    const which = free ? 'free' : 'private';

    const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    let uid: string;
    try {
      uid = await verifyFirebaseToken(token, env.FIREBASE_PROJECT_ID);
    } catch {
      return fail(401, `Sign in to use the ${which} AI.`);
    }

    const ip = req.headers.get('cf-connecting-ip') || 'unknown';
    const [user, net] = await Promise.all([env.PER_USER.limit({ key: uid }), env.PER_IP.limit({ key: ip })]);
    if (!user.success || !net.success) return fail(429, 'Too many requests right now. Try again in a minute.');
    // The free AI counts a request only once it has checked it (see freeAI).
    if (free) return freeAI(req, env, uid, url.pathname, cors, fail);
    if (planPath) return planInfo(env, uid, cors);
    // With Arise Private, the whole daily allowance. Without it, a few private questions a day,
    // on the same counter, so buying it partway through a day carries on from there.
    let quota: ReturnType<typeof allowance> | null = null;
    if (req.method === 'POST') {
      const paid = planActive(await planOf(env, uid));
      const limit = paid ? privateLimit(env) : privateFreeLimit(env);
      quota = allowance(env, uid, false, limit);
      if (!(await quota.take())) {
        if (paid) return fail(429, `You've used today's ${which} AI allowance. It resets at midnight UTC.`);
        return json(429, { error: { message: planMessage(env, limit), code: 'plan' }, code: 'plan' }, cors);
      }
    }

    // The app names the enclave it verified; the proxy only checks it's really a Tinfoil one.
    const enclave = req.headers.get('x-tinfoil-enclave-url') || '';
    let upstream: URL;
    try {
      upstream = new URL(url.pathname + url.search, enclave);
    } catch {
      return fail(400, 'Bad enclave address.');
    }
    if (upstream.protocol !== 'https:' || !ENCLAVE_HOST.test(upstream.hostname)) return fail(400, 'Bad enclave address.');

    const headers = new Headers();
    for (const h of PASS_UP) {
      const v = req.headers.get(h);
      if (v) headers.set(h, v);
    }
    headers.set('authorization', `Bearer ${env.TINFOIL_API_KEY}`);
    let res: Response;
    try {
      res = await fetch(upstream.toString(), { method: req.method, headers, body: req.method === 'POST' ? req.body : undefined });
    } catch {
      await quota?.giveBack();
      return fail(502, "Couldn't reach the private AI. Try again in a minute.");
    }
    // No answer (the enclave refused the request, or was busy), so it doesn't count.
    if (!res.ok) await quota?.giveBack();

    const out = new Headers(cors);
    for (const h of PASS_DOWN) {
      const v = res.headers.get(h);
      if (v) out.set(h, v);
    }
    return new Response(res.body, { status: res.status, headers: out });
  },
};

// One small counter per account and per AI. `take` uses one request of the day's allowance, or
// says none are left. `giveBack` returns one that got no answer. `used`: how many so far today.
function allowance(env: Env, uid: string, free: boolean, limit = free ? Number(env.FREE_DAILY_LIMIT) || 15 : privateLimit(env)) {
  // The free AI has its own counter, so using one never uses up the other.
  const quota = env.QUOTA.get(env.QUOTA.idFromName(free ? `free:${uid}` : uid));
  return {
    take: async () => (await quota.fetch(`https://quota/take?limit=${limit}`, { method: 'POST' })).status !== 429,
    giveBack: () => quota.fetch('https://quota/give', { method: 'POST' }).catch(() => undefined),
    used: async () => {
      try {
        const n = Number(((await (await quota.fetch('https://quota/used')).json()) as { n?: unknown })?.n);
        return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
      } catch {
        return 0;
      }
    },
  };
}

// ---------- Arise Private

// The account's plan, for Settings: GET /v1/plan. `left`: private AI questions left today.
async function planInfo(env: Env, uid: string, cors: Headers): Promise<Response> {
  const p = await planOf(env, uid);
  const paid = planActive(p);
  const limit = paid ? privateLimit(env) : privateFreeLimit(env);
  const used = await allowance(env, uid, false, limit).used();
  const out = { plan: paid ? 'private' : 'free', left: Math.max(0, limit - used), limit, renewsAt: p?.renewsAt ?? null, endsAt: p?.endsAt ?? null, portal: p?.portal || '', checkout: checkoutLinks(env) };
  const res = json(200, out, cors);
  res.headers.set('cache-control', 'no-store');
  return res;
}

// What Lemon Squeezy said last about the account's subscription, or null.
async function planOf(env: Env, uid: string): Promise<PlanRecord | null> {
  try {
    const res = await env.PLAN.get(env.PLAN.idFromName(uid)).fetch('https://plan/get');
    return res.ok ? cleanPlan(await res.json()) : null;
  } catch {
    return null;
  }
}

// The one record kept per account. Nothing about the person: no name, no email.
export interface PlanRecord {
  status: string; // Lemon Squeezy's: on_trial, active, paused, past_due, unpaid, cancelled or expired
  variant: string; // Monthly or Yearly
  renewsAt: string | null;
  endsAt: string | null; // set once it's cancelled: it lasts until then
  portal: string; // where the Player manages it (Lemon Squeezy's customer portal)
  updatedAt: string; // when Lemon Squeezy last changed it, to put its messages in order
}

const STATUSES = ['on_trial', 'active', 'paused', 'past_due', 'unpaid', 'cancelled', 'expired'];
const when = (v: unknown) => (typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v)) ? v : null);

export function cleanPlan(raw: unknown): PlanRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const status = typeof r.status === 'string' && STATUSES.includes(r.status) ? r.status : '';
  const updatedAt = when(r.updatedAt);
  if (!status || !updatedAt) return null;
  const portal = typeof r.portal === 'string' && r.portal.length <= 2000 && /^https:\/\/\S+$/.test(r.portal) ? r.portal : '';
  return { status, variant: typeof r.variant === 'string' ? r.variant.slice(0, 80) : '', renewsAt: when(r.renewsAt), endsAt: when(r.endsAt), portal, updatedAt };
}

// Whether the account has Arise Private now: paid up (or on a trial, or while a payment is being
// tried again), or cancelled but not yet at its end.
export function planActive(p: PlanRecord | null | undefined, now = Date.now()): boolean {
  if (!p) return false;
  if (['active', 'on_trial', 'past_due'].includes(p.status)) return true;
  return p.status === 'cancelled' && !!p.endsAt && Date.parse(p.endsAt) > now;
}

// ---------- the Lemon Squeezy webhook
// https://docs.lemonsqueezy.com/help/webhooks

const LEMON_EVENTS = ['subscription_created', 'subscription_updated', 'subscription_cancelled', 'subscription_resumed', 'subscription_expired', 'subscription_paused', 'subscription_unpaused', 'subscription_payment_success'];
const LEMON_MAX_BODY = 64_000;
// Firebase account ids: letters and digits (28 of them for Arise's accounts).
const FIREBASE_UID = /^[A-Za-z0-9]{20,128}$/;

type LemonBody = { meta?: { event_name?: unknown; custom_data?: { uid?: unknown } }; data?: { type?: unknown; attributes?: Record<string, unknown> } };

async function lemonWebhook(req: Request, env: Env): Promise<Response> {
  const say = (status: number, text: string) => new Response(text, { status, headers: { 'content-type': 'text/plain' } });
  if (req.method !== 'POST') return say(405, 'Method not allowed.');
  const secret = env.LEMON_WEBHOOK_SECRET || '';
  if (!secret) return say(401, 'Not set up.');
  if (Number(req.headers.get('content-length')) > LEMON_MAX_BODY) return say(400, 'Too big.');
  const raw = await req.arrayBuffer();
  if (raw.byteLength > LEMON_MAX_BODY) return say(400, 'Too big.');
  if (!(await signed(secret, raw, req.headers.get('x-signature') || ''))) return say(401, 'Bad signature.');
  let body: LemonBody;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return say(400, 'Not JSON.');
  }
  const event = body?.meta?.event_name;
  if (typeof event !== 'string' || !LEMON_EVENTS.includes(event)) return say(200, 'Not needed.');
  // The checkout link the app opens carries the account id (checkout[custom][uid]).
  const uid = body.meta?.custom_data?.uid;
  if (typeof uid !== 'string' || !FIREBASE_UID.test(uid)) return say(400, 'No Arise account in it.');
  // A payment's message carries the invoice, not the subscription. Lemon Squeezy sends
  // subscription_updated with it, which has what's kept here.
  if (body.data?.type !== 'subscriptions') return say(200, 'Nothing to change.');
  const a = body.data.attributes || {};
  const urls = (a.urls || {}) as Record<string, unknown>;
  const plan = cleanPlan({ status: a.status, variant: a.variant_name, renewsAt: a.renews_at, endsAt: a.ends_at, portal: urls.customer_portal, updatedAt: a.updated_at });
  if (!plan) return say(400, 'Not a subscription.');
  const res = await env.PLAN.get(env.PLAN.idFromName(uid)).fetch('https://plan/set', { method: 'POST', body: JSON.stringify(plan) });
  return res.ok ? say(200, 'OK.') : say(500, 'Not saved.');
}

// X-Signature is the hex HMAC-SHA256 of the raw body with the signing secret. WebCrypto's verify
// compares the two in constant time.
async function signed(secret: string, body: ArrayBuffer, signature: string): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/i.test(signature)) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const sig = new Uint8Array(32);
  for (let i = 0; i < 32; i++) sig[i] = parseInt(signature.slice(i * 2, i * 2 + 2), 16);
  return crypto.subtle.verify('HMAC', key, sig, body);
}

// ---------- the free AI (Cloudflare Workers AI)

type Fail = (status: number, message: string) => Response;

async function freeAI(req: Request, env: Env, uid: string, path: string, cors: Headers, fail: Fail): Promise<Response> {
  if (path.endsWith('/models')) return json(200, { object: 'list', data: FREE_MODELS.map((id) => ({ id, object: 'model', owned_by: 'cloudflare' })) }, cors);
  const tooBig = () => fail(413, "That's more than the free AI takes at once. Start a new chat, or use the private AI for this.");
  if (Number(req.headers.get('content-length')) > FREE_MAX_BODY) return tooBig();
  let body: Record<string, unknown>;
  try {
    const raw = await req.text();
    if (raw.length > FREE_MAX_BODY) return tooBig();
    body = JSON.parse(raw);
  } catch {
    return fail(400, UNREADABLE);
  }
  if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) return fail(400, UNREADABLE);
  const inputs: Record<string, unknown> = {};
  for (const k of FREE_FIELDS) if (body[k] !== undefined) inputs[k] = body[k];
  if (!['low', 'medium', 'high'].includes(inputs.reasoning_effort as string)) delete inputs.reasoning_effort;
  const asked = Math.floor(Number(body.max_tokens));
  inputs.max_tokens = asked > 0 ? Math.min(asked, FREE_MAX_TOKENS) : FREE_MAX_TOKENS;
  const model = FREE_MODELS.includes(body.model as string) ? (body.model as string) : FREE_MODELS[0];

  const quota = allowance(env, uid, true);
  if (!(await quota.take())) return fail(429, "You've used today's free AI allowance. It resets at midnight UTC.");
  let out: unknown;
  try {
    out = await env.AI.run(model, inputs);
  } catch (err) {
    const [status, message] = freeFailed(err);
    // No answer, and unless it was only busy, nothing was used either, so it doesn't count.
    if (message !== BUSY) await quota.giveBack();
    return fail(status, message);
  }
  if (out instanceof ReadableStream) {
    const headers = new Headers(cors);
    headers.set('content-type', 'text/event-stream');
    headers.set('cache-control', 'no-store');
    return new Response(out, { headers });
  }
  return json(200, out, cors);
}

// Workers AI says 3036 when the free daily allocation (shared by everyone using Arise) is used up.
// A request it can't take is a 400, so the app tries a simpler one. Anything else is "busy for
// now". All in words for the Player, which the app shows as they are.
function freeFailed(err: unknown): [number, string] {
  const m = String((err as Error)?.message || err);
  if (/\b(3036|4006)\b|neurons|daily free allocation/i.test(m)) return [429, USED_UP];
  if (/\b(3003|3006|3010|5004|5005|5006)\b|invalid|bad input|required propert|not supported|unsupported/i.test(m)) return [400, "The free AI couldn't take that request."];
  return [429, BUSY];
}

function corsHeaders(origin: string): Headers {
  const h = new Headers({ vary: 'origin' });
  if (!origin) return h;
  h.set('access-control-allow-origin', origin);
  h.set('access-control-allow-methods', 'GET, POST, OPTIONS');
  h.set('access-control-allow-headers', 'authorization, content-type, accept, ehbp-encapsulated-key, x-tinfoil-enclave-url, x-stainless-arch, x-stainless-lang, x-stainless-os, x-stainless-package-version, x-stainless-retry-count, x-stainless-runtime, x-stainless-runtime-version, x-stainless-timeout');
  h.set('access-control-expose-headers', 'ehbp-response-nonce');
  h.set('access-control-max-age', '86400');
  return h;
}

const json = (status: number, body: unknown, base: Headers) => {
  const headers = new Headers(base);
  headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(body), { status, headers });
};

// ---------- Firebase ID tokens
// https://firebase.google.com/docs/auth/admin/verify-id-tokens#verify_id_tokens_using_a_third-party_jwt_library

const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
let jwks: { keys: Map<string, CryptoKey>; until: number } | null = null;

async function signingKey(kid: string): Promise<CryptoKey | undefined> {
  if (!jwks || Date.now() > jwks.until || !jwks.keys.has(kid)) {
    const res = await fetch(JWKS_URL);
    if (!res.ok) throw new Error('jwks');
    const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get('cache-control') || '')?.[1]) || 3600;
    const body = (await res.json()) as { keys: (JsonWebKey & { kid: string })[] };
    const keys = new Map<string, CryptoKey>();
    for (const k of body.keys) keys.set(k.kid, await crypto.subtle.importKey('jwk', k, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']));
    jwks = { keys, until: Date.now() + maxAge * 1000 };
  }
  return jwks.keys.get(kid);
}

const b64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const part = (s: string) => JSON.parse(new TextDecoder().decode(b64url(s)));

export async function verifyFirebaseToken(token: string, projectId: string, now = Date.now() / 1000, keyFor = signingKey): Promise<string> {
  const [h, p, s] = token.split('.');
  if (!h || !p || !s) throw new Error('shape');
  const header = part(h);
  const claims = part(p);
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error('alg');
  const key = await keyFor(header.kid);
  if (!key) throw new Error('kid');
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(s), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) throw new Error('signature');
  if (claims.aud !== projectId || claims.iss !== `https://securetoken.google.com/${projectId}`) throw new Error('audience');
  if (typeof claims.exp !== 'number' || claims.exp < now) throw new Error('expired');
  if (typeof claims.iat !== 'number' || claims.iat > now + 60) throw new Error('issued');
  if (typeof claims.auth_time !== 'number' || claims.auth_time > now + 60) throw new Error('auth_time');
  if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 128) throw new Error('sub');
  return claims.sub;
}

// ---------- daily allowance, one small counter per account

interface StorageLike {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  deleteAll(): Promise<void>;
  setAlarm(time: number): Promise<void>;
}

export class Quota {
  constructor(private state: { storage: StorageLike }) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const limit = Number(url.searchParams.get('limit')) || 150;
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const saved = await this.state.storage.get<{ day: string; n: number }>('count');
    const n = saved?.day === day ? saved.n : 0;
    if (url.pathname === '/used') return new Response(JSON.stringify({ n }), { headers: { 'content-type': 'application/json' } });
    // A request that got no answer gives its one back.
    if (url.pathname === '/give') {
      if (n) await this.state.storage.put('count', { day, n: n - 1 });
      return new Response('ok');
    }
    if (n >= limit) return new Response('limit', { status: 429 });
    if (saved && saved.day !== day) await this.state.storage.deleteAll();
    await this.state.storage.put('count', { day, n: n + 1 });
    // The counter goes at midnight UTC, when the allowance starts again. The app never tells this
    // proxy when an account is deleted, so this is what keeps nothing about it here for longer.
    if (!n) await this.state.storage.setAlarm(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    return new Response('ok');
  }

  // Cloudflare runs this at the time set above.
  async alarm(): Promise<void> {
    await this.state.storage.deleteAll();
  }
}

// ---------- Arise Private, one small record per account

// How long the record of a plan that ended stays, in case a late message from Lemon Squeezy
// still comes. Then it goes: nothing is kept about an account that doesn't have the plan.
export const KEEP_ENDED = 30 * 24 * 3600 * 1000;

export class Plan {
  constructor(private state: { storage: StorageLike }) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const saved = cleanPlan(await this.state.storage.get<PlanRecord>('plan'));
    if (url.pathname !== '/set' || req.method !== 'POST') return new Response(JSON.stringify(saved), { headers: { 'content-type': 'application/json' } });
    const next = cleanPlan(await req.json().catch(() => null));
    if (!next) return new Response('bad', { status: 400 });
    // Lemon Squeezy may send its messages out of order, or again: an older one changes nothing.
    if (saved && Date.parse(next.updatedAt) < Date.parse(saved.updatedAt)) return new Response('older');
    await this.state.storage.put('plan', next);
    const now = Date.now();
    if (!planActive(next, now)) await this.state.storage.setAlarm(now + KEEP_ENDED);
    else if (next.status === 'cancelled' && next.endsAt) await this.state.storage.setAlarm(Date.parse(next.endsAt) + KEEP_ENDED);
    return new Response('ok');
  }

  // Cloudflare runs this at the time set above.
  async alarm(): Promise<void> {
    const saved = cleanPlan(await this.state.storage.get<PlanRecord>('plan'));
    if (saved && planActive(saved)) return; // bought again since
    await this.state.storage.deleteAll();
  }
}
