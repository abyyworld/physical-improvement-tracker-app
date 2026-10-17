// Sealing: the extension can lock a batch for Arise, but can never open it again.
//
// Arise makes a key pair for each linked browser (ECDH P-256) and gives the extension only the
// public half. Each batch gets a new throwaway key pair of its own: the two make a shared secret
// (ECDH), HKDF turns it into an AES-256-GCM key, and the throwaway private key is forgotten right
// away. Only the private key Arise keeps can make that secret again.
//
// The batch's link, id, time range and count are readable (the extension needs them to deliver
// and to forget the last hour), and they're part of the sealed data's check (additional data),
// so changing any of them makes the batch fail to open.
//
// WebCrypto only, the same in the extension, in Arise and in the tests.

import { fromB64url, toB64url, utf8 } from './bytes';

export const PROTOCOL = 'arise-browser/1';
const CURVE = { name: 'ECDH', namedCurve: 'P-256' } as const;
const subtle = () => globalThis.crypto.subtle;

export interface BatchMeta {
  id: string;
  from: number; // the earliest moment in it
  to: number; // the latest
  n: number; // how many things are in it
}

export interface SealedBatch extends BatchMeta {
  v: 1;
  link: string; // which linked browser sealed it
  epk: string; // the throwaway public key (base64url, 65 bytes)
  iv: string;
  ct: string;
  z: 0 | 1; // gzipped before sealing
}

export const aad = (link: string, m: BatchMeta) => utf8(`${PROTOCOL}|${link}|${m.id}|${m.from}|${m.to}|${m.n}`);
const info = (link: string) => utf8(`${PROTOCOL} batch key|${link}`);

// ---------- keys (Arise's side)

// A new key pair for a linked browser. The public key goes to the extension, as base64url.
export async function newKeyPair(extractable: boolean): Promise<{ pub: string; privateKey: CryptoKey }> {
  const pair = (await subtle().generateKey(CURVE, extractable, ['deriveBits'])) as CryptoKeyPair;
  return { pub: toB64url(await subtle().exportKey('raw', pair.publicKey)), privateKey: pair.privateKey };
}

export async function importPublic(pub: string): Promise<CryptoKey> {
  const raw = fromB64url(pub);
  if (raw.length !== 65 || raw[0] !== 4) throw new Error("That key doesn't look right.");
  return subtle().importKey('raw', raw, CURVE, true, []);
}

async function aesKey(secret: ArrayBuffer, epk: Uint8Array<ArrayBuffer>, link: string, use: KeyUsage): Promise<CryptoKey> {
  const ikm = await subtle().importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  return subtle().deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: epk, info: info(link) }, ikm, { name: 'AES-GCM', length: 256 }, false, [use]);
}

// ---------- gzip (where the browser has it; it always does in Chrome and Firefox)

const canZip = () => typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';
async function pipe(data: Uint8Array<ArrayBuffer>, stream: CompressionStream | DecompressionStream): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await new Response(new Response(data).body!.pipeThrough(stream)).arrayBuffer());
}

// ---------- sealing (the extension's side)

export async function sealBatch(pub: string | CryptoKey, link: string, meta: BatchMeta, payload: unknown): Promise<SealedBatch> {
  const recipient = typeof pub === 'string' ? await importPublic(pub) : pub;
  const eph = (await subtle().generateKey(CURVE, false, ['deriveBits'])) as CryptoKeyPair;
  const epk = new Uint8Array(await subtle().exportKey('raw', eph.publicKey));
  const secret = await subtle().deriveBits({ name: 'ECDH', public: recipient }, eph.privateKey, 256);
  const key = await aesKey(secret, epk, link, 'encrypt');
  const z = canZip() ? 1 : 0;
  let plain = utf8(JSON.stringify(payload));
  if (z) plain = await pipe(plain, new CompressionStream('gzip'));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: aad(link, meta) }, key, plain);
  return { v: 1, link, id: meta.id, from: meta.from, to: meta.to, n: meta.n, epk: toB64url(epk), iv: toB64url(iv), ct: toB64url(ct), z };
}

// ---------- opening (Arise's side)

export class SealError extends Error {}

export async function openBatch(privateKey: CryptoKey, b: SealedBatch): Promise<unknown> {
  try {
    const epk = fromB64url(b.epk);
    const sender = await subtle().importKey('raw', epk, CURVE, false, []);
    const secret = await subtle().deriveBits({ name: 'ECDH', public: sender }, privateKey, 256);
    const key = await aesKey(secret, epk, b.link, 'decrypt');
    let plain = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: fromB64url(b.iv), additionalData: aad(b.link, b) }, key, fromB64url(b.ct)));
    if (b.z) plain = await pipe(plain, new DecompressionStream('gzip'));
    return JSON.parse(new TextDecoder().decode(plain));
  } catch {
    throw new SealError("This batch couldn't be opened with this browser's key.");
  }
}

// The shape of a sealed batch as it arrives: anything else is dropped unopened.
export function isSealedBatch(x: unknown): x is SealedBatch {
  const b = x as SealedBatch;
  const str = (s: unknown, max: number) => typeof s === 'string' && s.length > 0 && s.length <= max && /^[A-Za-z0-9_-]+$/.test(s);
  const num = (n: unknown) => typeof n === 'number' && Number.isFinite(n);
  return (
    !!b && typeof b === 'object' && b.v === 1 && str(b.link, 64) && str(b.id, 64) && str(b.epk, 100) && str(b.iv, 20) && str(b.ct, 40_000_000) &&
    num(b.from) && num(b.to) && num(b.n) && b.from <= b.to && b.n >= 0 && (b.z === 0 || b.z === 1)
  );
}
