// Small byte helpers shared by the extension and Arise (src/life/browser-link.ts). WebCrypto only,
// so the same code runs in the extension, in the page and in the tests (Node).

const enc = new TextEncoder();

export const utf8 = (s: string) => new Uint8Array(enc.encode(s));

export function toB64url(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('Not base64url.');
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const randomId = (bytes = 16) => toB64url(globalThis.crypto.getRandomValues(new Uint8Array(bytes)));

export async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', utf8(text)));
}

// A short, stable fingerprint: the first 16 bytes of SHA-256, as 22 characters.
export const digest = async (text: string) => toB64url((await sha256(text)).subarray(0, 16));
