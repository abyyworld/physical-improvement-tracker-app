// The life log's keys and sealed packs: the life key is sealed with the account's data key, packs
// open only with the right key, account, pack and version, document ids don't tell which month a
// pack is, and a big pack is cut into parts the database takes.

import { describe, expect, it } from 'vitest';
import { newDataKey, randomBytes, toB64 } from '../lib/crypto';
import { CHUNK, MAX_PARTS, newLifeKey, newRev, openIndex, openLifeKey, openPack, partId, sealIndex, sealPack } from './seal';

// Text that doesn't compress (random bytes, in base64), about `n` bytes' worth.
function noise(n: number) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) out.set(randomBytes(Math.min(65536, n - i)), i);
  return toB64(out);
}

describe('the life key', () => {
  it("is sealed with the account's data key, and opens only with it, for that account", async () => {
    const dk = await newDataKey();
    const { sealed, keys } = await newLifeKey(dk, 'uid1');
    expect(sealed.iv).toMatch(/^[A-Za-z0-9+/]{16}$/);
    const again = await openLifeKey(dk, 'uid1', sealed);
    // The same key: what one seals, the other opens.
    const s = await sealPack(keys, 'uid1', 'mem', 'r1', 'hello');
    expect(await openPack(again, 'uid1', 'mem', 'r1', s.iv, s.parts)).toBe('hello');
    await expect(openLifeKey(await newDataKey(), 'uid1', sealed)).rejects.toMatchObject({ code: 'bad-data' });
    await expect(openLifeKey(dk, 'uid2', sealed)).rejects.toMatchObject({ code: 'bad-data' });
  });
});

describe('document ids', () => {
  it("are 43 characters whatever the pack, the same on every device, and don't say which month", async () => {
    const dk = await newDataKey();
    const { sealed, keys } = await newLifeKey(dk, 'uid1');
    const other = await openLifeKey(dk, 'uid1', sealed);
    const ids = await Promise.all(['e:2026-10', 'e:2026-11', 's:2026', 'mem'].map((p) => partId(keys, p, 0)));
    for (const id of ids) {
      expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(id).not.toMatch(/2026|mem/);
    }
    expect(new Set(ids).size).toBe(4);
    expect(await partId(other, 'e:2026-10', 0)).toBe(ids[0]); // another device, same account
    expect(await partId(keys, 'e:2026-10', 1)).not.toBe(ids[0]);
    // Another account's key gives other ids for the same month.
    const theirs = (await newLifeKey(await newDataKey(), 'uid2')).keys;
    expect(await partId(theirs, 'e:2026-10', 0)).not.toBe(ids[0]);
  });
});

describe('packs', () => {
  it('open only with the same account, pack and version', async () => {
    const { keys } = await newLifeKey(await newDataKey(), 'uid1');
    const rev = newRev();
    expect(rev).toMatch(/^[A-Za-z0-9_-]{1,40}$/);
    const s = await sealPack(keys, 'uid1', 'e:2026-10', rev, JSON.stringify({ secret: 'Searched "knee pain"' }));
    expect(s.parts.join('')).not.toContain('knee');
    expect(JSON.parse(await openPack(keys, 'uid1', 'e:2026-10', rev, s.iv, s.parts)).secret).toBe('Searched "knee pain"');
    for (const [uid, pack, r] of [
      ['uid2', 'e:2026-10', rev],
      ['uid1', 'e:2026-11', rev],
      ['uid1', 'e:2026-10', newRev()],
    ]) {
      await expect(openPack(keys, uid, pack, r, s.iv, s.parts)).rejects.toMatchObject({ code: 'bad-data' });
    }
    const idx = await sealIndex(keys, 'uid1', '{"v":1}');
    expect(await openIndex(keys, 'uid1', idx)).toBe('{"v":1}');
    await expect(openIndex(keys, 'uid2', idx)).rejects.toMatchObject({ code: 'bad-data' });
  });

  it('are compressed before sealing, so a month of everyday events stays small', async () => {
    const { keys } = await newLifeKey(await newDataKey(), 'uid1');
    const month = JSON.stringify(Array.from({ length: 3000 }, (_, i) => ({ id: `spotify:${i}`, source: 'spotify', kind: 'listen', at: 1760000000000 + i * 60000, title: `Listened to Daft Punk: One More Time (${i % 40})`, tier: 2, m: 1760000000000 })));
    const s = await sealPack(keys, 'uid1', 'e:2026-10', 'r1', month);
    expect(s.parts).toHaveLength(1);
    expect(s.parts[0].length).toBeLessThan(month.length / 4);
  });

  it("are cut into parts of at most 700,000 characters, and refused when there'd be too many", async () => {
    const { keys } = await newLifeKey(await newDataKey(), 'uid1');
    // Random text doesn't compress, so this needs two parts.
    const big = noise(800_000);
    const s = await sealPack(keys, 'uid1', 'e:2026-10', 'r1', big);
    expect(s.parts.length).toBe(2);
    for (const p of s.parts) {
      expect(p.length).toBeLessThanOrEqual(CHUNK);
      expect(p).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    }
    expect(await openPack(keys, 'uid1', 'e:2026-10', 'r1', s.iv, s.parts)).toBe(big);
    // Parts out of order don't open.
    await expect(openPack(keys, 'uid1', 'e:2026-10', 'r1', s.iv, [...s.parts].reverse())).rejects.toMatchObject({ code: 'bad-data' });
    // More parts than one write to the cloud can take (12; here 1, to keep the test quick).
    expect(MAX_PARTS).toBe(12);
    await expect(sealPack(keys, 'uid1', 'e:2026-10', 'r1', big, 1)).rejects.toMatchObject({ code: 'too-big' });
  });
});
