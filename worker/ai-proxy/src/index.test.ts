import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import worker, { Quota, verifyFirebaseToken, type Env } from './index';

const PROJECT = 'arise-test';
const ORIGIN = 'https://abyyworld.github.io';
let keys: CryptoKeyPair;
const now = () => Math.floor(Date.now() / 1000);

const b64url = (b: Uint8Array | string) => {
  const bytes = typeof b === 'string' ? new TextEncoder().encode(b) : b;
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

async function token(claims: Record<string, unknown> = {}, { kid = 'k1', key = keys.privateKey } = {}) {
  const h = b64url(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' }));
  const t = now();
  const p = b64url(JSON.stringify({ aud: PROJECT, iss: `https://securetoken.google.com/${PROJECT}`, sub: 'user-1', iat: t - 10, exp: t + 3600, auth_time: t - 10, ...claims }));
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${h}.${p}`)));
  return `${h}.${p}.${b64url(sig)}`;
}

beforeAll(async () => {
  keys = (await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
});

const keyFor = async (kid: string) => (kid === 'k1' ? keys.publicKey : undefined);

describe('Firebase token check', () => {
  it('accepts a good token and returns the account id', async () => {
    expect(await verifyFirebaseToken(await token(), PROJECT, now(), keyFor)).toBe('user-1');
  });

  it.each([
    ['another project', { aud: 'other' }],
    ['another issuer', { iss: 'https://evil.example' }],
    ['an expired token', { exp: now() - 5 }],
    ['a token from the future', { iat: now() + 3600 }],
    ['no account id', { sub: '' }],
  ])('refuses %s', async (_, claims) => {
    await expect(verifyFirebaseToken(await token(claims), PROJECT, now(), keyFor)).rejects.toThrow();
  });

  it('refuses a token signed by someone else', async () => {
    const other = (await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    await expect(verifyFirebaseToken(await token({}, { key: other.privateKey }), PROJECT, now(), keyFor)).rejects.toThrow('signature');
  });

  it('refuses an unknown key id and junk', async () => {
    await expect(verifyFirebaseToken(await token({}, { kid: 'nope' }), PROJECT, now(), keyFor)).rejects.toThrow();
    await expect(verifyFirebaseToken('not.a.token', PROJECT, now(), keyFor)).rejects.toThrow();
    await expect(verifyFirebaseToken('', PROJECT, now(), keyFor)).rejects.toThrow();
  });
});

describe('the proxy', () => {
  const quotaTaken: string[] = [];
  const env = (over: Partial<Env> = {}): Env => ({
    TINFOIL_API_KEY: 'tk_secret',
    FIREBASE_PROJECT_ID: PROJECT,
    ALLOWED_ORIGINS: `${ORIGIN}, capacitor://localhost`,
    PER_USER: { limit: async () => ({ success: true }) },
    PER_IP: { limit: async () => ({ success: true }) },
    QUOTA: {
      idFromName: (n: string) => n,
      get: (id) => ({
        fetch: async () => {
          quotaTaken.push(String(id));
          return new Response('ok');
        },
      }),
    },
    ...over,
  });

  const jwks = async () => {
    const jwk = { ...(await crypto.subtle.exportKey('jwk', keys.publicKey)), kid: 'k1' };
    return new Response(JSON.stringify({ keys: [jwk] }), { headers: { 'cache-control': 'max-age=3600' } });
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    quotaTaken.length = 0;
  });

  function stubFetch(upstream: (url: string, init: RequestInit) => Response) {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      if (url.startsWith('https://www.googleapis.com/')) return jwks();
      calls.push({ url, init });
      return upstream(url, init);
    });
    return calls;
  }

  const call = async (init: { method?: string; path?: string; headers?: Record<string, string>; body?: string } = {}, e = env()) =>
    worker.fetch(
      new Request(`https://ai.example.workers.dev${init.path || '/v1/chat/completions'}`, {
        method: init.method || 'POST',
        headers: { origin: ORIGIN, authorization: `Bearer ${await token()}`, 'x-tinfoil-enclave-url': 'https://router.inf6.tinfoil.sh', 'ehbp-encapsulated-key': 'abcd', 'content-type': 'application/json', ...init.headers },
        body: init.method === 'GET' ? undefined : (init.body ?? 'ENCRYPTED'),
      }),
      e,
    );

  it('forwards the encrypted body to the verified enclave with the API key, and passes the nonce back', async () => {
    const calls = stubFetch(() => new Response('ENCRYPTED ANSWER', { headers: { 'ehbp-response-nonce': 'n1', 'content-type': 'application/json', 'set-cookie': 'x=1' } }));
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ENCRYPTED ANSWER');
    expect(res.headers.get('ehbp-response-nonce')).toBe('n1');
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(res.headers.get('access-control-expose-headers')).toContain('ehbp-response-nonce');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://router.inf6.tinfoil.sh/v1/chat/completions');
    const sent = new Headers(calls[0].init.headers);
    expect(sent.get('authorization')).toBe('Bearer tk_secret');
    expect(sent.get('ehbp-encapsulated-key')).toBe('abcd');
    expect(sent.get('origin')).toBeNull();
    expect(quotaTaken).toEqual(['user-1']);
  });

  it('never sends the API key anywhere but a Tinfoil enclave', async () => {
    const calls = stubFetch(() => new Response('x'));
    for (const bad of ['https://evil.example', 'https://tinfoil.sh.evil.example', 'http://router.tinfoil.sh', 'https://evil.example/?x=.tinfoil.sh', '']) {
      const res = await call({ headers: { 'x-tinfoil-enclave-url': bad } });
      expect(res.status).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  it('refuses requests without a valid sign-in', async () => {
    const calls = stubFetch(() => new Response('x'));
    expect((await call({ headers: { authorization: 'Bearer junk' } })).status).toBe(401);
    expect((await call({ headers: { authorization: '' } })).status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('refuses other websites', async () => {
    stubFetch(() => new Response('x'));
    const res = await call({ headers: { origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('only serves the chat and model list paths', async () => {
    const calls = stubFetch(() => new Response('x'));
    expect((await call({ path: '/v1/files' })).status).toBe(404);
    expect((await call({ path: '/admin' })).status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it('answers the browser preflight', async () => {
    const res = await worker.fetch(new Request('https://ai.example.workers.dev/v1/chat/completions', { method: 'OPTIONS', headers: { origin: ORIGIN } }), env());
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-headers')).toContain('ehbp-encapsulated-key');
  });

  it('stops at the per-minute and daily limits', async () => {
    const calls = stubFetch(() => new Response('x'));
    expect((await call({}, env({ PER_USER: { limit: async () => ({ success: false }) } }))).status).toBe(429);
    expect((await call({}, env({ PER_IP: { limit: async () => ({ success: false }) } }))).status).toBe(429);
    const full = env({ QUOTA: { idFromName: (n) => n, get: () => ({ fetch: async () => new Response('limit', { status: 429 }) }) } });
    const res = await call({}, full);
    expect(res.status).toBe(429);
    expect(await res.text()).toContain('allowance');
    expect(calls).toHaveLength(0);
  });

  it("doesn't count a model list against the daily allowance", async () => {
    stubFetch(() => new Response('{"data":[]}'));
    expect((await call({ method: 'GET', path: '/v1/models' })).status).toBe(200);
    expect(quotaTaken).toEqual([]);
  });
});

describe('daily allowance', () => {
  const storage = () => {
    const m = new Map<string, unknown>();
    return { get: async <T>(k: string) => m.get(k) as T | undefined, put: async (k: string, v: unknown) => void m.set(k, v), deleteAll: async () => m.clear() };
  };

  it('allows up to the limit, then refuses until the next day', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-08T10:00:00Z'));
    const q = new Quota({ storage: storage() });
    const take = () => q.fetch(new Request('https://quota/take?limit=3', { method: 'POST' })).then((r) => r.status);
    expect([await take(), await take(), await take(), await take()]).toEqual([200, 200, 200, 429]);
    vi.setSystemTime(new Date('2026-10-09T00:00:01Z'));
    expect(await take()).toBe(200);
    vi.useRealTimers();
  });
});
