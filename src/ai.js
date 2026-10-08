// The AI coach inside the app: "the System".
//
// Works with whichever AI service the Player has a key for: Claude (Anthropic), Gemini (Google),
// OpenAI, OpenRouter, Groq, or any other service that uses the OpenAI format. Claude goes through
// Anthropic's official JavaScript SDK (loaded only when used);
// the others are plain HTTPS requests. The key is stored on this device only (never in backups) and
// requests go straight from this device to that service.

import { EXERCISES } from './program.js';
import * as S from './store';
import { normalizePlan, plain } from './lib/clean';

export { plain };

// Claude's default model.
export const MODEL = 'claude-opus-5-5';
const MODEL_NAME = 'Claude Opus 5.5';
// If a request is declined by a safety classifier, the API retries it on the model Anthropic
// recommends for that case instead of returning the refusal.
const BETAS = ['server-side-fallback-2026-07-01'];
// The name dates from when Claude was the only option; kept so saved keys keep working.
const KEY_STORE = 'arise-claude-key';
// USD per million tokens for the default Claude model, used for the running cost estimate.
const PRICE = { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 };
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta';

// `model` is the default; an empty one means "pick the best model this key can use".
export const PROVIDERS = {
  anthropic: { name: 'Claude', label: 'Claude (Anthropic)', company: 'Anthropic', keyUrl: 'https://console.anthropic.com/settings/keys', keyHint: 'sk-ant-…', model: MODEL },
  google: { name: 'Gemini', label: 'Gemini (Google)', company: 'Google', keyUrl: 'https://aistudio.google.com/apikey', keyHint: 'AIza…', model: 'gemini-flash-latest' },
  openai: { name: 'OpenAI', label: 'OpenAI (ChatGPT models)', company: 'OpenAI', keyUrl: 'https://platform.openai.com/api-keys', keyHint: 'sk-…', base: 'https://api.openai.com/v1', model: '' },
  openrouter: { name: 'OpenRouter', label: 'OpenRouter (one key, most models)', company: 'OpenRouter', keyUrl: 'https://openrouter.ai/keys', keyHint: 'sk-or-…', base: 'https://openrouter.ai/api/v1', model: 'openrouter/auto' },
  groq: { name: 'Groq', label: 'Groq', company: 'Groq', keyUrl: 'https://console.groq.com/keys', keyHint: 'gsk_…', base: 'https://api.groq.com/openai/v1', model: '' },
  custom: { name: 'your AI service', label: 'Other (works like OpenAI)', company: 'your AI service', keyUrl: '', keyHint: 'API key', base: '', model: '' },
};

export class AIError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ---------- key, service and model

export function getKey() {
  try {
    return localStorage.getItem(KEY_STORE) || '';
  } catch {
    return '';
  }
}

export function setKey(key) {
  try {
    if (key && key.trim()) localStorage.setItem(KEY_STORE, key.trim());
    else localStorage.removeItem(KEY_STORE);
  } catch {}
  client = null;
  models = null;
  standIn = null;
  googleBest = null;
}

export const hasKey = () => !!getKey();

// Most keys start with a tell-tale prefix. Returns null when it can't tell.
export function detectProvider(key) {
  const k = String(key || '').trim();
  if (/^sk-ant-/.test(k)) return 'anthropic';
  if (/^AIza/.test(k)) return 'google';
  if (/^sk-or-/.test(k)) return 'openrouter';
  if (/^gsk_/.test(k)) return 'groq';
  if (/^sk-/.test(k)) return 'openai';
  return null;
}

// The service in use: the one picked in Settings, or the one the key looks like.
export function provider() {
  const picked = S.state.settings.aiProvider;
  const id = Object.hasOwn(PROVIDERS, picked) && picked ? picked : detectProvider(getKey());
  return id ? { id, ...PROVIDERS[id] } : null;
}

// Keys with an unmistakable prefix only ever go to their own service, whatever is picked.
// (A plain "sk-" key can belong to many OpenAI-format services, so it's allowed anywhere.)
const OWN_HOST = { anthropic: true, google: true, openrouter: true, groq: true };
function keyMismatch(p) {
  const from = detectProvider(getKey());
  return from && OWN_HOST[from] && from !== p.id ? PROVIDERS[from] : null;
}

// The host a custom service's requests go to, which the Player confirms once on this device.
export const customHost = () => {
  try {
    return new URL(baseUrl({ id: 'custom' })).host;
  } catch {
    return '';
  }
};
const CONFIRMED = 'arise-ai-host-ok';
export const hostConfirmed = () => {
  try {
    return !!customHost() && localStorage.getItem(CONFIRMED) === customHost();
  } catch {
    return false;
  }
};
export function confirmHost() {
  try {
    localStorage.setItem(CONFIRMED, customHost());
  } catch {}
}

function need() {
  if (!getKey()) throw new AIError('no-key', 'Connect an AI in Settings first.');
  const p = provider();
  if (!p) throw new AIError('no-provider', "The app couldn't tell which AI service your key is for. Pick it in Settings.");
  if (p.id === 'custom' && !baseUrl(p)) throw new AIError('no-base', 'Add the API address of your AI service in Settings.');
  const other = keyMismatch(p);
  if (other) throw new AIError('wrong-service', `That key is for ${other.name}, but ${p.name} is picked in Settings. Pick ${other.name}, or paste a ${p.name} key.`);
  if (p.id === 'custom' && !hostConfirmed()) throw new AIError('confirm-host', `Confirm in Settings that your key may be sent to ${customHost() || 'that address'}.`);
  return p;
}

const baseUrl = (p) => (p.id === 'custom' ? S.state.settings.aiBase || '' : p.base || '').trim().replace(/\/+$/, '');
const cleanModel = (m) => String(m || '').trim().replace(/^models\//, '');

// The model to use: the one picked in Settings, the service's default, or the best one on offer.
// When the recommended model is busy, another one stands in until the app is reopened.
let standIn = null;

async function modelFor(p) {
  const picked = cleanModel(S.state.settings.aiModel);
  if (picked) return picked;
  if (standIn?.provider === p.id) return standIn.model;
  // Gemini: the newest stable Flash model on this key. "gemini-flash-latest" can point at a preview,
  // and previews are the first to be overloaded, so it's only the fallback.
  if (p.id === 'google') return (await googlePick()) || p.model;
  if (p.model) return p.model;
  const list = await listModels();
  const best = bestModel(p, list);
  if (!best) throw new AIError('no-model', `No usable models came back from ${p.name}. Type a model name in Settings.`);
  S.state.settings.aiModel = best;
  S.save();
  return best;
}

let googleBest = null;

async function googlePick() {
  if (googleBest === null) {
    const list = await listModels().catch(() => null);
    if (!list) return null; // try again next time
    googleBest = alternatives({ id: 'google' }, list, '')[0] || '';
  }
  return googleBest;
}

// The model the app recommends for the connected service (shown in Settings).
export function recommendedModel() {
  const p = provider();
  if (!p) return '';
  if (p.id === 'google' && googleBest) return googleBest;
  return p.model;
}

// The model standing in for a busy recommended one, if any.
export const standInModel = () => (standIn?.provider === provider()?.id ? standIn.model : null);

export function modelLabel() {
  const p = provider();
  if (!p) return 'your AI';
  const m = cleanModel(S.state.settings.aiModel) || (standIn?.provider === p.id ? standIn.model : '') || recommendedModel();
  if (p.id === 'anthropic' && m === MODEL) return MODEL_NAME;
  return m ? `${p.name} (${m})` : p.name;
}

// Models this key can use, for the picker in Settings. Cached until the key changes.
let models = null;
const NOT_CHAT = /embed|whisper|tts|dall-e|image|imagen|audio|realtime|transcribe|moderation|guard|search|davinci|babbage|computer-use|sora|veo|aqa|native|live/i;

export async function listModels({ refresh = false } = {}) {
  const p = need();
  if (models && !refresh && models.provider === p.id) return models.list;
  let list = [];
  if (p.id === 'anthropic') {
    const c = await getClient();
    try {
      const page = await c.models.list({ limit: 100 });
      list = page.data.map((m) => m.id);
    } catch (err) {
      throw friendlyClaude(err);
    }
  } else if (p.id === 'google') {
    const res = await request(p, `${GEMINI}/models?pageSize=1000`, { method: 'GET', headers: { 'x-goog-api-key': getKey() } });
    const data = await res.json();
    list = (data.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent') && /gemini/i.test(m.name) && !NOT_CHAT.test(m.name))
      .map((m) => cleanModel(m.name));
  } else {
    const res = await request(p, `${baseUrl(p)}/models`, { method: 'GET', headers: { Authorization: `Bearer ${getKey()}` } });
    const data = await res.json();
    list = (Array.isArray(data.data) ? data.data : Array.isArray(data) ? data : []).map((m) => m.id).filter((id) => id && !NOT_CHAT.test(id));
  }
  list = [...new Set(list)].sort();
  if (p.model && !list.includes(p.model)) list.unshift(p.model);
  models = { provider: p.id, list };
  return list;
}

// A sensible pick when the service has no fixed default: the newest full-size GPT on OpenAI,
// otherwise the biggest model by parameter count.
function bestModel(p, list) {
  if (!list.length) return '';
  const version = (id) => (id.match(/\d+(\.\d+)?/) || ['0'])[0];
  if (p.id === 'openai') {
    const gpt = list.filter((id) => /^gpt-\d/.test(id) && !/mini|nano|oss|chat|\d{4}-\d{2}-\d{2}/.test(id));
    if (gpt.length) return gpt.sort((a, b) => parseFloat(version(b)) - parseFloat(version(a)) || a.length - b.length)[0];
  }
  const size = (id) => Number((id.match(/(\d+)b\b/i) || [0, 0])[1]);
  return [...list].sort((a, b) => size(b) - size(a))[0];
}

// ---------- usage

function track(raw, claudeDefault) {
  // Services report these themselves, so anything that isn't a plain count is ignored.
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  const input = n(raw.input);
  const output = n(raw.output);
  const cacheWrite = n(raw.cacheWrite);
  const cacheRead = n(raw.cacheRead);
  const a = S.state.ai.usage;
  if (claudeDefault) {
    a.input += input;
    a.output += output;
    a.cacheWrite += cacheWrite;
    a.cacheRead += cacheRead;
  } else {
    a.otherIn += input + cacheWrite + cacheRead;
    a.otherOut += output;
  }
  a.calls += 1;
  S.save();
}

// Only known for Claude's default model; other services show their costs on their own dashboards.
export function usageCost() {
  const u = S.state.ai.usage;
  return (u.input * PRICE.input + u.output * PRICE.output + u.cacheWrite * PRICE.cacheWrite + u.cacheRead * PRICE.cacheRead) / 1e6;
}

// ---------- one request, whichever service is connected
//
// ask({ context, messages, effort, schema, maxTokens, onText, signal, bare, cacheLast }) -> { text, json }
//   messages: [{ role: 'user' | 'assistant', content: string }]
//   schema:   a JSON Schema; the answer comes back parsed in `json`
//   onText:   streams the answer; called with the full text so far
//   bare:     no system prompt or Player data (used for the key test)

async function ask(opts) {
  const p = need();
  const go = () => (p.id === 'anthropic' ? askClaude(p, opts) : p.id === 'google' ? askGemini(p, opts) : askOpenAI(p, opts));
  try {
    return await go();
  } catch (err) {
    // Only when the Player hasn't picked a model: if the recommended one is busy or out of free
    // quota, try other models this key can use.
    if (!['server', 'rate', 'not-found'].includes(err.code) || S.state.settings.aiModel || p.id !== 'google') throw err;
    const current = await modelFor(p);
    const list = await listModels().catch(() => []);
    for (const m of alternatives(p, list, current).slice(0, 2)) {
      standIn = { provider: p.id, model: m };
      try {
        return await go();
      } catch (e) {
        if (!['server', 'rate', 'not-found'].includes(e.code)) {
          standIn = null;
          throw e;
        }
      }
    }
    standIn = null;
    throw err;
  }
}

// Other everyday models on the same service, newest first. Skips previews and special-purpose ones.
function alternatives(p, list, current) {
  const version = (id) => parseFloat((id.match(/(\d+(\.\d+)?)/) || [0, 0])[1]);
  if (p.id === 'google') {
    const ok = list.filter((m) => m !== current && /^gemini-/.test(m) && !/preview|exp|lite|image|tts|live|audio|thinking|robotics|computer|learnlm|gemma/i.test(m));
    const flash = ok.filter((m) => /flash/.test(m)).sort((a, b) => version(b) - version(a) || a.length - b.length);
    const pro = ok.filter((m) => /pro/.test(m)).sort((a, b) => version(b) - version(a) || a.length - b.length);
    return [...flash, ...pro];
  }
  return list.filter((m) => m !== current);
}

const refused = (p) => new AIError('refusal', `${p.name} declined to answer that one. Try asking in a different way.`);
const cutOff = () => new AIError('format', 'The answer was cut off. Try again.');

function schemaNote(schema) {
  return `\n\nReply with only a JSON object, no code fences and no other text, that matches this JSON Schema:\n${JSON.stringify(schema)}`;
}

function parseJSON(text, p) {
  const t = String(text || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    return JSON.parse(t);
  } catch {}
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try {
      return JSON.parse(t.slice(a, b + 1));
    } catch {}
  }
  throw new AIError('format', `${p.name} sent an answer the app couldn't read. Try again.`);
}

// --- Claude (official SDK)

let sdk = null;
let client = null;
let clientKey = '';

async function getClient() {
  const key = getKey();
  if (!sdk) {
    try {
      const [{ Anthropic }, { jsonSchemaOutputFormat }] = await Promise.all([import('@anthropic-ai/sdk'), import('@anthropic-ai/sdk/helpers/json-schema')]);
      sdk = { Anthropic, jsonSchemaOutputFormat };
    } catch {
      throw new AIError('offline', 'Could not load the AI module. Check your internet connection and reopen the app.');
    }
  }
  if (!client || clientKey !== key) {
    client = new sdk.Anthropic({ apiKey: key, dangerouslyAllowBrowser: true, maxRetries: 2 });
    clientKey = key;
  }
  return client;
}

// Turn SDK errors into short, human messages. Most specific classes first.
function friendlyClaude(err) {
  if (err instanceof AIError) return err;
  const A = sdk?.Anthropic;
  if (A) {
    if (err instanceof A.AuthenticationError) return new AIError('auth', 'Claude rejected the API key. Check it in Settings.');
    if (err instanceof A.PermissionDeniedError) return new AIError('permission', `This API key can't use ${modelLabel()}.`);
    if (err instanceof A.RateLimitError) return new AIError('rate', 'Too many requests right now. Try again in a minute.');
    if (err instanceof A.BadRequestError) return new AIError('bad-request', `Claude couldn't take that request: ${err.message}`);
    if (err instanceof A.NotFoundError) return new AIError('not-found', `${modelLabel()} isn't available for this API key. Pick another model in Settings.`);
    if (err instanceof A.APIUserAbortError) return new AIError('aborted', 'Stopped.');
    if (err instanceof A.APIConnectionError) return new AIError('offline', "Couldn't reach Claude. Check your internet connection.");
    if (err instanceof A.APIError) return new AIError('server', `Claude is having trouble right now${err.status ? ` (${err.status})` : ''}. Try again soon.`);
  }
  return new AIError('unknown', err?.message || 'Something went wrong.');
}

const textOf = (message) =>
  message.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();

async function askClaude(p, { context, messages, effort = 'medium', schema, maxTokens = 16000, onText, signal, bare, cacheLast }) {
  const c = await getClient();
  const model = await modelFor(p);
  const msgs = messages.map((m) => ({ role: m.role, content: m.content }));
  if (cacheLast) {
    // Cache the conversation so far, so follow-up questions are cheaper.
    const last = msgs[msgs.length - 1];
    msgs[msgs.length - 1] = { role: last.role, content: [{ type: 'text', text: last.content, cache_control: { type: 'ephemeral' } }] };
  }
  const params = { model, max_tokens: maxTokens, messages: msgs };
  if (!bare) params.system = systemBlocks(context);
  // Effort and the fallback beta are set for the default model; other Claude models get a plain request.
  const main = model === MODEL;
  if (main) Object.assign(params, { betas: BETAS, fallbacks: 'default', output_config: { effort } });
  if (schema) params.output_config = { ...(params.output_config || {}), format: sdk.jsonSchemaOutputFormat(schema) };
  try {
    let msg;
    if (onText) {
      const stream = c.beta.messages.stream(params, { signal });
      let text = '';
      stream.on('text', (delta) => {
        text += delta;
        onText(plain(text));
      });
      msg = await stream.finalMessage();
    } else if (schema) {
      msg = await c.beta.messages.parse(params, { signal });
    } else {
      msg = await c.beta.messages.create(params, { signal });
    }
    const u = msg.usage || {};
    track({ input: u.input_tokens || 0, output: u.output_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0, cacheRead: u.cache_read_input_tokens || 0 }, main);
    if (msg.stop_reason === 'refusal') throw refused(p);
    if (schema && msg.stop_reason === 'max_tokens') throw cutOff();
    return { text: plain(textOf(msg)).trim(), json: schema ? msg.parsed_output : undefined };
  } catch (err) {
    throw friendlyClaude(err);
  }
}

// --- plain HTTPS services (Gemini and the OpenAI format)

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new AIError('aborted', 'Stopped.'));
    });
  });

async function request(p, url, init) {
  let res;
  // Busy (503) and rate limits (429) are often gone a second later, so try twice more before giving up.
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(url, init);
    } catch (err) {
      if (err?.name === 'AbortError') throw new AIError('aborted', 'Stopped.');
      throw new AIError(
        'offline',
        `Couldn't reach ${p.name}. Check your internet connection.${p.id === 'custom' ? ' Some services also block apps that run in a browser. OpenRouter works with most models.' : ''}`,
      );
    }
    if (res.ok || attempt >= 2 || ![429, 500, 502, 503, 504].includes(res.status)) break;
    const after = Number(res.headers.get('retry-after')) * 1000;
    await sleep(Math.min(8000, after || 1200 * 2 ** attempt + Math.random() * 400), init.signal);
  }
  if (res.ok) return res;
  let detail = '';
  try {
    const body = await res.text();
    try {
      const j = JSON.parse(body);
      detail = j.error?.message || j.message || body;
    } catch {
      detail = body;
    }
  } catch {}
  detail = String(detail).replace(/\s+/g, ' ').trim().slice(0, 200).replace(/[.\s]+$/, '');
  const s = res.status;
  const d = detail.toLowerCase();
  if (s === 401 || /api[ _-]?key.*(invalid|not valid|incorrect)|invalid[ _-]api[ _-]key|incorrect api key/.test(d)) throw new AIError('auth', `${p.name} rejected the API key. Check it in Settings.`);
  if (s === 402 || /insufficient_quota|insufficient credits|billing/.test(d)) throw new AIError('billing', `${p.name} says the account is out of credit. Top it up on their website.`);
  if (s === 403) throw new AIError('permission', `${p.name} didn't allow that${detail ? `: ${detail}` : '.'}`);
  if (s === 404) throw new AIError('not-found', `${p.name} couldn't find that model. Pick another one in Settings.`);
  if (s === 429) throw new AIError('rate', `${p.name} says too many requests, or this model's free limit is used up for now. Try again later, or pick another model in Settings.`);
  if (s >= 400 && s < 500) throw new AIError('bad-request', `${p.name} couldn't take that request${detail ? `: ${detail}` : '.'}`);
  throw new AIError('server', `${p.name} is busy or having trouble right now (${s}${detail ? `: ${detail}` : ''}). Try again in a minute, or pick another model in Settings.`);
}

// Services differ in what they accept, so try the richest request first and fall back to simpler ones
// when the service says the request itself was wrong. What worked is remembered until the app reloads.
const accepted = new Map();

async function post(p, url, headers, bodies, signal, kind) {
  const memo = `${url}|${kind}`;
  for (let i = accepted.get(memo) || 0; i < bodies.length; i++) {
    try {
      const res = await request(p, url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(bodies[i]), signal });
      accepted.set(memo, i);
      return res;
    } catch (err) {
      if (err.code !== 'bad-request' || i === bodies.length - 1) throw err;
    }
  }
}

// Server-sent events: calls onEvent with each JSON payload.
async function readEvents(res, onEvent) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let ev;
        try {
          ev = JSON.parse(data);
        } catch {
          continue;
        }
        onEvent(ev);
      }
    }
  } catch (err) {
    if (err?.name === 'AbortError') throw new AIError('aborted', 'Stopped.');
    throw err;
  }
}

async function askGemini(p, { context, messages, schema, onText, signal, bare }) {
  const model = await modelFor(p);
  const contents = messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  if (schema) contents[contents.length - 1].parts[0].text += schemaNote(schema);
  const base = { contents };
  if (!bare) base.systemInstruction = { parts: [{ text: SYSTEM }, ...(context ? [{ text: context }] : [])] };
  const bodies = schema
    ? [
        { ...base, generationConfig: { responseMimeType: 'application/json', responseJsonSchema: schema } },
        { ...base, generationConfig: { responseMimeType: 'application/json' } },
      ]
    : [base];
  const url = `${GEMINI}/models/${encodeURIComponent(model)}:${onText ? 'streamGenerateContent?alt=sse' : 'generateContent'}`;
  const res = await post(p, url, { 'x-goog-api-key': getKey() }, bodies, signal, schema ? 'json' : 'text');
  let text = '';
  let finish = null;
  let blocked = false;
  let usage = null;
  const take = (ev) => {
    if (ev.error) throw new AIError('server', `${p.name}: ${ev.error.message || 'something went wrong'}`);
    if (ev.promptFeedback?.blockReason) blocked = true;
    const cand = ev.candidates?.[0];
    for (const part of cand?.content?.parts || []) if (part.text && !part.thought) text += part.text;
    if (cand?.finishReason) finish = cand.finishReason;
    if (ev.usageMetadata) usage = ev.usageMetadata;
  };
  if (onText) {
    await readEvents(res, (ev) => {
      take(ev);
      if (text) onText(plain(text));
    });
  } else {
    take(await res.json());
  }
  if (usage) track({ input: usage.promptTokenCount || 0, output: (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0) });
  if (blocked || /SAFETY|PROHIBITED|BLOCKLIST|SPII/.test(finish || '')) throw refused(p);
  if (schema && finish === 'MAX_TOKENS') throw cutOff();
  return { text: plain(text).trim(), json: schema ? parseJSON(text, p) : undefined };
}

async function askOpenAI(p, { context, messages, schema, onText, signal, bare }) {
  const model = await modelFor(p);
  const msgs = messages.map((m) => ({ role: m.role, content: m.content }));
  if (schema) msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], content: msgs[msgs.length - 1].content + schemaNote(schema) };
  if (!bare) msgs.unshift({ role: 'system', content: context ? `${SYSTEM}\n\n${context}` : SYSTEM });
  const body = { model, messages: msgs };
  const bodies = onText
    ? [{ ...body, stream: true, stream_options: { include_usage: true } }, { ...body, stream: true }]
    : schema
      ? [{ ...body, response_format: { type: 'json_schema', json_schema: { name: 'answer', strict: true, schema } } }, { ...body, response_format: { type: 'json_object' } }, body]
      : [body];
  const res = await post(p, `${baseUrl(p)}/chat/completions`, { Authorization: `Bearer ${getKey()}` }, bodies, signal, onText ? 'stream' : schema ? 'json' : 'text');
  let text = '';
  let finish = null;
  let usage = null;
  let refusal = false;
  if (onText) {
    await readEvents(res, (ev) => {
      if (ev.error) throw new AIError('server', `${p.name}: ${ev.error.message || 'something went wrong'}`);
      const ch = ev.choices?.[0];
      if (ch?.delta?.content) {
        text += ch.delta.content;
        onText(plain(text));
      }
      if (ch?.delta?.refusal) refusal = true;
      if (ch?.finish_reason) finish = ch.finish_reason;
      if (ev.usage) usage = ev.usage;
    });
  } else {
    const data = await res.json();
    const ch = data.choices?.[0];
    text = typeof ch?.message?.content === 'string' ? ch.message.content : '';
    refusal = !!ch?.message?.refusal;
    finish = ch?.finish_reason || null;
    usage = data.usage;
  }
  if (usage) track({ input: usage.prompt_tokens || 0, output: usage.completion_tokens || 0 });
  if (refusal || finish === 'content_filter') throw refused(p);
  if (schema && finish === 'length') throw cutOff();
  return { text: plain(text).trim(), json: schema ? parseJSON(text, p) : undefined };
}

// ---------- prompts

const LIBRARY = Object.entries(EXERCISES)
  .map(([id, ex]) => `- ${id}: ${ex.name} (${ex.kind === 'big' ? 'big exercise' : 'band/core'}${ex.timed ? ', timed hold in seconds' : ''}). Harder: ${ex.harder}`)
  .join('\n');

// Kept byte-for-byte stable so it can be cached between requests.
const SYSTEM = `You are "the System", the AI coach inside Arise, a daily physical-improvement app styled after the System in Solo Leveling. The person using it is the Player. Your job is to help them lock in every single day, reach their long-term goal, and stay consistent wherever they are: at home, travelling, or in a chaotic week.

Action over talk
- This app exists to make the Player do the work, every day, for years. Talking is never the goal. If today's quest is not done and it is not a rest day, steer them to start it (or the smallest version of it) before anything else.
- Keep replies short: about 120 words at most, unless they ask for a review or a plan. No long essays, no repeating what they said.
- End every reply with one line that starts with "**Next action:**", naming one concrete thing they can do today, ideally within the next hour.
- If they are clearly procrastinating by chatting, say so kindly and send them to the quest.

How you talk
- Calm, direct and motivating, with a light touch of the System's voice ("[Quest]", "Level up", "Player") but always human underneath. Follow the tone the Player chose in their profile.
- Many ambitious people using this app have ADHD or get distracted easily. Keep answers concrete and lead with the single next action. Use short paragraphs, and bullets only when they help.
- Be honest. Don't flatter. Point out the patterns you see in their data, including uncomfortable ones, then give a clear way forward.
- Use only facts from the context below. If something isn't in the data, say you don't know. Quote real numbers (reps, dates, streaks) when they help.
- If the Player mentions faith (for example Islam), respect it; use it for encouragement only if their chosen tone includes it, and never preach.
- Write like a real coach texting the Player: plain everyday words, short sentences, contractions are fine. Never use em dashes or en dashes; use a comma, a full stop or the word "to" instead. No filler like "Great question", "Let's dive in", "Here's the thing" or "I hope this helps", and don't open with praise.
- Format with simple Markdown only: **bold**, short bullet or numbered lists. No tables, no headings, no links.

Safety
- You are not a doctor. For pain, injury, dizziness, or eating or sleep problems that sound serious, tell them to stop that exercise and see a professional. Never tell them to push through sharp pain.
- Progress gradually: add reps first, then load (backpack weight, thicker band), then the next variation, exactly as the rules say.
- If they mention self-harm or not wanting to live, respond with care and urge them to contact someone they trust, local emergency services or a crisis line right away.

The app
- Home workouts that need only resistance bands with a door anchor, a backpack with weight in it, a bed, a chair, a step and ideally a pull-up bar (at home, or one nearby such as in a park). Without a bar, the app swaps pull-ups, chin-ups and hanging leg raises for band lat pulldowns, band underhand pulldowns and reverse crunches, same sets. The context says where the Player's bar is.
- Two kinds of plan: a rotation (the default is A/B/C: sessions done in order, A, B, C, A, B, C…, on any day, with a weekly target of 4-6 sessions and the rest as rest days the Player logs) or a weekly split with fixed weekdays. The current plan, its rules and the weekly target are in the context.
- On a football day, if the next session is a legs session, the Player does the next upper-body session instead and the legs session stays next. The default C session is built for football performance and leg muscle: acceleration sprints first (first-step speed over 0-10 m is the usual weak spot; hills or a partner holding a band make the first steps harder), broad jumps, a short top-speed top-up, then Bulgarian split squats, single-leg RDLs, single-leg hip thrusts and calf raises. The Player wants muscle and performance, not injury-prevention work, so don't push prehab drills on them.
- The Player may be in a bulk, a cut or maintenance, and logs weigh-ins (weight, waist, shoulders). Effort stays the same across phases and food decides the direction; on a cut the default plan drops some sets (see below). Targets: bulk +0.25-0.5% of bodyweight a week, cut -0.4-0.75% a week (slower keeps more muscle and speed), protein about 1.6-2.2 g per kg a day and near the top of that on a cut. Shoulders divided by waist is their V-taper number.
- The default A/B/C plan has a cut version: while the phase is Cut, some slots drop a set (shown as "N sets on a cut" in the plan). Bulk and maintain use the full sets. Custom plans stay the same in every phase.
- Default body target unless their goal says otherwise: about 10-12% body fat all year (abs visible, speed kept), and a long-term fat-free mass index of about 21-22 (fat-free kg divided by height in metres squared). At 178 cm that's roughly 74-78 kg at 10-12%. Heavier than that tends to cost a winger acceleration. Above about 13%, cut first; at 10-12%, bulk slowly and cut back when they pass 13%.
- Players earn XP for sets, workouts, football, weigh-ins and daily log entries. Levels rise with XP; ranks go E, D, C, B, A, S.
- Exercise library (id: name):
${LIBRARY}`;

function systemBlocks(context) {
  return [
    { type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: context, cache_control: { type: 'ephemeral' } },
  ];
}

function slotText(sl) {
  let r = sl.amrap ? 'max reps' : sl.min === sl.max ? `${sl.min}` : `${sl.min}-${sl.max}`;
  if (sl.unit && sl.unit !== 'reps') r += ` ${sl.unit}`;
  if (sl.perLeg) r += ' per leg';
  return `${sl.sets}x${r}${sl.cut != null ? ` (${sl.cut} sets on a cut)` : ''}`;
}

const clip = (t, n) => (t.length > n ? `${t.slice(0, n)}…` : t);

// Everything the coach knows, as compact text. Recent weeks in detail; older history by month.
export function buildContext({ full = false } = {}) {
  const st = S.state;
  const k = S.todayKey();
  const out = [];
  const dateText = S.parseKey(k).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const planned = S.plannedFor(k);
  const sug = S.suggestedFor(k);
  const w = S.workouts();

  out.push('# Player data from the app (up to date)');
  out.push(`Today is ${dateText} (${k}), training week ${S.programWeek(k)}.`);
  out.push(
    `Today's quest: ${planned === 'rest' ? 'rest day' : w[planned].name}${sug !== planned ? ` (switched to ${w[sug].name} because they played football)` : ''}${S.planMode() === 'rotation' && planned !== 'rest' && S.isFootball(k) ? ' (leg exercises skipped because they played football)' : ''}. ` +
      `Done today: ${S.sessionsOn(k).map((s) => S.workoutName(s.workout, s)).join(', ') || 'nothing yet'}. ` +
      `Football today: ${S.isFootball(k) ? 'yes' : 'no'}. Easy week: ${S.isEasy(k) ? 'yes' : 'no'}.`,
  );

  const p = st.profile;
  out.push('', '## Profile');
  if (!p) out.push('The Player has not filled in their profile yet.');
  else {
    out.push(`Name: ${p.name || st.settings.name || 'not given'}`);
    out.push(`Long-term goal: ${p.goal || 'not given'}${p.deadline ? ` (by: ${p.deadline})` : ''}`);
    if (p.why) out.push(`Why it matters: ${p.why}`);
    const start = [p.pullups != null ? `${p.pullups} pull-ups` : '', p.pushups != null ? `${p.pushups} push-ups` : '', p.pistol ? `pistol squat: ${p.pistol}` : ''].filter(Boolean);
    if (start.length) out.push(`Starting point: ${start.join(', ')}`);
    if (p.equipment?.length) out.push(`Equipment: ${p.equipment.join(', ')}`);
    if (p.time) out.push(`Prefers training: ${p.time}`);
    if (p.travel) out.push(`Travels: ${p.travel}`);
    if (p.obstacles?.length || p.obstaclesNote) out.push(`What gets in the way: ${[...(p.obstacles || []), p.obstaclesNote].filter(Boolean).join('; ')}`);
    if (p.tone?.length) out.push(`Preferred tone: ${p.tone.join(', ')}`);
  }
  out.push(`Pull-up bar: ${{ home: 'at home', nearby: 'near home, so some sessions are at the bar and some at home with the band swaps', none: 'none, so the band and floor swaps are always used' }[st.settings.bar] || 'at home'}`);

  const L = S.levelInfo();
  const stt = S.stats();
  const cons = S.consistency();
  out.push('', '## Status');
  out.push(`Level ${L.level}, rank ${L.rank} (${L.title}), ${L.xp} XP. STR ${stt.str}, AGI ${stt.agi}, VIT ${stt.vit}.`);
  out.push(
    `Current streak ${S.currentStreak()} days (best ${S.bestStreak()}). ${cons == null ? 'No training yet.' : `Training days done in the last 4 weeks: ${cons}%.`} ` +
      `Total workouts: ${st.sessions.length}. Football days: ${st.football.length}.`,
  );

  const rot = S.planMode() === 'rotation';
  out.push('', `## Current plan (${S.isCustomPlan() ? 'personalised by the System' : rot ? 'A/B/C rotation template' : 'original weekly split'})`);
  if (rot) {
    out.push(`Type: rotation, done in this order on any day: ${S.workoutOrder().map((id) => `${w[id].name} [${id}]`).join(' → ')}, then repeat.`);
    out.push(`Weekly target: ${S.perWeek()} sessions and up to ${S.restAllowance()} rest days. This week so far: ${S.weekSummary(k).done} sessions, ${S.restsUsed(k)} rest days. Next session: ${w[S.nextWorkout()].name}.`);
  } else {
    out.push(`Type: weekly split. ${S.week().map((id, i) => `${DAYS[i]}: ${id === 'rest' || !w[id] ? 'rest' : `${w[id].name} [${id}]`}`).join(' | ')}`);
  }
  out.push(`Rules: ${S.planRules().map((r, i) => `(${i + 1}) ${r}`).join(' ')}`);
  for (const id of S.workoutOrder()) {
    out.push(`${w[id].name} [${id}]: ${w[id].slots.map((sl) => `${EXERCISES[sl.ex].name} ${slotText(sl)}${sl.note ? ` (${sl.note})` : ''}`).join('; ')}`);
  }

  // Recent 4 weeks in detail.
  const from = S.addDays(k, -27);
  const recent = st.sessions.filter((s) => s.date >= from).reverse();
  out.push('', '## Workouts in the last 4 weeks (newest first; numbers are reps or seconds per set)');
  if (!recent.length) out.push('None.');
  for (const s of recent) {
    const mins = Math.max(1, Math.round((s.finished - s.started) / 60000));
    const items = s.items
      .filter((it) => it.sets.length)
      .map((it) => `${EXERCISES[it.ex]?.name || it.ex} ${it.sets.map((x) => x.r).join('/')}${it.setup ? ` [${it.setup}]` : ''}`)
      .join('; ');
    out.push(`${s.date} ${S.workoutName(s.workout, s)} (${mins} min${s.easy ? ', easy week' : ''}): ${items}`);
  }
  const first = S.firstDay();
  const missed = [];
  for (let d = first && first > from ? first : from; first && d < k; d = S.addDays(d, 1)) {
    if (!S.covered(d)) missed.push(d);
  }
  out.push(`Missed days in the last 4 weeks (no workout, football or rest day logged): ${missed.length ? missed.join(', ') : 'none'}.`);
  const restRecent = st.rests.filter((d) => d >= from);
  if (rot && restRecent.length) out.push(`Rest days taken in the last 4 weeks: ${restRecent.join(', ')}.`);
  const fbRecent = st.football.filter((d) => d >= from);
  if (fbRecent.length) out.push(`Football in the last 4 weeks: ${fbRecent.join(', ')}.`);

  // Per-exercise trend, all time.
  const trends = S.exercisesWithData().map((id) => {
    const h = S.exerciseHistory(id);
    const firstE = h[0];
    const lastE = h[h.length - 1];
    const best = h.reduce((b, e) => Math.max(b, S.itemTotal(e.item)), 0);
    return `${EXERCISES[id].name}: ${h.length} times; first ${firstE.session.date} total ${S.itemTotal(firstE.item)}${firstE.item.setup ? ` [${firstE.item.setup}]` : ''}; latest ${lastE.session.date} total ${S.itemTotal(lastE.item)}${lastE.item.setup ? ` [${lastE.item.setup}]` : ''}; best total ${best}`;
  });
  if (trends.length) out.push('', '## Exercise trends (all time, totals per workout)', ...trends);

  // Older history, one line per month.
  const older = st.sessions.filter((s) => s.date < from);
  if (older.length || st.football.some((d) => d < from)) {
    out.push('', '## Older history by month');
    const months = new Map();
    const bump = (m, key) => {
      if (!months.has(m)) months.set(m, { workouts: 0, sets: 0, football: 0, energy: [] });
      months.get(m)[key]++;
    };
    for (const s of older) {
      bump(s.date.slice(0, 7), 'workouts');
      months.get(s.date.slice(0, 7)).sets += s.items.reduce((n, it) => n + it.sets.length, 0);
    }
    for (const d of st.football) if (d < from) bump(d.slice(0, 7), 'football');
    for (const [d, l] of Object.entries(st.logs)) {
      if (d < from && l.e) {
        if (!months.has(d.slice(0, 7))) months.set(d.slice(0, 7), { workouts: 0, sets: 0, football: 0, energy: [] });
        months.get(d.slice(0, 7)).energy.push(l.e);
      }
    }
    for (const [m, v] of [...months.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const avg = v.energy.length ? (v.energy.reduce((a, b) => a + b, 0) / v.energy.length).toFixed(1) : null;
      out.push(`${m}: ${v.workouts} workouts, ${v.sets} sets, ${v.football} football days${avg ? `, average energy ${avg}/5` : ''}`);
    }
  }

  // Body.
  const b = st.body;
  const bs = S.bodyStats(k);
  if (b.phase || b.entries.length) {
    out.push('', '## Body');
    out.push(`Phase: ${b.phase ? `${S.PHASES[b.phase].label} since ${b.phaseSince}` : 'not set'}.`);
    if (bs.last) {
      out.push(
        `Latest: weight ${bs.weight ?? '?'} kg, waist ${bs.waist ?? '?'} cm, shoulders ${bs.shoulders ?? '?'} cm, V-taper ratio ${bs.ratio ?? '?'}. ` +
          `Trend: ${bs.ratePerWeek != null ? `${bs.ratePerWeek} kg/week (${bs.ratePct}%/week)` : 'not enough weigh-ins yet'}${bs.verdict ? `, which is ${bs.verdict === 'ok' ? 'on target' : bs.verdict === 'fast' ? 'above the target range' : 'below the target range'}` : ''}.`,
      );
      out.push(`Weigh-ins (oldest first): ${b.entries.slice(-12).map((e) => `${e.date} ${[e.weight != null ? `${e.weight}kg` : '', e.waist != null ? `waist ${e.waist}` : '', e.shoulders != null ? `shoulders ${e.shoulders}` : ''].filter(Boolean).join(' ')}`).join('; ')}`);
    }
  }

  // Daily log.
  const logs = Object.entries(st.logs)
    .filter(([, l]) => l.e || (l.t && l.t.trim()))
    .sort(([a], [b]) => (a < b ? 1 : -1));
  const limit = full ? logs.length : 45;
  const perEntry = full ? 2000 : 700;
  out.push('', `## Daily log (${full ? 'every entry' : `latest ${Math.min(limit, logs.length)} of ${logs.length}`}, newest first)`);
  if (!logs.length) out.push('No entries yet.');
  let chars = 0;
  let shown = 0;
  for (const [d, l] of logs.slice(0, limit)) {
    const line = `${d}${l.e ? ` energy ${l.e}/5` : ''}: ${l.t && l.t.trim() ? clip(l.t.trim().replace(/\s+/g, ' '), perEntry) : '(no notes)'}`;
    if (chars + line.length > 400000) break; // keeps a years-long journal inside one request
    out.push(line);
    chars += line.length;
    shown++;
  }
  if (shown < logs.length) out.push(`(${logs.length - shown} older entries not included here; their energy is summarised by month above.)`);
  return out.join('\n');
}

// ---------- features

const BRIEFING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['message', 'focus'],
  properties: {
    message: { type: 'string', description: "2-3 short sentences in the System's voice, personal to the Player and grounded in their data." },
    focus: { type: 'string', description: 'One concrete action or cue for today, at most 15 words.' },
  },
};

// Today's personal System message. Cached per day.
export async function dailyBriefing({ force = false } = {}) {
  const k = S.todayKey();
  const cached = S.state.ai.daily[k];
  if (cached && !force) return cached;
  const { json: out } = await ask({
    context: buildContext(),
    effort: 'low',
    maxTokens: 4000,
    schema: BRIEFING_SCHEMA,
    messages: [
      {
        role: 'user',
        content:
          "Write today's System message for the top of the Today screen. Speak to me directly. Mention something real from my data (streak, a missed day, an exercise that is improving, my energy, my goal). If today is a rest day, make it about recovery. Make it different from a generic pep talk.",
      },
    ],
  });
  if (!out || typeof out.message !== 'string') throw new AIError('format', `${provider().name} sent an unexpected answer. Try again.`);
  const entry = { message: plain(out.message).trim(), focus: plain(out.focus || '').trim(), at: Date.now() };
  S.state.ai.daily[k] = entry;
  for (const d of Object.keys(S.state.ai.daily)) if (d < S.addDays(k, -30)) delete S.state.ai.daily[d];
  S.save();
  return entry;
}

// A short reflection on one day's log entry, saved with the entry.
export async function reflect(k, { onText, signal } = {}) {
  const log = S.state.logs[k] || {};
  const entry = `${log.e ? `Energy ${log.e}/5. ` : ''}${log.t && log.t.trim() ? log.t.trim() : '(no notes written)'}`;
  const { text } = await ask({
    context: buildContext(),
    effort: 'low',
    onText,
    signal,
    messages: [
      {
        role: 'user',
        content: `Here is my daily log for ${k}:\n"""\n${entry}\n"""\nReflect on it in 2-4 short sentences: one thing you notice (connect it to my recent data if you can), one concrete suggestion for tomorrow, and optionally one short question for me. Don't repeat my words back to me.`,
      },
    ],
  });
  S.setLog(k, { ai: text });
  return text;
}

const CHAT_KEEP = 30; // messages sent with each chat request

// Coach chat. The conversation lives in S.state.ai.chat.
export async function chat(userText, { full = false, onText, signal } = {}) {
  const log = S.state.ai.chat;
  log.push({ role: 'user', text: userText, at: Date.now() });
  S.save();
  // Failed replies stay on screen but are never sent back to the AI.
  let history = log
    .filter((m) => !m.error)
    .slice(-CHAT_KEEP)
    .map((m) => ({ role: m.role, content: m.text }));
  while (history.length && history[0].role !== 'user') history = history.slice(1);
  try {
    const { text } = await ask({ context: buildContext({ full }), effort: full ? 'high' : 'medium', messages: history, onText, signal, cacheLast: true });
    log.push({ role: 'assistant', text, at: Date.now() });
    if (log.length > 200) log.splice(0, log.length - 200);
    S.save();
    return text;
  } catch (err) {
    // Keep the question so it can be retried, but mark that no answer came back.
    log.push({ role: 'assistant', text: `⚠️ ${err.message}`, error: true, at: Date.now() });
    S.save();
    throw err;
  }
}

export function clearChat() {
  S.state.ai.chat = [];
  S.save();
}

// ---------- personalised plan

const EX_IDS = Object.keys(EXERCISES);

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'changes', 'mode', 'order', 'perWeek', 'week', 'workouts'],
  properties: {
    summary: { type: 'string', description: 'Two or three sentences explaining the plan and why it fits this Player.' },
    changes: { type: 'array', items: { type: 'string' }, description: 'Short bullet points: what changed compared to the current plan, and why. Empty if nothing changed.' },
    mode: { type: 'string', enum: ['rotation', 'week'], description: 'rotation = sessions done in order on any day; week = fixed weekdays.' },
    order: { type: 'array', items: { type: 'string' }, description: 'For a rotation: the workout ids in the order they are done, e.g. ["a","b"]. For a weekly split: all workout ids.' },
    perWeek: { type: 'integer', description: 'For a rotation: sessions per week, 3 to 6. For a weekly split: the number of training days.' },
    week: {
      type: 'array',
      items: { type: 'string' },
      description: 'For a weekly split: exactly 7 entries, Monday to Sunday, each a workout id or "rest". For a rotation: an empty array.',
    },
    workouts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'name', 'tag', 'legs', 'slots'],
        properties: {
          id: { type: 'string', description: 'Short lowercase id with letters, digits or underscores, e.g. a, b, travel, back, push.' },
          name: { type: 'string', description: 'Display name, e.g. "A · Pull & hinge" or "Back & width".' },
          tag: { type: 'string', description: 'A few words describing the session.' },
          legs: { type: 'boolean', description: 'True if this is a leg-focused session (skipped on football days).' },
          slots: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['ex', 'sets', 'min', 'max', 'amrap', 'perLeg', 'unit', 'note'],
              properties: {
                ex: { type: 'string', enum: EX_IDS },
                sets: { type: 'integer', description: 'Number of sets, 1 to 6.' },
                min: { type: 'integer', description: 'Bottom of the rep range (or seconds for timed holds). Use 0 when amrap is true.' },
                max: { type: 'integer', description: 'Top of the rep range (or seconds). Use 0 when amrap is true.' },
                amrap: { type: 'boolean', description: 'True for "as many reps as possible" sets.' },
                perLeg: { type: 'boolean' },
                unit: { type: 'string', enum: ['reps', 'sec', 'sprints'] },
                note: { type: 'string', description: 'Short setup cue, or an empty string.' },
              },
            },
          },
        },
      },
    },
  },
};

// Ask the AI for a personalised plan. Nothing changes until the Player applies it.
export async function proposePlan(request) {
  const { json } = await ask({
    context: buildContext(),
    effort: 'high',
    maxTokens: 16000,
    schema: PLAN_SCHEMA,
    messages: [
      {
        role: 'user',
        content: `Design my weekly training plan.\nWhat I want: ${request && request.trim() ? request.trim() : 'Personalise the plan to my goal, starting level, equipment and schedule.'}\n\nRules for the plan:\n- Use only exercises from the library (by id). Keep the plan doable at home with my equipment.\n- Keep what already works: change the current plan only where my goal, data or request gives a clear reason, and explain each change.\n- Keep the current plan type (rotation or weekly split) unless I asked to change it. A rotation needs 4 to 6 sessions a week; a weekly split needs at least 1 rest day.\n- Keep the existing workout ids for sessions that stay similar, so my history lines up.\n- Every session should train the lats and side delts (the V-taper) unless I asked otherwise.\n- Rep ranges should end each set with 1-2 reps left in the tank. Timed holds (unit "sec") only for timed exercises.`,
      },
    ],
  });
  return normalizePlan(json);
}

// ---------- personalised reminder texts

const NUDGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['messages'],
  properties: { messages: { type: 'array', items: { type: 'string' } } },
};

export async function writeReminders() {
  const { json } = await ask({
    context: buildContext(),
    effort: 'low',
    maxTokens: 8000,
    schema: NUDGE_SCHEMA,
    messages: [
      {
        role: 'user',
        content:
          'Write 40 different phone notification texts that remind me to do my daily quest. Each under 90 characters, in the System voice and my chosen tone, tied to my goal and what gets in my way. Vary them a lot: some short commands, some about my goal, some about streaks, some calm. Use {quest} where the name of that day\'s workout should go in about half of them.',
      },
    ],
  });
  const list = (Array.isArray(json?.messages) ? json.messages : []).map((m) => plain(m).replace(/\s+/g, ' ').trim()).filter((m) => m && m.length <= 140);
  if (list.length < 5) throw new AIError('format', `${provider().name} sent too few reminder texts. Try again.`);
  S.state.ai.nudges = { messages: list.slice(0, 60), at: Date.now() };
  S.save();
  return S.state.ai.nudges;
}

// Quick check that the key works, with the smallest possible request.
export async function testKey() {
  const { text } = await ask({ bare: true, effort: 'low', maxTokens: 1024, messages: [{ role: 'user', content: 'Reply with exactly: System online.' }] });
  return text;
}
