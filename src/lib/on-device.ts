// AI that runs on this device: Chrome's built-in model (the Prompt API, `LanguageModel`), on
// Windows, macOS, Linux and Chromebook Plus laptops with Chrome 148 or later. Nothing leaves the
// device, it works offline, and it costs nothing. Phones and other browsers don't have it yet.
// https://developer.chrome.com/docs/ai/prompt-api

export type Availability = 'available' | 'downloadable' | 'downloading' | 'unavailable';

interface Prompt {
  role: 'system' | 'user' | 'assistant';
  content: string;
}
interface Session {
  prompt(input: string, opts?: { signal?: AbortSignal; responseConstraint?: object }): Promise<string>;
  promptStreaming(input: string, opts?: { signal?: AbortSignal; responseConstraint?: object }): ReadableStream<string> & AsyncIterable<string>;
  destroy(): void;
  contextWindow?: number;
  inputQuota?: number;
}
interface Monitor {
  addEventListener(type: 'downloadprogress', fn: (e: { loaded: number }) => void): void;
}
interface LanguageModelAPI {
  availability(opts?: object): Promise<Availability>;
  create(opts?: { initialPrompts?: Prompt[]; signal?: AbortSignal; monitor?: (m: Monitor) => void; expectedInputs?: object[]; expectedOutputs?: object[] }): Promise<Session>;
}

const api = (): LanguageModelAPI | null => (globalThis as { LanguageModel?: LanguageModelAPI }).LanguageModel ?? null;
const LANGS = { expectedInputs: [{ type: 'text', languages: ['en'] }], expectedOutputs: [{ type: 'text', languages: ['en'] }] };

let known: Availability | null = null;

export async function availability(): Promise<Availability> {
  const lm = api();
  if (!lm) return (known = 'unavailable');
  try {
    return (known = await lm.availability(LANGS));
  } catch {
    return (known = 'unavailable');
  }
}

// The last answer from availability(), for drawing screens without waiting.
export const lastKnown = () => known;

// Downloads the model (a few GB, once). Chrome only allows this right after a tap or click.
export async function download(onProgress: (fraction: number) => void): Promise<void> {
  const lm = api();
  if (!lm) throw new Error("This browser doesn't have a built-in AI model.");
  const s = await lm.create({ ...LANGS, monitor: (m) => m.addEventListener('downloadprogress', (e) => onProgress(e.loaded)) });
  s.destroy();
  known = 'available';
}

export interface AskOptions {
  system: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  schema?: object;
  onText?: (text: string) => void;
  signal?: AbortSignal;
}

export async function ask({ system, messages, schema, onText, signal }: AskOptions): Promise<string> {
  const lm = api();
  if (!lm) throw new Error("This browser doesn't have a built-in AI model.");
  const history = messages.slice(0, -1);
  const last = messages[messages.length - 1];
  const session = await lm.create({ ...LANGS, signal, initialPrompts: [{ role: 'system', content: system }, ...history] });
  try {
    const opts = { signal, ...(schema ? { responseConstraint: schema } : {}) };
    if (!onText) return await session.prompt(last.content, opts);
    let text = '';
    for await (const chunk of session.promptStreaming(last.content, opts)) {
      text += chunk;
      onText(text);
    }
    return text;
  } finally {
    session.destroy();
  }
}
