// @vitest-environment jsdom
// The free AI chain's switching logic: reading each service's "limit reached" answers, working out
// when a limit starts again, and which keys can answer now. The error bodies below are the shapes
// each service documents or that people have posted from real answers.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as F from './free-ai';

const NOW = Date.UTC(2026, 9, 17, 15, 30); // Saturday 17 October 2026, 15:30 UTC (08:30 in California)
const MIN = 60_000;
const HOUR = 60 * MIN;

const reply = (service: string, status: number, body: unknown = '', headers: Record<string, string> = {}): F.Reply => ({ service, status, body: typeof body === 'string' ? body : JSON.stringify(body), headers });

// Google: a 429 with the quota that ran out (QuotaFailure) and a short RetryInfo.
const gemini = (quotaId: string, limit = '20') => ({
  error: {
    code: 429,
    message: `You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: ${limit}, model: gemini-2.5-flash\nPlease retry in 27.39s.`,
    status: 'RESOURCE_EXHAUSTED',
    details: [
      { '@type': 'type.googleapis.com/google.rpc.Help', links: [{ description: 'Learn more about Gemini API quotas', url: 'https://ai.google.dev/gemini-api/docs/rate-limits' }] },
      { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaId, quotaDimensions: { location: 'global', model: 'gemini-2.5-flash' }, quotaValue: limit }] },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '27s' },
    ],
  },
});

const groq = (what: string, wait: string) => ({
  error: {
    message: `Rate limit reached for model \`llama-3.3-70b-versatile\` in organization \`org_01abc\` service tier \`on_demand\` on ${what}: Limit 1000, Used 1000, Requested 1. Please try again in ${wait}. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing`,
    type: what.includes('tokens') ? 'tokens' : 'requests',
    code: 'rate_limit_exceeded',
  },
});

describe('reading a limit from each service', () => {
  it("Gemini: a daily limit rests until midnight in California, whatever its short retry hint says", () => {
    const f = F.classify(reply('google', 429, gemini('GenerateRequestsPerDayPerProjectPerModel-FreeTier')), NOW);
    expect(f).toEqual({ kind: 'limit', period: 'day', until: Date.UTC(2026, 9, 18, 7) }); // midnight PDT = 07:00 UTC
  });

  it('Gemini: a per-minute limit rests for the retry hint, and the billing words in it mean nothing', () => {
    const f = F.classify(reply('google', 429, gemini('GenerateRequestsPerMinutePerProjectPerModel-FreeTier')), NOW);
    expect(f).toEqual({ kind: 'limit', period: 'minute', until: NOW + 27_000 });
    expect(F.classify(reply('google', 429, gemini('GenerateContentInputTokensPerModelPerMinute-FreeTier')), NOW)).toMatchObject({ period: 'minute' });
  });

  it("Gemini: \"limit: 0\" means the model isn't free on this key (Pro models)", () => {
    expect(F.classify(reply('google', 429, gemini('GenerateRequestsPerDayPerProjectPerModel-FreeTier', '0')), NOW)).toEqual({ kind: 'model', until: NOW + 6 * HOUR, note: 'not-free' });
  });

  it("Groq: a daily limit rests as long as Groq says (its window rolls), a per-minute one too", () => {
    expect(F.classify(reply('groq', 429, groq('requests per day (RPD)', '1h26m4.4s'), { 'retry-after': '5165' }), NOW)).toEqual({ kind: 'limit', period: 'day', until: NOW + 5165_000 });
    // No retry-after header: the words say how long.
    expect(F.classify(reply('groq', 429, groq('tokens per day (TPD)', '17m29.6s')), NOW)).toEqual({ kind: 'limit', period: 'day', until: NOW + 1049_600 });
    expect(F.classify(reply('groq', 429, groq('tokens per minute (TPM)', '7.66s'), { 'retry-after': '8' }), NOW)).toEqual({ kind: 'limit', period: 'minute', until: NOW + 8000 });
  });

  it('Groq: a request bigger than the per-minute allowance is too big, not a limit', () => {
    const body = { error: { message: 'Request too large for model `llama-3.1-8b-instant` in organization `org_x` service tier `on_demand` on tokens per minute (TPM): Limit 6000, Requested 9000, please reduce your message size and try again.', type: 'tokens', code: 'rate_limit_exceeded' } };
    expect(F.classify(reply('groq', 413, body), NOW)).toEqual({ kind: 'too-big' });
  });

  it("OpenRouter: free models' daily limit rests until the reset it sends (midnight UTC)", () => {
    const reset = Date.UTC(2026, 9, 18);
    const body = { error: { message: 'Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day', code: 429, metadata: { headers: { 'X-RateLimit-Limit': '50', 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': String(reset) }, provider_name: null } }, user_id: 'user_x' };
    expect(F.classify(reply('openrouter', 429, body), NOW)).toEqual({ kind: 'limit', period: 'day', until: reset });
    // Without the reset: midnight UTC, as documented.
    expect(F.classify(reply('openrouter', 429, { error: { message: 'Rate limit exceeded: free-models-per-day.', code: 429 } }), NOW)).toEqual({ kind: 'limit', period: 'day', until: reset });
  });

  it('OpenRouter: the per-minute limit, a busy free model, and privacy settings that allow no free model', () => {
    expect(F.classify(reply('openrouter', 429, { error: { message: 'Rate limit exceeded: free-models-per-min.', code: 429 } }), NOW)).toMatchObject({ kind: 'limit', period: 'minute' });
    const upstream = { error: { message: 'Provider returned error', code: 429, metadata: { raw: 'meta-llama/llama-3.3-70b-instruct:free is temporarily rate-limited upstream. Please retry shortly.', provider_name: 'Venice' } } };
    expect(F.classify(reply('openrouter', 429, upstream), NOW)).toEqual({ kind: 'limit', period: 'minute', until: NOW + MIN });
    expect(F.classify(reply('openrouter', 404, { error: { message: 'No endpoints found matching your data policy (Free model publication). Configure: https://openrouter.ai/settings/privacy', code: 404 } }), NOW)).toEqual({ kind: 'key', note: 'policy' });
  });

  it("Cerebras: the daily limit rests until its reset header (seconds)", () => {
    const body = { message: 'Requests per day limit exceeded - too many requests sent.', type: 'too_many_requests_error', param: 'quota', code: 'request_quota_exceeded' };
    expect(F.classify(reply('cerebras', 429, body, { 'x-ratelimit-reset-requests-day': '33011.5' }), NOW)).toEqual({ kind: 'limit', period: 'day', until: NOW + 33_011_500 });
  });

  it('GitHub Models: the per-model daily limit, named in a header', () => {
    const body = { error: { code: 'RateLimitReached', message: 'Rate limit of 50 per 86400s exceeded for UserByModelByDay. Please wait 46080 seconds before retrying.', details: 'Rate limit of 50 per 86400s exceeded for UserByModelByDay.' } };
    expect(F.classify(reply('github', 429, body, { 'retry-after': '46080', 'x-ratelimit-type': 'UserByModelByDay' }), NOW)).toEqual({ kind: 'limit', period: 'day', until: NOW + 46_080_000 });
    const minute = { error: { code: 'RateLimitReached', message: 'Rate limit of 10 per 60s exceeded for UserByModelByMinute. Please wait 34 seconds before retrying.' } };
    expect(F.classify(reply('github', 429, minute, { 'retry-after': '34' }), NOW)).toEqual({ kind: 'limit', period: 'minute', until: NOW + 34_000 });
  });

  it('Cohere and Hugging Face: monthly allowances rest until the 1st', () => {
    const cohere = { message: "You are using a Trial key, which is limited to 1000 API calls / month. You can continue to use the Trial key for free or upgrade to a Production key with higher rate limits at 'https://dashboard.cohere.com/api-keys'." };
    expect(F.classify(reply('cohere', 429, cohere), NOW)).toEqual({ kind: 'limit', period: 'month', until: Date.UTC(2026, 10, 1) });
    const hf = { error: 'You have exceeded your monthly included credits for Inference Providers. Subscribe to PRO to get 20x more monthly included credits.' };
    expect(F.classify(reply('huggingface', 402, hf), NOW)).toEqual({ kind: 'limit', period: 'month', until: Date.UTC(2026, 10, 1) });
  });

  it('paid keys out of credit wait for the Player, whatever the status', () => {
    const openai = { error: { message: 'You exceeded your current quota, please check your plan and billing details.', type: 'insufficient_quota', param: null, code: 'insufficient_quota' } };
    expect(F.classify(reply('openai', 429, openai), NOW)).toEqual({ kind: 'credit' });
    const claude = { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.' } };
    expect(F.classify(reply('anthropic', 400, claude), NOW)).toEqual({ kind: 'credit' });
    expect(F.classify(reply('openrouter', 402, { error: { message: 'Insufficient credits', code: 402 } }), NOW)).toEqual({ kind: 'credit' });
  });

  it('Mistral, NVIDIA and services that say nothing: a short rest, longer only when they ask for hours', () => {
    expect(F.classify(reply('mistral', 429, { message: 'Requests rate limit exceeded' }), NOW)).toEqual({ kind: 'limit', period: 'minute', until: NOW + MIN });
    expect(F.classify(reply('nvidia', 429, { status: 429, title: 'Too Many Requests' }, { 'retry-after': '2' }), NOW)).toEqual({ kind: 'limit', period: 'minute', until: NOW + 5000 });
    expect(F.classify(reply('custom', 429, 'Too many requests', { 'retry-after': '7200' }), NOW)).toEqual({ kind: 'limit', period: 'day', until: NOW + 2 * HOUR });
    expect(F.classify(reply('custom', 429, 'Slow down', { 'retry-after': new Date(NOW + 30_000).toUTCString() }), NOW)).toEqual({ kind: 'limit', period: 'minute', until: NOW + 30_000 });
  });

  it('a rejected key, a busy server, no answer, and requests another key might take', () => {
    expect(F.classify(reply('groq', 401, { error: { message: 'Invalid API Key', type: 'invalid_request_error', code: 'invalid_api_key' } }), NOW)).toEqual({ kind: 'key' });
    expect(F.classify(reply('github', 403, { error: { message: 'The models:read permission is required' } }), NOW)).toEqual({ kind: 'key' });
    expect(F.classify(reply('openrouter', 403, { error: { message: 'Your input was flagged by moderation' } }), NOW)).toBeNull();
    expect(F.classify(reply('google', 503, { error: { code: 503, message: 'The model is overloaded. Please try again later.', status: 'UNAVAILABLE' } }), NOW)).toEqual({ kind: 'busy', until: NOW + MIN });
    expect(F.classify(reply('anthropic', 529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }), NOW)).toEqual({ kind: 'busy', until: NOW + MIN });
    expect(F.classify(reply('groq', 0), NOW)).toEqual({ kind: 'busy', until: NOW + MIN });
    expect(F.classify(reply('cohere', 400, { message: "invalid request: unknown field 'stream_options'" }), NOW)).toEqual({ kind: 'skip' });
    expect(F.classify(reply('cerebras', 400, { message: 'Please reduce the length of the messages or completion.' }), NOW)).toEqual({ kind: 'too-big' });
    expect(F.classify(reply('github', 413, { error: { code: 'tokens_limit_reached', message: 'Request body too large for gpt-4.1 model. Max size: 8000 tokens.' } }), NOW)).toEqual({ kind: 'too-big' });
    expect(F.classify(reply('google', 404, { error: { code: 404, message: 'models/gemini-0 is not found', status: 'NOT_FOUND' } }), NOW)).toEqual({ kind: 'model', until: NOW + HOUR });
  });
});

describe('when limits start again', () => {
  it('reads durations and reset times in every form services use', () => {
    expect(F.parseDuration('1m26.4s')).toBe(86_400);
    expect(F.parseDuration('2m59.56s')).toBe(179_560);
    expect(F.parseDuration('14h12m')).toBe(51_120_000);
    expect(F.parseDuration('7.66s')).toBe(7660);
    expect(F.parseDuration('250ms')).toBe(250);
    expect(F.parseDuration('soon')).toBeNull();
    expect(F.parseDuration('')).toBeNull();
    expect(F.resetValue('1766620800000', NOW)).toBe(1766620800000); // epoch milliseconds
    expect(F.resetValue('1766620800', NOW)).toBe(1766620800000); // epoch seconds
    expect(F.resetValue('30', NOW)).toBe(NOW + 30_000); // seconds from now
    expect(F.resetValue('2m', NOW)).toBe(NOW + 120_000);
    expect(F.resetValue('', NOW)).toBeNull();
  });

  it("finds the next midnight in California through both clock changes", () => {
    const pac = (t: number) => F.nextMidnight(F.PACIFIC, t);
    expect(pac(Date.UTC(2026, 0, 15, 12))).toBe(Date.UTC(2026, 0, 16, 8)); // winter: midnight PST is 08:00 UTC
    expect(pac(Date.UTC(2026, 6, 15, 12))).toBe(Date.UTC(2026, 6, 16, 7)); // summer: midnight PDT is 07:00 UTC
    expect(pac(Date.UTC(2026, 0, 16, 7, 59))).toBe(Date.UTC(2026, 0, 16, 8)); // a minute before
    expect(pac(Date.UTC(2026, 0, 16, 8))).toBe(Date.UTC(2026, 0, 17, 8)); // just after: the next one
    // Clocks go forward on Sunday 8 March 2026 at 2 am: Saturday night is still PST, Sunday night PDT.
    expect(pac(Date.UTC(2026, 2, 7, 20))).toBe(Date.UTC(2026, 2, 8, 8));
    expect(pac(Date.UTC(2026, 2, 8, 12))).toBe(Date.UTC(2026, 2, 9, 7));
    // Clocks go back on Sunday 1 November 2026 at 2 am, including from the hour that happens twice.
    expect(pac(Date.UTC(2026, 9, 31, 12))).toBe(Date.UTC(2026, 10, 1, 7));
    expect(pac(Date.UTC(2026, 10, 1, 8, 30))).toBe(Date.UTC(2026, 10, 2, 8));
    expect(pac(Date.UTC(2026, 10, 1, 9, 30))).toBe(Date.UTC(2026, 10, 2, 8));
  });

  it('midnight UTC, the 1st of the month, and each service', () => {
    expect(F.nextMidnight('UTC', NOW)).toBe(Date.UTC(2026, 9, 18));
    expect(F.nextMonth(Date.UTC(2026, 11, 31, 23))).toBe(Date.UTC(2027, 0, 1));
    expect(F.resetAt('google', 'day', NOW)).toBe(Date.UTC(2026, 9, 18, 7));
    expect(F.resetAt('groq', 'day', NOW)).toBe(Date.UTC(2026, 9, 18));
    expect(F.resetAt('nvidia', 'day', NOW)).toBe(NOW + 24 * HOUR);
    expect(F.resetAt('mistral', 'month', NOW)).toBe(Date.UTC(2026, 10, 1));
    expect(F.resetAt('custom', 'week', NOW)).toBe(NOW + 7 * 24 * HOUR);
    expect(F.resetAt('custom', 'minute', NOW)).toBe(NOW + MIN);
  });
});

describe('which keys answer', () => {
  const k = (id: string) => ({ id });

  it("keeps the Player's order, skips resting keys, and lists them soonest free first", () => {
    const cools: Record<string, F.AICool> = {
      b: { why: 'day', until: NOW + 5 * HOUR, at: NOW },
      c: { why: 'minute', until: NOW + MIN, at: NOW },
      d: { why: 'busy', until: NOW - 1, at: NOW - MIN }, // over: answers again
      e: { why: 'key', until: 0, at: NOW },
      f: { why: 'credit', until: 0, at: NOW },
    };
    const out = F.plan(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(k), cools, NOW, (x) => (x.id === 'g' ? 'consent' : null));
    expect(out.ready.map((x) => x.id)).toEqual(['a', 'd']);
    expect(out.waiting.map((x) => x.key.id)).toEqual(['c', 'b']);
    expect(out.off.map((x) => `${x.key.id}:${x.why}`)).toEqual(['e:key', 'f:credit', 'g:consent']);
  });

  it('turns each failure into a rest (or none)', () => {
    expect(F.coolFor({ kind: 'limit', period: 'day', until: NOW + HOUR }, NOW)).toEqual({ why: 'day', until: NOW + HOUR, at: NOW });
    expect(F.coolFor({ kind: 'busy', until: NOW + MIN }, NOW)).toEqual({ why: 'busy', until: NOW + MIN, at: NOW });
    expect(F.coolFor({ kind: 'model', until: NOW + HOUR, note: 'not-free' }, NOW)).toEqual({ why: 'model', until: NOW + HOUR, at: NOW, note: 'not-free' });
    expect(F.coolFor({ kind: 'key', note: 'policy' }, NOW)).toEqual({ why: 'key', until: 0, at: NOW, note: 'policy' });
    expect(F.coolFor({ kind: 'credit' }, NOW)).toEqual({ why: 'credit', until: 0, at: NOW });
    expect(F.coolFor({ kind: 'too-big' }, NOW)).toBeNull();
    expect(F.coolFor({ kind: 'skip' }, NOW)).toBeNull();
  });

  it('picks a good free model on OpenRouter, never a paid one', () => {
    const list = ['openai/gpt-4o', 'meta-llama/llama-3.3-70b-instruct:free', 'openai/gpt-oss-120b:free', 'google/gemma-3-27b-it:free', 'some/new-model:free'];
    expect(F.pickFree(list)).toBe('openai/gpt-oss-120b:free');
    expect(F.pickFree(list, ['openai/gpt-oss-120b:free'])).toBe('meta-llama/llama-3.3-70b-instruct:free');
    expect(F.pickFree(['some/new-model:free'])).toBe('some/new-model:free');
    expect(F.pickFree(['openai/gpt-4o'])).toBe('');
  });
});

describe('words for the screen', () => {
  const local = (t: number) => {
    const d = new Date(t);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  it("says when on this device's clock", () => {
    const now = new Date(2026, 9, 17, 9, 0).getTime(); // Saturday, local time
    expect(F.when(new Date(2026, 9, 17, 21, 0).getTime(), now)).toBe('21:00');
    expect(F.when(new Date(2026, 9, 19, 9, 5).getTime(), now)).toBe('Mon 09:05');
    expect(F.when(new Date(2026, 10, 1, 0, 0).getTime(), now)).toBe('1 Nov');
  });

  it('says what each rest means', () => {
    const at = NOW + 2 * HOUR;
    expect(F.statusOf(undefined, NOW)).toEqual({ state: 'ready', text: 'Ready' });
    expect(F.statusOf({ why: 'day', until: NOW - 1, at: NOW - HOUR }, NOW)).toEqual({ state: 'ready', text: 'Ready' });
    expect(F.statusOf({ why: 'day', until: at, at: NOW }, NOW)).toEqual({ state: 'resting', text: `Limit reached until ${F.when(at, NOW)}` });
    expect(F.statusOf({ why: 'minute', until: NOW + MIN, at: NOW }, NOW).text).toBe(`Limit reached until ${local(NOW + MIN)}`);
    expect(F.statusOf({ why: 'busy', until: at, at: NOW }, NOW).text).toBe(`Not answering. Trying again after ${F.when(at, NOW)}`);
    expect(F.statusOf({ why: 'model', until: at, at: NOW, note: 'not-free' }, NOW).text).toBe("This model isn't free on this key. Pick another one.");
    expect(F.statusOf({ why: 'key', until: 0, at: NOW }, NOW)).toEqual({ state: 'off', text: 'Key not working. Check it, then test it again.' });
    expect(F.statusOf({ why: 'key', until: 0, at: NOW, note: 'policy' }, NOW).text).toContain("OpenRouter's privacy settings");
    expect(F.statusOf({ why: 'credit', until: 0, at: NOW }, NOW)).toEqual({ state: 'off', text: 'Out of credit. Top it up, then test it again.' });
  });
});

describe('keys and rests on this device', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('moves the single key from before into the list, once, and keeps only one copy', () => {
    localStorage.setItem(F.LEGACY_KEY, '  sk-ant-old  ');
    const list = F.loadKeys();
    expect(list).toEqual([{ id: expect.stringMatching(/^k[a-z0-9]+$/), key: 'sk-ant-old' }]);
    expect(localStorage.getItem(F.LEGACY_KEY)).toBeNull();
    expect(F.loadKeys()).toEqual(list); // the same key, same id, next time
    localStorage.clear();
    expect(F.loadKeys()).toEqual([]);
  });

  it('drops anything that isn\'t a plain key, and caps the list', () => {
    localStorage.setItem(
      'arise-ai-keys',
      JSON.stringify([
        { id: 'a1', key: 'gsk_ok', provider: 'groq', model: 'llama-3.3-70b-versatile', base: '', label: 'Main' },
        { id: 'a1', key: 'gsk_duplicate' },
        { id: 'a2', key: 'has space' },
        { id: 'a3', key: '<script>' },
        { id: 'bad id!', key: 'gsk_x' },
        { id: 'a4', key: 'AIzaX', provider: 'nonsense', model: 'bad model name!', base: 'http://evil.example.com' },
        ...Array.from({ length: 30 }, (_, i) => ({ id: `z${i}`, key: `gsk_${i}` })),
      ]),
    );
    const list = F.loadKeys();
    expect(list[0]).toEqual({ id: 'a1', key: 'gsk_ok', provider: 'groq', model: 'llama-3.3-70b-versatile', base: '', label: 'Main' });
    expect(list[1]).toEqual({ id: 'a4', key: 'AIzaX' });
    expect(list).toHaveLength(20);
  });

  it('remembers rests across a restart, and forgets the ones that are over', async () => {
    F.setCool('a1', { why: 'day', until: Date.now() + HOUR, at: Date.now() });
    F.setCool('a2', { why: 'minute', until: Date.now() - 1, at: Date.now() - MIN });
    F.setCool('a3', { why: 'key', until: 0, at: Date.now() });
    vi.resetModules();
    const again = await import('./free-ai');
    expect(Object.keys(again.loadCools())).toEqual(['a1', 'a3']);
    again.setCool('a1', null);
    expect(Object.keys(again.loadCools())).toEqual(['a3']);
    again.clearCools();
    expect(again.loadCools()).toEqual({});
    // Anything odd in storage is dropped, not trusted.
    localStorage.setItem('arise-ai-cool', JSON.stringify({ ok1: { why: 'day', until: Date.now() + HOUR, at: 1, note: 'x<y' }, 'bad id': { why: 'day', until: 9e15, at: 1 }, ok2: { why: 'forever', until: 1, at: 1 }, ok3: 'nope' }));
    expect(again.loadCools()).toEqual({ ok1: { why: 'day', until: expect.any(Number), at: 1 } });
    localStorage.setItem('arise-ai-cool', 'not json');
    expect(again.loadCools()).toEqual({});
  });

  it('remembers which key answered last', () => {
    expect(F.loadLast()).toBeNull();
    F.saveLast({ keyId: 'a1', provider: 'groq', model: 'llama-3.3-70b-versatile', at: 5 });
    expect(F.loadLast()).toEqual({ keyId: 'a1', provider: 'groq', model: 'llama-3.3-70b-versatile', at: 5 });
    localStorage.setItem('arise-ai-last', '{"keyId": 3}');
    expect(F.loadLast()).toBeNull();
  });

  it('lists the free services with what the screen needs', () => {
    for (const s of F.FREE) {
      expect(s.keyUrl).toMatch(/^https:\/\//);
      expect(s.limits.length).toBeGreaterThan(20);
      expect(s.privacy.length).toBeGreaterThan(20);
      expect(s.limits + s.privacy + s.signup).not.toMatch(/[—–]/); // plain words, no long dashes
    }
    expect(F.freeService('google')?.privacy).toBe('Google may use what you send to improve its products, and people may read it.');
    expect(F.freeService('nvidia')?.web).toBe('no');
  });
});
