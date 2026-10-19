// @vitest-environment jsdom
// "Your computer's AI" as an engine (ai.js): only once the Player turns it on, first in the
// automatic order while it answers (before the private AI), as private as the AI on this device,
// and like every AI, only a strong or trusted model writes the memory.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const device = { state: 'unavailable' as string };
vi.mock('./lib/on-device', () => ({ lastKnown: () => device.state, availability: async () => device.state, ask: vi.fn(), download: vi.fn() }));
vi.mock('./ai-config', () => ({ PRIVATE_AI: { proxy: 'https://ai.example.workers.dev/v1/', model: 'gpt-oss-120b', name: 'Private AI' } }));
vi.mock('tinfoil', () => ({
  SecureClient: class {
    async ready() {}
    getBaseURL() {
      return 'https://ai.example.workers.dev/v1';
    }
    fetch = (url: string, init: RequestInit) => fetch(url, init);
  },
}));

const OLLAMA = 'http://localhost:11434';
let models: object[] = [];
let up = true;
const sent: { url: string; body: Record<string, unknown> }[] = [];

function ndjson(text: string) {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(enc.encode(`${JSON.stringify({ message: { content: text }, done: false })}\n`));
        c.enqueue(enc.encode(`${JSON.stringify({ message: { content: '' }, done: true, done_reason: 'stop' })}\n`));
        c.close();
      },
    }),
  );
}

async function load({ signedIn = true } = {}) {
  vi.resetModules();
  const S = await import('./store');
  const AI = await import('./ai.js');
  const Local = await import('./lib/local-ai');
  AI.connectAccount({ signedIn: () => signedIn, idToken: async () => (signedIn ? 'token' : null) });
  return { S, AI, Local };
}

beforeEach(() => {
  localStorage.clear();
  device.state = 'unavailable';
  models = [{ name: 'qwen2.5:14b', details: { parameter_size: '14.8B' } }];
  up = true;
  sent.length = 0;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    if (!url.startsWith(OLLAMA) || !up) throw new TypeError('Failed to fetch');
    if (url === `${OLLAMA}/api/tags`) return new Response(JSON.stringify({ models }));
    if (url === `${OLLAMA}/api/chat`) {
      const body = JSON.parse(String(init.body));
      sent.push({ url, body });
      return ndjson(body.format ? '{"message":"Rest well.","focus":"Sleep by 11."}' : 'Small steps today.');
    }
    throw new TypeError('Failed to fetch');
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('picking it', () => {
  it("isn't used, or even looked for, until the Player turns it on", async () => {
    const calls: string[] = [];
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => (calls.push(url), real(url, init)));
    const { AI } = await load();
    await AI.initAI();
    expect(AI.engine()).toBe('private');
    expect(calls).toEqual([]);
  });

  it('comes first in the automatic order while it answers, before the private AI', async () => {
    const { AI, Local } = await load();
    Local.setPrefs({ on: true });
    await AI.initAI(); // finds it
    expect(AI.engine()).toBe('local');
    expect(AI.isPrivate()).toBe(true);
    expect(AI.engineLabel()).toBe('qwen2.5:14b in Ollama on this computer');
  });

  it("hands over to the private AI when it isn't there, and to nothing when it was picked", async () => {
    up = false;
    const { S, AI, Local } = await load();
    Local.setPrefs({ on: true });
    await AI.initAI();
    expect(AI.engine()).toBe('private');
    S.state.settings.aiEngine = 'local';
    expect(AI.engine()).toBeNull();
    // Another pick stays the pick, whatever is on this computer.
    up = true;
    await Local.check({ asked: true });
    S.state.settings.aiEngine = 'private';
    expect(AI.engine()).toBe('private');
  });
});

describe('asking it', () => {
  it('answers the coach chat from this computer, with the whole picture and the life log it may read', async () => {
    const { S, AI, Local } = await load();
    Local.setPrefs({ on: true });
    await AI.initAI();
    AI.useMemory({ profile: (e: string) => `PROFILE for ${e}`, profileTier: () => 3, recall: async (_q: string, e: string) => ({ text: `NOTES for ${e}`, tier: 3 }), cap: (e: string) => (e === 'local' ? 3 : 1) });
    const text = await AI.chat('How am I doing?');
    expect(text).toBe('Small steps today.');
    expect(sent).toHaveLength(1);
    const system = String((sent[0].body.messages as { role: string; content: string }[])[0].content);
    expect(system).toContain('PROFILE for local');
    expect(system).toContain('NOTES for local');
    expect(sent[0].body.model).toBe('qwen2.5:14b');
    // The reply keeps the tier it was made from, like any private AI's.
    expect(S.state.ai.chat.at(-1)).toMatchObject({ role: 'assistant', text: 'Small steps today.', tier: 3 });
  });

  it("writes today's message as JSON", async () => {
    const { AI, Local } = await load();
    Local.setPrefs({ on: true });
    await AI.initAI();
    const out = await AI.dailyBriefing();
    expect(out).toMatchObject({ message: 'Rest well.', focus: 'Sleep by 11.' });
    expect(sent[0].body.format).toBeTruthy();
  });

  it('never lets a small model write the memory', async () => {
    const { AI, Local } = await load();
    Local.setPrefs({ on: true });
    await AI.initAI();
    expect(AI.memoryStrength()).toBe('weak');
    await expect(AI.askMemory({ instructions: 'Sum up', prompt: 'the day', schema: undefined, signal: undefined, engine: 'local' })).rejects.toMatchObject({ code: 'weak' });
    expect(sent).toEqual([]);
  });

  it('lets a model it doesn\'t know write the memory once trusted, and the memory reads it back as strong', async () => {
    models = [{ name: 'house-model', details: {} }];
    const { AI, Local } = await load();
    Local.setPrefs({ on: true });
    await AI.initAI();
    expect(AI.memoryStrength()).toBe('weak');
    Local.trust('house-model', true);
    expect(AI.memoryStrength()).toBe('strong');
    expect(AI.trustedModel('local', 'house-model')).toBe(true);
    const out = await AI.askMemory({ instructions: 'Sum up', prompt: 'the day', schema: undefined, signal: undefined, engine: 'local' });
    expect(out.by).toBe('local:house-model');
  });
});
