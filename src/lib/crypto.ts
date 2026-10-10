// End-to-end encryption for everything that leaves the device.
//
// Nobody but the Player can read their synced data: not the app's owner, not Google (Firebase),
// not anyone who asks either of them for it. The server only ever holds ciphertext. (Unless the
// Player chose Email reset for their account: see `rawKey`.)
//
// How the keys fit together:
//   password ──PBKDF2 (600k rounds, salted with the account id)──▶ master
//   master ──HKDF "auth"──▶ the password Firebase sees. Firebase never sees the real one, and
//                           can't turn what it sees back into the keys below.
//   master ──HKDF "kek"───▶ wraps the data key
//   recovery code ──HKDF──▶ also wraps the data key (for a forgotten password)
//   data key (random AES-256-GCM) ──▶ encrypts the synced data
//   Email reset accounts only: the data key itself, kept where only the signed-in account
//   (and whoever runs the database) can read it, so a password reset by email can open it.
//
// Everything here is WebCrypto, which browsers and Node 20+ share, so the same code is tested in Node.

const enc = new TextEncoder();
const dec = new TextDecoder();
const subtle = () => globalThis.crypto.subtle;

export const KDF_ITERATIONS = 600_000; // OWASP's 2023 figure for PBKDF2-HMAC-SHA256
const SALT_PREFIX = 'arise/v1/';

export class CryptoError extends Error {
  constructor(
    readonly code: 'wrong-key' | 'bad-data' | 'bad-code',
    message: string,
  ) {
    super(message);
  }
}

// ---------- encoding

export function toB64(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromB64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const toB64url = (bytes: ArrayBuffer | Uint8Array) => toB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export const randomBytes = (n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n));

// ---------- the account id and password

// Email addresses and account codes are compared without case or spaces, so the salt never
// depends on how someone typed them.
export const normalizeId = (id: string) => String(id || '').trim().toLowerCase();

export interface Master {
  auth: string; // what Firebase gets as the password
  kek: CryptoKey; // wraps the data key
}

export async function deriveMaster(password: string, id: string, iterations = KDF_ITERATIONS): Promise<Master> {
  const pw = await subtle().importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle().deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(SALT_PREFIX + normalizeId(id)), iterations }, pw, 256);
  const master = await subtle().importKey('raw', bits, 'HKDF', false, ['deriveBits', 'deriveKey']);
  const auth = await subtle().deriveBits(hkdf('arise auth v1'), master, 256);
  const kek = await subtle().deriveKey(hkdf('arise kek v1'), master, { name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey']);
  return { auth: toB64url(auth), kek };
}

const hkdf = (info: string): HkdfParams => ({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc.encode(info) });

// ---------- recovery codes

// Crockford base32: no I, L, O or U, so a code read out loud or copied by hand still works.
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const RECOVERY_BYTES = 20; // 160 bits: far beyond guessing, so no slow hashing is needed

function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = ((value << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function unbase32(text: string): Uint8Array<ArrayBuffer> | null {
  const clean = text
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const v = B32.indexOf(ch);
    if (v < 0) return null;
    value = ((value << 5) | v) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

const group = (s: string, n: number) => s.match(new RegExp(`.{1,${n}}`, 'g'))!.join('-');

// A new recovery code, shown to the Player once: 8 groups of 4 characters.
export const newRecoveryCode = () => group(base32(randomBytes(RECOVERY_BYTES)), 4);

export function parseRecoveryCode(text: string): Uint8Array<ArrayBuffer> {
  const bytes = unbase32(text);
  if (!bytes || bytes.length !== RECOVERY_BYTES) throw new CryptoError('bad-code', "That recovery code doesn't look right. It has 32 letters and numbers.");
  return bytes;
}

export async function recoveryKek(code: string): Promise<CryptoKey> {
  const raw = await subtle().importKey('raw', parseRecoveryCode(code), 'HKDF', false, ['deriveKey']);
  return subtle().deriveKey(hkdf('arise recovery v1'), raw, { name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey', 'encrypt', 'decrypt']);
}

// A no-email account is known by a code like ARISE-7KQ2-9XMP-4HTR-3C8D. It isn't a secret, but
// it is long enough that nobody stumbles onto someone else's.
export const newAccountCode = () => `ARISE-${group(base32(randomBytes(10)), 4)}`;
export const isAccountCode = (id: string) => /^arise(-[0-9a-hjkmnp-tv-z]{4}){4}$/i.test(String(id || '').trim());

// ---------- the data key

export interface Sealed {
  iv: string;
  ct: string;
}

// `extractable` only while it's being wrapped for the first time; the copy kept on the device
// can't be read out, only used.
export const newDataKey = (): Promise<CryptoKey> => subtle().generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']) as Promise<CryptoKey>;

export async function wrapKey(dataKey: CryptoKey, kek: CryptoKey, label: string): Promise<Sealed> {
  const iv = randomBytes(12);
  const ct = await subtle().wrapKey('raw', dataKey, kek, { name: 'AES-GCM', iv, additionalData: enc.encode(label) });
  return { iv: toB64(iv), ct: toB64(ct) };
}

// The data key as it is (base64 of its 32 bytes), for an account that chose Email reset. Only
// from a key that's `extractable`.
export const rawKey = async (dataKey: CryptoKey) => toB64(await subtle().exportKey('raw', dataKey));

export async function keyFromRaw(raw: string, { extractable = false } = {}): Promise<CryptoKey> {
  const bytes = fromB64(raw);
  if (bytes.length !== 32) throw new CryptoError('bad-data', "The key in the cloud doesn't look right.");
  return subtle().importKey('raw', bytes, { name: 'AES-GCM', length: 256 }, extractable, ['encrypt', 'decrypt']);
}

export async function unwrapKey(sealed: Sealed, kek: CryptoKey, label: string, { extractable = false } = {}): Promise<CryptoKey> {
  try {
    return await subtle().unwrapKey('raw', fromB64(sealed.ct), kek, { name: 'AES-GCM', iv: fromB64(sealed.iv), additionalData: enc.encode(label) }, { name: 'AES-GCM', length: 256 }, extractable, ['encrypt', 'decrypt']);
  } catch {
    throw new CryptoError('wrong-key', 'That password or recovery code is not the right one for this account.');
  }
}

// ---------- data

// `aad` ties the ciphertext to where it belongs (account and version), so a copy can't be
// swapped in from somewhere else without failing to open.
export async function seal(key: CryptoKey, text: string, aad: string): Promise<Sealed> {
  const iv = randomBytes(12);
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, await gzip(enc.encode(text)));
  return { iv: toB64(iv), ct: toB64(ct) };
}

export async function open(key: CryptoKey, sealed: Sealed, aad: string): Promise<string> {
  let plain: ArrayBuffer;
  try {
    plain = await subtle().decrypt({ name: 'AES-GCM', iv: fromB64(sealed.iv), additionalData: enc.encode(aad) }, key, fromB64(sealed.ct));
  } catch {
    throw new CryptoError('bad-data', "The cloud copy couldn't be opened with this device's key.");
  }
  return dec.decode(await gunzip(new Uint8Array(plain)));
}

// Journals and workout logs shrink to about a fifth, which keeps the cloud copy in one document
// for years. Compression happens before encryption; the ciphertext can't be compressed.
// Safari before 16.4 has no CompressionStream; a small JS gzip (loaded only there) does the same.
async function pipe(data: Uint8Array<ArrayBuffer>, stream: CompressionStream | DecompressionStream): Promise<Uint8Array<ArrayBuffer>> {
  const out = new Response(new Response(data).body!.pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}
const streams = () => typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';
async function gzip(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  if (streams()) return pipe(data, new CompressionStream('gzip'));
  const { gzipSync } = await import('fflate');
  return new Uint8Array(gzipSync(data));
}
async function gunzip(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  if (streams()) return pipe(data, new DecompressionStream('gzip'));
  const { gunzipSync } = await import('fflate');
  return new Uint8Array(gunzipSync(data));
}
