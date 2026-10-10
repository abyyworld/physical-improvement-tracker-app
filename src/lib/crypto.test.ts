import { describe, expect, it } from 'vitest';
import * as C from './crypto';

// Fewer rounds keep the tests quick; the real count is checked separately.
const FAST = 1000;

describe('master key', () => {
  it('gives the same Firebase password for the same password and id, whatever the case of the id', async () => {
    const a = await C.deriveMaster('correct horse', 'Me@Example.com', FAST);
    const b = await C.deriveMaster('correct horse', '  me@example.com ', FAST);
    expect(a.auth).toBe(b.auth);
    expect(a.auth).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('never hands Firebase the real password', async () => {
    const m = await C.deriveMaster('correct horse', 'me@example.com', FAST);
    expect(m.auth).not.toContain('correct');
  });

  it('changes with the password and with the id', async () => {
    const a = await C.deriveMaster('correct horse', 'me@example.com', FAST);
    const b = await C.deriveMaster('correct horsf', 'me@example.com', FAST);
    const c = await C.deriveMaster('correct horse', 'you@example.com', FAST);
    expect(new Set([a.auth, b.auth, c.auth]).size).toBe(3);
  });

  it('uses OWASP-level rounds by default', () => {
    expect(C.KDF_ITERATIONS).toBeGreaterThanOrEqual(600_000);
  });
});

describe('data key wrapping', () => {
  it('opens with the right password and refuses the wrong one', async () => {
    const dk = await C.newDataKey();
    const right = await C.deriveMaster('pw one', 'id', FAST);
    const wrong = await C.deriveMaster('pw two', 'id', FAST);
    const sealed = await C.wrapKey(dk, right.kek, 'uid1');
    const back = await C.unwrapKey(sealed, right.kek, 'uid1');
    const text = await C.seal(back, 'hello', 'x');
    expect(await C.open(dk, text, 'x')).toBe('hello');
    await expect(C.unwrapKey(sealed, wrong.kek, 'uid1')).rejects.toMatchObject({ code: 'wrong-key' });
  });

  it('is bound to its label, so a wrapped key from another account is refused', async () => {
    const dk = await C.newDataKey();
    const m = await C.deriveMaster('pw', 'id', FAST);
    const sealed = await C.wrapKey(dk, m.kek, 'uid1');
    await expect(C.unwrapKey(sealed, m.kek, 'uid2')).rejects.toMatchObject({ code: 'wrong-key' });
  });

  it('keeps the copy on the device unreadable', async () => {
    const dk = await C.newDataKey();
    const m = await C.deriveMaster('pw', 'id', FAST);
    const local = await C.unwrapKey(await C.wrapKey(dk, m.kek, 'u'), m.kek, 'u');
    expect(local.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', local)).rejects.toThrow();
  });
});

describe('recovery codes', () => {
  it('look like 8 groups of 4 and parse back to 20 bytes', () => {
    const code = C.newRecoveryCode();
    expect(code).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){7}[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(C.parseRecoveryCode(code)).toHaveLength(20);
  });

  it('forgive lower case, spaces, missing dashes and look-alike letters', async () => {
    const code = C.newRecoveryCode();
    const messy = code.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o').replace(/1/g, 'l');
    const dk = await C.newDataKey();
    const sealed = await C.wrapKey(dk, await C.recoveryKek(code), 'u');
    await expect(C.unwrapKey(sealed, await C.recoveryKek(messy), 'u')).resolves.toBeTruthy();
  });

  it('reject codes of the wrong length or with stray characters', () => {
    expect(() => C.parseRecoveryCode('ABCD-EFGH')).toThrow(C.CryptoError);
    expect(() => C.parseRecoveryCode(`${C.newRecoveryCode()}!`)).toThrow(C.CryptoError);
  });

  it('are different every time', () => {
    const codes = new Set(Array.from({ length: 50 }, C.newRecoveryCode));
    expect(codes.size).toBe(50);
  });
});

describe('account codes', () => {
  it('are recognised, and emails are not', () => {
    const code = C.newAccountCode();
    expect(code).toMatch(/^ARISE(-[0-9A-HJKMNP-TV-Z]{4}){4}$/);
    expect(C.isAccountCode(code)).toBe(true);
    expect(C.isAccountCode(code.toLowerCase())).toBe(true);
    expect(C.isAccountCode('me@example.com')).toBe(false);
  });
});

describe('sealing data', () => {
  it('round-trips text, including emoji and a large journal', async () => {
    const dk = await C.newDataKey();
    const big = JSON.stringify({ logs: Array.from({ length: 2000 }, (_, i) => ({ d: i, t: 'Felt strong today 💪 '.repeat(5) })) });
    const sealed = await C.seal(dk, big, 'uid/rev1');
    expect(await C.open(dk, sealed, 'uid/rev1')).toBe(big);
    // Compressed before encryption, so a repetitive journal takes far less room.
    expect(sealed.ct.length).toBeLessThan(big.length / 4);
  });

  it('gives different ciphertext for the same text', async () => {
    const dk = await C.newDataKey();
    const a = await C.seal(dk, 'same', 'a');
    const b = await C.seal(dk, 'same', 'a');
    expect(a.ct).not.toBe(b.ct);
    expect(a.iv).not.toBe(b.iv);
  });

  it('refuses tampered ciphertext or the wrong place', async () => {
    const dk = await C.newDataKey();
    const sealed = await C.seal(dk, 'secret', 'uid/rev1');
    const bytes = C.fromB64(sealed.ct);
    bytes[0] ^= 1;
    await expect(C.open(dk, { iv: sealed.iv, ct: C.toB64(bytes) }, 'uid/rev1')).rejects.toMatchObject({ code: 'bad-data' });
    await expect(C.open(dk, sealed, 'uid/rev2')).rejects.toMatchObject({ code: 'bad-data' });
  });

  it('never contains the plain text', async () => {
    const dk = await C.newDataKey();
    const sealed = await C.seal(dk, 'my weight is 80kg', 'a');
    expect(atob(sealed.ct)).not.toContain('weight');
  });

  it('works on browsers without CompressionStream (Safari before 16.4), both ways', async () => {
    const dk = await C.newDataKey();
    const text = 'Felt strong today 💪 '.repeat(200);
    const modern = await C.seal(dk, text, 'a');
    const g = globalThis as { CompressionStream?: unknown; DecompressionStream?: unknown };
    const saved = [g.CompressionStream, g.DecompressionStream];
    delete g.CompressionStream;
    delete g.DecompressionStream;
    try {
      expect(await C.open(dk, modern, 'a')).toBe(text);
      const old = await C.seal(dk, text, 'a');
      expect(old.ct.length).toBeLessThan(text.length / 4);
      [g.CompressionStream, g.DecompressionStream] = saved;
      expect(await C.open(dk, old, 'a')).toBe(text);
    } finally {
      [g.CompressionStream, g.DecompressionStream] = saved;
    }
  });
});

describe('share link keys', () => {
  it('are 256 random bits in base64url, different every time', async () => {
    const keys = await Promise.all(Array.from({ length: 20 }, C.newLinkKey));
    for (const k of keys) {
      expect(k).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(C.fromB64url(k)).toHaveLength(32);
    }
    expect(new Set(keys).size).toBe(20);
  });

  it('round-trip a snapshot, bound to its share: a copy put in place of another share is refused', async () => {
    const text = JSON.stringify({ title: 'Run a half marathon', streak: 12 });
    const key = await C.linkKey(await C.newLinkKey());
    const sealed = await C.seal(key, text, 'share/AAAAAAAAAAAAAAAAAAAAAA');
    expect(await C.open(key, sealed, 'share/AAAAAAAAAAAAAAAAAAAAAA')).toBe(text);
    expect(atob(sealed.ct)).not.toContain('marathon');
    await expect(C.open(key, sealed, 'share/BBBBBBBBBBBBBBBBBBBBBB')).rejects.toMatchObject({ code: 'bad-data' });
    await expect(C.open(await C.linkKey(await C.newLinkKey()), sealed, 'share/AAAAAAAAAAAAAAAAAAAAAA')).rejects.toMatchObject({ code: 'bad-data' });
  });

  it('can only be used once imported, never read back out', async () => {
    const key = await C.linkKey(await C.newLinkKey());
    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow();
  });

  it('refuse a key cut short or with stray characters', async () => {
    const k = await C.newLinkKey();
    await expect(C.linkKey(k.slice(0, 40))).rejects.toMatchObject({ code: 'bad-data' });
    await expect(C.linkKey(`${k.slice(0, 42)}!`)).rejects.toMatchObject({ code: 'bad-data' });
    await expect(C.linkKey('')).rejects.toMatchObject({ code: 'bad-data' });
  });

  it('base64url round-trips any bytes', () => {
    for (let n = 0; n < 40; n++) {
      const bytes = C.randomBytes(n);
      const s = C.toB64url(bytes);
      expect(s).toMatch(/^[A-Za-z0-9_-]*$/);
      expect(C.fromB64url(s)).toEqual(bytes);
    }
  });
});

describe('base64', () => {
  it('round-trips bytes larger than one chunk', () => {
    const bytes = new Uint8Array(100_000).map((_, i) => (i * 7919) % 256);
    expect(C.fromB64(C.toB64(bytes))).toEqual(bytes);
  });
});
