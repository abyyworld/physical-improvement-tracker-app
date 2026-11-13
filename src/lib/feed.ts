// What an app did with its me link through the web connector (worker/connector): which tools it
// used, when, and the notes it added. The connector keeps these sealed, so what it stores is only
// ciphertext; the app opens them with keys made from the link's own key.
//
//   link key ──HMAC "arise-feed-key/<id>"──▶ the AES-GCM key the entries are sealed with
//   link key ──HMAC "arise-feed-read/<id>"─▶ the token Arise shows to read them back
//
// The connector only ever sees the link key while it answers an app (which already has the
// link), and it keeps only a SHA-256 of the read token. On its own (no app imports), so the
// connector Worker uses the same code.

const enc = new TextEncoder();
const dec = new TextDecoder();
const subtle = () => globalThis.crypto.subtle;

const b64 = (u8: Uint8Array) => {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64url = (u8: Uint8Array) => b64(u8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s: string) => unb64(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));

export const FEED_TOOLS = ['about_me', 'my_goals', 'recent_days', 'search', 'fetch', 'add_note'] as const;
export type FeedTool = (typeof FEED_TOOLS)[number];

// One thing an app did. `note`: the words of a note it added (add_note only).
export interface FeedEntry {
  at: number;
  tool: FeedTool;
  ok: boolean;
  client?: string; // 'Claude', 'ChatGPT', 'Gemini' or '' when the connector couldn't tell
  note?: string;
}

// As the connector keeps it: n counts up from 1 for each link (the connector numbers them once
// they're sealed; inside, each has its own time).
export interface SealedEntry {
  n: number;
  iv: string;
  ct: string;
}

async function hmac(linkKey: string, label: string): Promise<Uint8Array<ArrayBuffer>> {
  const raw = unb64url(linkKey);
  if (raw.length !== 32) throw new Error("That link isn't complete.");
  const k = await subtle().importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle().sign('HMAC', k, enc.encode(label)));
}

export interface FeedKeys {
  key: CryptoKey;
  token: string;
}

export async function feedKeys(id: string, linkKey: string): Promise<FeedKeys> {
  const raw = await hmac(linkKey, `arise-feed-key/${id}`);
  const key = await subtle().importKey('raw', raw, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return { key, token: b64url(await hmac(linkKey, `arise-feed-read/${id}`)) };
}

export async function tokenHash(token: string): Promise<string> {
  const h = new Uint8Array(await subtle().digest('SHA-256', enc.encode(token)));
  return [...h].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const aad = (id: string) => enc.encode(`feed/${id}`);

export async function sealEntry(key: CryptoKey, id: string, e: FeedEntry): Promise<{ iv: string; ct: string }> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: aad(id) }, key, enc.encode(JSON.stringify(e))));
  return { iv: b64(iv), ct: b64(ct) };
}

const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]+/g;

// An entry checked field by field. Null when it doesn't open, or isn't one.
export async function openEntry(key: CryptoKey, id: string, s: SealedEntry): Promise<FeedEntry | null> {
  let raw: unknown;
  try {
    const plain = await subtle().decrypt({ name: 'AES-GCM', iv: unb64(s.iv), additionalData: aad(id) }, key, unb64(s.ct));
    raw = JSON.parse(dec.decode(plain));
  } catch {
    return null;
  }
  return cleanEntry(raw);
}

export function cleanEntry(raw: unknown): FeedEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.at !== 'number' || !Number.isFinite(r.at) || r.at <= 0 || !FEED_TOOLS.includes(r.tool as FeedTool)) return null;
  const out: FeedEntry = { at: r.at, tool: r.tool as FeedTool, ok: r.ok === true };
  if (typeof r.client === 'string' && /^[A-Za-z ]{1,20}$/.test(r.client)) out.client = r.client;
  if (out.tool === 'add_note' && typeof r.note === 'string') {
    const note = r.note.replace(/\r\n?/g, '\n').replace(CONTROL, ' ').trim().slice(0, 1000);
    if (note) out.note = note;
  }
  return out;
}

// Who's asking, from the request's User-Agent, in a word.
export function clientName(ua: string | null | undefined): string {
  const s = String(ua || '');
  if (/claude|anthropic/i.test(s)) return 'Claude';
  if (/openai|chatgpt/i.test(s)) return 'ChatGPT';
  if (/gemini|google/i.test(s)) return 'Gemini';
  return '';
}

// What each tool means, for the access log in Arise.
export const TOOL_WORDS: Record<FeedTool, string> = {
  about_me: 'read about you',
  my_goals: 'read your goals',
  recent_days: 'read your last days',
  search: 'searched what it gets',
  fetch: 'opened one item',
  add_note: 'added a note',
};
