// How strong an AI model is, for writing Arise's memory.
//
// What Arise learns (the summaries of days, weeks and months, the facts, the profile made from
// them, and the AI journal) is read back by every later request. A small model's mistakes would
// be built on by the next model, and the next, so only strong models write the memory. Chat and
// quick answers still work with any model.
//
// Strong: the private AI's big models (gpt-oss-120b, Llama 3.3 70B and up), Claude Sonnet and Opus
// (and Haiku 4.5 or newer), OpenAI's GPT-4o, GPT-4.1 and GPT-5 class (not mini or nano), Gemini
// Pro and Flash (not Flash-Lite), and large open models: 70B parameters or more, DeepSeek V3 and
// R1 (not the smaller models made from them), Qwen3 235B, Kimi K2, Llama 4 Maverick and the like.
// Weak: the AI on the device, gpt-oss-20b, anything with 8B or a few tens of billions of
// parameters, and mini, nano, lite and small models.
// A model this file doesn't know is weak too (`sure: false`): the Player may trust one of their
// own keys' models in Settings, or a model on their own computer (lib/local-ai.ts).
//
// No app imports, so the memory, the AI layer and the tests can all use it.

export type Strength = 'strong' | 'weak';
export interface Verdict {
  strength: Strength;
  sure: boolean; // false: a model this file doesn't know, which counts as weak
}

const strong: Verdict = { strength: 'strong', sure: true };
const weak: Verdict = { strength: 'weak', sure: true };
const unknown: Verdict = { strength: 'weak', sure: false };

// The model's own name, without where it's served from: '@cf/openai/gpt-oss-120b' and
// 'openai/gpt-oss-120b:free' are both 'gpt-oss-120b'.
export function modelName(model: unknown): string {
  return String(model ?? '')
    .trim()
    .toLowerCase()
    .replace(/^models\//, '')
    .replace(/:(free|beta|extended|nitro|floor|online|exacto)$/, '')
    .split('/')
    .at(-1)!;
}

// Billions of parameters in the name ('llama-3.3-70b', 'qwen3:235b', 'mixtral-8x22b'), the
// largest if there are several, or 0. An "a22b" or "e4b" is the part that's active per token,
// not the size, so only a number on its own counts.
export function sizeOf(name: string): number {
  let best = 0;
  for (const m of name.matchAll(/(?:^|[^a-z0-9.])(\d+)x(\d+(?:\.\d+)?)b(?![a-z0-9])/g)) best = Math.max(best, Number(m[1]) * Number(m[2]));
  for (const m of name.matchAll(/(?:^|[^a-z0-9.x])(\d+(?:\.\d+)?)b(?![a-z0-9])/g)) best = Math.max(best, Number(m[1]));
  return best;
}

const SMALL = /(^|[-_.:\s])(mini|nano|lite|tiny|small|micro)([-_.:\s]|$)/;

export function classify(engine: string | null | undefined, model: unknown): Verdict {
  if (engine === 'device') return weak; // the small model in the browser
  const name = modelName(model);
  if (!name) return unknown;
  if (SMALL.test(name)) return weak;

  // gpt-oss: 120b is strong, 20b isn't.
  const oss = /gpt-oss[-_:]?(\d+)b/.exec(name);
  if (oss) return Number(oss[1]) >= 70 ? strong : weak;

  // Claude: Sonnet and Opus; Haiku from 4.5.
  if (name.includes('claude')) {
    if (/opus|sonnet/.test(name)) return strong;
    // 'claude-haiku-4-5' or 'claude-3-5-haiku-20241022' (a date isn't a version).
    const before = /claude-(\d{1,2})(?:[-.](\d))?-haiku/.exec(name);
    const after = /haiku-(\d{1,2})(?![\d])(?:[-.](\d)(?!\d))?/.exec(name);
    const v = before || after;
    if (v) return Number(v[1]) + Number(v[2] || 0) / 10 >= 4.5 ? strong : weak;
    return weak;
  }

  // OpenAI: GPT-4o, GPT-4.1, GPT-4.5 and GPT-5 or newer, and the o1 and o3 reasoning models.
  const gpt = /^(?:chat)?gpt-(\d+)(?:\.(\d+))?(o\b)?/.exec(name);
  if (gpt) return gpt[3] || Number(gpt[1]) + Number(gpt[2] || 0) / 10 >= 4.1 ? strong : weak;
  if (/^o[1-9](-pro|-preview)?(-\d{4}-\d{2}-\d{2})?$/.test(name)) return strong;

  // Gemini: Pro and Flash (Flash-Lite and the 8B Flash are caught above and here).
  if (name.startsWith('gemini')) {
    if (sizeOf(name) && sizeOf(name) < 70) return weak;
    return /pro|flash/.test(name) ? strong : unknown;
  }

  // Large open models known by name. A DeepSeek with a size in its name is a smaller one made from
  // it ('deepseek-r1-0528-qwen3-8b', 'deepseek-r1:8b'): its size decides, below.
  const sized = sizeOf(name);
  if (/deepseek/.test(name) && !/distill/.test(name) && !(sized && sized < 70) && /deepseek-(v3|r1|chat|reasoner|v2\.5|prover-v2)/.test(name)) return strong;
  if (/kimi-k2|maverick|glm-4\.[5-9]|glm-[5-9]|minimax-m[1-9]|command-a\b|command-a-|command-r-plus|command-r\+|mistral-large|qwen3-coder-480b/.test(name)) return strong;

  // Anything else by its size.
  const size = sizeOf(name);
  if (size >= 70) return strong;
  if (size > 0) return weak;
  return unknown;
}

// ---------- who wrote something in the memory
//
// Each summary, fact and journal records the AI that wrote it as `by`:
// 'private:gpt-oss-120b', 'free:@cf/openai/gpt-oss-120b', 'own:anthropic:claude-sonnet-4-5',
// 'local:qwen2.5:72b' (the Player's own computer: lib/local-ai.ts).
// (A model's name can have colons in it, so for "own" the service comes first and the rest is
// the model.)

const BY = /^(?:(private|free|device|local):([\w.:/@+-]{1,120})|own:([a-z]{1,20}):([\w.:/@+-]{1,120}))$/;

export const cleanBy = (v: unknown): string => (typeof v === 'string' && BY.test(v) ? v : '');

export function makeBy(engine: string, model: string, provider = ''): string {
  return cleanBy(engine === 'own' ? `own:${provider}:${model}` : `${engine}:${model}`);
}

export function parseBy(by: unknown): { engine: string; provider: string; model: string } | null {
  const m = BY.exec(cleanBy(by));
  if (!m) return null;
  return m[1] ? { engine: m[1], provider: '', model: m[2] } : { engine: 'own', provider: m[3], model: m[4] };
}

// Whether what `by` wrote counts as strong. `trusted(provider, model)`: a model the Player trusts
// for one of their keys (provider 'local': on their own computer). Nothing recorded (made before
// Arise recorded it) counts as weak, so a strong model writes it again.
export function strongBy(by: unknown, trusted: (provider: string, model: string) => boolean = () => false): boolean {
  const p = parseBy(by);
  if (!p) return false;
  const v = classify(p.engine, p.model);
  return v.strength === 'strong' || (!v.sure && (p.engine === 'own' || p.engine === 'local') && trusted(p.engine === 'local' ? 'local' : p.provider, p.model));
}

// "the private AI (gpt-oss-120b)", for the screens.
export function byText(by: unknown): string {
  const p = parseBy(by);
  if (!p) return '';
  const model = modelName(p.model);
  if (p.engine === 'private') return `the private AI (${model})`;
  if (p.engine === 'free') return `the free AI (${model})`;
  if (p.engine === 'device') return 'the AI on this device';
  if (p.engine === 'local') return `the AI on your computer (${model})`;
  return `your AI key (${model})`;
}

export const WAITS = 'Learning waits for a strong AI: the private AI or a strong key in Your AI keys.';
