// @vitest-environment jsdom
// Which AI engine answers. The rule that matters most: nothing goes to the Player's own AI service
// (which can read it) unless they picked it and said yes to that.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const device = { state: 'unavailable' as string };
vi.mock('./lib/on-device', () => ({ lastKnown: () => device.state, availability: async () => device.state, ask: vi.fn(), download: vi.fn() }));
const config = { proxy: 'https://ai.example.workers.dev/v1/', model: 'llama3-3-70b', name: 'Private AI' };
vi.mock('./ai-config', () => ({ PRIVATE_AI: config }));

async function load({ signedIn = false } = {}) {
  vi.resetModules();
  const S = await import('./store');
  const AI = await import('./ai.js');
  AI.connectAccount({ signedIn: () => signedIn, idToken: async () => (signedIn ? 'token' : null) });
  return { S, AI };
}

beforeEach(() => {
  localStorage.clear();
  device.state = 'unavailable';
  config.proxy = 'https://ai.example.workers.dev/v1/';
});

describe('picking the AI engine', () => {
  it('uses the private AI by default for a signed-in player', async () => {
    const { AI } = await load({ signedIn: true });
    expect(AI.engine()).toBe('private');
    expect(AI.isPrivate()).toBe(true);
  });

  it('falls back to the on-device model, then to nothing', async () => {
    device.state = 'available';
    expect((await load()).AI.engine()).toBe('device');
    device.state = 'downloadable';
    expect((await load()).AI.engine()).toBeNull();
  });

  it("never picks the player's own service by itself, even with a key saved", async () => {
    const { AI } = await load();
    AI.setKey('sk-ant-something');
    expect(AI.engine()).toBeNull();
    device.state = 'available';
    expect(AI.engine()).toBe('device');
  });

  it('uses their own service only once it is picked and agreed to', async () => {
    const { S, AI } = await load({ signedIn: true });
    AI.setKey('sk-ant-something');
    S.state.settings.aiEngine = 'own';
    expect(AI.engine()).toBeNull(); // picked, but not agreed yet
    AI.consent('anthropic');
    expect(AI.engine()).toBe('own');
    expect(AI.isPrivate()).toBe(false);
  });

  it('asks again after switching to a different service', async () => {
    const { S, AI } = await load();
    AI.setKey('sk-ant-something');
    S.state.settings.aiEngine = 'own';
    AI.consent('anthropic');
    AI.setKey('AIzaSomething');
    expect(AI.provider()?.id).toBe('google');
    expect(AI.engine()).toBeNull();
  });

  it('keeps people who had a key before engines existed on their own service', async () => {
    localStorage.setItem('arise-claude-key', 'sk-ant-old');
    const { S, AI } = await load();
    await AI.initAI();
    expect(S.state.settings.aiEngine).toBe('own');
    expect(AI.engine()).toBe('own');
  });

  it('does that only on the first start of 2.0, so a key alone never turns their service back on', async () => {
    const first = await load();
    await first.AI.initAI(); // first start of 2.0, no key yet
    first.AI.setKey('sk-ant-pasted-but-declined');
    const { S, AI } = await load();
    await AI.initAI();
    expect(S.state.settings.aiEngine).toBe('');
    expect(AI.engine()).toBeNull();

    // Someone who switched back to "let the app pick" stays there after a restart.
    AI.consent('anthropic');
    const again = await load();
    await again.AI.initAI();
    expect(again.AI.engine()).toBeNull();
  });

  it('needs the proxy to be set up and an account for the private AI', async () => {
    config.proxy = '';
    expect((await load({ signedIn: true })).AI.engine()).toBeNull();
    config.proxy = 'https://ai.example.workers.dev/v1/';
    expect((await load({ signedIn: false })).AI.engine()).toBeNull();
  });

  it("refuses to send a key to a service it doesn't belong to", async () => {
    const { S, AI } = await load();
    AI.setKey('sk-ant-something');
    S.state.settings.aiEngine = 'own';
    S.state.settings.aiProvider = 'openai';
    AI.consent('openai');
    await expect(AI.testKey()).rejects.toMatchObject({ code: 'wrong-service' });
  });
});

describe('what the coach is told about the streak', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("marks a workout-only Player's free day, so a streak across a missed day makes sense", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 8, 12)); // Thursday 8 October 2026
    const session = (k: string) => ({ id: `s${k.replace(/-/g, '')}`, workout: 'a', date: k, started: 1, finished: 2, easy: false, items: [{ ex: 'band_row', setup: '', sets: [{ r: 10, done: true }] }] });
    const trained = ['09-28', '09-29', '09-30', '10-02', '10-03', '10-04', '10-05', '10-06', '10-07'].map((d) => `2026-${d}`); // not 1 October
    localStorage.setItem('pit-data-v1', JSON.stringify({ sessions: trained.map(session) }));
    const { S, AI } = await load();
    expect(S.streakDay('2026-10-01')).toBe('free');
    expect(S.currentStreak()).toBe(9);
    const context = AI.buildContext({ full: true });
    expect(context).toContain("2026-10-01: nothing done (the week's free day, so the streak held)");
    expect(context).toContain("Missed days in the last 4 weeks (no workout, football or rest day logged): 2026-10-01 (the week's free day).");
  });
});

describe('the private AI model', () => {
  it('asks gpt-oss to think briefly, and drops the setting for a server that rejects it', async () => {
    const { S, AI } = await load();
    AI.setKey('sk-or-something');
    S.state.settings.aiEngine = 'own';
    S.state.settings.aiModel = 'openai/gpt-oss-120b';
    AI.consent('openrouter');
    const sent: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      sent.push(body);
      if (body.reasoning_effort) return new Response(JSON.stringify({ error: { message: 'unknown field reasoning_effort' } }), { status: 400 });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Do set 1 now.' }, finish_reason: 'stop' }] }));
    });
    const reply = await AI.chat('Hi');
    vi.unstubAllGlobals();
    expect(sent.map((b) => b.reasoning_effort)).toEqual(['low', undefined]);
    expect(reply).toContain('Do set 1 now');
  });
});
