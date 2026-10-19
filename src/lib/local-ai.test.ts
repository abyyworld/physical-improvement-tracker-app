// @vitest-environment jsdom
// "Your computer's AI" (Ollama or LM Studio on this computer), with a mocked fetch: it's off until
// picked, finds what's there and why not, picks the best model, streams answers, and only a strong
// (or trusted) model writes the memory.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { strongBy, WAITS } from '../life/strength';

type L = typeof import('./local-ai');
async function load(): Promise<L> {
  vi.resetModules();
  return import('./local-ai');
}

const OLLAMA = 'http://localhost:11434';
const LMSTUDIO = 'http://localhost:1234';

const tags = (models: object[]) => new Response(JSON.stringify({ models }));
const OLLAMA_MODELS = [
  { name: 'llama3.2:3b', details: { parameter_size: '3.2B' } },
  { name: 'qwen2.5:14b', details: { parameter_size: '14.8B' } },
  { name: 'nomic-embed-text:latest', details: { parameter_size: '137M' }, capabilities: ['embedding'] },
  // Ollama's cloud models answer from ollama.com: never used, however big.
  { name: 'gpt-oss:120b-cloud', remote_host: 'https://ollama.com:443', remote_model: 'gpt-oss:120b', details: { parameter_size: '116.8B' } },
  { name: 'qwen2.5-coder:32b', details: { parameter_size: '32.8B' } },
];

// A stream of chunks, as fetch gives it.
function streamed(chunks: string[], { status = 200 } = {}) {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(c) {
        for (const ch of chunks) c.enqueue(enc.encode(ch));
        c.close();
      },
    }),
    { status },
  );
}
const ndjson = (parts: string[], done = 'stop') => [...parts.map((p) => `${JSON.stringify({ message: { role: 'assistant', content: p }, done: false })}\n`), `${JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, done_reason: done })}\n`];
const sse = (parts: string[]) => [...parts.map((p) => `data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`), `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`, 'data: [DONE]\n\n'];

interface Call {
  url: string;
  init: RequestInit;
}
// The computer: what answers at each address. A function gets the call; `null` is nothing there;
// 'blocked' is there, but refusing this website (CORS), so only a no-cors request gets through.
type Answer = ((c: Call) => Response | Promise<Response>) | null | 'blocked';
function computer(routes: Record<string, Answer>) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const base = url.startsWith(OLLAMA) ? OLLAMA : url.startsWith(LMSTUDIO) ? LMSTUDIO : '';
    const route = routes[url] ?? (base ? routes[base] : undefined);
    if (route === undefined || route === null) throw new TypeError('Failed to fetch');
    if (route === 'blocked') {
      if (init.mode === 'no-cors') return new Response(null, { status: 200 });
      throw new TypeError('Failed to fetch');
    }
    return route({ url, init });
  });
  return calls;
}
const body = (c: Call) => JSON.parse(String(c.init.body));
const fail = (code: string, message: string) => Object.assign(new Error(message), { code });
const deps = { system: (compact: boolean) => (compact ? 'SHORT RULES' : 'FULL RULES'), fail };

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('off until picked', () => {
  it("never reaches for this computer's apps until the Player turns it on", async () => {
    const calls = computer({});
    const L = await load();
    expect(L.status()).toBe('off');
    expect(L.ready()).toBe(false);
    await L.start();
    expect(await L.check()).toBe('off');
    expect(calls).toEqual([]);
  });
});

describe('finding Ollama and LM Studio', () => {
  it('finds Ollama and picks its best model: a family that coaches well, then the biggest', async () => {
    const calls = computer({ [`${OLLAMA}/api/tags`]: () => tags(OLLAMA_MODELS), [`${LMSTUDIO}/v1/models`]: null, [`${LMSTUDIO}/`]: null });
    const L = await load();
    L.setPrefs({ on: true });
    expect(await L.check({ asked: true })).toBe('ready');
    expect(L.ready()).toBe(true);
    expect(L.current()).toEqual({ id: 'qwen2.5:14b', server: 'ollama', params: 14.8 });
    // The picker: no embeddings, no cloud models; code models last.
    expect(L.models().map((m) => m.id)).toEqual(['qwen2.5:14b', 'llama3.2:3b', 'qwen2.5-coder:32b']);
    expect(L.label()).toBe('qwen2.5:14b in Ollama on this computer');
    // Nothing but this computer was asked, without cookies.
    expect(calls.every((c) => c.url.startsWith('http://localhost:') && c.init.credentials === 'omit')).toBe(true);
  });

  it("keeps the Player's pick while it's there, and falls back to the best one when it isn't", async () => {
    computer({ [`${OLLAMA}/api/tags`]: () => tags(OLLAMA_MODELS), [LMSTUDIO]: null });
    const L = await load();
    L.setPrefs({ on: true, server: 'ollama', model: 'llama3.2:3b' });
    await L.check({ asked: true });
    expect(L.current()?.id).toBe('llama3.2:3b');
    L.setPrefs({ model: 'mistral:7b' }); // since removed
    expect(L.current()?.id).toBe('qwen2.5:14b');
    expect(L.prefs().model).toBe('mistral:7b');
  });

  it('finds LM Studio in the OpenAI format, without its embedding models', async () => {
    computer({
      [OLLAMA]: null,
      [`${LMSTUDIO}/v1/models`]: () => new Response(JSON.stringify({ data: [{ id: 'text-embedding-nomic-embed-text-v1.5' }, { id: 'qwen2.5-7b-instruct' }, { id: 'google/gemma-3-12b' }] })),
    });
    const L = await load();
    L.setPrefs({ on: true });
    expect(await L.check({ asked: true })).toBe('ready');
    expect(L.current()).toEqual({ id: 'google/gemma-3-12b', server: 'lmstudio', params: 12 });
    expect(L.models().map((m) => m.id)).toEqual(['google/gemma-3-12b', 'qwen2.5-7b-instruct']);
  });

  it("tells 'there, but not letting Arise in' from 'not there'", async () => {
    computer({ [OLLAMA]: 'blocked', [LMSTUDIO]: null });
    const L = await load();
    L.setPrefs({ on: true });
    expect(await L.check({ asked: true })).toBe('blocked');
    expect(L.serverWith('blocked')).toBe('ollama');
    expect(L.ready()).toBe(false);

    computer({ [OLLAMA]: null, [LMSTUDIO]: null });
    expect(await L.check({ asked: true })).toBe('missing');
  });

  it('says when an app is there with no model yet', async () => {
    computer({ [`${OLLAMA}/api/tags`]: () => tags([]), [LMSTUDIO]: null });
    const L = await load();
    L.setPrefs({ on: true });
    expect(await L.check({ asked: true })).toBe('no-model');
    expect(L.serverWith('no-model')).toBe('ollama');
  });

  it("on Safari, which blocks it, says so instead of 'not found'", async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15');
    computer({});
    const L = await load();
    L.setPrefs({ on: true });
    expect(await L.check({ asked: true })).toBe('safari');
    vi.restoreAllMocks();
  });

  it("never makes the browser ask in the background: that waits for the Player's tap", async () => {
    const state = { value: 'prompt' };
    Object.defineProperty(navigator, 'permissions', { configurable: true, value: { query: async ({ name }: { name: string }) => (name === 'local-network-access' ? { state: state.value } : Promise.reject(new TypeError('unknown'))) } });
    const calls = computer({ [`${OLLAMA}/api/tags`]: () => tags(OLLAMA_MODELS), [LMSTUDIO]: null });
    const L = await load();
    L.setPrefs({ on: true });
    expect(await L.check()).toBe('ask');
    expect(calls).toEqual([]);
    // A tap: the browser may ask now.
    expect(await L.check({ asked: true })).toBe('ready');
    // Said no: nothing is tried, and the Player is told how to allow it.
    state.value = 'denied';
    computer({});
    expect(await L.check({ asked: true })).toBe('denied');
    expect(L.ready()).toBe(false);
    Object.defineProperty(navigator, 'permissions', { configurable: true, value: undefined });
  });

  it('looks again by itself while it is on and not answering, and stops when turned off', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-10-19T10:00:00Z') });
    const calls = computer({ [OLLAMA]: null, [LMSTUDIO]: null });
    const L = await load();
    L.setPrefs({ on: true });
    await L.check();
    const n = calls.length;
    expect(L.ready()).toBe(false); // looked a moment ago
    expect(calls.length).toBe(n);
    vi.setSystemTime(Date.parse('2026-10-19T10:01:00Z'));
    computer({ [`${OLLAMA}/api/tags`]: () => tags(OLLAMA_MODELS), [LMSTUDIO]: null });
    expect(L.ready()).toBe(false); // starts looking
    await vi.waitFor(() => expect(L.ready()).toBe(true));
    L.setPrefs({ on: false });
    expect(L.ready()).toBe(false);
    expect(L.status()).toBe('off');
  });

  it('forgets everything on "Erase all data"', async () => {
    computer({ [`${OLLAMA}/api/tags`]: () => tags(OLLAMA_MODELS), [LMSTUDIO]: null });
    const L = await load();
    L.setPrefs({ on: true, trust: ['mystery'] });
    await L.check({ asked: true });
    L.forget();
    expect(L.prefs()).toEqual({ on: false, server: '', model: '', trust: [] });
    expect(L.ready()).toBe(false);
  });
});

describe('asking it', () => {
  async function ready(models = OLLAMA_MODELS, chat?: Answer) {
    const calls = computer({ [`${OLLAMA}/api/tags`]: () => tags(models), ...(chat !== undefined ? { [`${OLLAMA}/api/chat`]: chat } : {}), [LMSTUDIO]: null });
    const L = await load();
    L.setPrefs({ on: true });
    await L.check({ asked: true });
    return { L, calls };
  }

  it("streams an answer from Ollama, in Ollama's own format, with room for the whole request", async () => {
    const { L, calls } = await ready(OLLAMA_MODELS, () => streamed(ndjson(['Sleep ', 'came first — ', 'then the run.'])));
    const seen: string[] = [];
    const out = await L.ask({ context: (compact, e) => `CONTEXT ${compact ? 'short' : 'full'} for ${e}`, messages: [{ role: 'user', content: 'How was my week?' }], onText: (t) => seen.push(t) }, deps);
    expect(out).toEqual({ text: 'Sleep came first, then the run.', json: undefined, by: 'local:qwen2.5:14b' });
    expect(seen.at(-1)).toBe('Sleep came first, then the run.');
    const chat = calls.find((c) => c.url === `${OLLAMA}/api/chat`)!;
    expect(chat.init.method).toBe('POST');
    expect(chat.init.credentials).toBe('omit');
    expect(body(chat)).toEqual({
      model: 'qwen2.5:14b',
      messages: [
        { role: 'system', content: 'FULL RULES\n\nCONTEXT full for local' },
        { role: 'user', content: 'How was my week?' },
      ],
      stream: true,
      options: { num_ctx: 16384, num_predict: 4096 },
      think: false,
    });
  });

  it('keeps an answer to the JSON Schema, and reads it', async () => {
    const schema = { type: 'object', properties: { message: { type: 'string' } } };
    const { L, calls } = await ready(OLLAMA_MODELS, () => streamed(ndjson(['{"message":', '"Rest today."}'])));
    const out = await L.ask({ context: 'C', schema, messages: [{ role: 'user', content: 'Today?' }] }, deps);
    expect(out.json).toEqual({ message: 'Rest today.' });
    const b = body(calls.find((c) => c.url.endsWith('/api/chat'))!);
    expect(b.format).toEqual(schema);
    expect(b.messages.at(-1).content).toMatch(/^Today\?\n\nReply with only a JSON object/);
  });

  it("never shows a model's thinking, and gives a whole plan room to finish", async () => {
    const { L, calls } = await ready(OLLAMA_MODELS, () => streamed(ndjson(['<think>Let me see', '…</think>', 'Here is the plan.'])));
    const seen: string[] = [];
    const out = await L.ask({ effort: 'high', maxTokens: 16000, messages: [{ role: 'user', content: 'Plan?' }], onText: (t) => seen.push(t) }, deps);
    expect(out.text).toBe('Here is the plan.');
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((t) => !t.includes('think') && !t.includes('Let me see'))).toBe(true);
    const b = body(calls.find((c) => c.url.endsWith('/api/chat'))!);
    expect(b.think).toBe(false);
    expect(b.options).toEqual({ num_ctx: 16384, num_predict: 6144 });
  });

  it('looks again now and then while it answers, in case it was closed', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-10-19T10:00:00Z') });
    const { L, calls } = await ready(OLLAMA_MODELS);
    const n = calls.length;
    expect(L.ready()).toBe(true);
    expect(calls.length).toBe(n);
    vi.setSystemTime(Date.parse('2026-10-19T10:06:00Z'));
    computer({ [OLLAMA]: null, [LMSTUDIO]: null }); // closed meanwhile
    expect(L.ready()).toBe(true); // what it knew, while it looks again
    await vi.waitFor(() => expect(L.ready()).toBe(false));
    expect(L.status()).toBe('missing');
  });

  it('sends the short version when the whole picture is more than it holds', async () => {
    const { L, calls } = await ready(OLLAMA_MODELS, () => streamed(ndjson(['OK.'])));
    const asked: boolean[] = [];
    await L.ask({ context: (compact) => (asked.push(compact), compact ? 'short context' : 'x'.repeat(60000)), messages: [{ role: 'user', content: 'Hi' }] }, deps);
    expect(asked).toEqual([false, true]);
    expect(body(calls.find((c) => c.url.endsWith('/api/chat'))!).messages[0].content).toBe('SHORT RULES\n\nshort context');
  });

  it('drops the oldest turns of a long chat to make it fit', async () => {
    const { L, calls } = await ready(OLLAMA_MODELS, () => streamed(ndjson(['OK.'])));
    const long = 'y'.repeat(20000);
    const messages = [
      { role: 'user' as const, content: long },
      { role: 'assistant' as const, content: long },
      { role: 'user' as const, content: 'And now?' },
    ];
    await L.ask({ context: 'C', messages }, deps);
    expect(body(calls.find((c) => c.url.endsWith('/api/chat'))!).messages.map((m: { role: string }) => m.role)).toEqual(['system', 'user']);
  });

  it('streams from LM Studio in the OpenAI format', async () => {
    const calls = computer({
      [OLLAMA]: null,
      [`${LMSTUDIO}/v1/models`]: () => new Response(JSON.stringify({ data: [{ id: 'qwen2.5-7b-instruct' }] })),
      [`${LMSTUDIO}/v1/chat/completions`]: () => streamed(sse(['Small ', 'steps.'])),
    });
    const L = await load();
    L.setPrefs({ on: true });
    await L.check({ asked: true });
    const out = await L.ask({ bare: true, maxTokens: 1024, messages: [{ role: 'user', content: 'Reply with exactly: System online.' }] }, deps);
    expect(out.text).toBe('Small steps.');
    expect(out.by).toBe('local:qwen2.5-7b-instruct');
    expect(body(calls.find((c) => c.url.endsWith('/v1/chat/completions'))!)).toEqual({ model: 'qwen2.5-7b-instruct', messages: [{ role: 'user', content: 'Reply with exactly: System online.' }], stream: true, max_tokens: 1024 });
  });

  it("tries a plain request when the app doesn't know the extras", async () => {
    let n = 0;
    const { L, calls } = await ready(OLLAMA_MODELS, () => (++n === 1 ? new Response(JSON.stringify({ error: 'invalid format' }), { status: 400 }) : streamed(ndjson(['{"ok":true}']))));
    const out = await L.ask({ schema: { type: 'object' }, messages: [{ role: 'user', content: 'Go' }] }, deps);
    expect(out.json).toEqual({ ok: true });
    const sent = calls.filter((c) => c.url.endsWith('/api/chat')).map(body);
    expect(sent[0].format).toBeDefined();
    expect(sent[1].format).toBeUndefined();
    expect(sent[1].think).toBeUndefined();
  });

  it('says plainly when it stopped answering, and the next request goes to the next AI', async () => {
    const { L } = await ready(OLLAMA_MODELS, null);
    await expect(L.ask({ messages: [{ role: 'user', content: 'Hi' }] }, deps)).rejects.toMatchObject({ code: 'offline', message: "Couldn't reach Ollama on this computer. Is it still running?" });
    expect(L.ready()).toBe(false);
  });

  it("says when the model isn't there any more", async () => {
    const { L } = await ready(OLLAMA_MODELS, () => new Response(JSON.stringify({ error: 'model "qwen2.5:14b" not found, try pulling it first' }), { status: 404 }));
    await expect(L.ask({ messages: [{ role: 'user', content: 'Hi' }] }, deps)).rejects.toMatchObject({ code: 'not-found', message: "Ollama doesn't have qwen2.5:14b any more. Pick another model in Settings, AI coach." });
  });

  it('passes on what went wrong, with a hint when the model is too big for this computer', async () => {
    const { L } = await ready(OLLAMA_MODELS, () => new Response(JSON.stringify({ error: 'model requires more system memory (12.3 GiB) than is available (8.1 GiB)' }), { status: 500 }));
    await expect(L.ask({ messages: [{ role: 'user', content: 'Hi' }] }, deps)).rejects.toMatchObject({
      code: 'server',
      message: "Ollama couldn't answer: model requires more system memory (12.3 GiB) than is available (8.1 GiB). A smaller model may fit (Settings, AI coach).",
    });
  });

  it('gives up on an app that takes too long, and Stop stops it', async () => {
    const hang = ({ init }: Call) =>
      new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    const { L } = await ready(OLLAMA_MODELS, hang);
    vi.useFakeTimers();
    const slow = L.ask({ messages: [{ role: 'user', content: 'Hi' }] }, deps);
    const caught = slow.catch((e) => e);
    await vi.advanceTimersByTimeAsync(180_001);
    expect(await caught).toMatchObject({ code: 'offline', message: 'Ollama took too long to answer. A smaller model answers faster (Settings, AI coach).' });
    vi.useRealTimers();

    const ctl = new AbortController();
    const stopped = L.ask({ messages: [{ role: 'user', content: 'Hi' }], signal: ctl.signal }, deps).catch((e) => e);
    ctl.abort();
    expect(await stopped).toMatchObject({ code: 'aborted' });
  });
});

describe('the memory: only strong or trusted models write it', () => {
  it('a small model chats, but never writes the memory, and the Player can\'t trust one known to be small', async () => {
    const { L } = await (async () => {
      computer({ [`${OLLAMA}/api/tags`]: () => tags([{ name: 'qwen2.5:7b', details: { parameter_size: '7.6B' } }]), [LMSTUDIO]: null });
      const L = await load();
      L.setPrefs({ on: true });
      await L.check({ asked: true });
      return { L };
    })();
    expect(L.memoryOf('qwen2.5:7b')).toBe('weak');
    expect(L.memoryStrength()).toBe('weak');
    await expect(L.ask({ strong: true, bare: true, messages: [{ role: 'user', content: 'Sum up the day' }] }, deps)).rejects.toMatchObject({ code: 'weak', message: WAITS });
  });

  it('knows a model by the size the app reports when its name says nothing, and records it that way', async () => {
    computer({ [`${OLLAMA}/api/tags`]: () => tags([{ name: 'llama3.3:latest', details: { parameter_size: '70.6B' } }]), [`${OLLAMA}/api/chat`]: () => streamed(ndjson(['{"summary":"A good day."}'])), [LMSTUDIO]: null });
    const L = await load();
    L.setPrefs({ on: true });
    await L.check({ asked: true });
    expect(L.memoryStrength()).toBe('strong');
    const out = await L.ask({ strong: true, bare: true, schema: { type: 'object' }, messages: [{ role: 'user', content: 'Sum up the day' }] }, deps);
    expect(out.by).toBe('local:llama3.3:70.6b');
    expect(strongBy(out.by)).toBe(true);
  });

  it('a model Arise doesn\'t know writes it only once the Player trusts it', async () => {
    computer({ [`${OLLAMA}/api/tags`]: () => tags([{ name: 'house-model', details: {} }]), [LMSTUDIO]: null });
    const L = await load();
    L.setPrefs({ on: true });
    await L.check({ asked: true });
    expect(L.memoryOf('house-model')).toBe('unknown');
    expect(L.memoryStrength()).toBe('weak');
    L.trust('house-model', true);
    expect(L.memoryOf('house-model')).toBe('trusted');
    expect(L.memoryStrength()).toBe('strong');
    expect(strongBy('local:house-model', (provider, model) => provider === 'local' && L.trusted(model))).toBe(true);
    L.trust('house-model', false);
    expect(L.memoryStrength()).toBe('weak');
  });
});

describe('setting it up', () => {
  it("gives the one command for a Mac, with another copy of Arise's address only when needed", async () => {
    const L = await load();
    expect(L.SITE_ORIGIN).toBe('https://abyyworld.github.io');
    expect(L.setupCommand('https://abyyworld.github.io')).toBe('curl -fsSL https://raw.githubusercontent.com/abyyworld/physical-improvement-tracker-app/main/scripts/local-ai-mac.sh | bash');
    expect(L.setupCommand('http://localhost:5173')).toBe(L.setupCommand()); // Ollama lets localhost in already
    expect(L.setupCommand('https://arise.example.com')).toBe(`${L.setupCommand()} -s -- https://arise.example.com`);
    expect(L.setupCommand('https://evil.example.com; rm -rf ~')).toBe(L.setupCommand());
    expect(L.origins('https://arise.example.com')).toBe('https://abyyworld.github.io,https://arise.example.com');
  });

  it('is offered on computers, not phones or tablets', async () => {
    const L = await load();
    expect(L.onComputer({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/141.0 Safari/537.36', maxTouchPoints: 0 })).toBe(true);
    expect(L.onComputer({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0', maxTouchPoints: 0 })).toBe(true);
    expect(L.onComputer({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148', maxTouchPoints: 5 })).toBe(false);
    expect(L.onComputer({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/18.0 Safari/605.1.15', maxTouchPoints: 5 })).toBe(false); // an iPad
    expect(L.onComputer({ userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/141.0 Mobile Safari/537.36', maxTouchPoints: 5 })).toBe(false);
  });
});
