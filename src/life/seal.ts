// The life log's keys and sealed packs (see packs.ts and cloud.ts).
//
//   life key (32 random bytes, one per account) ──sealed with the account's data key──▶ the 'key'
//                 document. Changing the password or the recovery code re-wraps the data key
//                 (account.ts), never this one, so no pack has to be sealed again.
//   life key ──HKDF "arise life seal v1"──▶ seals each pack and the index (AES-256-GCM)
//   life key ──HKDF "arise life ids v1"───▶ HMAC-SHA-256 of a pack's name and part number: the
//                 document's id, 43 characters of base64url whatever the pack, so the ids in the
//                 cloud don't tell which months the Player has anything in.
//
// A pack is compressed before it's sealed (gzip, lib/crypto.ts) and split into parts of at most
// 700,000 characters, one document each. Each seal is tied to the account, the pack and its
// version (the AAD), so a part from elsewhere, or from another version, doesn't open.

import { fromB64, randomBytes, seal, open, toB64, toB64url, type Sealed } from '../lib/crypto';

const subtle = () => globalThis.crypto.subtle;
const enc = new TextEncoder();
const hkdf = (info: string): HkdfParams => ({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc.encode(info) });

export const CHUNK = 700_000; // characters of ciphertext per document, as firestore.rules allows
export const MAX_PARTS = 12; // a pack's parts go up in one write, which Firestore keeps under 10 MB

export class PackError extends Error {
  constructor(
    readonly code: 'too-big' | 'bad-data',
    message: string,
  ) {
    super(message);
  }
}

export interface LifeKeys {
  sealKey: CryptoKey;
  idKey: CryptoKey;
}

const keyLabel = (uid: string) => `${uid}/life/key`;

// A new life key, sealed with the account's data key for the 'key' document.
export async function newLifeKey(dataKey: CryptoKey, uid: string): Promise<{ sealed: Sealed; keys: LifeKeys }> {
  const raw = randomBytes(32);
  const sealed = await seal(dataKey, toB64(raw), keyLabel(uid));
  return { sealed, keys: await deriveKeys(raw) };
}

// The life key from the 'key' document. Throws (bad-data) if the data key can't open it.
export async function openLifeKey(dataKey: CryptoKey, uid: string, sealed: Sealed): Promise<LifeKeys> {
  const raw = fromB64(await open(dataKey, sealed, keyLabel(uid)));
  if (raw.length !== 32) throw new PackError('bad-data', "The life log's key in the cloud doesn't look right.");
  return deriveKeys(raw);
}

async function deriveKeys(raw: Uint8Array<ArrayBuffer>): Promise<LifeKeys> {
  const base = await subtle().importKey('raw', raw, 'HKDF', false, ['deriveKey']);
  const sealKey = await subtle().deriveKey(hkdf('arise life seal v1'), base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const idKey = await subtle().deriveKey(hkdf('arise life ids v1'), base, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign']);
  return { sealKey, idKey };
}

// The document id of part `i` of a pack.
export async function partId(keys: LifeKeys, pack: string, i: number): Promise<string> {
  return toB64url(await subtle().sign('HMAC', keys.idKey, enc.encode(`${pack}#${i}`)));
}

const packLabel = (uid: string, pack: string, rev: string) => `${uid}/life/${pack}/${rev}`;
const indexLabel = (uid: string) => `${uid}/life/index`;

// A pack sealed and cut into parts. `iv` goes with every part.
export async function sealPack(keys: LifeKeys, uid: string, pack: string, rev: string, text: string, maxParts = MAX_PARTS): Promise<{ iv: string; parts: string[] }> {
  const s = await seal(keys.sealKey, text, packLabel(uid, pack, rev));
  const parts: string[] = [];
  for (let i = 0; i < s.ct.length; i += CHUNK) parts.push(s.ct.slice(i, i + CHUNK));
  if (parts.length > maxParts) throw new PackError('too-big', `Part of your life log (${pack}) is too big to sync.`);
  return { iv: s.iv, parts };
}

export async function openPack(keys: LifeKeys, uid: string, pack: string, rev: string, iv: string, parts: readonly string[]): Promise<string> {
  return open(keys.sealKey, { iv, ct: parts.join('') }, packLabel(uid, pack, rev));
}

export const sealIndex = (keys: LifeKeys, uid: string, text: string) => seal(keys.sealKey, text, indexLabel(uid));
export const openIndex = (keys: LifeKeys, uid: string, s: Sealed) => open(keys.sealKey, s, indexLabel(uid));

// A new version's name.
export const newRev = () => `${Date.now().toString(36)}${toB64url(randomBytes(6))}`;

// A fingerprint of a pack's text, to tell whether it changed since it was last synced.
export async function digest(text: string): Promise<string> {
  return toB64url(await subtle().digest('SHA-256', enc.encode(text)));
}
