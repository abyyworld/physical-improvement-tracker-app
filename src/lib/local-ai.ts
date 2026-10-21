// "Your computer's AI": an open AI model the Player runs on their own computer, in Ollama or LM
// Studio (free apps). Arise talks to it at http://localhost while Arise is open on that computer,
// so nothing the coach sends leaves it: no account, no keys, no limits, and it works offline.
//
// It's off until the Player picks it in Settings, AI coach. Only then does the page reach for
// localhost (a browser may ask about that once). From then on Arise looks for it by itself when it
// opens and every little while, and the automatic order picks it first while it answers (ai.js).
//
// What a browser needs, and what Settings says in plain words:
// - The app has to let Arise's website in (CORS). Ollama: OLLAMA_ORIGINS with Arise's address
//   (scripts/local-ai-mac.sh sets it on a Mac). LM Studio: Enable CORS in its server settings.
// - Chrome and Edge (142 or later) ask once to let a website reach apps on this device.
// - Safari treats http://localhost as insecure content and blocks it (WebKit bug 171934).
// A page can't tell "nothing there" from "there, but not letting this site in", except with a
// request that doesn't need the app's OK (mode: 'no-cors'): it gets through only if something answers.
//
// Ollama is asked in its own format (/api/chat), which takes the context size with each request,
// so a long request isn't cut short; LM Studio in the OpenAI format (/v1/chat/completions). Both
// stream. Ollama's cloud models answer from ollama.com, not from this computer, so they're never used.
//
// Like every AI, only a strong model writes the memory (life/strength.ts): 70B parameters or more
// (the size the app reports, or the one in the name), or a model Arise doesn't know, or doesn't
// know the size of, that the Player trusts (on this device).

import { plain } from './clean';
import { SITE_URL } from './pages';
import { cleanLocalAI, type LocalAIPrefs, type LocalServer } from './validate';
import { classify, makeBy, modelName, sizeOf, WAITS, type Verdict } from '../life/strength';

export type { LocalAIPrefs, LocalServer };

export const NAME = "Your computer's AI";

interface Server {
  id: LocalServer;
  name: string;
  base: string;
  list: string; // where it lists its models
  chat: string;
}
export const SERVERS: Record<LocalServer, Server> = {
  ollama: { id: 'ollama', name: 'Ollama', base: 'http://localhost:11434', list: '/api/tags', chat: '/api/chat' },
  lmstudio: { id: 'lmstudio', name: 'LM Studio', base: 'http://localhost:1234', list: '/v1/models', chat: '/v1/chat/completions' },
};
const ORDER: LocalServer[] = ['ollama', 'lmstudio'];

// Tokens one request may hold (Ollama's num_ctx): the same each time, since a new size makes
// Ollama load the model again. Part of it is kept for the answer: REPLY, or what the request asks
// for, up to LONGEST (a whole plan as JSON).
export const CONTEXT = 16384;
const REPLY = 4096;
const LONGEST = 6144;
// Waiting for the first words (loading the model and reading a long request take a while on a
// laptop), then between words. Looking for the apps: quick in the background, longer after a tap,
// when the browser may be asking the Player first.
const FIRST = 180_000;
const BETWEEN = 60_000;
const QUIET = 4_000;
const ASKED = 60_000;
// How often to look again while it isn't answering, and while it is (it may have been closed).
const AGAIN = 30_000;
const FRESH = 5 * 60_000;
// Roughly: a token is 3 to 4 characters of English. The lower guess, so a request fits.
const tokens = (s: string) => Math.ceil(s.length / 3);

// ---------- the Player's choices (on this device only: lib/validate.ts)

const KEY = 'arise-local-ai';

export function prefs(): LocalAIPrefs {
  try {
    return cleanLocalAI(JSON.parse(localStorage.getItem(KEY) || '{}'));
  } catch {
    return cleanLocalAI({});
  }
}

export function setPrefs(changes: Partial<LocalAIPrefs>): LocalAIPrefs {
  const next = cleanLocalAI({ ...prefs(), ...changes });
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {}
  if (!next.on) stopLooking();
  emit();
  return next;
}

// "Erase all data": its choices go, and it's off again.
export function forget() {
  try {
    localStorage.removeItem(KEY);
  } catch {}
  stopLooking();
  emit();
}

// ---------- what was found

export interface LocalModel {
  id: string;
  server: LocalServer;
  params: number; // billions of parameters, 0 when not known
}
type Seen = { state: 'ready' | 'no-model' | 'blocked' | 'missing'; models: LocalModel[] };

// off: not picked. checking: looking. ready: a model answers. no-model: an app is there, with no
// model. blocked: an app is there, but doesn't let Arise in (CORS). missing: nothing found. ask:
// the browser has to ask the Player first (only after a tap). denied: the browser says no.
// safari: Safari never allows it.
export type Status = 'off' | 'checking' | 'ready' | 'no-model' | 'blocked' | 'missing' | 'ask' | 'denied' | 'safari';

let found: Partial<Record<LocalServer, Seen>> = {};
let state: Status = 'off';
let checkedAt = 0;
let checking: Promise<Status> | null = null;
let gen = 0; // a look that started before the Player turned it off doesn't count

function stopLooking() {
  gen++;
  found = {};
  state = 'off';
  checkedAt = 0;
  checking = null;
}

const listeners = new Set<() => void>();
export function onChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit() {
  for (const fn of listeners) {
    try {
      fn();
    } catch {}
  }
}

export const status = (): Status => (prefs().on ? state : 'off');
export const busy = () => !!checking;
// The app behind a 'no-model' or 'blocked', for the words on screen.
export const serverWith = (kind: Seen['state']): LocalServer | null => ORDER.find((id) => found[id]?.state === kind) || null;

// Every model found, the best first, for the picker.
export function models(): LocalModel[] {
  return ORDER.flatMap((id) => (found[id]?.state === 'ready' ? rankModels(found[id]!.models) : []));
}

// The best model found, whatever the Player picked.
export function best(): LocalModel | null {
  for (const id of ORDER) if (found[id]?.state === 'ready') return rankModels(found[id]!.models)[0] || null;
  return null;
}

// The app and model that answer now: the Player's pick if it's there, otherwise the best one
// (their app first). Their pick stays saved while it's gone.
export function current(): LocalModel | null {
  const p = prefs();
  if (!p.on) return null;
  const ids = p.server ? [p.server, ...ORDER.filter((x) => x !== p.server)] : ORDER;
  for (const id of ids) {
    const f = found[id];
    if (f?.state !== 'ready' || !f.models.length) continue;
    return (id === p.server && p.model && f.models.find((m) => m.id === p.model)) || rankModels(f.models)[0];
  }
  return null;
}

// Whether it can answer now (ai.js, engine()). It looks again every little while, in the
// background, without ever making the browser ask the Player.
export function ready(): boolean {
  if (!prefs().on) return false;
  const now = !!current();
  if (!checking && state !== 'ask' && Date.now() - checkedAt > (now ? FRESH : AGAIN)) void check();
  return now;
}

// "qwen2.5:14b in Ollama on this computer", for "Replies come from …".
export function label(): string {
  const at = current();
  return at ? `${at.id} in ${SERVERS[at.server].name} on this computer` : 'the AI on this computer';
}

// ---------- looking for Ollama and LM Studio

// The browser's permission to reach apps on this device (Chrome's Local Network Access):
// 'granted', 'prompt', 'denied', or '' when the browser doesn't have one.
async function permission(): Promise<string> {
  const p = globalThis.navigator?.permissions;
  if (!p?.query) return '';
  for (const name of ['loopback-network', 'local-network-access']) {
    try {
      return (await p.query({ name } as unknown as PermissionDescriptor)).state;
    } catch {}
  }
  return '';
}

export const isSafari = (ua = globalThis.navigator?.userAgent || '') => /safari/i.test(ua) && !/chrome|chromium|crios|fxios|edg|opr|android/i.test(ua);

// A laptop or desktop: not a phone or tablet (iPads say they're Macs, but have a touch screen).
export function onComputer(nav: { userAgent?: string; maxTouchPoints?: number } | undefined = globalThis.navigator): boolean {
  const ua = nav?.userAgent || '';
  if (!ua || /android|iphone|ipad|ipod|mobile/i.test(ua)) return false;
  return !(/macintosh/i.test(ua) && (nav?.maxTouchPoints || 0) > 1);
}

async function timed(url: string, init: RequestInit, ms: number, read?: (res: Response) => Promise<unknown>) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await globalThis.fetch(url, { ...init, signal: ctl.signal, cache: 'no-store', credentials: 'omit' });
    return { res, data: read ? await read(res) : undefined };
  } finally {
    clearTimeout(t);
  }
}

async function probe(id: LocalServer, ms: number): Promise<Seen> {
  const s = SERVERS[id];
  try {
    const { res, data } = await timed(`${s.base}${s.list}`, {}, ms, (r) => (r.ok ? r.json() : Promise.resolve(null)));
    if (!res.ok) return { state: 'missing', models: [] };
    const list = modelsFrom(id, data);
    return { state: list.length ? 'ready' : 'no-model', models: list };
  } catch {
    // Nothing there, or there but not letting this site in. This request needs no OK from the app,
    // so it only gets through when something answers.
    try {
      await timed(`${s.base}/`, { mode: 'no-cors' }, Math.min(ms, QUIET));
      return { state: 'blocked', models: [] };
    } catch {
      return { state: 'missing', models: [] };
    }
  }
}

function summary(perm: string): Status {
  const all = ORDER.map((id) => found[id]?.state);
  if (current()) return 'ready';
  if (all.includes('no-model')) return 'no-model';
  if (all.includes('blocked')) return 'blocked';
  if (perm === 'denied') return 'denied';
  return isSafari() ? 'safari' : 'missing';
}

// Looks for Ollama and LM Studio on this computer. `asked`: the Player tapped, so the browser may
// ask them, and it waits for their answer.
export function check({ asked = false } = {}): Promise<Status> {
  if (!prefs().on) {
    state = 'off';
    return Promise.resolve(state);
  }
  if (checking && !asked) return checking;
  const my = ++gen;
  if (!current()) state = 'checking';
  const run: Promise<Status> = (async () => {
    const perm = await permission();
    // In the background, never make the browser ask: that waits for a tap. What was found before
    // (when it was allowed) goes too, so nothing asks it meanwhile and the next AI answers.
    if (perm === 'prompt' && !asked) {
      if (my === gen) found = {};
      return 'ask';
    }
    if (perm === 'denied') {
      if (my === gen) found = {};
      return 'denied';
    }
    const seen = await Promise.all(ORDER.map(async (id) => [id, await probe(id, asked ? ASKED : QUIET)] as const));
    if (my === gen) found = Object.fromEntries(seen);
    return summary(perm);
  })()
    .catch(() => 'missing' as Status)
    .then((s) => {
      if (my === gen) {
        state = s;
        checkedAt = Date.now();
      }
      return status();
    })
    .finally(() => {
      if (checking === run) checking = null;
      emit();
    });
  // (Set before anyone hears of it: a screen drawn now asks ready(), which mustn't start another.)
  checking = run;
  emit();
  return run;
}

// At start (ai.js, initAI): looks, but waits a moment at most.
export async function start(wait = 2500): Promise<void> {
  if (!prefs().on) return;
  let t: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([check(), new Promise((r) => (t = setTimeout(r, wait)))]);
  clearTimeout(t);
}

// An app stopped answering: the next request goes to the next AI, and it's looked for again later.
function gone(id: LocalServer) {
  found = { ...found, [id]: { state: 'missing', models: [] } };
  state = summary('');
  checkedAt = Date.now();
  emit();
}

// ---------- models

// Not for chat: embeddings, speech, safety filters.
const NOT_CHAT = /embed|bge[-:]|minilm|nomic-bert|rerank|mxbai|e5-|whisper|tts|guard/i;

const paramsFrom = (v: unknown) => {
  const m = /^(\d+(?:\.\d+)?)\s*([BM])$/i.exec(String(v ?? '').trim());
  return m ? Number(m[1]) / (m[2].toUpperCase() === 'M' ? 1000 : 1) : 0;
};

// The chat models in Ollama's /api/tags or LM Studio's /v1/models.
export function modelsFrom(server: LocalServer, data: unknown): LocalModel[] {
  const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const list = server === 'ollama' ? d.models : d.data;
  const out: LocalModel[] = [];
  if (!Array.isArray(list)) return out;
  for (const x of list) {
    if (!x || typeof x !== 'object') continue;
    const o = x as Record<string, unknown>;
    const id = String((server === 'ollama' ? o.name || o.model : o.id) ?? '').trim();
    if (!/^[\w.:/@+-]{1,120}$/.test(id) || out.some((m) => m.id === id)) continue;
    // Ollama's cloud models run on ollama.com: what they're sent leaves the computer.
    if (o.remote_host || o.remote_model || /(^|[-:])cloud$/i.test(id)) continue;
    if (Array.isArray(o.capabilities) && !o.capabilities.includes('completion')) continue;
    if (NOT_CHAT.test(id) || o.type === 'embeddings') continue;
    const details = (o.details && typeof o.details === 'object' ? o.details : {}) as Record<string, unknown>;
    out.push({ id, server, params: paramsFrom(details.parameter_size) || sizeOf(modelName(id)) });
  }
  return out;
}

// Families that coach well, best first, and kinds that don't suit it (code, maths, pictures, base
// models, ones that think at length before every answer).
const FAMILY = [/qwen-?3/, /qwen-?2\.5/, /gemma-?[34]/, /llama-?3\.3/, /llama-?3/, /gemma/, /mistral|ministral|magistral/, /phi-?4/, /gpt-oss/];
const ODD = /code|math|\br1\b|qwq|reason|thinking|vision|-vl\b|vl:|llava|\bbase\b|:text\b|uncensored|abliterated/;

// The best first: a family that coaches well, then the biggest.
export function rankModels(list: readonly LocalModel[]): LocalModel[] {
  const fam = (m: LocalModel) => {
    const i = FAMILY.findIndex((r) => r.test(modelName(m.id)));
    return i < 0 ? FAMILY.length : i;
  };
  const odd = (m: LocalModel) => (ODD.test(modelName(m.id)) ? 1 : 0);
  const unknown = (m: LocalModel) => (fam(m) === FAMILY.length ? 1 : 0);
  return [...list].sort((a, b) => odd(a) - odd(b) || unknown(a) - unknown(b) || b.params - a.params || fam(a) - fam(b) || (a.id < b.id ? -1 : 1));
}

// ---------- which models may write the memory

const paramsOf = (model: string) =>
  ORDER.flatMap((id) => found[id]?.models || []).find((m) => m.id === model)?.params || 0;

// By its name, or by the size the app reports when the name doesn't say ('llama3.3:latest').
export function verdict(model: string, params = paramsOf(model)): Verdict {
  const v = classify('local', model);
  if (v.sure || !(params > 0)) return v;
  return { strength: params >= 70 ? 'strong' : 'weak', sure: true };
}

export const trusted = (model: string) => prefs().trust.includes(model);

export function trust(model: string, on: boolean) {
  const rest = prefs().trust.filter((m) => m !== model);
  setPrefs({ trust: on ? [...rest, model] : rest });
}

// For Settings: 'strong', 'weak' (known to be too small), 'unknown' (weak until trusted) or 'trusted'.
export function memoryOf(model: string, params = paramsOf(model)): 'strong' | 'weak' | 'unknown' | 'trusted' {
  const v = verdict(model, params);
  if (v.strength === 'strong') return 'strong';
  if (v.sure) return 'weak';
  return trusted(model) ? 'trusted' : 'unknown';
}

// For ai.js, memoryStrength().
export function memoryStrength(): 'strong' | 'weak' {
  const at = current();
  return at && ['strong', 'trusted'].includes(memoryOf(at.id, at.params)) ? 'strong' : 'weak';
}

// The name the memory records for who wrote something: with the size in it when the name alone
// doesn't say, so it reads the same later (life/strength.ts, strongBy).
export function memoryName(model: string, params = 0): string {
  if (classify('local', model).sure || !(params > 0)) return model;
  const base = model.replace(/:latest$/, '');
  return `${base}${base.includes(':') ? '-' : ':'}${Number(params.toFixed(1))}b`;
}

// ---------- asking it

type Role = 'system' | 'user' | 'assistant';
interface Msg {
  role: Role;
  content: string;
}
// The same request as everywhere in ai.js (see ask there).
export interface AskRequest {
  context?: string | ((compact: boolean, engine: string) => string);
  messages: Msg[] | ((engine: string) => Msg[]);
  schema?: object;
  maxTokens?: number;
  effort?: string;
  onText?: (text: string) => void;
  signal?: AbortSignal;
  bare?: boolean;
  strong?: boolean;
}
// From ai.js: the coach's instructions (the short version for a compact request), and its errors.
export interface AskDeps {
  system: (compact: boolean) => string;
  fail: (code: string, message: string) => Error;
}
export interface Answer {
  text: string;
  json?: unknown;
  by: string;
}

const size = (list: Msg[]) => list.reduce((n, m) => n + tokens(m.content) + 4, 0);

// The latest turns that fit, starting with the Player's.
function fit(list: Msg[], room: number): Msg[] {
  let out = list;
  while (out.length > 1 && size(out) > room) out = out.slice(1);
  while (out.length > 1 && out[0].role !== 'user') out = out.slice(1);
  return out;
}

// Thinking some models write before the answer, which isn't for the Player.
export const visible = (t: string) =>
  t
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/<think>[\s\S]*$/, '')
    .replace(/^\s+/, '');

const schemaNote = (schema: object) => `\n\nReply with only a JSON object, no code fences and no other text, that matches this JSON Schema:\n${JSON.stringify(schema)}`;

function parseJSON(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
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
  return undefined;
}

export async function ask(raw: AskRequest, deps: AskDeps): Promise<Answer> {
  const at = current();
  if (!at) throw deps.fail('no-ai', `${NAME} isn't answering right now. See Settings, AI coach.`);
  if (raw.strong && !['strong', 'trusted'].includes(memoryOf(at.id, at.params))) throw deps.fail('weak', WAITS);
  const reply = Math.max(256, Math.min(raw.maxTokens || REPLY, LONGEST));
  const room = CONTEXT - reply;
  const shorter = typeof raw.context === 'function';
  for (const compact of shorter ? [false, true] : [false]) {
    const ctx = typeof raw.context === 'function' ? raw.context(compact, 'local') : raw.context || '';
    const history = (typeof raw.messages === 'function' ? raw.messages('local') : raw.messages).map((m) => ({ role: m.role, content: String(m.content ?? '') }));
    const system = raw.bare ? '' : `${deps.system(compact)}${ctx ? `\n\n${ctx}` : ''}`;
    // The whole picture when it fits; otherwise the short version, like the AI on this device.
    if (!compact && shorter && tokens(system) + size(history) > room) continue;
    try {
      return await send(at, system, fit(history, room - tokens(system)), raw, reply, deps);
    } catch (err) {
      if ((err as { code?: string })?.code === 'too-big' && !compact && shorter) continue;
      throw err;
    }
  }
  throw deps.fail('too-big', `That was more than ${at.id} takes at once.`);
}

async function send(at: LocalModel, system: string, history: Msg[], raw: AskRequest, reply: number, deps: AskDeps): Promise<Answer> {
  const msgs: Msg[] = [...(system ? [{ role: 'system' as Role, content: system }] : []), ...history];
  const last = msgs.length - 1;
  if (raw.schema && last >= 0) msgs[last] = { ...msgs[last], content: msgs[last].content + schemaNote(raw.schema) };
  const plainBody =
    at.server === 'ollama'
      ? { model: at.id, messages: msgs, stream: true, options: { num_ctx: CONTEXT, num_predict: reply } }
      : { model: at.id, messages: msgs, stream: true, max_tokens: reply };
  // The answer kept to the JSON Schema, and (Ollama) no long thinking first: on a laptop that
  // can take minutes, and it counts against the answer's room. An older app that doesn't know
  // these gets the plain request.
  const rich =
    at.server === 'ollama'
      ? { ...plainBody, think: false, ...(raw.schema ? { format: raw.schema } : {}) }
      : { ...plainBody, ...(raw.schema ? { response_format: { type: 'json_schema', json_schema: { name: 'answer', strict: true, schema: raw.schema } } } : {}) };
  const bodies = JSON.stringify(rich) === JSON.stringify(plainBody) ? [plainBody] : [rich, plainBody];
  for (let i = 0; ; i++) {
    try {
      return await stream(at, bodies[i], raw, deps);
    } catch (err) {
      if ((err as { code?: string })?.code !== 'bad-request' || i >= bodies.length - 1) throw err;
    }
  }
}

async function stream(at: LocalModel, body: object, raw: AskRequest, deps: AskDeps): Promise<Answer> {
  const s = SERVERS[at.server];
  const ctl = new AbortController();
  let late = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wait = (ms: number) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      late = true;
      ctl.abort();
    }, ms);
  };
  const stop = () => ctl.abort();
  raw.signal?.addEventListener('abort', stop, { once: true });
  if (raw.signal?.aborted) stop();
  const lost = (before: boolean) => {
    if (raw.signal?.aborted) return deps.fail('aborted', 'Stopped.');
    if (late) return deps.fail('offline', `${s.name} took too long to answer. A smaller model answers faster (Settings, AI coach).`);
    if (!before) return deps.fail('offline', `${s.name} stopped in the middle of the answer. Try again.`);
    gone(at.server);
    return deps.fail('offline', `Couldn't reach ${s.name} on this computer. Is it still running?`);
  };
  let text = '';
  let finish = '';
  const take = (line: string) => {
    let j: Record<string, unknown> | null = null;
    const data = at.server === 'ollama' ? line.trim() : line.startsWith('data:') ? line.slice(5).trim() : '';
    if (!data || data === '[DONE]') return;
    try {
      j = JSON.parse(data);
    } catch {
      return;
    }
    if (!j || typeof j !== 'object') return;
    if (j.error) {
      const e = j.error as { message?: string } | string;
      throw deps.fail('server', `${s.name} couldn't answer: ${String(typeof e === 'string' ? e : e.message || 'something went wrong').slice(0, 200)}`);
    }
    if (at.server === 'ollama') {
      const m = j.message as { content?: unknown } | undefined;
      if (typeof m?.content === 'string') text += m.content;
      if (j.done) finish = String(j.done_reason || 'stop');
    } else {
      const ch = (j.choices as { delta?: { content?: unknown }; finish_reason?: unknown }[] | undefined)?.[0];
      if (typeof ch?.delta?.content === 'string') text += ch.delta.content;
      if (ch?.finish_reason) finish = String(ch.finish_reason);
    }
  };
  wait(FIRST);
  try {
    let res: Response;
    try {
      res = await globalThis.fetch(`${s.base}${s.chat}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctl.signal,
        cache: 'no-store',
        credentials: 'omit',
      });
    } catch {
      throw lost(true);
    }
    if (!res.ok) throw await refused(res, at, deps);
    if (!res.body) throw deps.fail('server', `${s.name} sent no answer. Try again.`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let shown = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        wait(BETWEEN);
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, '');
          buf = buf.slice(nl + 1);
          take(line);
        }
        const now = plain(visible(text));
        if (raw.onText && now && now !== shown) raw.onText((shown = now));
      }
      take(buf + dec.decode());
    } catch (err) {
      if ((err as { code?: string })?.code) throw err; // one of ours, from the answer itself
      throw lost(false);
    }
  } finally {
    clearTimeout(timer);
    raw.signal?.removeEventListener('abort', stop);
  }
  const out = plain(visible(text)).trim();
  if (raw.schema && finish === 'length') throw deps.fail('format', 'The answer was cut off. Try again.');
  if (!out) throw deps.fail('format', `${s.name} sent an empty answer. Try again.`);
  const json = raw.schema ? parseJSON(visible(text)) : undefined;
  if (raw.schema && json === undefined) throw deps.fail('format', `${s.name} sent an answer the app couldn't read. Try again, or pick a bigger model.`);
  return { text: out, json, by: makeBy('local', memoryName(at.id, at.params)) };
}

// A request the app turned down, in plain words.
async function refused(res: Response, at: LocalModel, deps: AskDeps): Promise<Error> {
  const s = SERVERS[at.server];
  let detail = '';
  try {
    const body = await res.text();
    try {
      const j = JSON.parse(body);
      detail = j?.error?.message || (typeof j?.error === 'string' ? j.error : '') || j?.message || body;
    } catch {
      detail = body;
    }
  } catch {}
  detail = String(detail).replace(/\s+/g, ' ').trim().slice(0, 200).replace(/[.\s]+$/, '');
  const d = detail.toLowerCase();
  if (res.status === 404 || /not found|does not exist|no such model|try pulling/.test(d)) {
    void check(); // its list changed
    return deps.fail('not-found', `${s.name} doesn't have ${at.id} any more. Pick another model in Settings, AI coach.`);
  }
  if (/context (length|window|size)|n_ctx|too long|too many tokens|exceeds/.test(d)) {
    return deps.fail('too-big', `That was more than ${at.id} takes at once.${at.server === 'lmstudio' ? ' In LM Studio, load it with a longer context length (16384 or more).' : ''}`);
  }
  if (res.status >= 400 && res.status < 500) return deps.fail('bad-request', `${s.name} couldn't take that request${detail ? `: ${detail}` : '.'}`);
  return deps.fail('server', `${s.name} couldn't answer${detail ? `: ${detail}` : ''}.${/memory|ram\b|vram|alloc/.test(d) ? ' A smaller model may fit (Settings, AI coach).' : ''}`);
}

// ---------- setting it up

// Arise's website. The Mac setup lets it in; a copy of Arise at another address is added to it.
export const SITE_ORIGIN = new URL(SITE_URL).origin;
// The one command for a Mac (Terminal). It's scripts/local-ai-mac.sh in this repo.
export const SETUP_SCRIPT = 'https://raw.githubusercontent.com/abyyworld/physical-improvement-tracker-app/main/scripts/local-ai-mac.sh';
const ownOrigin = (origin: string) => (/^https:\/\/[a-z0-9.-]{1,200}(:\d{1,5})?$/i.test(origin) && origin !== SITE_ORIGIN ? origin : '');

export function setupCommand(origin = ''): string {
  const own = ownOrigin(origin);
  return `curl -fsSL ${SETUP_SCRIPT} | bash${own ? ` -s -- ${own}` : ''}`;
}

// The addresses OLLAMA_ORIGINS needs on Windows and Linux (by hand).
export const origins = (origin = '') => [SITE_ORIGIN, ownOrigin(origin)].filter(Boolean).join(',');
