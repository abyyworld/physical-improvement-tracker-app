// Web Push, with nothing but WebCrypto: the message is encrypted to the browser (RFC 8291) and
// the request is signed with this server's key (VAPID, RFC 8292). Only the browser that
// subscribed can read a message; the push service in between (Apple's, Google's, Mozilla's,
// Microsoft's) only passes it on.

const te = new TextEncoder();
const subtle = () => globalThis.crypto.subtle;
const P256 = { name: 'ECDH', namedCurve: 'P-256' } as const;

type Bytes = Uint8Array<ArrayBuffer>;

// ---------- base64url, as push subscriptions and VAPID use it

export function toB64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(s: string): Bytes {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('base64url');
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Bytes> {
  const key = await subtle().importKey('raw', concat(ikm), 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: concat(salt), info: concat(info) }, key, length * 8));
}

// ---------- the message (RFC 8291, with the aes128gcm content coding of RFC 8188)

// Browsers accept at most this much of a message once it's decrypted.
export const MAX_MESSAGE = 3993;
const RECORD_SIZE = 4096;

// A browser's public key (p256dh) must be a point on the P-256 curve; importing it checks that.
export async function browserKey(p256dh: Uint8Array): Promise<CryptoKey> {
  if (p256dh.length !== 65 || p256dh[0] !== 4) throw new Error('p256dh');
  return subtle().importKey('raw', concat(p256dh), P256, false, []);
}

export interface EncryptOptions {
  // Fixed values, only for checking against the RFC's example. Normally both are new each time.
  salt?: Uint8Array;
  serverKeys?: { privateKey: CryptoKey; publicKey: Uint8Array };
}

export async function encrypt(message: Uint8Array, p256dh: Uint8Array, auth: Uint8Array, opts: EncryptOptions = {}): Promise<Bytes> {
  if (message.length > MAX_MESSAGE) throw new Error('too long');
  if (auth.length !== 16) throw new Error('auth');
  const salt = opts.salt ?? globalThis.crypto.getRandomValues(new Uint8Array(16));
  let server = opts.serverKeys;
  if (!server) {
    const pair = (await subtle().generateKey(P256, true, ['deriveBits'])) as CryptoKeyPair;
    server = { privateKey: pair.privateKey, publicKey: new Uint8Array(await subtle().exportKey('raw', pair.publicKey)) };
  }
  const shared = new Uint8Array(await subtle().deriveBits({ name: 'ECDH', public: await browserKey(p256dh) }, server.privateKey, 256));
  const ikm = await hkdf(auth, shared, concat(te.encode('WebPush: info\0'), p256dh, server.publicKey), 32);
  const cek = await hkdf(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);
  const key = await subtle().importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  // One record: the message, then 2, which marks the last record (no padding after it).
  const sealed = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(message, Uint8Array.of(2))));
  // The header: salt, record size, and the server's one-time public key, which the browser needs.
  const header = new Uint8Array(21);
  header.set(salt);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = server.publicKey.length;
  return concat(header, server.publicKey, sealed);
}

// ---------- VAPID: who is sending (RFC 8292)

export interface Vapid {
  privateKey: CryptoKey; // ES256, for signing
  publicKey: string; // base64url of the raw public key, which the app subscribes with
}

// A new key pair, as the JWK that's kept (it holds both halves).
export async function newVapidJwk(): Promise<JsonWebKey> {
  const pair = (await subtle().generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const { kty, crv, d, x, y } = await subtle().exportKey('jwk', pair.privateKey);
  return { kty, crv, d, x, y };
}

export async function importVapid(jwk: JsonWebKey): Promise<Vapid> {
  const { kty, crv, d, x, y } = jwk;
  const privateKey = await subtle().importKey('jwk', { kty, crv, d, x, y }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  return { privateKey, publicKey: toB64url(concat(Uint8Array.of(4), fromB64url(x!), fromB64url(y!))) };
}

// The Authorization header for one push service. The token says who's sending (`subject`, a
// mailto: or https: address the push service can use to get in touch) and lasts an hour.
export async function vapidHeader(v: Vapid, endpoint: string, subject: string, now = Date.now()): Promise<string> {
  const part = (o: object) => toB64url(te.encode(JSON.stringify(o)));
  const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 3600, sub: subject })}`;
  // WebCrypto's ECDSA signature is already the raw r || s that JWTs use.
  const sig = new Uint8Array(await subtle().sign({ name: 'ECDSA', hash: 'SHA-256' }, v.privateKey, te.encode(unsigned)));
  return `vapid t=${unsigned}.${toB64url(sig)}, k=${v.publicKey}`;
}
