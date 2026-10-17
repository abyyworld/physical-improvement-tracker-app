// @vitest-environment jsdom
// Only strong models write the memory (life/strength.ts), through ai.js: requests for the memory
// go only to a strong model, the chain of the Player's keys skips weak keys instead of falling back
// to them, a model the Player trusts for a key counts, and every answer says who wrote it. Chat
// still works with any model.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const device = { state: 'unavailable' as string, ask: vi.fn(async () => '{"summary":"x"}') };
vi.mock('./lib/on-device', () => ({ lastKnown: () => device.state, availability: async () => device.state, ask: () => device.ask(), download: vi.fn() }));
vi.mock('./ai-config', () => ({ PRIVATE_AI: { proxy: 'https://ai.example.workers.dev/v1/', model: 'llama3-3-70b', name: 'Private AI' } }));

async function load({ signedIn = false } = {}) {
  vi.resetModules();
  const S = await import('./store');
  const AI = await import('./ai.js');
  AI.connectAccount({ signedIn: () => signedIn, idToken: async () => (signedIn ? 'token' : null) });
  return { S, AI };
}

type Init = { method?: string; body?: string };
const answer = (text: string) => new Response(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3 } }));
const gemini = (text: string) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] }));
function stub(routes: Record<string, (url: string, init: Init) => Response>) {
  const calls: { host: string; model: string }[] = [];
  vi.stubGlobal('fetch', async (url: string, init: Init = {}) => {
    const host = new URL(url).host;
    const body = init.body ? JSON.parse(init.body) : {};
    calls.push({ host, model: body.model || decodeURIComponent(url.split('/models/')[1]?.split(':')[0] || '') });
    if (!routes[host]) throw new TypeError('Failed to fetch');
    return routes[host](url, init);
  });
  return calls;
}
const memo = { signal: undefined, instructions: 'Sum up the day.', prompt: 'The day.', schema: { type: 'object', properties: { summary: { type: 'string' } } } };
const SUMMARY = '{"summary":"A good day."}';

beforeEach(() => {
  localStorage.clear();
  device.state = 'unavailable';
  device.ask.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe('your AI keys', () => {
  async function keys(...list: { key: string; model: string; provider?: string }[]) {
    const out = await load();
    for (const k of list) out.AI.addKey(k);
    out.S.state.settings.aiEngine = 'own';
    for (const id of ['groq', 'google', 'mistral']) out.AI.consent(id);
    return out;
  }

  it('asks only a key whose model is strong, skipping a weak one before it, and chat still uses the first', async () => {
    const { AI } = await keys({ key: 'gsk_small', model: 'llama-3.1-8b-instant' }, { key: 'AIzaBig', model: 'gemini-2.5-flash' });
    const calls = stub({ 'api.groq.com': () => answer('Groq here.'), 'generativelanguage.googleapis.com': () => gemini(SUMMARY) });
    expect(AI.memoryStrength()).toBe('strong');
    const out = await AI.askMemory({ ...memo, engine: 'own' });
    expect(out).toMatchObject({ json: { summary: 'A good day.' }, by: 'own:google:gemini-2.5-flash' });
    expect(calls.map((c) => c.host)).toEqual(['generativelanguage.googleapis.com']);
    expect(await AI.testKey()).toBe('Groq here.');
    expect(AI.keyRows().map((r) => r.memory)).toEqual(['weak', 'strong']);
  });

  it('waits when every key is weak, and sends nothing', async () => {
    const { AI } = await keys({ key: 'gsk_small', model: 'llama-3.1-8b-instant' }, { key: 'AIzaLite', model: 'gemini-2.0-flash-lite' });
    const calls = stub({ 'api.groq.com': () => answer('x'), 'generativelanguage.googleapis.com': () => gemini('x') });
    expect(AI.memoryStrength()).toBe('weak');
    await expect(AI.askMemory({ ...memo, engine: 'own' })).rejects.toMatchObject({ code: 'weak', message: 'Learning waits for a strong AI: the private AI or a strong key in Your AI keys.' });
    expect(calls).toEqual([]);
  });

  it('never falls back to a weak key when the strong one fails', async () => {
    const { AI } = await keys({ key: 'AIzaBig', model: 'gemini-2.5-pro' }, { key: 'gsk_small', model: 'llama-3.1-8b-instant' });
    const calls = stub({ 'generativelanguage.googleapis.com': () => new Response(JSON.stringify({ error: { code: 429, message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' } }), { status: 429, headers: { 'retry-after': '60' } }), 'api.groq.com': () => answer('x') });
    await expect(AI.askMemory({ ...memo, engine: 'own' })).rejects.toMatchObject({ code: 'rate' });
    expect(calls.every((c) => c.host === 'generativelanguage.googleapis.com')).toBe(true);
    // Resting now: the memory waits for it instead of asking the small one.
    await expect(AI.askMemory({ ...memo, engine: 'own' })).rejects.toMatchObject({ code: 'rate' });
    expect(calls.some((c) => c.host === 'api.groq.com')).toBe(false);
  });

  it('counts a model it does not know only once you trust it for that key, and asks again after the model changes', async () => {
    const { AI } = await keys({ key: 'mistral-key-1234', model: 'mistral-medium-latest', provider: 'mistral' });
    const calls = stub({ 'api.mistral.ai': () => answer(SUMMARY) });
    const id = AI.keys()[0].id;
    expect(AI.keyRows()[0].memory).toBe('unknown');
    expect(AI.memoryStrength()).toBe('weak');
    await expect(AI.askMemory({ ...memo, engine: 'own' })).rejects.toMatchObject({ code: 'weak' });
    AI.trustKey(id, true);
    expect(AI.keyRows()[0].memory).toBe('trusted');
    expect(AI.memoryStrength()).toBe('strong');
    expect(AI.trustedModel('mistral', 'mistral-medium-latest')).toBe(true);
    expect(await AI.askMemory({ ...memo, engine: 'own' })).toMatchObject({ by: 'own:mistral:mistral-medium-latest' });
    expect(calls).toHaveLength(1);
    // Kept on this device only, never in the data that syncs or a backup.
    expect(localStorage.getItem('pit-data-v1') || '').not.toContain('mistral-medium');
    AI.updateKey(id, { model: 'mistral-large-2411' });
    expect(AI.keyRows()[0].memory).toBe('strong');
    AI.updateKey(id, { model: 'magistral-medium-latest' });
    expect(AI.keyRows()[0].memory).toBe('unknown');
    // Trust never makes a model known to be small strong.
    AI.updateKey(id, { model: 'mistral-small-latest' });
    AI.trustKey(id, true);
    expect(AI.keyRows()[0].memory).toBe('weak');
    AI.removeKey(id);
    expect(AI.trustedModel('mistral', 'mistral-small-latest')).toBe(false);
  });
});

describe('the other engines', () => {
  it('never lets the AI on this device write the memory, though it still chats', async () => {
    device.state = 'available';
    const { AI } = await load();
    expect(AI.engine()).toBe('device');
    expect(AI.memoryStrength()).toBe('weak');
    await expect(AI.askMemory({ ...memo, engine: 'device' })).rejects.toMatchObject({ code: 'weak' });
    expect(device.ask).not.toHaveBeenCalled();
    await AI.testKey();
    expect(device.ask).toHaveBeenCalledTimes(1);
  });

  it("asks the free AI's big model, and waits when the smaller one is picked", async () => {
    const { S, AI } = await load({ signedIn: true });
    S.state.settings.aiEngine = 'free';
    AI.agreeFree();
    const calls = stub({ 'ai.example.workers.dev': () => answer(SUMMARY) });
    expect(AI.memoryStrength()).toBe('strong');
    expect(await AI.askMemory({ ...memo, engine: 'free' })).toMatchObject({ by: 'free:@cf/openai/gpt-oss-120b' });
    S.state.settings.freeModel = '@cf/openai/gpt-oss-20b';
    expect(AI.memoryStrength()).toBe('weak');
    await expect(AI.askMemory({ ...memo, engine: 'free' })).rejects.toMatchObject({ code: 'weak' });
    expect(calls.map((c) => c.model)).toEqual(['@cf/openai/gpt-oss-120b']);
  });

  it("says whether the private AI's picked model may write it", async () => {
    const { S, AI } = await load({ signedIn: true });
    expect(AI.engine()).toBe('private');
    expect(AI.memoryStrength()).toBe('strong'); // its recommended model
    S.state.settings.privateModel = 'gemma4-31b';
    expect(AI.memoryStrength()).toBe('weak');
    S.state.settings.privateModel = 'deepseek-r1-0528';
    expect(AI.memoryStrength()).toBe('strong');
    expect((await load()).AI.memoryStrength()).toBe('none');
  });
});
