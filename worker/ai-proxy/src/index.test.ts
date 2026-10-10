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
  const quotaLimits: string[] = [];
  const quotaGiven: string[] = [];
  const aiRuns: { model: string; inputs: Record<string, unknown> }[] = [];
  let aiAnswer: (inputs: Record<string, unknown>) => unknown = () => ({ choices: [{ message: { role: 'assistant', content: 'Do set 1 now.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
  const env = (over: Partial<Env> = {}): Env => ({
    TINFOIL_API_KEY: 'tk_secret',
    FIREBASE_PROJECT_ID: PROJECT,
    ALLOWED_ORIGINS: `${ORIGIN}, capacitor://localhost`,
    PER_USER: { limit: async () => ({ success: true }) },
    PER_IP: { limit: async () => ({ success: true }) },
    QUOTA: {
      idFromName: (n: string) => n,
      get: (id) => ({
        fetch: async (url: string) => {
          if (new URL(url).pathname === '/give') {
            quotaGiven.push(String(id));
            return new Response('ok');
          }
          quotaTaken.push(String(id));
          quotaLimits.push(new URL(url).searchParams.get('limit') || '');
          return new Response('ok');
        },
      }),
    },
    AI: {
      run: async (model, inputs) => {
        aiRuns.push({ model, inputs });
        return aiAnswer(inputs);
      },
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
    quotaLimits.length = 0;
    quotaGiven.length = 0;
    aiRuns.length = 0;
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

  describe('the free AI', () => {
    const chat = { messages: [{ role: 'user', content: 'Hi' }] };
    const callFree = async (body: unknown = chat, e = env(), headers: Record<string, string> = {}) =>
      worker.fetch(
        new Request('https://ai.example.workers.dev/free/v1/chat/completions', {
          method: 'POST',
          headers: { origin: ORIGIN, authorization: `Bearer ${await token()}`, 'content-type': 'application/json', ...headers },
          body: typeof body === 'string' ? body : JSON.stringify(body),
        }),
        e,
      );
    const answerWith = (fn: typeof aiAnswer) => {
      aiAnswer = fn;
    };
    const normal = aiAnswer;
    afterEach(() => {
      aiAnswer = normal;
    });

    it('answers with Workers AI, and never calls Tinfoil or uses its key', async () => {
      const calls = stubFetch(() => new Response('x'));
      const res = await callFree();
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
      expect((await res.json()).choices[0].message.content).toBe('Do set 1 now.');
      expect(aiRuns).toHaveLength(1);
      expect(calls).toHaveLength(0);
    });

    it('needs a valid sign-in', async () => {
      stubFetch(() => new Response('x'));
      const res = await callFree(chat, env(), { authorization: 'Bearer junk' });
      expect(res.status).toBe(401);
      expect(await res.text()).toContain('free AI');
      expect((await callFree(chat, env(), { authorization: '' })).status).toBe(401);
      expect(aiRuns).toHaveLength(0);
    });

    it('always uses its own model, and passes on only the allowed fields', async () => {
      stubFetch(() => new Response('x'));
      await callFree({ ...chat, model: '@cf/meta/a-pricey-model', temperature: 0.5, max_tokens: 900, reasoning_effort: 'low', response_format: { type: 'json_object' }, tools: [{ type: 'function' }], user: 'me@example.com', lora: 'x' });
      expect(aiRuns[0].model).toBe('@cf/openai/gpt-oss-120b');
      expect(aiRuns[0].inputs).toEqual({ ...chat, temperature: 0.5, max_tokens: 900, reasoning_effort: 'low', response_format: { type: 'json_object' } });
      await callFree({ ...chat, reasoning_effort: 'extreme' });
      expect(aiRuns[1].inputs).toEqual({ ...chat, max_tokens: 8000 });
    });

    it('refuses a request without messages, without using the allowance', async () => {
      stubFetch(() => new Response('x'));
      expect((await callFree({ prompt: 'Hi' })).status).toBe(400);
      expect((await callFree('not json')).status).toBe(400);
      expect(aiRuns).toHaveLength(0);
      expect(quotaTaken).toEqual([]);
    });

    it("caps what one request can use of everybody's allowance", async () => {
      stubFetch(() => new Response('x'));
      await callFree({ ...chat, max_tokens: 1_000_000_000 });
      await callFree({ ...chat, max_tokens: -5 });
      expect(aiRuns.map((r) => r.inputs.max_tokens)).toEqual([8000, 8000]);
      const res = await callFree({ messages: [{ role: 'user', content: 'x'.repeat(2_000_000) }] });
      expect(res.status).toBe(413);
      expect((await res.json()).error.message).toContain('more than the free AI takes at once');
      expect((await callFree(chat, env(), { 'content-length': '5000000' })).status).toBe(413);
      expect(aiRuns).toHaveLength(2);
      expect(quotaTaken).toHaveLength(2);
    });

    it('has its own daily allowance, apart from the private AI', async () => {
      stubFetch(() => new Response('x'));
      await callFree();
      expect(quotaTaken).toEqual(['free:user-1']);
      expect(quotaLimits).toEqual(['15']);
      await callFree(chat, env({ FREE_DAILY_LIMIT: '5' }));
      expect(quotaLimits[1]).toBe('5');
      const full = env({ QUOTA: { idFromName: (n) => n, get: () => ({ fetch: async () => new Response('limit', { status: 429 }) }) } });
      const res = await callFree(chat, full);
      expect(res.status).toBe(429);
      expect(await res.text()).toContain("today's free AI allowance");
      expect(aiRuns).toHaveLength(2);
    });

    it('passes a streamed answer straight through', async () => {
      stubFetch(() => new Response('x'));
      const events = 'data: {"choices":[{"delta":{"content":"Do "}}]}\n\ndata: {"choices":[{"delta":{"content":"it."}}]}\n\ndata: [DONE]\n\n';
      answerWith(() => new Response(events).body);
      const res = await callFree({ ...chat, stream: true, stream_options: { include_usage: true } });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/event-stream');
      expect(await res.text()).toBe(events);
      expect(aiRuns[0].inputs).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    });

    it('says clearly when the free allowance is used up, or the request was wrong, or it is busy', async () => {
      stubFetch(() => new Response('x'));
      answerWith(() => {
        throw new Error('3036: You have used up your daily free allocation of 10,000 neurons, please upgrade to Cloudflare Workers Paid plan.');
      });
      let res = await callFree();
      expect(res.status).toBe(429);
      expect((await res.json()).error.message).toBe("The free AI has used up today's allowance. It resets at midnight UTC.");
      answerWith(() => {
        throw new Error('5006: Error: required properties at "/" are "messages"');
      });
      expect((await callFree()).status).toBe(400);
      expect(quotaGiven).toEqual(['free:user-1', 'free:user-1']); // no answer and nothing used: those don't count
      answerWith(() => {
        throw new Error('3040: Out of capacity');
      });
      res = await callFree();
      expect(res.status).toBe(429);
      expect((await res.json()).error.message).toContain('busy');
      expect(quotaGiven).toHaveLength(2);
    });

    it('lists just its one model, without using the allowance', async () => {
      stubFetch(() => new Response('x'));
      const res = await worker.fetch(new Request('https://ai.example.workers.dev/free/v1/models', { headers: { origin: ORIGIN, authorization: `Bearer ${await token()}` } }), env());
      expect(res.status).toBe(200);
      expect((await res.json()).data.map((m: { id: string }) => m.id)).toEqual(['@cf/openai/gpt-oss-120b']);
      expect(quotaTaken).toEqual([]);
      expect(aiRuns).toHaveLength(0);
    });

    it('only serves its chat and model list paths', async () => {
      stubFetch(() => new Response('x'));
      const get = await worker.fetch(new Request('https://ai.example.workers.dev/free/v1/chat/completions', { headers: { origin: ORIGIN, authorization: `Bearer ${await token()}` } }), env());
      expect(get.status).toBe(405);
      expect((await worker.fetch(new Request('https://ai.example.workers.dev/free/v1/files', { method: 'POST', headers: { origin: ORIGIN } }), env())).status).toBe(404);
      expect(aiRuns).toHaveLength(0);
    });
  });
});

describe('daily allowance', () => {
  const storage = () => {
    const m = new Map<string, unknown>();
    const alarm = { at: 0 };
    return {
      m,
      alarm,
      get: async <T>(k: string) => m.get(k) as T | undefined,
      put: async (k: string, v: unknown) => void m.set(k, v),
      deleteAll: async () => m.clear(),
      setAlarm: async (t: number) => void (alarm.at = t),
    };
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

  it('takes one back for a request that got no answer', async () => {
    const st = storage();
    const q = new Quota({ storage: st });
    const take = () => q.fetch(new Request('https://quota/take?limit=1', { method: 'POST' })).then((r) => r.status);
    const give = () => q.fetch(new Request('https://quota/give', { method: 'POST' }));
    await give(); // nothing to give back yet
    expect(await take()).toBe(200);
    expect(await take()).toBe(429);
    await give();
    expect(await take()).toBe(200);
  });

  it("deletes the account's counter at midnight UTC, so nothing is kept after the day", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-08T22:30:00Z'));
    const st = storage();
    const q = new Quota({ storage: st });
    expect((await q.fetch(new Request('https://quota/take?limit=3', { method: 'POST' }))).status).toBe(200);
    expect(st.m.size).toBe(1);
    expect(new Date(st.alarm.at).toISOString()).toBe('2026-10-09T00:00:00.000Z');
    await q.alarm();
    expect(st.m.size).toBe(0);
    vi.useRealTimers();
  });
});
