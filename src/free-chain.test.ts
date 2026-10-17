// @vitest-environment jsdom
// The free AI chain, end to end through ai.js: several keys tried in the Player's order, with a key
// that hits its limit resting while the next one answers. Services are stubbed by host.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./lib/on-device', () => ({ lastKnown: () => 'unavailable', availability: async () => 'unavailable', ask: vi.fn(), download: vi.fn() }));
vi.mock('./ai-config', () => ({ PRIVATE_AI: { proxy: 'https://ai.example.workers.dev/v1/', model: 'llama3-3-70b', name: 'Private AI' } }));

async function load() {
  vi.resetModules();
  const S = await import('./store');
  const AI = await import('./ai.js');
  AI.connectAccount({ signedIn: () => false, idToken: async () => null });
  return { S, AI };
}

const GROQ = 'api.groq.com';
const GEMINI = 'generativelanguage.googleapis.com';
type Init = { method?: string; body?: string; headers?: Record<string, string>; signal?: AbortSignal };
type Route = (url: string, init: Init) => Response | Promise<Response>;

const okAnswer = (text = 'Do set 1 now.') => new Response(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3 } }));
const geminiAnswer = (text = 'Gemini here.') => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] }));
// Streamed answers, as server-sent events.
const enc = new TextEncoder();
const groqChunk = (text: string) => enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
const geminiStream = (text = 'Gemini streamed.') => new Response(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
// A request that only ends when it's stopped, like one the service is still working on.
const pending = (init: Init) =>
  new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError'))));
// The coach screen's chat, with what it passes along (ai.js is plain JavaScript, so its types are guessed).
type Chat = (text: string, opts: { signal?: AbortSignal; onText?: (t: string) => void }) => Promise<string>;
const streamChat = (AI: { chat: unknown }, text: string, opts: Parameters<Chat>[1]) => (AI.chat as Chat)(text, opts);
const groqLimit = (what: string, retry: string) =>
  new Response(JSON.stringify({ error: { message: `Rate limit reached for model \`llama-3.3-70b-versatile\` in organization \`org_1\` service tier \`on_demand\` on ${what}: Limit 1000, Used 1000, Requested 1. Please try again in 1m0s.`, type: 'requests', code: 'rate_limit_exceeded' } }), { status: 429, headers: { 'retry-after': retry } });

// Answers by host; a host with no route can't be reached.
function stub(routes: Record<string, Route>) {
  const calls: { host: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal('fetch', async (url: string, init: Init) => {
    const host = new URL(url).host;
    calls.push({ host, body: init.body ? JSON.parse(init.body) : {} });
    if (!routes[host]) throw new TypeError('Failed to fetch');
    return routes[host](url, init);
  });
  return calls;
}

// Groq first, then Gemini, both agreed to.
async function twoKeys() {
  const out = await load();
  out.AI.addKey({ key: 'gsk_first', model: 'llama-3.3-70b-versatile' });
  out.AI.addKey({ key: 'AIzaSecond', model: 'gemini-2.5-flash' });
  out.S.state.settings.aiEngine = 'own';
  out.AI.consent('groq');
  out.AI.consent('google');
  return out;
}

// Local midday, so a key's reset an hour or two later falls on the same day and reads as plain "14:00".
function atMidday() {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 17, 12)); // Saturday 17 October 2026
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (globalThis as { Capacitor?: unknown }).Capacitor;
});

describe('keys on this device', () => {
  it('moves the single key from before into the list, and the old calls still work', async () => {
    localStorage.setItem('arise-claude-key', 'sk-ant-old');
    const { AI } = await load();
    expect(AI.keys()).toHaveLength(1);
    expect(AI.getKey()).toBe('sk-ant-old');
    expect(AI.provider()?.id).toBe('anthropic');
    AI.setKey('gsk_new');
    expect(AI.keys()).toHaveLength(1);
    expect(AI.provider()?.id).toBe('groq');
    AI.addKey({ key: 'csk-abc' });
    expect(AI.keys().map((k) => AI.keyProvider(k))).toEqual(['groq', 'cerebras']);
    AI.setKey('');
    expect(AI.keys()).toEqual([]);
    expect(AI.hasKey()).toBe(false);
  });

  it('knows more services from their keys', async () => {
    const { AI } = await load();
    const keys = ['csk-1', 'nvapi-1', 'hf_1', 'github_pat_1', 'ghp_1', 'gsk_1', 'sk-or-1', 'sk-1', 'mystery'];
    expect(keys.map((k) => AI.detectProvider(k))).toEqual(['cerebras', 'nvidia', 'huggingface', 'github', 'github', 'groq', 'openrouter', 'openai', null]);
  });

  it('reorders, edits and removes keys', async () => {
    const { AI } = await twoKeys();
    const [a, b] = AI.keys().map((k) => k.id);
    AI.moveKey(b, -1);
    expect(AI.keys().map((k) => k.id)).toEqual([b, a]);
    AI.moveKey(b, -1); // already first
    expect(AI.keys().map((k) => k.id)).toEqual([b, a]);
    AI.updateKey(a, { model: 'llama-3.1-8b-instant' });
    expect(AI.keyRows()[1]).toMatchObject({ name: 'Groq', model: 'llama-3.1-8b-instant', tail: 'irst' });
    AI.removeKey(b);
    expect(AI.keys().map((k) => k.id)).toEqual([a]);
    // The same key pasted again stays one key.
    expect(AI.addKey({ key: 'gsk_first', model: 'openai/gpt-oss-120b' })?.id).toBe(a);
    expect(AI.keys()).toHaveLength(1);
    expect(AI.keyModel(AI.keys()[0])).toBe('openai/gpt-oss-120b');
  });

  it("a bad new key in an edit keeps the saved one, and a bad model never turns into OpenRouter's paid pick", async () => {
    const { AI } = await twoKeys();
    const id = AI.keys()[0].id;
    expect(AI.updateKey(id, { key: 'gsk_has space' })).toBeNull();
    expect(AI.keys().map((k) => k.key)).toEqual(['gsk_first', 'AIzaSecond']);
    expect(AI.addKey({ key: 'gsk_bad key' })).toBeNull();
    const or = AI.addKey({ key: 'sk-or-mine' })!;
    AI.updateKey(or.id, { model: 'not a model!' });
    expect(AI.keyModel(AI.keys()[2])).toBe('');
    expect(AI.keyRows()[2].model).toBe('best free model');
  });

  it('forgets every key and what it knew about them when the data on this device is erased', async () => {
    const { AI } = await twoKeys();
    stub({ [GROQ]: () => groqLimit('requests per day (RPD)', '3600'), [GEMINI]: () => geminiAnswer() });
    await AI.chat('Hi');
    AI.setKey('');
    AI.forgetConsent();
    expect(AI.keys()).toEqual([]);
    expect(JSON.parse(localStorage.getItem('arise-ai-cool')!)).toEqual({});
    expect(AI.lastAnswer()).toBeNull();
    expect(AI.consented('groq')).toBe(false);
  });
});

describe('switching keys', () => {
  it('answers with the next key when one reaches its daily limit, and leaves it resting, also after a restart', async () => {
    atMidday();
    const { AI } = await twoKeys();
    const calls = stub({ [GROQ]: () => groqLimit('requests per day (RPD)', '3600'), [GEMINI]: () => geminiAnswer() });
    expect(await AI.chat('Hi')).toBe('Gemini here.');
    expect(calls.map((c) => c.host)).toEqual([GROQ, GEMINI]);
    const rows = AI.keyRows();
    expect(rows.map((r) => r.state)).toEqual(['resting', 'ready']);
    expect(rows[0].text).toBe('Limit reached until 13:00');
    expect(AI.answeredBy()).toBe('Gemini · gemini-2.5-flash');
    expect(AI.engineLabel()).toBe('your AI keys, in your order (last answer: Gemini · gemini-2.5-flash)');

    calls.length = 0;
    await AI.chat('Again');
    expect(calls.map((c) => c.host)).toEqual([GEMINI]); // Groq rests

    const restarted = await load();
    restarted.S.state.settings.aiEngine = 'own';
    calls.length = 0;
    await restarted.AI.chat('After a restart');
    expect(calls.map((c) => c.host)).toEqual([GEMINI]);
  });

  it("doesn't wait on a key's per-minute limit when another key can answer now", async () => {
    const { AI } = await twoKeys();
    const calls = stub({ [GROQ]: () => groqLimit('tokens per minute (TPM)', '20'), [GEMINI]: () => geminiAnswer() });
    const start = Date.now();
    expect(await AI.chat('Hi')).toBe('Gemini here.');
    expect(Date.now() - start).toBeLessThan(1000);
    expect(calls.map((c) => c.host)).toEqual([GROQ, GEMINI]);
    const rest = JSON.parse(localStorage.getItem('arise-ai-cool')!);
    const until = (Object.values(rest)[0] as { until: number }).until;
    expect(until - Date.now()).toBeGreaterThan(15_000);
    expect(until - Date.now()).toBeLessThanOrEqual(20_000);
  });

  it('says when the first key is free again once every key is resting, and suggests the free or private AI', async () => {
    const { AI } = await twoKeys();
    const geminiDaily = { error: { code: 429, message: 'Quota exceeded for metric: generate_content_free_tier_requests, limit: 20', status: 'RESOURCE_EXHAUSTED', details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }] } };
    stub({ [GROQ]: () => groqLimit('requests per day (RPD)', '7200'), [GEMINI]: () => new Response(JSON.stringify(geminiDaily), { status: 429 }) });
    const err = await AI.chat('Hi').catch((e) => e);
    expect(err.code).toBe('rate');
    expect(err.message).toMatch(/^All your AI keys are resting\. The first one free again is (Groq|Gemini), at \S+/);
    expect(err.message).toContain('use the free AI or the private AI (Settings, AI coach)');
    expect(err.until).toBeGreaterThan(Date.now());
    // Nothing is asked while they rest.
    const calls = stub({});
    await expect(AI.chat('Again')).rejects.toMatchObject({ code: 'rate' });
    expect(calls).toHaveLength(0);
  });

  it('with one key, says when it is back and suggests adding another', async () => {
    atMidday();
    const { S, AI } = await load();
    AI.addKey({ key: 'gsk_only', model: 'llama-3.3-70b-versatile' });
    S.state.settings.aiEngine = 'own';
    AI.consent('groq');
    stub({ [GROQ]: () => groqLimit('requests per day (RPD)', '7200') });
    await expect(AI.chat('Hi')).rejects.toMatchObject({ code: 'rate', message: expect.stringMatching(/^Groq is at its limit until 14:00\. Add another free key in Settings to keep going\./) });
  });

  it('a rejected key waits until it is changed, and the next key answers meanwhile', async () => {
    const { AI } = await twoKeys();
    const calls = stub({ [GROQ]: () => new Response(JSON.stringify({ error: { message: 'Invalid API Key', code: 'invalid_api_key' } }), { status: 401 }), [GEMINI]: () => geminiAnswer() });
    expect(await AI.chat('Hi')).toBe('Gemini here.');
    expect(AI.keyRows()[0]).toMatchObject({ state: 'off', text: 'Key not working. Check it, then test it again.' });
    calls.length = 0;
    await AI.chat('Again');
    expect(calls.map((c) => c.host)).toEqual([GEMINI]);
    AI.updateKey(AI.keys()[0].id, { key: 'gsk_fixed' });
    expect(AI.keyRows()[0]).toMatchObject({ state: 'ready', text: 'Ready' });
  });

  it('moves on from a busy service, or one that cannot be reached', async () => {
    const { AI } = await twoKeys();
    let calls = stub({ [GROQ]: () => new Response('Service Unavailable', { status: 503 }), [GEMINI]: () => geminiAnswer() });
    expect(await AI.chat('Hi')).toBe('Gemini here.');
    expect(calls.map((c) => c.host)).toEqual([GROQ, GEMINI]); // no second try on Groq first
    localStorage.removeItem('arise-ai-cool');
    calls = stub({ [GEMINI]: () => geminiAnswer() }); // Groq can't be reached
    expect(await AI.chat('Hi')).toBe('Gemini here.');
    expect(calls.map((c) => c.host)).toEqual([GROQ, GEMINI]);
    expect(AI.keyRows()[0].text).toMatch(/^Not answering\. Trying again after/);
  });

  it("gives a key that can't take the whole picture the short version first", async () => {
    const { AI } = await twoKeys();
    const sizes: number[] = [];
    const calls = stub({
      [GROQ]: (_url, init) => {
        const body = JSON.parse(init.body || '{}');
        sizes.push(String(body.messages[0].content).length);
        if (sizes.length > 1) return okAnswer('Short and done.');
        const big = { error: { message: 'Request too large for model on tokens per minute (TPM): Limit 6000, Requested 9000, please reduce your message size and try again.', code: 'rate_limit_exceeded' } };
        return new Response(JSON.stringify(big), { status: 413 });
      },
      [GEMINI]: () => geminiAnswer(),
    });
    expect(await AI.chat('Hi')).toBe('Short and done.');
    expect(calls.every((c) => c.host === GROQ)).toBe(true);
    expect(sizes).toHaveLength(2);
    expect(sizes[1]).toBeLessThanOrEqual(sizes[0]);
  });

  it("stops at once for what another key wouldn't fix, like a refusal", async () => {
    const { AI } = await twoKeys();
    const calls = stub({ [GROQ]: () => new Response(JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'content_filter' }] })), [GEMINI]: () => geminiAnswer() });
    await expect(AI.chat('Hi')).rejects.toMatchObject({ code: 'refusal' });
    expect(calls.map((c) => c.host)).toEqual([GROQ]);
  });

  it('asks once per service: a key for a service not agreed to is skipped', async () => {
    const { S, AI } = await load();
    AI.addKey({ key: 'mistral-key-123', provider: 'mistral', model: 'mistral-medium-latest' });
    S.state.settings.aiEngine = 'own';
    expect(AI.engine()).toBeNull();
    expect(AI.keyRows()[0]).toMatchObject({ state: 'off', consent: true, text: 'Waiting for your OK to send data to Mistral.' });
    AI.addKey({ key: 'gsk_second', model: 'llama-3.3-70b-versatile' });
    AI.consent('groq');
    expect(AI.engine()).toBe('own');
    const calls = stub({ [GROQ]: () => okAnswer() });
    await AI.chat('Hi');
    expect(calls.map((c) => c.host)).toEqual([GROQ]);
    expect(AI.consented('mistral')).toBe(false);
    expect(AI.consented('groq')).toBe(true);
  });

  it('Stop stops an answer that is streaming in from a key that is not the last one', async () => {
    const { AI } = await twoKeys();
    const calls = stub({
      [GROQ]: (_url, init) =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(groqChunk('Half an ans'));
              // The rest never comes; like a real answer, it ends when the request is stopped.
              init.signal?.addEventListener('abort', () => c.error(new DOMException('The operation was aborted.', 'AbortError')));
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      [GEMINI]: () => geminiStream(),
    });
    const stop = new AbortController();
    const seen: string[] = [];
    const out = streamChat(AI, 'Hi', { signal: stop.signal, onText: (t) => (seen.push(t), stop.abort()) });
    await expect(out).rejects.toMatchObject({ code: 'aborted' });
    expect(seen).toEqual(['Half an ans']);
    expect(calls.map((c) => c.host)).toEqual([GROQ]); // stopped, not passed on
  });

  it('moves on when the connection drops halfway through an answer', async () => {
    const { AI } = await twoKeys();
    const calls = stub({
      [GROQ]: () => {
        let n = 0;
        return new Response(
          new ReadableStream({
            pull(c) {
              if (n++ === 0) c.enqueue(groqChunk('Half an ans'));
              else c.error(new TypeError('network error'));
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
      [GEMINI]: () => geminiStream(),
    });
    const seen: string[] = [];
    expect(await streamChat(AI, 'Hi', { onText: (t) => seen.push(t) })).toBe('Gemini streamed.');
    expect(seen).toEqual(['Half an ans', 'Gemini streamed.']);
    expect(calls.map((c) => c.host)).toEqual([GROQ, GEMINI]);
    expect(AI.keyRows()[0].text).toMatch(/^Not answering\. Trying again after/);
  });

  it("waits longer for an answer that comes in one piece than for one that streams, before trying the next key", async () => {
    vi.useFakeTimers();
    try {
      const { AI } = await twoKeys();
      // A daily message (one JSON answer, written in full before it's sent) that takes two minutes.
      let calls = stub({
        [GROQ]: (_url, init) =>
          new Promise((resolve, reject) => {
            const t = setTimeout(() => resolve(okAnswer(JSON.stringify({ message: 'Slow but sure.', focus: 'Set one.' }))), 120_000);
            init.signal?.addEventListener('abort', () => (clearTimeout(t), reject(new DOMException('The operation was aborted.', 'AbortError'))));
          }),
        [GEMINI]: () => geminiAnswer(JSON.stringify({ message: 'From Gemini.', focus: 'Set one.' })),
      });
      const briefing = AI.dailyBriefing({ force: true });
      await vi.advanceTimersByTimeAsync(125_000);
      expect((await briefing).message).toBe('Slow but sure.');
      expect(calls.map((c) => c.host)).toEqual([GROQ]);
      // A chat streams, so its answer starts at once: one that hasn't started after 90 seconds moves on.
      calls = stub({ [GROQ]: (_url, init) => pending(init), [GEMINI]: () => geminiStream() });
      const chat = streamChat(AI, 'Hi', { onText: () => {} });
      await vi.advanceTimersByTimeAsync(91_000);
      expect(await chat).toBe('Gemini streamed.');
      expect(calls.map((c) => c.host)).toEqual([GROQ, GEMINI]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("with one key resting and another waiting for an OK, doesn't say all of them rest", async () => {
    atMidday();
    const { S, AI } = await load();
    AI.addKey({ key: 'gsk_only', model: 'llama-3.3-70b-versatile' });
    AI.addKey({ key: 'mistral-key-123', provider: 'mistral' });
    S.state.settings.aiEngine = 'own';
    AI.consent('groq');
    stub({ [GROQ]: () => groqLimit('requests per day (RPD)', '7200') });
    await expect(AI.chat('Hi')).rejects.toMatchObject({ code: 'rate', message: expect.stringMatching(/^Groq is at its limit until 14:00\. Add another free key/) });
  });

  it('Test tries a resting key anyway, and a good answer ends its rest', async () => {
    const { AI } = await twoKeys();
    const id = AI.keys()[0].id;
    localStorage.setItem('arise-ai-cool', JSON.stringify({ [id]: { why: 'day', until: Date.now() + 3600_000, at: Date.now() } }));
    stub({ [GROQ]: () => okAnswer('System online.') });
    expect(await AI.testKeyEntry(id)).toBe('Groq · llama-3.3-70b-versatile');
    expect(AI.keyRows()[0].state).toBe('ready');
  });
});

describe('services that work differently', () => {
  it('in the iPhone app, asks services that block web pages through the phone itself', async () => {
    const nativePromise = vi.fn(async (_plugin: string, _method: string, _opts: { url: string; data: string }) => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      data: { choices: [{ message: { content: 'From the phone.' }, finish_reason: 'stop' }] },
    }));
    (globalThis as { Capacitor?: unknown }).Capacitor = { isNativePlatform: () => true, nativePromise };
    const { AI } = await twoKeys();
    const calls = stub({ [GEMINI]: () => geminiAnswer() });
    expect(await AI.chat('Hi')).toBe('From the phone.');
    expect(calls).toHaveLength(0);
    expect(nativePromise).toHaveBeenCalledTimes(1);
    const [plugin, method, opts] = nativePromise.mock.calls[0];
    expect([plugin, method, opts.url]).toEqual(['CapacitorHttp', 'request', 'https://api.groq.com/openai/v1/chat/completions']);
    expect(JSON.parse(opts.data).model).toBe('llama-3.3-70b-versatile');
  });

  it('in the iPhone app, a limit from the phone request switches keys too', async () => {
    const nativePromise = vi.fn(async () => ({ status: 429, headers: { 'retry-after': '3600' }, data: { error: { message: 'Rate limit reached on requests per day (RPD)', code: 'rate_limit_exceeded' } } }));
    (globalThis as { Capacitor?: unknown }).Capacitor = { isNativePlatform: () => true, nativePromise };
    const { AI } = await twoKeys();
    stub({ [GEMINI]: () => geminiAnswer() });
    expect(await AI.chat('Hi')).toBe('Gemini here.');
    expect(AI.keyRows()[0].state).toBe('resting');
  });

  it('skips a service that only answers the iPhone app when in a browser', async () => {
    const { S, AI } = await load();
    AI.addKey({ key: 'nvapi-abc' });
    AI.addKey({ key: 'gsk_second', model: 'llama-3.3-70b-versatile' });
    S.state.settings.aiEngine = 'own';
    AI.consent('nvidia');
    AI.consent('groq');
    expect(AI.keyRows()[0]).toMatchObject({ state: 'off', text: 'Works in the iPhone app only.' });
    const calls = stub({ [GROQ]: () => okAnswer() });
    await AI.chat('Hi');
    expect(calls.map((c) => c.host)).toEqual([GROQ]);
  });

  it("picks a free model on OpenRouter, and tries another free one when it's busy", async () => {
    const { S, AI } = await load();
    AI.addKey({ key: 'sk-or-free' });
    S.state.settings.aiEngine = 'own';
    AI.consent('openrouter');
    const sent: string[] = [];
    stub({
      'openrouter.ai': (_url, init) => {
        if (init.method === 'GET') return new Response(JSON.stringify({ data: ['openai/gpt-5', 'openai/gpt-oss-120b:free', 'meta-llama/llama-3.3-70b-instruct:free'].map((id) => ({ id })) }));
        const { model } = JSON.parse(init.body || '{}');
        sent.push(model);
        if (model === 'openai/gpt-oss-120b:free') return new Response(JSON.stringify({ error: { message: 'Provider returned error', code: 429, metadata: { raw: 'temporarily rate-limited upstream' } } }), { status: 429 });
        return okAnswer();
      },
    });
    await AI.chat('Hi');
    expect(sent).toEqual(['openai/gpt-oss-120b:free', 'meta-llama/llama-3.3-70b-instruct:free']);
  });

  it("never falls back to OpenRouter's paid automatic pick when no free model is on offer: the next key answers", async () => {
    const { S, AI } = await load();
    AI.addKey({ key: 'sk-or-free' });
    AI.addKey({ key: 'gsk_second', model: 'llama-3.3-70b-versatile' });
    S.state.settings.aiEngine = 'own';
    AI.consent('openrouter');
    AI.consent('groq');
    const sent: string[] = [];
    const calls = stub({
      'openrouter.ai': (_url, init) => {
        if (init.method === 'GET') return new Response(JSON.stringify({ data: [{ id: 'openai/gpt-5' }, { id: 'anthropic/claude-opus-4.1' }] }));
        sent.push(JSON.parse(init.body || '{}').model);
        return okAnswer('Paid for.');
      },
      [GROQ]: () => okAnswer('From Groq.'),
    });
    expect(await AI.chat('Hi')).toBe('From Groq.');
    expect(sent).toEqual([]);
    expect(calls.map((c) => c.host)).toEqual(['openrouter.ai', GROQ]);
    expect(AI.keyRows()[0]).toMatchObject({ state: 'resting', text: expect.stringMatching(/^Model not found\./) });
  });

  it('keeps a key from before working with its old settings: its own address, once allowed', async () => {
    localStorage.setItem('arise-claude-key', 'local-key-1');
    const { S, AI } = await load();
    S.state.settings.aiEngine = 'own';
    S.state.settings.aiProvider = 'custom';
    S.state.settings.aiBase = 'https://llm.example.com/v1/';
    S.state.settings.aiModel = 'my-model';
    AI.consent('custom');
    await expect(AI.chat('Hi')).rejects.toMatchObject({ code: 'confirm-host' });
    AI.confirmHost('https://llm.example.com/v1');
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
      urls.push(`${url} ${JSON.parse(init.body).model}`);
      return okAnswer();
    });
    await AI.chat('Hi');
    expect(urls).toEqual(['https://llm.example.com/v1/chat/completions my-model']);
  });

  it("an old OpenRouter key keeps OpenRouter's automatic pick, as before", async () => {
    localStorage.setItem('arise-claude-key', 'sk-or-old');
    const { S, AI } = await load();
    S.state.settings.aiEngine = 'own';
    AI.consent('openrouter');
    const sent: string[] = [];
    stub({ 'openrouter.ai': (_url, init) => (sent.push(JSON.parse(init.body || '{}').model), okAnswer()) });
    await AI.chat('Hi');
    expect(sent).toEqual(['openrouter/auto']);
  });
});
