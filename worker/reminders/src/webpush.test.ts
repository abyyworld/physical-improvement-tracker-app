// Web Push encryption (RFC 8291) against the RFC's own example, and VAPID signatures (RFC 8292).

import { describe, expect, it } from 'vitest';
import { browser, decrypt } from './test/helpers';
import { MAX_MESSAGE, encrypt, fromB64url, importVapid, newVapidJwk, toB64url, vapidHeader } from './webpush';

const subtle = () => globalThis.crypto.subtle;
const te = new TextEncoder();

// RFC 8291, section 5 (and Appendix A for the private keys).
const RFC = {
  plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  message:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

describe('base64url', () => {
  it('round-trips bytes and refuses anything else', () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(fromB64url(toB64url(bytes))).toEqual(bytes);
    expect(toB64url(te.encode('??>'))).toBe('Pz8-');
    expect(() => fromB64url('a+b/')).toThrow();
    expect(() => fromB64url('a b')).toThrow();
  });
});

describe('encrypting a push message (RFC 8291)', () => {
  it("matches the RFC's example exactly", async () => {
    const asPublic = fromB64url(RFC.asPublic);
    const privateKey = await subtle().importKey(
      'jwk',
      { kty: 'EC', crv: 'P-256', d: RFC.asPrivate, x: toB64url(asPublic.slice(1, 33)), y: toB64url(asPublic.slice(33)) },
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      ['deriveBits'],
    );
    const out = await encrypt(fromB64url(RFC.plaintext), fromB64url(RFC.uaPublic), fromB64url(RFC.auth), {
      salt: fromB64url(RFC.salt),
      serverKeys: { privateKey, publicKey: asPublic },
    });
    expect(toB64url(out)).toBe(RFC.message);
    expect(new TextDecoder().decode(fromB64url(RFC.plaintext))).toBe('When I grow up, I want to be a watermelon');
  });

  it('can be read by the browser it was meant for, and only by it', async () => {
    const b = await browser();
    const message = JSON.stringify({ kind: 'morning', date: '2026-10-09' });
    const out = await encrypt(te.encode(message), b.publicKey, b.auth);
    expect(await decrypt(out, b)).toBe(message);
    // A new salt and a new one-time key every time, so the same message never looks the same.
    const again = await encrypt(te.encode(message), b.publicKey, b.auth);
    expect(toB64url(again.slice(0, 86))).not.toBe(toB64url(out.slice(0, 86)));
    expect(again.length).toBe(out.length);
    // Another browser's keys can't open it.
    const other = await browser();
    await expect(decrypt(out, { ...other, publicKey: b.publicKey, auth: b.auth })).rejects.toThrow();
    await expect(decrypt(out, { ...b, auth: other.auth })).rejects.toThrow();
  });

  it('lays out the header as aes128gcm says', async () => {
    const b = await browser();
    const out = await encrypt(te.encode('hi'), b.publicKey, b.auth);
    expect(new DataView(out.buffer).getUint32(16)).toBe(4096); // record size
    expect(out[20]).toBe(65); // the key id is the server's one-time public key
    expect(out[21]).toBe(4);
    expect(out.length).toBe(16 + 4 + 1 + 65 + 2 + 1 + 16); // header, message, delimiter, tag
  });

  it('refuses bad browser keys and messages that are too long', async () => {
    const b = await browser();
    await expect(encrypt(te.encode('x'), b.publicKey.slice(1), b.auth)).rejects.toThrow();
    const offCurve = new Uint8Array(65).fill(7);
    offCurve[0] = 4;
    await expect(encrypt(te.encode('x'), offCurve, b.auth)).rejects.toThrow();
    await expect(encrypt(te.encode('x'), b.publicKey, b.auth.slice(1))).rejects.toThrow();
    await expect(encrypt(new Uint8Array(MAX_MESSAGE + 1), b.publicKey, b.auth)).rejects.toThrow();
  });
});

describe('VAPID (RFC 8292)', () => {
  it('signs a token for the push service that verifies with the public key', async () => {
    const jwk = await newVapidJwk();
    const vapid = await importVapid(jwk);
    const now = Date.UTC(2026, 9, 9, 6, 30);
    const header = await vapidHeader(vapid, 'https://fcm.googleapis.com/fcm/send/abc:def?x=1', 'mailto:owner@example.com', now);

    const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header);
    expect(m).not.toBeNull();
    const [, h, c, sig, k] = m!;
    expect(k).toBe(vapid.publicKey);
    expect(JSON.parse(new TextDecoder().decode(fromB64url(h)))).toEqual({ typ: 'JWT', alg: 'ES256' });
    const claims = JSON.parse(new TextDecoder().decode(fromB64url(c)));
    expect(claims).toEqual({ aud: 'https://fcm.googleapis.com', exp: now / 1000 + 3600, sub: 'mailto:owner@example.com' });

    // ES256 in a JWT is the raw 64-byte r || s, and it checks out with the key the app subscribes with.
    const signature = fromB64url(sig);
    expect(signature.length).toBe(64);
    const key = fromB64url(k);
    expect(key.length).toBe(65);
    const pub = await subtle().importKey('raw', key, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    expect(await subtle().verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, signature, te.encode(`${h}.${c}`))).toBe(true);
    expect(await subtle().verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, signature, te.encode(`${h}.${c}x`))).toBe(false);
  });

  it('keeps the same public key when the stored key pair is loaded again', async () => {
    const jwk = JSON.parse(JSON.stringify(await newVapidJwk()));
    expect(Object.keys(jwk).sort()).toEqual(['crv', 'd', 'kty', 'x', 'y']);
    expect((await importVapid(jwk)).publicKey).toBe((await importVapid(jwk)).publicKey);
    expect((await importVapid(jwk)).publicKey).not.toBe((await importVapid(await newVapidJwk())).publicKey);
  });
});
