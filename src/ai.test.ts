// @vitest-environment jsdom
// Which AI engine answers. The rule that matters most: nothing goes to the Player's own AI service
// (which can read it) unless they picked it and said yes to that.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const device = { state: 'unavailable' as string };
vi.mock('./lib/on-device', () => ({ lastKnown: () => device.state, availability: async () => device.state, ask: vi.fn(), download: vi.fn() }));
const config = { proxy: 'https://ai.example.workers.dev/v1/', model: 'llama3-3-70b', name: 'Private AI' };
vi.mock('./ai-config', () => ({ PRIVATE_AI: config }));
// The private AI's verified, encrypting client, as a plain fetch (attestation is Tinfoil's to test).
vi.mock('tinfoil', () => ({
  SecureClient: class {
    async ready() {}
    getBaseURL() {
      return 'https://ai.example.workers.dev/v1';
    }
    fetch = (url: string, init: RequestInit) => fetch(url, init);
  },
}));

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

describe('the free AI', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is never picked by itself, even when agreed to', async () => {
    const { AI } = await load({ signedIn: true });
    AI.agreeFree();
    expect(AI.engine()).toBe('private');
    config.proxy = '';
    expect((await load({ signedIn: true })).AI.engine()).toBeNull();
  });

  it('needs to be picked, agreed to, and an account', async () => {
    const { S, AI } = await load({ signedIn: true });
    S.state.settings.aiEngine = 'free';
    expect(AI.engine()).toBeNull(); // picked, but not agreed yet
    AI.agreeFree();
    expect(AI.engine()).toBe('free');
    expect(AI.isPrivate()).toBe(false);
    expect(AI.engineLabel()).toContain('Cloudflare');

    const out = await load({ signedIn: false });
    out.S.state.settings.aiEngine = 'free';
    expect(out.AI.engine()).toBeNull();
  });

  it('forgets the yes when the data on this device is erased', async () => {
    const { S, AI } = await load({ signedIn: true });
    S.state.settings.aiEngine = 'free';
    AI.agreeFree();
    AI.forgetConsent();
    expect(AI.engine()).toBeNull();
  });

  it("lives at /free/v1 on the private AI's proxy", async () => {
    const { AI } = await load();
    expect(AI.freeBase()).toBe('https://ai.example.workers.dev/free/v1');
    config.proxy = '';
    expect((await load()).AI.freeBase()).toBe('');
  });

  it("asks it with the account's sign-in and its own model, and shows the proxy's words when the day's allowance is gone", async () => {
    const { S, AI } = await load({ signedIn: true });
    S.state.settings.aiEngine = 'free';
    S.state.settings.aiModel = 'some-model-for-my-own-key';
    AI.agreeFree();
    const sent: { url: string; auth: string; body: Record<string, unknown> }[] = [];
    let full = false;
    vi.stubGlobal('fetch', async (url: string, init: { body: string; headers: Record<string, string> }) => {
      sent.push({ url, auth: init.headers.Authorization, body: JSON.parse(init.body) });
      if (full) return new Response(JSON.stringify({ error: { message: "The free AI has used up today's allowance. It resets at midnight UTC." } }), { status: 429 });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Do set 1 now.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 4 } }));
    });
    expect(await AI.chat('Hi')).toContain('Do set 1 now');
    expect(sent[0].url).toBe('https://ai.example.workers.dev/free/v1/chat/completions');
    expect(sent[0].auth).toBe('Bearer token');
    expect(sent[0].body.model).toBe('@cf/openai/gpt-oss-120b');
    expect(sent[0].body.reasoning_effort).toBe('low');
    expect(S.state.ai.usage.calls).toBe(1);

    full = true;
    sent.length = 0;
    await expect(AI.chat('Again')).rejects.toMatchObject({ code: 'rate', message: "The free AI has used up today's allowance. It resets at midnight UTC." });
    expect(sent).toHaveLength(1); // no point trying again straight away
  });

  it('is offered when the private AI is out of credit', async () => {
    const { AI } = await load({ signedIn: true });
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { message: 'insufficient credits' } }), { status: 402 }));
    await expect(AI.chat('Hi')).rejects.toMatchObject({ code: 'billing', message: expect.stringContaining('switch to the free AI in Settings, AI coach (less private)') });
  });

  it("shows the proxy's words when it can't take a request, and stops at once when it's too big", async () => {
    const { S, AI } = await load({ signedIn: true });
    S.state.settings.aiEngine = 'free';
    AI.agreeFree();
    let reply = { status: 400, message: "The free AI couldn't take that request." };
    let posts = 0;
    vi.stubGlobal('fetch', async () => {
      posts++;
      return new Response(JSON.stringify({ error: { message: reply.message } }), { status: reply.status });
    });
    await expect(AI.chat('Hi')).rejects.toMatchObject({ code: 'bad-request', message: "The free AI couldn't take that request." });
    reply = { status: 413, message: "That's more than the free AI takes at once. Start a new chat, or use the private AI for this." };
    posts = 0;
    await expect(AI.chat('Hi')).rejects.toMatchObject({ code: 'too-big', message: reply.message });
    expect(posts).toBe(1);
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

describe('what the coach is told about the whole person', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // Sam: a life check-in (and the one before), two days of check-ins with the coach's reflections
  // on them, and workout answers from an older intro. No goal, so no workout plan.
  async function sam() {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 17, 12)); // Saturday 17 October 2026
    const life = { at: '2026-10-17', areas: { sleep: 2, body: 3, mind: 3, people: 5, work: 2, money: 3, fun: 2, meaning: 3 }, grow: ['sleep', 'meaning'], values: ['Family', 'Health', 'Faith'], hope: 'Feel fit, finish my degree and see my family more.' };
    localStorage.setItem(
      'pit-data-v1',
      JSON.stringify({
        profile: { name: 'Sam', pullups: 5, pushups: 20, equipment: ['Resistance bands'], life, lifeBefore: { at: '2026-09-15', areas: { sleep: 1, money: 3 } } },
        logs: {
          '2026-10-17': { s: 2, e: 3, m: 3, t: 'Long day at work.', ai: 'A reflection only Sam reads.', at: 1 },
          '2026-10-16': { e: 4, t: 'Good day.', ai: 'Another reflection only Sam reads.', at: 1 },
        },
      }),
    );
    return load({ signedIn: true });
  }
  const statusOf = (ctx: string) => {
    const lines = ctx.split('\n');
    return lines[lines.indexOf('## Status') + 1];
  };

  it('starts with their life: how they rate it and their recent check-ins, both optional', async () => {
    const { AI } = await sam();
    const ctx = AI.buildContext();
    expect(ctx).toContain('## Their own ratings and words (optional, and most people never give them; 1 = hard, 5 = great)\nLife check-in on 2026-10-17: Sleep 2, Body and health 3, Mood and mind 3, People you love 5, Work or study 2, Money 3, Fun and rest 2, Purpose 3.');
    expect(ctx).toContain('They want to grow first: Sleep, Purpose.');
    expect(ctx).toContain('Daily check-ins, last 7 days (newest first): 2026-10-17 sleep 2, energy 3, mood 3; 2026-10-16 energy 4.');
    expect(ctx.indexOf('## Their own ratings and words')).toBeGreaterThan(ctx.indexOf('Today is '));
    expect(ctx.indexOf('## Their own ratings and words')).toBeLessThan(ctx.indexOf("## Today's quests"));
    const short = AI.buildContext({ compact: true });
    expect(short).toContain('Life check-in on 2026-10-17: Sleep 2,');
    expect(short).not.toContain('A great next year');
  });

  it('lists each check-in with sleep, energy and mood, and never the reflections on them', async () => {
    const { S, AI } = await sam();
    const all = () => [AI.buildContext(), AI.buildContext({ compact: true }), AI.buildContext({ full: true })];
    for (const ctx of all()) {
      expect(ctx).toContain('## Daily check-ins (optional; sleep, energy and mood from 1 to 5, and their own words; newest first)\n2026-10-17 sleep 2/5, energy 3/5, mood 3/5: Long day at work.\n2026-10-16 energy 4/5: Good day.');
    }
    S.saveGoal({ id: 'fitness', title: 'Get fit', category: 'fitness', workouts: true });
    for (const ctx of all()) expect(ctx).not.toContain('reflection only Sam reads');
  });

  it('keeps workout answers and training stats to people on the plan, and never mentions a rank', async () => {
    const { S, AI } = await sam();
    let ctx = AI.buildContext();
    expect(ctx).not.toContain('Starting point');
    expect(ctx).not.toContain('Equipment');
    expect(statusOf(ctx)).toBe('Level 1, 10 XP.');
    S.saveGoal({ id: 'fitness', title: 'Get fit', category: 'fitness', workouts: true });
    ctx = AI.buildContext();
    expect(ctx).toContain('Starting point: 5 pull-ups, 20 push-ups');
    expect(ctx).toContain('Equipment: Resistance bands');
    expect(statusOf(ctx)).toMatch(/^Level 1, 10 XP\. Training stats: STR \d+, AGI \d+\.$/);
    expect(ctx).not.toMatch(/\brank\b/i);
  });

  it('tells the coach to look at the whole person first, the same from Safety on in both looks', async () => {
    const { S, AI } = await sam();
    S.state.settings.aiEngine = 'free';
    AI.agreeFree();
    const sent: string[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: { body?: string }) => {
      sent.push(JSON.parse(init.body || '{}').messages.find((m: { role: string }) => m.role === 'system').content);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Sleep first.' }, finish_reason: 'stop' }] }));
    });
    await AI.chat('Hi');
    S.state.settings.look = 'system';
    await AI.chat('Hi');
    for (const sys of sent) {
      expect(sys).toContain('The whole person first');
      expect(sys).toContain('You may question a goal');
      expect(sys).toContain('say so once');
      expect(sys).not.toContain('Talking is never the goal');
      expect(sys).not.toContain('End every reply');
      expect(sys.indexOf('Safety')).toBe(sys.indexOf('\nSafety\n') + 1); // not before its heading
      expect(sys).not.toContain('The plan is one part of their life.');
    }
    const [arise, system] = sent;
    expect(arise).not.toContain('Solo Leveling');
    expect(arise.slice(arise.indexOf('Safety'))).toBe(system.slice(system.indexOf('Safety')));
    S.saveGoal({ id: 'fitness', title: 'Get fit', category: 'fitness', workouts: true });
    await AI.chat('Hi');
    expect(sent[2]).toContain('The plan is one part of their life. Fit training around their sleep, recovery, work and the people in their life');
  });

  it('asks how a goal fits the rest of their life when it suggests quests, and keeps the answer', async () => {
    const { S, AI } = await sam();
    S.state.settings.aiEngine = 'free';
    AI.agreeFree();
    const bodies: { messages: { content: string }[]; response_format?: { json_schema?: { schema: { required: string[] } } } }[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      const json = { summary: 'Small and steady.', fit: 'Studying late — it would cost you sleep.', quests: [{ title: 'Study Spanish', how: '', schedule: 'daily', days: [], times: 0, target: 20, unit: 'min' }], measures: [], milestones: [] };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(json) }, finish_reason: 'stop' }] }));
    });
    const idea = await AI.proposeQuests({ title: 'Speak Spanish', category: 'learning', quests: [] });
    expect(idea.fit).toBe('Studying late, it would cost you sleep.');
    expect(bodies[0].response_format?.json_schema?.schema.required).toContain('fit');
    expect(bodies[0].messages.at(-1)!.content).toContain('In fit, say honestly how this goal fits the rest of my life.');
    expect(bodies[0].messages[0].content).toContain('## Their own ratings and words');
  });

  it('keeps how a goal fits when it turns an answer into quests', async () => {
    const { AI } = await sam();
    const quests = [{ title: 'Walk', how: '', schedule: 'daily', days: [], times: 0, target: 0, unit: '' }];
    expect(AI.normalizeQuests({ summary: 'A start.', fit: '  It fits your week.  ', quests, measures: [], milestones: [] }).fit).toBe('It fits your week.');
    expect(AI.normalizeQuests({ summary: 'A start.', quests, measures: [], milestones: [] }).fit).toBe('');
    expect(AI.normalizeQuests({ summary: 'A start.', fit: 'x'.repeat(900), quests, measures: [], milestones: [] }).fit).toHaveLength(400);
  });
});

describe('what Arise saw, for the coach', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const HEAD = '## What Arise saw (worked out on the device from the life log; nothing typed by them)';
  const ALL = `${HEAD}\n- Fri 16 Oct: slept 7 h (23:30 to 06:30); 6,400 steps; in touch with 3 people.`;
  const LEFT_OUT = `${HEAD}\nSome of what Arise saw uses parts of the life log this AI may not read, so it's left out.`;

  // What Arise saw as src/life/insight.ts hands it out: only what the AI may read (sleep and people
  // are tier 3), with how much each AI may read set by src/life/policy.ts.
  async function withSignals() {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 17, 12)); // Saturday 17 October 2026
    const loaded = await load({ signedIn: true });
    const P = await import('./life/policy');
    loaded.AI.useMemory({ cap: (e: 'private' | 'device' | 'free' | 'own' | null) => P.capFor(e) });
    const asked: [number, boolean][] = [];
    loaded.AI.useSignals((cap: number, compact: boolean) => {
      asked.push([cap, compact]);
      return cap >= 3 ? { text: ALL, tier: 3 } : { text: LEFT_OUT, tier: 1 };
    });
    return { ...loaded, P, asked };
  }
  // Every request, as sent, answered with plain words.
  function stubAnswers() {
    const bodies: { messages: { role: string; content: string }[] }[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ message: 'Go easy.', focus: 'Sleep early.', messages: Array.from({ length: 8 }, (_, i) => `Start with {quest}, ${i}.`) }) }, finish_reason: 'stop' }] }));
    });
    return bodies;
  }
  const system = (b: { messages: { role: string; content: string }[] }) => b.messages.find((m) => m.role === 'system')!.content;

  it('comes first, with everything for the private AI and the one on this device, and only Arise’s own for the free AI and your keys', async () => {
    const { S, AI, P, asked } = await withSignals();
    S.state.profile = { name: 'Sam', life: { at: '2026-10-17', areas: { sleep: 2 }, grow: [], values: [], hope: '' } };
    const priv = AI.buildContext({ e: 'private' });
    expect(priv).toContain(ALL);
    expect(priv.indexOf(HEAD)).toBeGreaterThan(priv.indexOf('Today is '));
    expect(priv.indexOf(HEAD)).toBeLessThan(priv.indexOf('## Their own ratings and words'));
    expect(priv.indexOf('## Their own ratings and words')).toBeLessThan(priv.indexOf("## Today's quests"));
    expect(asked.at(-1)).toEqual([3, false]);
    // The AI on this device: all of it, in the short version.
    expect(AI.buildContext({ e: 'device', compact: true })).toContain(ALL);
    expect(asked.at(-1)).toEqual([3, true]);
    // The free AI and the Player's own keys: nothing from sleep or people, and a line saying so.
    for (const e of ['free', 'own']) {
      const ctx = AI.buildContext({ e });
      expect(ctx).toContain(LEFT_OUT);
      expect(ctx).not.toContain('slept 7 h');
      expect(ctx).not.toContain('in touch with 3 people');
      expect(asked.at(-1)).toEqual([1, false]);
    }
    // Unless the Player lets less private AIs read the life log.
    P.setPrefs({ lessPrivate: true });
    expect(AI.buildContext({ e: 'free' })).toContain(ALL);
    expect(AI.buildContext({ e: 'own' })).toContain(ALL);
  });

  it('marks a reply or a daily message made from it, so it only goes back to an AI that may read it', async () => {
    const { S, AI } = await withSignals();
    const bodies = stubAnswers();
    await AI.chat('How am I doing?'); // the private AI
    expect(system(bodies.at(-1)!)).toContain(ALL);
    expect(S.state.ai.chat.at(-1)).toMatchObject({ role: 'assistant', tier: 3 });
    expect(await AI.dailyBriefing({ force: true })).toMatchObject({ message: 'Go easy.', tier: 3 });

    S.state.settings.aiEngine = 'free';
    AI.agreeFree();
    await AI.chat('And now?');
    const sent = bodies.at(-1)!;
    expect(system(sent)).toContain(LEFT_OUT);
    expect(JSON.stringify(sent)).not.toContain('slept 7 h');
    expect(sent.messages.filter((m) => m.role !== 'system').map((m) => m.content)).toEqual(['How am I doing?', AI.HIDDEN_REPLY, 'And now?']);
    expect(S.state.ai.chat.at(-1)).not.toHaveProperty('tier');
    expect(await AI.dailyBriefing({ force: true })).not.toHaveProperty('tier');
  });

  it('stays out of the reminder texts, which show on the lock screen', async () => {
    const { AI } = await withSignals();
    const bodies = stubAnswers();
    await AI.writeReminders();
    expect(system(bodies.at(-1)!)).not.toContain(HEAD);
    expect(system(bodies.at(-1)!)).toContain('# Player data from the app');
  });

  // A pattern made from the same signals (tier 3), as src/life/insight.ts hands it out.
  const PATTERNS = "## Patterns Arise found on this device\n- You sleep 1 h less after nights on your phone or computer past midnight (12 days).";
  const withPatterns = async () => {
    const loaded = await withSignals();
    const caps: number[] = [];
    loaded.AI.useInsight((cap: number) => {
      caps.push(cap);
      return cap >= 3 ? { text: PATTERNS, tier: 3 } : { text: '', tier: 1 };
    });
    return { ...loaded, caps };
  };

  it('leaves the patterns found in what Arise saw out of the reminder texts too', async () => {
    const { AI } = await withPatterns();
    const bodies = stubAnswers();
    expect(AI.buildContext({ e: 'private' })).toContain(PATTERNS);
    await AI.writeReminders(); // the private AI, which may read them
    expect(system(bodies.at(-1)!)).not.toContain('Patterns Arise found');
    expect(system(bodies.at(-1)!)).not.toContain('past midnight');
  });

  it('gives quest and plan suggestions nothing above tier 1, even for the private AI', async () => {
    const { AI, asked, caps } = await withPatterns();
    const bodies = stubAnswers();
    await AI.proposeQuests({ title: 'Sleep better', category: 'health', quests: [] }).catch(() => {});
    await AI.proposePlan('').catch(() => {});
    expect(bodies).toHaveLength(2);
    for (const b of bodies) {
      expect(system(b)).toContain(LEFT_OUT);
      expect(system(b)).not.toContain('slept 7 h');
      expect(system(b)).not.toContain('past midnight');
    }
    expect(asked.slice(-2).map(([cap]) => cap)).toEqual([1, 1]);
    expect(caps.slice(-2)).toEqual([1, 1]);
  });

  it("keeps a question about a pattern at the pattern's tier: an AI that may not read it never gets it", async () => {
    const { S, AI, P } = await withSignals();
    const bodies = stubAnswers();
    const Q = 'Arise noticed: You sleep 1 h less after nights on your phone or computer past midnight (12 days). What do you make of it?';
    expect(AI.lifeCap()).toBe(3); // the private AI
    await AI.chat(Q, { about: 3 });
    expect(bodies.at(-1)!.messages.at(-1)!.content).toBe(Q);
    expect(S.state.ai.chat.at(-2)).toMatchObject({ role: 'user', text: Q, tier: 3 });
    expect(S.state.ai.chat.at(-1)).toMatchObject({ role: 'assistant', tier: 3 });

    // The Player moves to the free AI, with the life log kept from it.
    S.state.settings.aiEngine = 'free';
    AI.agreeFree();
    expect(AI.lifeCap()).toBe(1);
    await AI.chat('And now?');
    expect(JSON.stringify(bodies.at(-1))).not.toContain('past midnight');
    expect(bodies.at(-1)!.messages.filter((m) => m.role !== 'system').map((m) => m.content)).toEqual([AI.HIDDEN_QUESTION, AI.HIDDEN_REPLY, 'And now?']);
    // Kept with its tier when the data is read back (a restart, sync or a backup).
    const V = await import('./lib/validate');
    expect(V.cleanState(JSON.parse(JSON.stringify(S.state)), S.state.settings).ai.chat.find((m) => m.text === Q)).toMatchObject({ tier: 3 });
    // Allowed: it goes again.
    P.setPrefs({ lessPrivate: true });
    await AI.chat('Once more?');
    expect(bodies.at(-1)!.messages.some((m) => m.content === Q)).toBe(true);
  });
});

describe('the coach never asks to rate things or keep a diary', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // An ask to rate, check in or keep a diary, in one sentence that doesn't say "never" or "don't".
  const ASK = /\b(ask|remind|encourage|nudge|get|invite|start with)\b[^.;\n]{0,60}\b(rate|rating|check in|check-in|keep a (diary|journal)|write (something|a few words|down))/i;
  const asks = (t: string) =>
    t
      .split(/\n|(?<=[.;!?])\s+/)
      .filter((x) => ASK.test(x) && !/\b(never|don't)\b/i.test(x));

  it('in any prompt, in both looks, with nothing rated or written, and the same from Safety on', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 17, 12)); // Saturday 17 October 2026
    const { S, AI } = await load({ signedIn: true });
    S.state.settings.aiEngine = 'free';
    AI.agreeFree();
    const sent: { kind: string; look: string; system: string; user: string }[] = [];
    let kind = '';
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      const { messages } = JSON.parse(init.body) as { messages: { role: string; content: string }[] };
      sent.push({ kind, look: S.state.settings.look === 'system' ? 'system' : 'arise', system: messages.find((m) => m.role === 'system')!.content, user: messages.filter((m) => m.role === 'user').at(-1)!.content });
      const json = {
        message: 'Go easy.',
        focus: 'Sleep early.',
        summary: 'Small steps.',
        fit: '',
        quests: [{ title: 'Read 10 pages', how: '', schedule: 'daily', days: [], times: 0, target: 0, unit: '' }],
        measures: [],
        milestones: [],
        messages: Array.from({ length: 8 }, (_, i) => `Start with {quest}, ${i}.`),
      };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(json) }, finish_reason: 'stop' }] }));
    });
    for (const look of ['auto', 'system'] as const) {
      S.state.settings.look = look;
      kind = 'chat';
      await AI.chat('Hi');
      kind = 'daily';
      await AI.dailyBriefing({ force: true });
      kind = 'reflect';
      await AI.reflect('2026-10-17');
      kind = 'quests';
      await AI.proposeQuests({ title: 'Read more', category: 'learning', quests: [] });
      kind = 'reminders';
      await AI.writeReminders();
    }
    expect(sent).toHaveLength(10);
    for (const r of sent) {
      expect(r.system).toContain('Most people never rate or write anything. Work from what Arise saw: their sleep, movement, focus, people, screens and patterns, and their goals.');
      expect(r.system).toContain('Never ask them to rate things or keep a diary; if you need to know how they feel, ask one short question in plain words.');
      expect(r.system).toContain('Ratings and check-ins are optional, and most people never do them.');
      expect(r.system).toContain("They haven't rated their life, which is normal: work from what Arise saw and their goals.");
      expect(r.system).toContain('## Daily check-ins (optional;');
      expect(r.system).not.toContain('ask about one part of their life you know nothing about');
      expect(r.system).not.toContain('The daily check-in: sleep, energy and mood from 1 to 5');
      expect(asks(r.system)).toEqual([]);
      expect(asks(r.user)).toEqual([]);
    }
    // The daily message and the reflection need nothing from them.
    const daily = sent.find((r) => r.kind === 'daily')!.user;
    expect(daily).toContain('what Arise saw in my days (my sleep, movement, focus, people and screens)');
    expect(daily).toContain('my own ratings and check-ins if I gave any');
    expect(daily).not.toContain('my recent check-ins');
    const reflection = sent.find((r) => r.kind === 'reflect')!.user;
    expect(reflection).toContain('Reflect on my day (2026-10-17) in 2-4 short sentences, from what Arise saw');
    expect(reflection).toContain("I didn't check in or write anything, and that's fine.");
    expect(reflection).not.toContain('Here is my check-in');
    expect(S.state.logs['2026-10-17'].ai).toContain('Go easy.'); // saved with the day
    // Both looks: their own opening and voice, and the same from Safety on, for every request.
    for (const k of ['chat', 'daily', 'reflect', 'quests', 'reminders']) {
      const [arise, sys] = ['arise', 'system'].map((look) => sent.find((r) => r.kind === k && r.look === look)!.system);
      expect(arise).not.toContain('Solo Leveling');
      expect(sys).toContain('Solo Leveling');
      expect(arise.slice(arise.indexOf('\nSafety\n'))).toBe(sys.slice(sys.indexOf('\nSafety\n')));
    }
  });

  it('catches an ask to rate or keep a diary when there is one', () => {
    expect(asks('Start with how you are today: sleep, energy and mood, in the check-in.')).toHaveLength(1);
    expect(asks('Ask them to rate their sleep from 1 to 5.')).toHaveLength(1);
    expect(asks('Encourage them to keep a diary.')).toHaveLength(1);
    expect(asks('Never ask them to rate things or keep a diary; if you need to know how they feel, ask one short question in plain words.')).toEqual([]);
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

describe('picking the model for the private and free AI', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // The enclave's model list and answers. `gone` models answer "not found".
  function stubPrivate(gone: string[] = []) {
    const sent: string[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: { method: string; body?: string }) => {
      if (init.method === 'GET') return new Response(JSON.stringify({ data: ['llama3-3-70b', 'gpt-oss-120b', 'deepseek-r1-70b', 'nomic-embed-text', 'llama-guard3-1b'].map((id) => ({ id })) }));
      const { model } = JSON.parse(init.body || '{}');
      sent.push(model);
      if (gone.includes(model)) return new Response(JSON.stringify({ error: { message: 'model not found' } }), { status: 404 });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Do set 1 now.' }, finish_reason: 'stop' }] }));
    });
    return sent;
  }

  it('offers the chat models the private AI has, the recommended one first', async () => {
    const { AI } = await load({ signedIn: true });
    stubPrivate();
    expect(await AI.engineModels('private')).toEqual(['llama3-3-70b', 'gpt-oss-120b', 'deepseek-r1-70b']);
    expect(AI.engineModelName('private', 'llama3-3-70b')).toBe('llama3-3-70b (recommended)');
    expect(AI.engineModelName('private', 'gpt-oss-120b')).toBe('gpt-oss-120b');
  });

  it("asks the private AI with the Player's pick, and with the recommended one when the pick isn't on offer", async () => {
    const { S, AI } = await load({ signedIn: true });
    const sent = stubPrivate();
    expect(await AI.chat('Hi')).toContain('Do set 1 now');
    S.state.settings.privateModel = 'deepseek-r1-70b';
    await AI.chat('Hi');
    S.state.settings.privateModel = 'not-offered-any-more';
    await AI.chat('Hi');
    S.state.settings.privateModel = 'nomic-embed-text'; // on the list, but not a chat model
    await AI.chat('Hi');
    expect(sent).toEqual(['llama3-3-70b', 'deepseek-r1-70b', 'llama3-3-70b', 'llama3-3-70b']);
    expect(S.state.settings.privateModel).toBe('nomic-embed-text'); // nothing cleared
  });

  it("answers with the recommended model when the pick isn't found, and keeps the pick saved", async () => {
    const { S, AI } = await load({ signedIn: true });
    S.state.settings.privateModel = 'deepseek-r1-70b';
    const sent = stubPrivate(['deepseek-r1-70b']);
    expect(await AI.chat('Hi')).toContain('Do set 1 now');
    expect(sent).toEqual(['deepseek-r1-70b', 'llama3-3-70b']);
    await AI.chat('Again');
    expect(sent.slice(2)).toEqual(['llama3-3-70b']); // no second try on a model that isn't there
    expect(S.state.settings.privateModel).toBe('deepseek-r1-70b');
  });

  it("sends the free AI the Player's pick, and the recommended one for a model it doesn't take", async () => {
    const { S, AI } = await load({ signedIn: true });
    S.state.settings.aiEngine = 'free';
    AI.agreeFree();
    const sent: { url: string; model: string }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: { method: string; body?: string }) => {
      if (init.method === 'GET') return new Response(JSON.stringify({ data: [{ id: '@cf/openai/gpt-oss-120b' }, { id: '@cf/openai/gpt-oss-20b' }] }));
      sent.push({ url, model: JSON.parse(init.body || '{}').model });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Do set 1 now.' }, finish_reason: 'stop' }] }));
    });
    expect(await AI.engineModels('free')).toEqual(['@cf/openai/gpt-oss-120b', '@cf/openai/gpt-oss-20b']);
    expect(AI.engineModelName('free', '@cf/openai/gpt-oss-120b')).toBe('gpt-oss-120b (recommended)');
    expect(AI.engineModelName('free', '@cf/openai/gpt-oss-20b')).toBe('gpt-oss-20b (faster, stretches the free allowance)');
    await AI.chat('Hi');
    S.state.settings.freeModel = '@cf/openai/gpt-oss-20b';
    await AI.chat('Hi');
    S.state.settings.freeModel = '@cf/meta/a-pricey-model';
    await AI.chat('Hi');
    expect(sent.map((s) => s.model)).toEqual(['@cf/openai/gpt-oss-120b', '@cf/openai/gpt-oss-20b', '@cf/openai/gpt-oss-120b']);
    expect(sent.every((s) => s.url === 'https://ai.example.workers.dev/free/v1/chat/completions')).toBe(true);
  });

  it('talks the way the look does: plainly in the Arise look, as the System in the System look', async () => {
    const { S, AI } = await load({ signedIn: true });
    S.state.settings.aiEngine = 'free';
    AI.agreeFree();
    const sent: { role: string; content: string }[][] = [];
    vi.stubGlobal('fetch', async (_url: string, init: { method: string; body?: string }) => {
      if (init.method === 'GET') return new Response(JSON.stringify({ data: [] }));
      sent.push(JSON.parse(init.body || '{}').messages);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Do set 1 now.' }, finish_reason: 'stop' }] }));
    });
    await AI.chat('Hi');
    S.state.settings.look = 'system';
    await AI.chat('Hi');
    const [arise, system] = sent.map((m) => m.find((x) => x.role === 'system')!.content);
    expect(arise).toContain('never call yourself "the System" unless the tone they chose is the System.');
    expect(arise).not.toContain('You are "the System"');
    expect(arise).not.toContain('Solo Leveling');
    expect(system).toContain('You are "the System", the AI coach inside Arise, a daily self-improvement app styled after the System in Solo Leveling.');
    expect(system).toContain(`a light touch of the System's voice`);
    // Everything after the opening and the voice is the same in both.
    expect(arise.slice(arise.indexOf('Safety'))).toBe(system.slice(system.indexOf('Safety')));
  });

  it("still offers the free AI's models when the proxy can't list them", async () => {
    const { AI } = await load({ signedIn: true });
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 500 }));
    expect(await AI.engineModels('free')).toEqual(['@cf/openai/gpt-oss-120b', '@cf/openai/gpt-oss-20b']);
  });
});
