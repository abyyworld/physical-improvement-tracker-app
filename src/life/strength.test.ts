// Which AI models are strong enough to write Arise's memory, and who wrote what.

import { describe, expect, it } from 'vitest';
import { byText, classify, cleanBy, makeBy, modelName, parseBy, sizeOf, strongBy } from './strength';

const s = (engine: string, model: string) => classify(engine, model).strength;

describe('strong and weak models', () => {
  it.each([
    // The private AI's big models.
    ['private', 'gpt-oss-120b'],
    ['private', 'llama3-3-70b'],
    ['private', 'deepseek-r1-0528'],
    ['private', 'qwen2-5-72b'],
    ['private', 'kimi-k2-thinking'],
    ['free', '@cf/openai/gpt-oss-120b'],
    ['free', '@cf/meta/llama-3.3-70b-instruct-fp8-fast'],
    // Claude.
    ['own', 'claude-opus-5-5'],
    ['own', 'claude-sonnet-4-5'],
    ['own', 'claude-3-7-sonnet-latest'],
    ['own', 'claude-haiku-4-5'],
    ['own', 'claude-haiku-4-5-20251001'],
    // OpenAI.
    ['own', 'gpt-4.1'],
    ['own', 'openai/gpt-4.1'],
    ['own', 'gpt-4o'],
    ['own', 'openai/gpt-4o'], // GitHub Models
    ['own', 'chatgpt-4o-latest'],
    ['own', 'gpt-4o-2024-08-06'],
    ['own', 'gpt-5'],
    ['own', 'gpt-5.1-2025-11-13'],
    ['own', 'o3'],
    // Gemini.
    ['own', 'gemini-2.5-pro'],
    ['own', 'gemini-2.5-flash'],
    ['own', 'gemini-flash-latest'],
    ['own', 'models/gemini-3-pro-preview'],
    // Large open models.
    ['own', 'llama-3.3-70b-versatile'],
    ['own', 'meta-llama/llama-3.1-405b-instruct:free'],
    ['own', 'deepseek-chat'],
    ['own', 'deepseek/deepseek-chat-v3-0324:free'],
    ['own', 'deepseek-ai/DeepSeek-R1'],
    ['own', 'deepseek-r1:671b'],
    ['own', 'deepseek-ai/DeepSeek-Prover-V2-671B'],
    ['own', 'qwen-3-235b-a22b-instruct-2507'],
    ['own', 'qwen3:235b'],
    ['own', 'moonshotai/kimi-k2-instruct'],
    ['own', 'meta-llama/llama-4-maverick-17b-128e-instruct'],
    ['own', 'command-a-03-2025'],
    ['own', 'mistral-large-latest'],
    ['own', 'openai/gpt-oss-120b'],
    ['own', 'llama3.3:70b'],
  ])('%s %s is strong', (engine, model) => {
    expect(classify(engine, model)).toEqual({ strength: 'strong', sure: true });
  });

  it.each([
    ['device', 'gemini-nano'],
    ['device', 'gpt-oss-120b'], // whatever it says, the AI on the device is small
    ['free', '@cf/openai/gpt-oss-20b'],
    ['private', 'gemma4-31b'],
    ['private', 'mistral-small-3-1-24b'],
    ['own', 'gpt-oss:20b'],
    ['own', 'llama-3.1-8b-instant'],
    ['own', 'gpt-4.1-mini'],
    ['own', 'gpt-4.1-nano'],
    ['own', 'gpt-5-mini'],
    ['own', 'gpt-5-nano'],
    ['own', 'o4-mini'],
    ['own', 'gpt-4o-mini'],
    ['own', 'openai/gpt-4o-mini'],
    ['own', 'gpt-3.5-turbo'],
    ['own', 'gemini-2.0-flash-lite'],
    ['own', 'gemini-flash-lite-latest'],
    ['own', 'gemini-1.5-flash-8b'],
    ['own', 'claude-3-5-haiku-20241022'],
    ['own', 'claude-3-haiku-20240307'],
    ['own', 'qwen/qwen3-32b'],
    ['own', 'meta-llama/llama-4-scout-17b-16e-instruct'],
    ['own', 'mixtral-8x7b-32768'],
    ['own', 'deepseek-r1-distill-qwen-14b'],
    // Small models made from DeepSeek R1 without "distill" in the name: their size decides.
    ['own', 'deepseek/deepseek-r1-0528-qwen3-8b:free'],
    ['own', 'deepseek-ai/DeepSeek-R1-0528-Qwen3-8B'],
    ['own', 'deepseek-r1:1.5b'],
    ['own', 'deepseek-r1:8b'],
    ['own', 'deepseek-r1:32b'],
    ['own', 'deepseek-prover-v2-7b'],
    ['own', 'gemma-3-27b-it'],
    ['own', 'mistral-small-latest'],
  ])('%s %s is weak', (engine, model) => {
    expect(classify(engine, model)).toEqual({ strength: 'weak', sure: true });
  });

  it("counts a model it doesn't know as weak, and says it isn't sure", () => {
    for (const m of ['mistral-medium-latest', 'some-new-model', 'gemma-3n-e4b-it', '', 'openrouter/auto']) expect(classify('own', m)).toEqual({ strength: 'weak', sure: false });
    expect(classify('private', undefined)).toEqual({ strength: 'weak', sure: false });
  });

  it('reads the size from the name, not the part that works on each token', () => {
    expect(sizeOf('qwen3-235b-a22b')).toBe(235);
    expect(sizeOf('mixtral-8x22b-instruct')).toBe(176);
    expect(sizeOf('gemma-3n-e4b-it')).toBe(0);
    expect(sizeOf('llama-3.1-8b-instant')).toBe(8);
    expect(sizeOf('qwen2.5-0.5b')).toBe(0.5);
    expect(modelName('@cf/openai/gpt-oss-120b')).toBe('gpt-oss-120b');
    expect(modelName('models/Gemini-2.5-Pro')).toBe('gemini-2.5-pro');
    expect(modelName('openai/gpt-oss-120b:free')).toBe('gpt-oss-120b');
  });
});

describe('who wrote it', () => {
  it('records the engine and the model, and the service for your own keys', () => {
    expect(makeBy('private', 'gpt-oss-120b')).toBe('private:gpt-oss-120b');
    expect(makeBy('own', 'deepseek/deepseek-r1:free', 'openrouter')).toBe('own:openrouter:deepseek/deepseek-r1:free');
    expect(parseBy('own:openrouter:deepseek/deepseek-r1:free')).toEqual({ engine: 'own', provider: 'openrouter', model: 'deepseek/deepseek-r1:free' });
    expect(parseBy('free:@cf/openai/gpt-oss-120b')).toEqual({ engine: 'free', provider: '', model: '@cf/openai/gpt-oss-120b' });
    for (const bad of ['', 'private:', 'cloud:gpt-5', 'own:gpt-5', 'private:<script>', 42, null]) expect(cleanBy(bad)).toBe('');
  });

  it('says whether it was strong, with the models you trust, and counts nothing recorded as weak', () => {
    expect(strongBy('private:gpt-oss-120b')).toBe(true);
    expect(strongBy('free:@cf/openai/gpt-oss-20b')).toBe(false);
    expect(strongBy(undefined)).toBe(false);
    expect(strongBy('own:mistral:mistral-medium-latest')).toBe(false);
    const trusted = (provider: string, model: string) => provider === 'mistral' && model === 'mistral-medium-latest';
    expect(strongBy('own:mistral:mistral-medium-latest', trusted)).toBe(true);
    // Trust never turns a model known to be weak into a strong one.
    expect(strongBy('own:openai:gpt-5-mini', () => true)).toBe(false);
  });

  it("knows a model on the Player's own computer, and trusts one only as they do", () => {
    expect(makeBy('local', 'qwen2.5:72b')).toBe('local:qwen2.5:72b');
    expect(parseBy('local:qwen2.5:7b')).toEqual({ engine: 'local', provider: '', model: 'qwen2.5:7b' });
    expect(strongBy('local:qwen2.5:72b')).toBe(true);
    expect(strongBy('local:qwen2.5:7b', () => true)).toBe(false); // known to be small
    expect(strongBy('local:house-model')).toBe(false);
    expect(strongBy('local:house-model', (provider, model) => provider === 'local' && model === 'house-model')).toBe(true);
    // A key's trust isn't the computer's.
    expect(strongBy('local:house-model', (provider) => provider === '')).toBe(false);
    expect(byText('local:qwen2.5:72b')).toBe('the AI on your computer (qwen2.5:72b)');
  });

  it('names it in plain words', () => {
    expect(byText('private:gpt-oss-120b')).toBe('the private AI (gpt-oss-120b)');
    expect(byText('free:@cf/openai/gpt-oss-120b')).toBe('the free AI (gpt-oss-120b)');
    expect(byText('own:anthropic:claude-sonnet-4-5')).toBe('your AI key (claude-sonnet-4-5)');
    expect(byText('')).toBe('');
  });
});

it('keeps the plain line for when learning waits', async () => {
  const { WAITS } = await import('./strength');
  expect(WAITS).toBe('Learning waits for a strong AI: the private AI or a strong key in Your AI keys.');
  expect(s('own', 'gpt-5')).toBe('strong');
});
