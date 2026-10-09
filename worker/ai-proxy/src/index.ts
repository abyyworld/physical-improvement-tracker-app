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

export interface Env {
  TINFOIL_API_KEY: string;
  FIREBASE_PROJECT_ID: string;
  ALLOWED_ORIGINS: string; // comma-separated, e.g. https://abyyworld.github.io,capacitor://localhost
  DAILY_LIMIT?: string; // requests per account per day (UTC), default 150
  PER_USER: RateLimiter;
  PER_IP: RateLimiter;
  QUOTA: DurableObjectNamespaceLike;
}

// Minimal shapes of the Cloudflare bindings used here, so this file needs no extra type package.
export interface RateLimiter {
  limit(o: { key: string }): Promise<{ success: boolean }>;
}
export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(input: string, init?: RequestInit): Promise<Response> };
}

// Tinfoil enclaves live under tinfoil.sh. Anything else is refused, so the proxy can't be used
// to send Arise's API key to another host.
const ENCLAVE_HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.tinfoil\.sh$/;
const PASS_UP = ['content-type', 'accept', 'ehbp-encapsulated-key', 'x-tinfoil-enclave-url'];
const PASS_DOWN = ['content-type', 'ehbp-response-nonce', 'cache-control'];
const PATHS = /^\/v1\/(chat\/completions|models)$/;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const origin = req.headers.get('origin') || '';
    const allowed = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
    const cors = corsHeaders(allowed.includes(origin) ? origin : '');
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const fail = (status: number, message: string) => json(status, { error: { message } }, cors);

    if (!allowed.includes(origin)) return fail(403, 'This origin may not use the Arise AI.');
    const url = new URL(req.url);
    if (!PATHS.test(url.pathname)) return fail(404, 'Not found.');
    if (!['GET', 'POST'].includes(req.method)) return fail(405, 'Method not allowed.');

    const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    let uid: string;
    try {
      uid = await verifyFirebaseToken(token, env.FIREBASE_PROJECT_ID);
    } catch {
      return fail(401, 'Sign in to use the private AI.');
    }

    const ip = req.headers.get('cf-connecting-ip') || 'unknown';
    const [user, net] = await Promise.all([env.PER_USER.limit({ key: uid }), env.PER_IP.limit({ key: ip })]);
    if (!user.success || !net.success) return fail(429, 'Too many requests right now. Try again in a minute.');
    if (req.method === 'POST') {
      const limit = Number(env.DAILY_LIMIT) || 150;
      const quota = env.QUOTA.get(env.QUOTA.idFromName(uid));
      const res = await quota.fetch(`https://quota/take?limit=${limit}`, { method: 'POST' });
      if (res.status === 429) return fail(429, "You've used today's private AI allowance. It resets at midnight UTC.");
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
    const res = await fetch(upstream.toString(), { method: req.method, headers, body: req.method === 'POST' ? req.body : undefined });

    const out = new Headers(cors);
    for (const h of PASS_DOWN) {
      const v = res.headers.get(h);
      if (v) out.set(h, v);
    }
    return new Response(res.body, { status: res.status, headers: out });
  },
};

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
    const limit = Number(new URL(req.url).searchParams.get('limit')) || 150;
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const saved = await this.state.storage.get<{ day: string; n: number }>('count');
    const n = saved?.day === day ? saved.n : 0;
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
