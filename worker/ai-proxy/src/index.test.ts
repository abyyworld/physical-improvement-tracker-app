import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import worker, { FREE_MODELS, KEEP_ENDED, Plan, Quota, planActive, verifyFirebaseToken, type Env, type PlanRecord } from './index';

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

// A Durable Object's storage, in memory.
const memory = () => {
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

// Arise Private's records, one real Plan per account, in memory.
function plans() {
  const all = new Map<string, { plan: Plan; storage: ReturnType<typeof memory> }>();
  const one = (uid: string) => {
    if (!all.has(uid)) {
      const storage = memory();
      all.set(uid, { plan: new Plan({ storage }), storage });
    }
    return all.get(uid)!;
  };
  return {
    all,
    one,
    ns: { idFromName: (n: string) => n, get: (id: unknown) => ({ fetch: (url: string, init?: RequestInit) => one(String(id)).plan.fetch(new Request(url, init)) }) },
  };
}

// Before Arise Private, everybody had the private AI's whole daily allowance. The tests of how the
// proxy works sign in with an account that has the plan, so they still see that. It renews far in
// the future, since a plan long past its renewal date has lapsed.
const RENEWS = '2099-11-18T10:00:00.000000Z';
const SUBSCRIBED: PlanRecord = { status: 'active', variant: 'Monthly', renewsAt: RENEWS, endsAt: null, portal: 'https://arise.lemonsqueezy.com/billing', updatedAt: '2026-10-18T10:00:00.000000Z' };
const subscriber = { idFromName: (n: string) => n, get: () => ({ fetch: async () => new Response(JSON.stringify(SUBSCRIBED)) }) };

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
  const quotaUsed = { n: 0 }; // what the counter says was used today
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
          if (new URL(url).pathname === '/used') return new Response(JSON.stringify({ n: quotaUsed.n }));
          quotaTaken.push(String(id));
          quotaLimits.push(new URL(url).searchParams.get('limit') || '');
          return new Response('ok');
        },
      }),
    },
    PLAN: subscriber,
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
    quotaUsed.n = 0;
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

  it('gives the count back when the enclave gives no answer', async () => {
    stubFetch(() => new Response('{"error":"busy"}', { status: 503 }));
    expect((await call()).status).toBe(503);
    expect(quotaTaken).toEqual(['user-1']);
    expect(quotaGiven).toEqual(['user-1']);
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.startsWith('https://www.googleapis.com/')) return jwks();
      throw new TypeError('Network down');
    });
    const res = await call();
    expect(res.status).toBe(502);
    expect((await res.json()).error.message).toBe("Couldn't reach the private AI. Try again in a minute.");
    expect(quotaGiven).toEqual(['user-1', 'user-1']);
  });

  describe('Arise Private', () => {
    const SECRET = 'a-long-random-signing-secret-for-the-tests';
    const UID = 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9v';
    const LINKS = { LEMON_CHECKOUT_MONTHLY: 'https://arise.lemonsqueezy.com/buy/monthly-id', LEMON_CHECKOUT_YEARLY: 'https://arise.lemonsqueezy.com/buy/yearly-id' };
    const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
    async function sign(body: string, secret = SECRET) {
      const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
    }
    // What Lemon Squeezy sends: the subscription, with the person's name and email in it too.
    const event = (name: string, attributes: Record<string, unknown> = {}, { uid = UID as unknown, type = 'subscriptions', id = '42' as unknown, test = false } = {}) =>
      JSON.stringify({
        meta: { event_name: name, test_mode: test, custom_data: { uid } },
        data: {
          type,
          id,
          attributes: {
            store_id: 1,
            customer_id: 2,
            product_name: 'Arise Private',
            variant_name: 'Monthly',
            user_name: 'Sam Example',
            user_email: 'sam@example.com',
            status: 'active',
            card_brand: 'visa',
            card_last_four: '4242',
            renews_at: RENEWS,
            ends_at: null,
            test_mode: test,
            created_at: '2026-10-18T10:00:00.000000Z',
            updated_at: '2026-10-18T10:00:00.000000Z',
            urls: { update_payment_method: 'https://arise.lemonsqueezy.com/subscription/42/payment-details', customer_portal: 'https://arise.lemonsqueezy.com/billing?expires=1&signature=abc' },
            ...attributes,
          },
        },
      });
    const hook = async (body: string, e: Env, { signature, method = 'POST' }: { signature?: string; method?: string } = {}) =>
      worker.fetch(new Request('https://ai.example.workers.dev/billing/lemon', { method, headers: { 'content-type': 'application/json', 'x-signature': signature ?? (await sign(body)) }, body: method === 'GET' ? undefined : body }), e);
    const getPlan = async (e: Env, uid = UID) => worker.fetch(new Request('https://ai.example.workers.dev/v1/plan', { headers: { origin: ORIGIN, authorization: `Bearer ${await token({ sub: uid })}` } }), e);
    const setup = (over: Partial<Env> = {}) => {
      const p = plans();
      return { p, e: env({ PLAN: p.ns, LEMON_WEBHOOK_SECRET: SECRET, ...LINKS, ...over }) };
    };

    it('keeps a subscription Lemon Squeezy signed, and nothing about the person', async () => {
      stubFetch(() => new Response('x'));
      const { p, e } = setup();
      const res = await hook(event('subscription_created'), e);
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
      const kept = p.one(UID).storage.m.get('subs');
      // The link to manage it is the store's billing page: the signed one Lemon Squeezy sends
      // stops working after 24 hours.
      expect(kept).toEqual({ 42: { status: 'active', variant: 'Monthly', renewsAt: RENEWS, endsAt: null, portal: 'https://arise.lemonsqueezy.com/billing', updatedAt: '2026-10-18T10:00:00.000000Z' } });
      expect(JSON.stringify(kept)).not.toMatch(/sam|4242|visa|signature|expires/i);
      const plan = await getPlan(e);
      expect(plan.status).toBe(200);
      expect(plan.headers.get('access-control-allow-origin')).toBe(ORIGIN);
      expect(await plan.json()).toEqual({ plan: 'private', left: 150, limit: 150, renewsAt: RENEWS, endsAt: null, portal: 'https://arise.lemonsqueezy.com/billing', checkout: { monthly: LINKS.LEMON_CHECKOUT_MONTHLY, yearly: LINKS.LEMON_CHECKOUT_YEARLY } });
    });

    it('serves a link to manage the subscription that keeps working, not the signed one', async () => {
      stubFetch(() => new Response('x'));
      const { e } = setup();
      const portal = (url: unknown) => event('subscription_updated', { urls: { customer_portal: url } });
      expect((await hook(portal('https://arise.lemonsqueezy.com/billing?expires=1700000000&signature=0a1b2c'), e)).status).toBe(200);
      expect((await (await getPlan(e)).json()).portal).toBe('https://arise.lemonsqueezy.com/billing');
      // A store on its own address keeps it.
      expect((await hook(event('subscription_updated', { updated_at: '2026-10-18T11:00:00.000000Z', urls: { customer_portal: 'https://shop.example.com/billing?expires=1&signature=s' } }), e)).status).toBe(200);
      expect((await (await getPlan(e)).json()).portal).toBe('https://shop.example.com/billing');
      for (const bad of ['javascript:alert(1)', 'http://arise.lemonsqueezy.com/billing', 42, `https://${'a'.repeat(2000)}.com`]) {
        const { e: fresh } = setup();
        expect((await hook(portal(bad), fresh)).status).toBe(200);
        expect((await (await getPlan(fresh)).json()).portal).toBe('');
      }
    });

    it("ignores a purchase made in Lemon Squeezy's Test mode, unless the account is set to try it", async () => {
      stubFetch(() => new Response('x'));
      const { p, e } = setup();
      const res = await hook(event('subscription_created', {}, { test: true }), e);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('Test mode, ignored.');
      expect(p.all.size).toBe(0);
      // Only the attributes say so: still test mode.
      const marked = JSON.parse(event('subscription_created'));
      marked.data.attributes.test_mode = true;
      expect((await hook(JSON.stringify(marked), e)).status).toBe(200);
      expect(p.all.size).toBe(0);
      // Another account set to try it doesn't make this one count.
      expect((await hook(event('subscription_created', {}, { test: true }), { ...e, LEMON_TEST_UIDS: 'other1234567890abcdefghij' })).status).toBe(200);
      expect(p.all.size).toBe(0);
      expect((await (await getPlan(e)).json()).plan).toBe('free');
      const tester = { ...e, LEMON_TEST_UIDS: `other1234567890abcdefghij, ${UID}` };
      expect(await (await hook(event('subscription_created', {}, { test: true }), tester)).text()).toBe('OK.');
      expect((await (await getPlan(tester)).json()).plan).toBe('private');
    });

    it("keeps each subscription apart: another one ending doesn't end the plan", async () => {
      stubFetch(() => new Response('x'));
      const { p, e } = setup();
      const at = (h: number) => `2026-10-18T${String(h).padStart(2, '0')}:00:00.000000Z`;
      const status = async () => (await (await getPlan(e)).json()).plan;
      // A yearly plan, then a second one bought by mistake on another device.
      expect((await hook(event('subscription_created', { variant_name: 'Yearly', updated_at: at(10) }, { id: '41' }), e)).status).toBe(200);
      expect((await hook(event('subscription_created', { updated_at: at(11) }, { id: 99 }), e)).status).toBe(200);
      // The second is cancelled and ends: the yearly one still counts.
      expect((await hook(event('subscription_cancelled', { status: 'cancelled', ends_at: '2026-10-18T13:00:00.000000Z', updated_at: at(12) }, { id: 99 }), e)).status).toBe(200);
      expect((await hook(event('subscription_expired', { status: 'expired', ends_at: '2026-10-18T13:00:00.000000Z', updated_at: at(13) }, { id: 99 }), e)).status).toBe(200);
      expect(await status()).toBe('private');
      expect(await (await getPlan(e)).json()).toMatchObject({ plan: 'private', renewsAt: RENEWS, endsAt: null });
      expect(Object.keys(p.one(UID).storage.m.get('subs') as object).sort()).toEqual(['41', '99']);
      // Each is put in order on its own: an older message about one changes nothing.
      expect((await hook(event('subscription_updated', { status: 'active', updated_at: at(11) }, { id: 99 }), e)).status).toBe(200);
      expect((p.one(UID).storage.m.get('subs') as Record<string, PlanRecord>)['99'].status).toBe('expired');
      // The yearly one ends too: now it's over.
      expect((await hook(event('subscription_expired', { status: 'expired', ends_at: at(14), updated_at: at(14) }, { id: '41' }), e)).status).toBe(200);
      expect(await status()).toBe('free');
      // Without a subscription id, there's nothing to keep it under.
      for (const id of [null, '', 'a/b', {}]) expect((await hook(event('subscription_created', {}, { id }), e)).status).toBe(400);
    });

    it('refuses a webhook without the right signature, or before the secret is set', async () => {
      stubFetch(() => new Response('x'));
      const { p, e } = setup();
      const body = event('subscription_created');
      expect((await hook(body, e, { signature: '' })).status).toBe(401);
      expect((await hook(body, e, { signature: 'not-hex' })).status).toBe(401);
      expect((await hook(body, e, { signature: await sign(body, 'another-secret') })).status).toBe(401);
      expect((await hook(body.replace('active', 'on_trial'), e, { signature: await sign(body) })).status).toBe(401); // changed after signing
      expect((await hook(body, { ...e, LEMON_WEBHOOK_SECRET: '' })).status).toBe(401);
      expect((await hook(body, { ...e, LEMON_WEBHOOK_SECRET: undefined })).status).toBe(401);
      expect(p.all.size).toBe(0);
      expect((await hook(body, e, { method: 'GET' })).status).toBe(405);
    });

    it('refuses what it cannot use, and says yes to what it does not need', async () => {
      stubFetch(() => new Response('x'));
      const { p, e } = setup();
      expect((await hook('not json', e)).status).toBe(400);
      expect((await hook(event('subscription_created', {}, { uid: '' }), e)).status).toBe(400);
      expect((await hook(event('subscription_created', {}, { uid: 'user-1' }), e)).status).toBe(400); // not a Firebase account id
      expect((await hook(event('subscription_created', {}, { uid: 42 }), e)).status).toBe(400);
      expect((await hook(event('subscription_created', { status: 'free-forever' }), e)).status).toBe(400);
      expect((await hook(event('subscription_created', { updated_at: 'soon' }), e)).status).toBe(400);
      expect((await hook('x'.repeat(70_000), e)).status).toBe(400);
      expect((await hook(event('order_created'), e)).status).toBe(200);
      expect((await hook(event('license_key_created'), e)).status).toBe(200);
      // A payment's message is about the invoice: it changes nothing.
      expect((await hook(event('subscription_payment_success', { status: 'paid' }, { type: 'subscription-invoices' }), e)).status).toBe(200);
      expect(p.all.size).toBe(0);
    });

    it('takes every subscription event, and ignores one older than what it has', async () => {
      stubFetch(() => new Response('x'));
      const { p, e } = setup();
      const at = (h: number) => `2026-10-18T${String(h).padStart(2, '0')}:00:00.000000Z`;
      const status = async () => (await (await getPlan(e)).json()).plan;
      expect(await status()).toBe('free');
      for (const name of ['subscription_created', 'subscription_updated', 'subscription_resumed', 'subscription_unpaused', 'subscription_payment_success']) {
        expect((await hook(event(name, { updated_at: at(10) }), e)).status).toBe(200);
      }
      expect(await status()).toBe('private');
      expect((await hook(event('subscription_paused', { status: 'paused', updated_at: at(12) }), e)).status).toBe(200);
      expect(await status()).toBe('free');
      // Sent before the pause, arriving after it.
      expect((await hook(event('subscription_updated', { status: 'active', updated_at: at(11) }), e)).status).toBe(200);
      expect(await status()).toBe('free');
      expect((p.one(UID).storage.m.get('subs') as Record<string, PlanRecord>)['42']).toMatchObject({ status: 'paused', updatedAt: at(12) });
      expect((await hook(event('subscription_unpaused', { status: 'active', updated_at: at(13) }), e)).status).toBe(200);
      expect(await status()).toBe('private');
      expect((await hook(event('subscription_cancelled', { status: 'cancelled', ends_at: '2099-11-18T10:00:00.000000Z', updated_at: at(14) }), e)).status).toBe(200);
      const plan = await (await getPlan(e)).json();
      expect(plan).toMatchObject({ plan: 'private', endsAt: '2099-11-18T10:00:00.000000Z' });
      expect((await hook(event('subscription_expired', { status: 'expired', ends_at: '2026-10-18T15:00:00.000000Z', updated_at: at(15) }), e)).status).toBe(200);
      expect(await status()).toBe('free');
    });

    it('counts a plan as active while paid, on a trial, retrying a payment, or cancelled until its end', () => {
      const now = Date.parse('2026-10-19T12:00:00Z');
      const plan = (status: string, endsAt: string | null = null): PlanRecord => ({ ...SUBSCRIBED, status, endsAt });
      expect(['active', 'on_trial', 'past_due'].map((s) => planActive(plan(s), now))).toEqual([true, true, true]);
      expect(['paused', 'unpaid', 'expired'].map((s) => planActive(plan(s), now))).toEqual([false, false, false]);
      expect(planActive(plan('cancelled', '2026-10-20T00:00:00Z'), now)).toBe(true);
      expect(planActive(plan('cancelled', '2026-10-19T11:59:59Z'), now)).toBe(false);
      expect(planActive(plan('cancelled'), now)).toBe(false);
      expect(planActive(null, now)).toBe(false);
    });

    it('lets a paid-up plan lapse when nothing renewed it three weeks after its renewal date', () => {
      const renewsAt = '2026-10-01T10:00:00.000000Z';
      const late = (days: number) => Date.parse(renewsAt) + days * 24 * 3600 * 1000;
      for (const status of ['active', 'on_trial', 'past_due']) {
        const p: PlanRecord = { ...SUBSCRIBED, status, renewsAt };
        expect(planActive(p, late(-1))).toBe(true);
        expect(planActive(p, late(14))).toBe(true); // Lemon Squeezy is still trying the payment
        expect(planActive(p, late(20.9))).toBe(true);
        expect(planActive(p, late(21))).toBe(false);
        expect(planActive(p, late(400))).toBe(false);
      }
      // The owner's has no renewal date, and never lapses.
      expect(planActive({ ...SUBSCRIBED, renewsAt: null }, late(4000))).toBe(true);
    });

    it('gives an account without the plan 5 private questions a day, then says how to get more', async () => {
      const calls = stubFetch(() => new Response('ENCRYPTED ANSWER'));
      const { e } = setup();
      expect((await call({}, e)).status).toBe(200);
      expect(quotaLimits).toEqual(['5']);
      expect(quotaTaken).toEqual(['user-1']); // the same counter as with the plan
      await call({}, { ...e, PRIVATE_FREE_LIMIT: '3' });
      expect(quotaLimits[1]).toBe('3');
      const full = { ...e, QUOTA: { idFromName: (n: string) => n, get: () => ({ fetch: async () => new Response('limit', { status: 429 }) }) } };
      const res = await call({}, full);
      expect(res.status).toBe(429);
      expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
      const body = await res.json();
      expect(body.error.message).toBe("You've used today's 5 free private questions. Arise Private gives you the private AI all day for $5 a month.");
      expect(body.error.code).toBe('plan');
      expect(body.code).toBe('plan');
      // Before it's on sale, it doesn't offer it.
      const soon = await call({}, { ...full, LEMON_CHECKOUT_MONTHLY: '', LEMON_CHECKOUT_YEARLY: undefined });
      expect((await soon.json()).error).toEqual({ message: "You've used today's 5 free private questions. They start again at midnight UTC.", code: 'plan' });
      expect(calls).toHaveLength(2);
    });

    it('gives an account with the plan the whole daily allowance', async () => {
      stubFetch(() => new Response('ENCRYPTED ANSWER'));
      const { e } = setup();
      expect((await hook(event('subscription_created'), e)).status).toBe(200);
      const as = async (over: Partial<Env> = {}) =>
        worker.fetch(
          new Request('https://ai.example.workers.dev/v1/chat/completions', {
            method: 'POST',
            headers: { origin: ORIGIN, authorization: `Bearer ${await token({ sub: UID })}`, 'x-tinfoil-enclave-url': 'https://router.inf6.tinfoil.sh', 'content-type': 'application/json' },
            body: 'ENCRYPTED',
          }),
          { ...e, ...over },
        );
      expect((await as()).status).toBe(200);
      expect(quotaLimits).toEqual(['150']);
      await as({ DAILY_LIMIT: '400' });
      expect(quotaLimits[1]).toBe('400');
      const res = await as({ QUOTA: { idFromName: (n: string) => n, get: () => ({ fetch: async () => new Response('limit', { status: 429 }) }) } });
      expect(res.status).toBe(429);
      const body = await res.json();
      expect(body.error.message).toBe("You've used today's private AI allowance. It resets at midnight UTC.");
      expect(body.code).toBeUndefined();
    });

    it("always gives the owner's own accounts the plan, without a subscription", async () => {
      stubFetch(() => new Response('ENCRYPTED ANSWER'));
      const { e } = setup();
      const owner = { ...e, OWNER_UIDS: ` other1234567890abcdefghij , ${UID}` };
      const res = await getPlan(owner);
      expect(await res.json()).toMatchObject({ plan: 'private', limit: 150, renewsAt: null, endsAt: null, portal: '' });
      const ask = await worker.fetch(
        new Request('https://ai.example.workers.dev/v1/chat/completions', {
          method: 'POST',
          headers: { origin: ORIGIN, authorization: `Bearer ${await token({ sub: UID })}`, 'x-tinfoil-enclave-url': 'https://router.inf6.tinfoil.sh', 'content-type': 'application/json' },
          body: 'ENCRYPTED',
        }),
        owner,
      );
      expect(ask.status).toBe(200);
      expect(quotaLimits).toEqual(['150']);
      // Anyone else is still on the free plan.
      expect((await (await getPlan({ ...e, OWNER_UIDS: 'other1234567890abcdefghij' })).json()).plan).toBe('free');
      expect((await (await getPlan({ ...e, OWNER_UIDS: '' })).json()).plan).toBe('free');
    });

    it("says which plan the account has and how many private questions are left today, without using one", async () => {
      stubFetch(() => new Response('x'));
      const { e } = setup();
      quotaUsed.n = 2;
      const res = await getPlan(e);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.json()).toEqual({ plan: 'free', left: 3, limit: 5, renewsAt: null, endsAt: null, portal: '', checkout: { monthly: LINKS.LEMON_CHECKOUT_MONTHLY, yearly: LINKS.LEMON_CHECKOUT_YEARLY } });
      quotaUsed.n = 9;
      expect((await (await getPlan(e)).json()).left).toBe(0);
      // Not set up yet, or not a real link: no checkout.
      const none = await getPlan({ ...e, LEMON_CHECKOUT_MONTHLY: undefined, LEMON_CHECKOUT_YEARLY: 'javascript:alert(1)' });
      expect((await none.json()).checkout).toEqual({ monthly: '', yearly: '' });
      expect(quotaTaken).toEqual([]);
    });

    it('only tells a signed-in account about its own plan', async () => {
      stubFetch(() => new Response('x'));
      const { e } = setup();
      expect((await hook(event('subscription_created'), e)).status).toBe(200);
      const res = await worker.fetch(new Request('https://ai.example.workers.dev/v1/plan', { headers: { origin: ORIGIN, authorization: 'Bearer junk' } }), e);
      expect(res.status).toBe(401);
      expect((await (await getPlan(e, 'someoneElse1234567890abcd')).json()).plan).toBe('free');
      const post = await worker.fetch(new Request('https://ai.example.workers.dev/v1/plan', { method: 'POST', headers: { origin: ORIGIN, authorization: `Bearer ${await token({ sub: UID })}` } }), e);
      expect(post.status).toBe(405);
      const other = await worker.fetch(new Request('https://ai.example.workers.dev/v1/plan', { headers: { origin: 'https://evil.example', authorization: `Bearer ${await token({ sub: UID })}` } }), e);
      expect(other.status).toBe(403);
    });
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

    it('only uses a model on its list, and passes on only the allowed fields', async () => {
      stubFetch(() => new Response('x'));
      await callFree({ ...chat, model: '@cf/meta/a-pricey-model', temperature: 0.5, max_tokens: 900, reasoning_effort: 'low', response_format: { type: 'json_object' }, tools: [{ type: 'function' }], user: 'me@example.com', lora: 'x' });
      expect(aiRuns[0].model).toBe('@cf/openai/gpt-oss-120b');
      expect(aiRuns[0].inputs).toEqual({ ...chat, temperature: 0.5, max_tokens: 900, reasoning_effort: 'low', response_format: { type: 'json_object' } });
      await callFree({ ...chat, reasoning_effort: 'extreme' });
      expect(aiRuns[1].inputs).toEqual({ ...chat, max_tokens: 8000 });
    });

    it('uses the model the app asks for when it is on the list, and the default otherwise', async () => {
      stubFetch(() => new Response('x'));
      await callFree({ ...chat, model: '@cf/openai/gpt-oss-20b' });
      await callFree({ ...chat, model: '@cf/openai/gpt-oss-120b' });
      await callFree(chat);
      await callFree({ ...chat, model: '' });
      await callFree({ ...chat, model: ['@cf/openai/gpt-oss-20b'] });
      await callFree({ ...chat, model: 'gpt-oss-20b' });
      expect(aiRuns.map((r) => r.model)).toEqual(['@cf/openai/gpt-oss-20b', '@cf/openai/gpt-oss-120b', ...Array(4).fill('@cf/openai/gpt-oss-120b')]);
      expect(FREE_MODELS[0]).toBe('@cf/openai/gpt-oss-120b');
      expect(aiRuns.every((r) => !('model' in r.inputs))).toBe(true);
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

    it('lists the models on its list, default first, without using the allowance', async () => {
      stubFetch(() => new Response('x'));
      const res = await worker.fetch(new Request('https://ai.example.workers.dev/free/v1/models', { headers: { origin: ORIGIN, authorization: `Bearer ${await token()}` } }), env());
      expect(res.status).toBe(200);
      expect((await res.json()).data.map((m: { id: string }) => m.id)).toEqual(['@cf/openai/gpt-oss-120b', '@cf/openai/gpt-oss-20b']);
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
  it('says how many were used today, without using one', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-08T10:00:00Z'));
    const q = new Quota({ storage: memory() });
    const used = async () => (await (await q.fetch(new Request('https://quota/used'))).json()).n;
    expect(await used()).toBe(0);
    await q.fetch(new Request('https://quota/take?limit=5', { method: 'POST' }));
    await q.fetch(new Request('https://quota/take?limit=5', { method: 'POST' }));
    expect(await used()).toBe(2);
    expect(await used()).toBe(2);
    vi.setSystemTime(new Date('2026-10-09T00:00:01Z'));
    expect(await used()).toBe(0);
    vi.useRealTimers();
  });

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

describe("Arise Private's record", () => {
  const set = (plan: Plan, rec: Partial<PlanRecord> & { id?: unknown }) => plan.fetch(new Request('https://plan/set', { method: 'POST', body: JSON.stringify({ id: '42', ...SUBSCRIBED, ...rec }) }));
  const get = async (plan: Plan) => (await plan.fetch(new Request('https://plan/get'))).json();
  const DAY = 24 * 3600 * 1000;

  it('keeps only the newest about each subscription, and only what it needs', async () => {
    const storage = memory();
    const plan = new Plan({ storage });
    expect(await get(plan)).toBeNull();
    await set(plan, { status: 'past_due', updatedAt: '2026-10-18T12:00:00Z', email: 'sam@example.com' } as Partial<PlanRecord>);
    await set(plan, { status: 'active', updatedAt: '2026-10-18T11:00:00Z' });
    expect(await get(plan)).toEqual({ ...SUBSCRIBED, status: 'past_due', updatedAt: '2026-10-18T12:00:00Z' });
    expect((await plan.fetch(new Request('https://plan/set', { method: 'POST', body: 'junk' }))).status).toBe(400);
    expect((await set(plan, { id: undefined })).status).toBe(400);
    expect((await set(plan, { id: 42 })).status).toBe(400);
  });

  it('counts the account as having the plan while any of its subscriptions gives it', async () => {
    const storage = memory();
    const plan = new Plan({ storage });
    await set(plan, { id: '1', variant: 'Yearly', updatedAt: '2026-10-18T10:00:00Z' });
    await set(plan, { id: '2', status: 'expired', endsAt: '2026-10-18T13:00:00Z', updatedAt: '2026-10-18T13:00:00Z' });
    expect(await get(plan)).toMatchObject({ status: 'active', variant: 'Yearly' });
    // One that renews comes before one that only lasts until its end.
    await set(plan, { id: '3', status: 'cancelled', endsAt: '2099-01-01T00:00:00Z', updatedAt: '2026-10-18T14:00:00Z' });
    expect(await get(plan)).toMatchObject({ status: 'active', variant: 'Yearly' });
    await set(plan, { id: '1', status: 'expired', updatedAt: '2026-10-18T15:00:00Z' });
    expect(await get(plan)).toMatchObject({ status: 'cancelled', endsAt: '2099-01-01T00:00:00Z' });
    await set(plan, { id: '3', status: 'expired', updatedAt: '2026-10-18T16:00:00Z' });
    expect(planActive(await get(plan))).toBe(false);
  });

  it('deletes each subscription 30 days after it ends, and the record with the last one', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-19T12:00:00Z'));
    const storage = memory();
    const plan = new Plan({ storage });
    const subs = () => Object.keys((storage.m.get('subs') as object) || {});
    const renewsAt = '2026-11-18T10:00:00Z';
    await set(plan, { id: 'a', renewsAt });
    // Even a paid-up one goes, a month after it lapsed without renewing.
    expect(storage.alarm.at).toBe(Date.parse(renewsAt) + 21 * DAY + KEEP_ENDED);
    await set(plan, { id: 'b', status: 'cancelled', endsAt: '2026-10-25T10:00:00Z', updatedAt: '2026-10-19T00:00:00Z' });
    expect(storage.alarm.at).toBe(Date.parse('2026-10-25T10:00:00Z') + KEEP_ENDED);
    vi.setSystemTime(storage.alarm.at - 1);
    await plan.alarm();
    expect(subs()).toEqual(['a', 'b']);
    vi.setSystemTime(storage.alarm.at);
    await plan.alarm();
    expect(subs()).toEqual(['a']); // the other one stays
    // It renews: it stays longer.
    await set(plan, { id: 'a', renewsAt: '2026-12-18T10:00:00Z', updatedAt: '2026-11-18T10:00:00Z' });
    expect(storage.alarm.at).toBe(Date.parse('2026-12-18T10:00:00Z') + 21 * DAY + KEEP_ENDED);
    await set(plan, { id: 'a', status: 'expired', updatedAt: '2026-11-20T10:00:00Z' });
    expect(storage.alarm.at).toBe(Date.parse('2026-11-20T10:00:00Z') + KEEP_ENDED);
    vi.setSystemTime(storage.alarm.at);
    await plan.alarm();
    expect(storage.m.size).toBe(0);
    vi.useRealTimers();
  });
});

