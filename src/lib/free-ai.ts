// The free AI chain: the Player links several AI keys (free ones like Gemini and Groq, or paid
// ones), and the coach tries them in their order. When a key hits its limit, it rests until that
// limit starts again and the next key answers instead.
//
// This file is the table of free AI services, the keys and rest times kept on this device, and
// the pure switching logic: reading a failed answer, working out how long a key rests, and which
// keys can answer now. src/ai.js does the calling.
//
// What's in the table was checked in October 2026 against each service's docs where they could
// be reached, and against recent write-ups where they couldn't. Free plans change often, so the
// switching never relies on the numbers here: it reads each failure, and only falls back to the
// documented reset time when the service doesn't say.

import { cleanAICools, cleanAIKeys, type AICool, type AIKey, type CoolWhy } from './validate';

export type { AICool, AIKey, CoolWhy };

// When a service's daily limit starts again: midnight in California (Google), midnight UTC, or a
// window that rolls (the service says how long in each answer).
export type Reset = 'pacific' | 'utc' | 'rolling' | 'month';
// Whether a web page may call the service: 'yes' (checked), 'try' (not confirmed: the app tries,
// and in the iPhone app it always works), 'no' (the service blocks web pages: iPhone app only).
export type Web = 'yes' | 'try' | 'no';

export interface Service {
  id: string;
  name: string;
  label: string;
  company: string;
  keyUrl: string;
  keyHint: string;
  base: string; // its OpenAI-format address; Gemini has its own format, so ''
  model: string; // the model to use when the Player picks none; '' = the best one on the key
  limits: string; // the free limits, in one plain line
  privacy: string; // what happens to what the coach sends, in one plain line
  signup: string;
  reset: Reset;
  web: Web;
}

// Free services, best first for someone with no money to spend. Key prefixes are in
// detectProvider (ai.js).
export const FREE: Service[] = [
  {
    id: 'google',
    name: 'Gemini',
    label: 'Gemini (Google)',
    company: 'Google',
    keyUrl: 'https://aistudio.google.com/apikey',
    keyHint: 'AIza…',
    base: '',
    model: 'gemini-flash-latest',
    limits: 'Free Flash models, each with its own daily limit and a few a minute. The daily limit starts again at midnight in California.',
    privacy: 'Google may use what you send to improve its products, and people may read it.',
    signup: 'A Google account. No card.',
    reset: 'pacific',
    web: 'yes',
  },
  {
    id: 'groq',
    name: 'Groq',
    label: 'Groq',
    company: 'Groq',
    keyUrl: 'https://console.groq.com/keys',
    keyHint: 'gsk_…',
    base: 'https://api.groq.com/openai/v1',
    model: '',
    limits: 'About 30 a minute and 1,000 a day on the big models, more on small ones. Long chats can be too big for it, so the app sends a shorter summary.',
    privacy: "Groq says it doesn't use what you send to train AI.",
    signup: 'An email. No card.',
    reset: 'utc',
    web: 'try',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    label: 'OpenRouter (one key, many models)',
    company: 'OpenRouter',
    keyUrl: 'https://openrouter.ai/keys',
    keyHint: 'sk-or-…',
    base: 'https://openrouter.ai/api/v1',
    model: '',
    limits: 'Models marked free: 20 a minute and 50 a day (1,000 a day once you have bought $10 of credit). Starts again at midnight UTC.',
    privacy: 'Free models run at other companies. Some keep what you send or use it to train AI.',
    signup: 'An email. No card.',
    reset: 'utc',
    web: 'yes',
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    label: 'Cerebras',
    company: 'Cerebras',
    keyUrl: 'https://cloud.cerebras.ai',
    keyHint: 'csk-…',
    base: 'https://api.cerebras.ai/v1',
    model: '',
    limits: 'A big daily allowance (about a million tokens, pieces of words) and a few requests a minute.',
    privacy: "Cerebras says it doesn't keep what you send.",
    signup: 'An email. It may ask for a card.',
    reset: 'utc',
    web: 'try',
  },
  {
    id: 'mistral',
    name: 'Mistral',
    label: 'Mistral',
    company: 'Mistral',
    keyUrl: 'https://console.mistral.ai/api-keys',
    keyHint: 'API key',
    base: 'https://api.mistral.ai/v1',
    model: 'mistral-medium-latest',
    limits: 'Free Experiment plan: about one request a second, with a large monthly allowance.',
    privacy: 'Mistral may use what you send on the free plan to train its AI.',
    signup: 'An email and a phone number. No card.',
    reset: 'month',
    web: 'try',
  },
  {
    id: 'github',
    name: 'GitHub Models',
    label: 'GitHub Models',
    company: 'GitHub',
    keyUrl: 'https://github.com/settings/personal-access-tokens/new',
    keyHint: 'github_pat_…',
    base: 'https://models.github.ai/inference',
    model: 'openai/gpt-4.1',
    limits: 'About 50 to 150 a day per model and 10 to 15 a minute. Short questions only, so the app sends a shorter summary.',
    privacy: "GitHub says what you send isn't used to train AI.",
    signup: 'A GitHub account. Make a token with the Models permission.',
    reset: 'utc',
    web: 'try',
  },
  {
    id: 'sambanova',
    name: 'SambaNova',
    label: 'SambaNova',
    company: 'SambaNova',
    keyUrl: 'https://cloud.sambanova.ai/apis',
    keyHint: 'API key',
    base: 'https://api.sambanova.ai/v1',
    model: '',
    limits: 'A small free daily allowance and a few requests a minute.',
    privacy: "SambaNova's own rules say what it keeps.",
    signup: 'An email. No card.',
    reset: 'utc',
    web: 'try',
  },
  {
    id: 'huggingface',
    name: 'Hugging Face',
    label: 'Hugging Face',
    company: 'Hugging Face',
    keyUrl: 'https://huggingface.co/settings/tokens',
    keyHint: 'hf_…',
    base: 'https://router.huggingface.co/v1',
    model: 'openai/gpt-oss-120b',
    limits: 'A small monthly credit, a few cents, for every model together. Starts again each month.',
    privacy: 'Hugging Face passes it to the company that runs the model. Their rules say what they keep.',
    signup: 'An email. No card. Make a token that can call Inference Providers.',
    reset: 'month',
    web: 'try',
  },
  {
    id: 'cohere',
    name: 'Cohere',
    label: 'Cohere (trial key)',
    company: 'Cohere',
    keyUrl: 'https://dashboard.cohere.com/api-keys',
    keyHint: 'API key',
    base: 'https://api.cohere.ai/compatibility/v1',
    model: 'command-a-03-2025',
    limits: 'Trial key: 1,000 requests a month and 20 a minute. Meant for trying out.',
    privacy: "Cohere's own rules say what it keeps from trial keys.",
    signup: 'An email. No card.',
    reset: 'month',
    web: 'try',
  },
  {
    id: 'nvidia',
    name: 'NVIDIA',
    label: 'NVIDIA (iPhone app only)',
    company: 'NVIDIA',
    keyUrl: 'https://build.nvidia.com/settings/api-keys',
    keyHint: 'nvapi-…',
    base: 'https://integrate.api.nvidia.com/v1',
    model: 'openai/gpt-oss-120b',
    limits: 'About 40 requests a minute while the free credits last. Only works in the iPhone app.',
    privacy: "Meant for trying out. NVIDIA's own rules say what it keeps.",
    signup: 'An NVIDIA account with a phone number.',
    reset: 'rolling',
    web: 'no',
  },
];

export const freeService = (id: string | undefined) => FREE.find((s) => s.id === id) || null;

// ---------- keys and rest times on this device

const KEYS = 'arise-ai-keys';
const COOLS = 'arise-ai-cool';
const LAST = 'arise-ai-last';
// The single key from before there could be many. Moved into the list the first time it's read.
export const LEGACY_KEY = 'arise-claude-key';

const read = (name: string): unknown => {
  try {
    const v = localStorage.getItem(name);
    return v == null ? null : JSON.parse(v);
  } catch {
    return null;
  }
};
const write = (name: string, v: unknown) => {
  try {
    localStorage.setItem(name, JSON.stringify(v));
  } catch {}
};

export const newKeyId = () => `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export function loadKeys(): AIKey[] {
  let raw: unknown = null;
  let legacy: string | null = null;
  try {
    raw = localStorage.getItem(KEYS);
    legacy = localStorage.getItem(LEGACY_KEY);
  } catch {
    return [];
  }
  if (raw == null) {
    // First start with many keys: the old key becomes the first one, following its old settings.
    const list = legacy && legacy.trim() ? cleanAIKeys([{ id: newKeyId(), key: legacy.trim() }]) : [];
    saveKeys(list);
    return list;
  }
  return cleanAIKeys(read(KEYS));
}

export function saveKeys(list: AIKey[]) {
  write(KEYS, cleanAIKeys(list));
  try {
    localStorage.removeItem(LEGACY_KEY); // the list is the only copy now
  } catch {}
}

// Rest times, without the ones that are over. Kept so they survive closing the app.
export function loadCools(now = Date.now()): Record<string, AICool> {
  const all = cleanAICools(read(COOLS));
  for (const [id, c] of Object.entries(all)) if (c.until && c.until <= now) delete all[id];
  return all;
}
export function setCool(id: string, c: AICool | null) {
  const all = loadCools();
  if (c) all[id] = c;
  else delete all[id];
  write(COOLS, all);
}
export const clearCools = () => write(COOLS, {});

// Which key answered last, for "Answered by Groq · llama-…".
export interface Last {
  keyId: string;
  provider: string;
  model: string;
  at: number;
}
export function loadLast(): Last | null {
  const v = read(LAST) as Partial<Last> | null;
  if (!v || typeof v !== 'object' || typeof v.keyId !== 'string' || typeof v.provider !== 'string' || typeof v.model !== 'string' || typeof v.at !== 'number') return null;
  return { keyId: v.keyId.slice(0, 40), provider: v.provider.slice(0, 20), model: v.model.slice(0, 120), at: v.at };
}
export const saveLast = (l: Last | null) => write(LAST, l);

// ---------- reading a failure

export type Period = 'minute' | 'day' | 'week' | 'month';
export type Failure =
  | { kind: 'limit'; period: Period; until: number } // a limit: try the next key, this one rests until `until`
  | { kind: 'key'; note?: string } // key rejected or not allowed: rests until the Player edits or tests it
  | { kind: 'credit' } // out of paid credit: the same
  | { kind: 'model'; until: number; note?: string } // that model isn't offered (or isn't free) on this key
  | { kind: 'busy'; until: number } // server trouble or no answer in time
  | { kind: 'too-big' } // more than this key takes at once: a shorter request may work
  | { kind: 'skip' }; // this key couldn't take the request: try the next, no rest

export interface Reply {
  service: string;
  status: number; // 0: no answer at all (couldn't connect, or no answer in time)
  body?: string;
  headers?: { get(name: string): string | null } | Record<string, string | undefined> | null;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function header(h: Reply['headers'], name: string): string | null {
  if (!h) return null;
  if (typeof (h as Headers).get === 'function') return (h as Headers).get(name);
  const rec = h as Record<string, string | undefined>;
  const k = Object.keys(rec).find((x) => x.toLowerCase() === name);
  return k ? (rec[k] ?? null) : null;
}

// "1m26.4s", "2m59.56s", "14h12m", "7.66s", "250ms" (Groq's and Google's style) to milliseconds.
export function parseDuration(s: unknown): number | null {
  const m = String(s ?? '')
    .trim()
    .match(/^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m(?!s))?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?$/);
  if (!m || !m.slice(1).some(Boolean)) return null;
  return Math.round((Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0)) * 1000 + Number(m[4] || 0));
}

// A reset time in any of the forms services use: epoch milliseconds or seconds, seconds from now,
// a duration, or a date.
export function resetValue(v: unknown, now: number): number | null {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (n > 1e12) return Math.round(n);
    if (n > 1e9) return Math.round(n * 1000);
    return now + Math.round(n * 1000);
  }
  const d = parseDuration(s);
  if (d != null) return now + d;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

// Midnight next comes round in a time zone, as an instant. DST-safe: US clocks change at 2 am,
// so midnight itself is never skipped or doubled.
function offset(tz: string, t: number): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(t));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - Math.floor(t / 1000) * 1000;
}
export const PACIFIC = 'America/Los_Angeles';
export function nextMidnight(tz: string, now: number): number {
  if (tz === 'UTC') {
    const d = new Date(now);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  }
  try {
    const off = offset(tz, now);
    const local = new Date(now + off);
    const target = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1);
    return target - offset(tz, target - off);
  } catch {
    return nextMidnight('UTC', now);
  }
}
export function nextMonth(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

// When a used-up limit starts again, from what the service documents.
export function resetAt(service: string, period: Period, now: number): number {
  if (period === 'minute') return now + MIN;
  if (period === 'week') return now + 7 * DAY;
  const reset = freeService(service)?.reset || 'utc';
  if (period === 'month') return nextMonth(now);
  if (reset === 'pacific') return nextMidnight(PACIFIC, now);
  if (reset === 'rolling') return now + DAY;
  return nextMidnight('UTC', now);
}

const MONTHLY = /per[ _-]?month|permonth|monthly|\/ ?month|bymonth|this month/;
const WEEKLY = /per[ _-]?week|perweek|weekly|byweek/;
// ("today" isn't a sign: Groq's per-minute message ends "Upgrade to Dev Tier today".)
const DAILY = /per[ _-]?day|perday|daily|\brpd\b|\btpd\b|byday|86400|per 24 ?h|requests?-day|tokens?-day/;
const SHORT = /per[ _-]?(minute|second|hour)|perminute|persecond|\brpm\b|\btpm\b|\brps\b|byminute|per-min|60s\b/;
const TOO_BIG = /too large|too long|context length|context window|maximum context|max(imum)? size|tokens_limit_reached|reduce the length|too many tokens|prompt is too long/;

function json(body: string | undefined): Record<string, unknown> | null {
  try {
    const j = JSON.parse(body || '');
    return j && typeof j === 'object' ? j : null;
  } catch {
    return null;
  }
}

// How long the service said to wait, if it did.
function hint(r: Reply, j: Record<string, unknown> | null, text: string, now: number): number | null {
  const after = header(r.headers, 'retry-after');
  if (after) {
    const n = Number(after);
    if (Number.isFinite(n)) return now + Math.max(0, n) * 1000;
    const t = Date.parse(after);
    if (!Number.isNaN(t)) return t;
  }
  const err = (j?.error && typeof j.error === 'object' ? j.error : {}) as Record<string, unknown>;
  // Google: a RetryInfo detail with retryDelay "27s".
  for (const d of Array.isArray(err.details) ? err.details : []) {
    const delay = (d as Record<string, unknown>)?.retryDelay;
    if (typeof delay === 'string') {
      const ms = parseDuration(delay);
      if (ms != null) return now + ms;
    }
  }
  // OpenRouter: the limit's own headers, inside the error.
  const meta = (err.metadata && typeof err.metadata === 'object' ? err.metadata : {}) as Record<string, unknown>;
  const inner = meta.headers && typeof meta.headers === 'object' ? (meta.headers as Record<string, string>) : null;
  const fromMeta = resetValue(header(inner, 'x-ratelimit-reset'), now);
  if (fromMeta) return fromMeta;
  // Words: "Please try again in 1m26.4s" (Groq), "Please wait 23677 seconds" (GitHub).
  const again = text.match(/(?:try again|retry) in ([\d.hms]+)/);
  if (again) {
    const ms = parseDuration(again[1].replace(/\.$/, ''));
    if (ms != null) return now + ms;
  }
  const wait = text.match(/(?:wait|retry after|try again after) (\d+(?:\.\d+)?) ?(?:s\b|sec|seconds)/);
  if (wait) return now + Number(wait[1]) * 1000;
  // Headers: Cerebras (seconds to the daily reset), Groq (time to the daily request reset), others.
  for (const name of ['x-ratelimit-reset-requests-day', 'x-ratelimit-reset-tokens-day', 'x-ratelimit-reset-requests', 'x-ratelimit-reset']) {
    const t = resetValue(header(r.headers, name), now);
    if (t) return t;
  }
  return null;
}

function limitPeriod(r: Reply, j: Record<string, unknown> | null, text: string): Period | null {
  // Google names the quota that ran out: "GenerateRequestsPerDayPerProjectPerModel-FreeTier".
  const err = (j?.error && typeof j.error === 'object' ? j.error : {}) as Record<string, unknown>;
  const ids: string[] = [];
  for (const d of Array.isArray(err.details) ? err.details : []) {
    for (const v of Array.isArray((d as Record<string, unknown>)?.violations) ? ((d as Record<string, unknown>).violations as Record<string, unknown>[]) : []) {
      ids.push(`${v?.quotaId || ''} ${v?.quotaMetric || ''}`.toLowerCase());
    }
  }
  const quota = ids.join(' ');
  // GitHub names it in a header: "UserByModelByDay".
  const type = (header(r.headers, 'x-ratelimit-type') || '').toLowerCase();
  for (const s of [quota, type, text]) {
    if (!s) continue;
    if (MONTHLY.test(s)) return 'month';
    if (WEEKLY.test(s)) return 'week';
    if (DAILY.test(s)) return 'day';
    if (SHORT.test(s)) return 'minute';
  }
  return null;
}

// What a failed answer means for this key. Null: nothing another key would fix (like a refusal).
export function classify(r: Reply, now: number): Failure | null {
  const s = r.status;
  if (s === 0) return { kind: 'busy', until: now + MIN };
  const j = json(r.body);
  const err = (j?.error && typeof j.error === 'object' ? j.error : j || {}) as Record<string, unknown>;
  const code = `${err.code ?? ''} ${err.type ?? ''} ${err.status ?? ''}`.toLowerCase();
  const text = `${typeof err.message === 'string' ? err.message : typeof j?.error === 'string' ? j.error : r.body || ''} ${code}`.toLowerCase();
  const service = freeService(r.service);
  if (s === 401) return { kind: 'key' };
  if (s === 403) return /flagged|moderation|safety/.test(text) ? null : { kind: 'key' };
  if (s === 402) {
    // Monthly free credit (Hugging Face) starts again next month; paid credit needs topping up.
    return service?.reset === 'month' || MONTHLY.test(text) ? { kind: 'limit', period: 'month', until: nextMonth(now) } : { kind: 'credit' };
  }
  if (s === 404) {
    // OpenRouter, when its privacy settings don't allow any free model.
    if (/data policy|privacy/.test(text)) return { kind: 'key', note: 'policy' };
    return { kind: 'model', until: now + HOUR };
  }
  if (s === 413 || (s === 400 && TOO_BIG.test(text))) return { kind: 'too-big' };
  if (s === 400 && /credit balance|insufficient[_ ](quota|credit|balance)|billing/.test(text)) return { kind: 'credit' };
  if (s === 429) {
    // Google's "limit: 0": this model has no free use on this key (Pro models, for example).
    if (/limit: 0\b|"quotavalue":\s*"0"/.test(`${text} ${(r.body || '').toLowerCase()}`)) return { kind: 'model', until: now + 6 * HOUR, note: 'not-free' };
    // OpenAI's "insufficient_quota" is paid credit that ran out, whatever the words say.
    if (/insufficient_quota/.test(code)) return { kind: 'credit' };
    if (TOO_BIG.test(text) && /request too large|reduce/.test(text)) return { kind: 'too-big' };
    let period = limitPeriod(r, j, text);
    let until = hint(r, j, text, now);
    // A service that says nothing but asks for a wait of hours means its daily limit.
    if (!period) period = until && until - now > HOUR ? 'day' : 'minute';
    if (period === 'minute') {
      if (until && until - now > HOUR) period = 'day';
      else return { kind: 'limit', period, until: Math.max(until || now + MIN, now + 5000) };
    }
    // Google's retryDelay on a daily limit is a few seconds, which isn't when it starts again.
    if (!until || until - now > 40 * DAY || (service?.reset === 'pacific' && until - now < 5 * MIN)) until = resetAt(r.service, period, now);
    return { kind: 'limit', period, until: Math.max(until, now + MIN) };
  }
  if (s === 400 || s === 422) return { kind: 'skip' };
  if (s === 408 || s >= 500) return { kind: 'busy', until: now + MIN };
  return null;
}

// How long a key rests after a failure. Null: it doesn't rest (the next request may well work).
export function coolFor(f: Failure, now: number): AICool | null {
  switch (f.kind) {
    case 'limit':
      return { why: f.period, until: f.until, at: now };
    case 'busy':
      return { why: 'busy', until: f.until, at: now };
    case 'model':
      return { why: 'model', until: f.until, at: now, ...(f.note ? { note: f.note } : {}) };
    case 'key':
      return { why: 'key', until: 0, at: now, ...(f.note ? { note: f.note } : {}) };
    case 'credit':
      return { why: 'credit', until: 0, at: now };
    default:
      return null;
  }
}

// ---------- which keys can answer now

export const waitsForPlayer = (c: AICool | undefined) => !!c && (c.why === 'key' || c.why === 'credit');

// The keys in the Player's order: those that can answer now, those resting (soonest free first),
// and those that can't be used at all (`problem` says why, or the key waits for the Player).
export function plan<K extends { id: string }>(keys: K[], cools: Record<string, AICool>, now: number, problem: (k: K) => string | null = () => null) {
  const ready: K[] = [];
  const waiting: { key: K; cool: AICool }[] = [];
  const off: { key: K; why: string }[] = [];
  for (const k of keys) {
    const why = problem(k);
    const c = cools[k.id];
    if (why) off.push({ key: k, why });
    else if (waitsForPlayer(c)) off.push({ key: k, why: c.why });
    else if (c && c.until > now) waiting.push({ key: k, cool: c });
    else ready.push(k);
  }
  waiting.sort((a, b) => a.cool.until - b.cool.until);
  return { ready, waiting, off };
}

// ---------- words for the screen

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');

// A time on this device's clock: "21:00" today, "Sat 09:00" this week, "1 Nov" after that.
export function when(t: number, now: number): string {
  const a = new Date(t);
  const hm = `${pad(a.getHours())}:${pad(a.getMinutes())}`;
  if (a.toDateString() === new Date(now).toDateString()) return hm;
  if (t - now < 6 * DAY) return `${WEEKDAYS[a.getDay()]} ${hm}`;
  return `${a.getDate()} ${MONTHS[a.getMonth()]}`;
}

export type KeyState = 'ready' | 'resting' | 'off';

// A key's line in Settings: Ready, Limit reached until 21:00, Key not working…
export function statusOf(c: AICool | undefined, now: number): { state: KeyState; text: string } {
  if (!c || (c.until && c.until <= now && !waitsForPlayer(c))) return { state: 'ready', text: 'Ready' };
  const at = when(c.until, now);
  switch (c.why) {
    case 'key':
      return { state: 'off', text: c.note === 'policy' ? "Turn on free models in OpenRouter's privacy settings, then test it again." : 'Key not working. Check it, then test it again.' };
    case 'credit':
      return { state: 'off', text: 'Out of credit. Top it up, then test it again.' };
    case 'busy':
      return { state: 'resting', text: `Not answering. Trying again after ${at}` };
    case 'model':
      return { state: 'resting', text: c.note === 'not-free' ? "This model isn't free on this key. Pick another one." : `Model not found. Trying again after ${at}` };
    default:
      return { state: 'resting', text: `Limit reached until ${at}` };
  }
}

// ---------- models

// A good free model on OpenRouter: free ones end in ":free" and come and go, so pick from the list.
const FREE_PREFER = [/gpt-oss-120b/, /deepseek-(chat|v3)/, /llama-3\.3-70b/, /qwen3?-?235b|qwen3-next/, /kimi|glm-4/, /gemma-3-27b/, /mistral-small/, /llama/];
export function pickFree(list: string[], not: string[] = []): string {
  const free = list.filter((m) => m.endsWith(':free') && !not.includes(m));
  for (const re of FREE_PREFER) {
    const m = free.find((x) => re.test(x));
    if (m) return m;
  }
  return free[0] || '';
}
