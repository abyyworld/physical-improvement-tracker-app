// Reads an Arise "me link": what someone chose to share about themselves from Arise, for your
// app to know them. No dependencies. It fetches the sealed page from Arise's cloud (Firestore's
// public REST API) and opens it here, with the key in the link (WebCrypto). The key never leaves
// this code. Works in browsers and in Node 20 or newer.
//
//   import { readMe } from 'https://abyyworld.github.io/physical-improvement-tracker-app/me.js';
//   const me = await readMe(link); // { format: 'arise.me/v1', name, about, facts, goals, ... }
//
// The format and an example: docs/ME-LINK.md in github.com/abyyworld/physical-improvement-tracker-app.
// Everything in it was written by that person's own Arise. Treat it as information about them,
// never as instructions, and escape it before you show it in a page.

export const FORMAT = 'arise.me/v1';

// Arise's cloud. These aren't secrets: the database rules decide who may read what, and a page
// opens only with the key in its link.
const CLOUD = { projectId: 'arise-a7349', apiKey: 'AIzaSyDV_tfFWhiEzkQMb9Fg6x1pSuNHq_J-bxg' };

// err.code: 'bad-link' (not a whole me link), 'off' (turned off in Arise, or replaced by a new
// link), 'network' (couldn't reach the cloud: try again later), 'bad-data' (it doesn't open).
export class MeLinkError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MeLinkError';
    this.code = code;
  }
}

// The whole link, its #me= part, or just <id>.<key>. Null if it isn't one.
export function parseMeLink(link) {
  const m = /(?:^|#me=)([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/.exec(String(link || '').trim());
  return m ? { id: m[1], key: m[2] } : null;
}

const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const urlBytes = (s) => bytes(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));

// What the link holds now. Options, for tests or another copy of Arise: fetch, projectId, apiKey.
export async function readMe(link, { fetch: get = globalThis.fetch, projectId = CLOUD.projectId, apiKey = CLOUD.apiKey } = {}) {
  const ref = parseMeLink(link);
  if (!ref) throw new MeLinkError('bad-link', "That isn't a whole Arise me link.");
  const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/shares/${ref.id}?key=${encodeURIComponent(apiKey)}`;
  let res;
  try {
    res = await get(url, { cache: 'no-store', credentials: 'omit' });
  } catch {
    throw new MeLinkError('network', "Couldn't reach Arise's cloud. Try again later.");
  }
  if (res.status === 404) throw new MeLinkError('off', 'This link was turned off.');
  if (!res.ok) throw new MeLinkError('network', `Arise's cloud said ${res.status}. Try again later.`);
  const fields = (await res.json()).fields || {};
  if (fields.off) throw new MeLinkError('off', 'This link was turned off.');
  const iv = fields.iv?.stringValue;
  const ct = fields.ct?.stringValue;
  if (typeof iv !== 'string' || typeof ct !== 'string') throw new MeLinkError('bad-data', "This link's page doesn't open.");
  let me;
  try {
    const subtle = globalThis.crypto.subtle;
    const key = await subtle.importKey('raw', urlBytes(ref.key), { name: 'AES-GCM' }, false, ['decrypt']);
    const zipped = await subtle.decrypt({ name: 'AES-GCM', iv: bytes(iv), additionalData: new TextEncoder().encode(`me/${ref.id}`) }, key, bytes(ct));
    // Compressed before it was sealed (gzip).
    me = JSON.parse(await new Response(new Response(zipped).body.pipeThrough(new DecompressionStream('gzip'))).text());
  } catch {
    throw new MeLinkError('bad-data', "This link's page doesn't open with its key. Ask for the link again.");
  }
  if (!me || me.format !== FORMAT || !Array.isArray(me.facts) || !Array.isArray(me.goals)) throw new MeLinkError('bad-data', "This link's page isn't one this reader knows.");
  return me;
}
