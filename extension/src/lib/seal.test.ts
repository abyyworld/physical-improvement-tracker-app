// Sealing: the extension locks batches with Arise's public key; only Arise's private key opens them.

import { describe, expect, it } from 'vitest';
import { fromB64url, toB64url } from './bytes';
import { type BatchMeta, SealError, importPublic, isSealedBatch, newKeyPair, openBatch, sealBatch } from './seal';

const LINK = 'L'.repeat(22);
const meta = (over: Partial<BatchMeta> = {}): BatchMeta => ({ id: 'B'.repeat(22), from: 1000, to: 2000, n: 2, ...over });
const payload = { v: 1, events: [{ id: 'browser:x', title: 'Searched "protein bars"' }, { id: 'browser:y', title: 'Ünïcödé 🏋️' }] };

describe('sealing batches', () => {
  it('opens with the private key what was sealed with the public key', async () => {
    const { pub, privateKey } = await newKeyPair(false);
    const sealed = await sealBatch(pub, LINK, meta(), payload);
    expect(isSealedBatch(sealed)).toBe(true);
    expect(sealed).toMatchObject({ v: 1, link: LINK, id: meta().id, from: 1000, to: 2000, n: 2 });
    expect(await openBatch(privateKey, sealed)).toEqual(payload);
  });

  it("can't be read without the private key: nothing readable in it, and another key can't open it", async () => {
    const { pub } = await newKeyPair(false);
    const other = await newKeyPair(false);
    const sealed = await sealBatch(pub, LINK, meta(), payload);
    const json = JSON.stringify(sealed);
    expect(json).not.toContain('protein');
    expect(json).not.toContain('browser:x');
    await expect(openBatch(other.privateKey, sealed)).rejects.toBeInstanceOf(SealError);
  });

  it('uses a new throwaway key every time, so two batches never look alike', async () => {
    const { pub } = await newKeyPair(false);
    const a = await sealBatch(pub, LINK, meta(), payload);
    const b = await sealBatch(pub, LINK, meta(), payload);
    expect(a.epk).not.toBe(b.epk);
    expect(a.ct).not.toBe(b.ct);
  });

  it('fails to open if its link, id, times or count were changed, or a byte of it', async () => {
    const { pub, privateKey } = await newKeyPair(false);
    const sealed = await sealBatch(pub, LINK, meta(), payload);
    const flip = (s: string) => {
      const b = fromB64url(s);
      b[5] ^= 1;
      return toB64url(b);
    };
    for (const bad of [
      { ...sealed, link: 'M'.repeat(22) },
      { ...sealed, id: 'C'.repeat(22) },
      { ...sealed, from: 999 },
      { ...sealed, to: 2001 },
      { ...sealed, n: 3 },
      { ...sealed, ct: flip(sealed.ct) },
      { ...sealed, iv: flip(sealed.iv) },
      { ...sealed, epk: (await newKeyPair(false)).pub },
    ]) {
      await expect(openBatch(privateKey, bad)).rejects.toBeInstanceOf(SealError);
    }
  });

  it('compresses what it seals', async () => {
    const { pub, privateKey } = await newKeyPair(false);
    const big = { v: 1, events: Array.from({ length: 500 }, (_, i) => ({ id: `browser:${i}`, title: 'Watched the same kind of thing again', url: 'https://www.youtube.com/watch' })) };
    const sealed = await sealBatch(pub, LINK, meta({ n: 500 }), big);
    expect(sealed.z).toBe(1);
    expect(sealed.ct.length).toBeLessThan(JSON.stringify(big).length / 5);
    expect(await openBatch(privateKey, sealed)).toEqual(big);
  });

  it("keeps the private key unreadable when asked, and the public key is all the extension gets", async () => {
    const { pub, privateKey } = await newKeyPair(false);
    expect(privateKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('pkcs8', privateKey)).rejects.toThrow();
    expect(fromB64url(pub)).toHaveLength(65);
    const key = await importPublic(pub);
    expect(key.type).toBe('public');
    await expect(importPublic('A'.repeat(87))).rejects.toThrow();
    await expect(importPublic('short')).rejects.toThrow();
  });

  it('checks the shape of a sealed batch before opening it', async () => {
    const { pub } = await newKeyPair(false);
    const ok = await sealBatch(pub, LINK, meta(), payload);
    for (const bad of [null, 'x', {}, { ...ok, v: 2 }, { ...ok, from: 3000 }, { ...ok, n: -1 }, { ...ok, ct: 'not base64!' }, { ...ok, link: '' }, { ...ok, z: 2 }, { ...ok, to: Infinity }]) {
      expect(isSealedBatch(bad)).toBe(false);
    }
  });
});
