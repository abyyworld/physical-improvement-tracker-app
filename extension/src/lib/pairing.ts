// How Arise's page and the extension talk, and the 4-word code that proves they're talking to
// each other.
//
// They meet on Arise's own page: the extension's content script runs only there (and on
// localhost in a development build) and passes messages to and from the extension. Everything
// on the way is checked against the shapes below.
//
// Linking:
//   page → offer {link, pub, commit}   a new link id, Arise's public key for it, and a hash of a
//                                       secret number the page picked (it can't change it later)
//   ext  → {nonce}                      a number the extension picked after seeing the offer
//   page → reveal {link, nonce}         the page's number; the extension checks it against the hash
// Both sides then show 4 words made from all of it. If something in between swapped the key, the
// words differ, and it can't pick its numbers to make them match: each side's number is fixed
// before it sees the other's. The person checks the words and presses "They match" in the
// extension's own window, which a web page can't fake.

import { type SealedBatch, isSealedBatch } from './seal';
import { randomId, sha256, toB64url } from './bytes';
import { WORDS } from './words';

export const NS = 'arise-browser-link/1';
export const CODE_WORDS = 4;

export interface Note {
  id: string;
  t: 'forget';
  from: number;
  to: number;
}

export type PageRequest =
  | { t: 'hello' }
  | { t: 'offer'; link: string; pub: string; commit: string }
  | { t: 'reveal'; link: string; nonce: string }
  | { t: 'status'; link: string }
  | { t: 'pull'; link: string }
  | { t: 'ack'; link: string; ids: string[]; notes: string[] }
  | { t: 'unlink'; link: string };

export type Push = { t: 'paired' | 'declined' | 'ready' | 'unlinked'; link: string };

export interface HelloReply {
  ok: true;
  version: string;
  browser: string; // e.g. "Chrome on macOS"
  linked: string | null; // the link this page knows about, if the extension has one with it
  pairing: boolean;
}
export interface StatusReply {
  ok: true;
  linked: boolean;
  waiting: number; // sealed batches not delivered yet
  paused: boolean;
}
export interface PullReply {
  ok: true;
  batches: SealedBatch[];
  notes: Note[];
  more: boolean;
}
export type Fail = { ok: false; error: string };

// ---------- checks

const ID = /^[A-Za-z0-9_-]{16,64}$/;
const isId = (s: unknown): s is string => typeof s === 'string' && ID.test(s);
const isPub = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9_-]{87}$/.test(s); // 65 bytes
const isIds = (a: unknown, max = 1000): a is string[] => Array.isArray(a) && a.length <= max && a.every(isId);

export function parseRequest(x: unknown): PageRequest | null {
  const m = x as Record<string, unknown>;
  if (!m || typeof m !== 'object') return null;
  switch (m.t) {
    case 'hello':
      return { t: 'hello' };
    case 'offer':
      return isId(m.link) && isPub(m.pub) && isId(m.commit) ? { t: 'offer', link: m.link, pub: m.pub, commit: m.commit } : null;
    case 'reveal':
      return isId(m.link) && isId(m.nonce) ? { t: 'reveal', link: m.link, nonce: m.nonce } : null;
    case 'status':
    case 'pull':
    case 'unlink':
      return isId(m.link) ? { t: m.t, link: m.link } : null;
    case 'ack':
      return isId(m.link) && isIds(m.ids) && isIds(m.notes ?? []) ? { t: 'ack', link: m.link, ids: m.ids as string[], notes: (m.notes as string[]) ?? [] } : null;
    default:
      return null;
  }
}

export function parsePush(x: unknown): Push | null {
  const m = x as Record<string, unknown>;
  return m && typeof m === 'object' && ['paired', 'declined', 'ready', 'unlinked'].includes(m.t as string) && isId(m.link) ? { t: m.t as Push['t'], link: m.link as string } : null;
}

export function parseNote(x: unknown): Note | null {
  const n = x as Note;
  return n && n.t === 'forget' && isId(n.id) && Number.isFinite(n.from) && Number.isFinite(n.to) && n.from <= n.to ? { id: n.id, t: 'forget', from: n.from, to: n.to } : null;
}

export function parsePull(x: unknown): PullReply | null {
  const r = x as PullReply;
  if (!r || r.ok !== true || !Array.isArray(r.batches) || !Array.isArray(r.notes ?? [])) return null;
  return { ok: true, batches: r.batches.filter(isSealedBatch), notes: (r.notes ?? []).map(parseNote).filter((n): n is Note => !!n), more: !!r.more };
}

// ---------- the code

export const newNonce = () => randomId(16);
export const newLinkId = () => randomId(16);

export async function commitment(nonce: string): Promise<string> {
  return toB64url((await sha256(`${NS} commit|${nonce}`)).subarray(0, 24));
}

export async function pairCode(link: string, pub: string, pageNonce: string, extNonce: string): Promise<string[]> {
  const h = await sha256(`${NS} code|${link}|${pub}|${pageNonce}|${extNonce}`);
  return Array.from(h.subarray(0, CODE_WORDS), (b) => WORDS[b]);
}
