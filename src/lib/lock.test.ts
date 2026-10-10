// @vitest-environment jsdom
// The app lock's passcode, its wait after wrong tries, Face ID's answer, and that the lock stays
// on this device: never in a backup or the saved data.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as L from './lock';

const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const saved = () => JSON.parse(localStorage.getItem(L.KEY) || 'null');

beforeEach(() => {
  localStorage.clear();
  // The page's own clock (performance.now) moves with time going by, not with the device's clock.
  vi.useFakeTimers({ toFake: ['Date', 'performance'] });
  vi.setSystemTime(new Date(2026, 9, 10, 12));
});
afterEach(() => vi.useRealTimers());
const wait = (ms: number) => vi.advanceTimersByTime(ms);

describe('the passcode', () => {
  it('keeps a slow salted hash, never the passcode', async () => {
    await L.turnOn('482916', { away: 5 });
    const l = saved();
    expect(Object.keys(l).sort()).toEqual(['away', 'bio', 'digits', 'fails', 'hash', 'iter', 'rp', 'salt', 'until']);
    expect(JSON.stringify(l)).not.toContain('482916');
    expect(l).toMatchObject({ iter: 310_000, digits: 6, away: 5, bio: '', fails: 0, until: 0 });
    expect(l.salt).toMatch(/^[\w-]{22}$/);
    expect(l.hash).toMatch(/^[\w-]{43}$/);
    // The same passcode again gets another salt, so another hash.
    await L.turnOn('482916');
    expect(saved().salt).not.toBe(l.salt);
    expect(saved().hash).not.toBe(l.hash);
  });

  it('hashes with PBKDF2: the same salt gives the same hash, another salt another', async () => {
    const salt = new Uint8Array(16).fill(7);
    const a = await L.hashPasscode('1234', salt, 1000);
    expect(await L.hashPasscode('1234', salt, 1000)).toBe(a);
    expect(await L.hashPasscode('1235', salt, 1000)).not.toBe(a);
    expect(await L.hashPasscode('1234', new Uint8Array(16).fill(8), 1000)).not.toBe(a);
  });

  it('opens with the right passcode only', async () => {
    await L.turnOn('1234');
    expect(await L.check('1235')).toBe('wrong');
    expect(await L.check('12345')).toBe('wrong');
    expect(await L.check('12a4')).toBe('wrong');
    expect(await L.check('1234')).toBe('ok');
    expect(saved().fails).toBe(0);
  });

  it('takes 4 to 8 digits', async () => {
    expect(['123', '123456789', '12 34', 'abcd', ''].some(L.validPasscode)).toBe(false);
    expect(['1234', '12345678', '0000'].every(L.validPasscode)).toBe(true);
    await expect(L.turnOn('123')).rejects.toThrow(/4 to 8 digits/);
    expect(L.isOn()).toBe(false);
  });

  it('is off when what is saved is not a lock', () => {
    for (const v of ['nope', '{}', '{"salt":"x"}', '{"salt":"a b","hash":"c"}']) {
      localStorage.setItem(L.KEY, v);
      expect(L.read()).toBe(null);
    }
  });
});

describe('wrong passcodes', () => {
  it('waits 30 seconds after 5 wrong ones, then twice as long after each one more', async () => {
    expect([0, 4, 5, 6, 7, 30].map(L.waitFor)).toEqual([0, 0, 30_000, 60_000, 120_000, 3_600_000]);
    await L.turnOn('1234');
    for (let i = 0; i < 4; i++) expect(await L.check('0000')).toBe('wrong');
    expect(L.waitLeft()).toBe(0);
    expect(await L.check('0000')).toBe('wrong');
    expect(L.waitLeft()).toBe(30_000);
    // Meanwhile not even the right passcode is checked, and nothing is counted.
    expect(await L.check('1234')).toBe('wait');
    expect(saved().fails).toBe(5);

    wait(29_000);
    expect(L.waitLeft()).toBe(1000);
    wait(1000);
    expect(await L.check('9999')).toBe('wrong');
    expect(L.waitLeft()).toBe(60_000);

    wait(60_000);
    expect(await L.check('1234')).toBe('ok');
    expect(saved()).toMatchObject({ fails: 0, until: 0 });
    expect(await L.check('0000')).toBe('wrong');
    expect(L.waitLeft()).toBe(0); // counting starts again
  });

  it('still waits after the app is opened again', async () => {
    await L.turnOn('1234');
    for (let i = 0; i < 5; i++) await L.check('0000');
    vi.resetModules();
    const again = await import('./lock');
    expect(again.waitLeft()).toBe(30_000);
    expect(await again.check('1234')).toBe('wait');
  });

  it("doesn't wait longer when the clock is turned back", async () => {
    await L.turnOn('1234');
    for (let i = 0; i < 5; i++) await L.check('0000');
    vi.setSystemTime(Date.now() - 24 * 3600_000);
    expect(L.waitLeft()).toBe(30_000);
  });

  it("doesn't end the wait when the clock is moved forward, even with a restart", async () => {
    await L.turnOn('1234');
    for (let i = 0; i < 5; i++) await L.check('0000');
    wait(10_000);
    vi.setSystemTime(Date.now() + 3600_000);
    expect(L.waitLeft()).toBe(20_000);
    expect(await L.check('1234')).toBe('wait');

    // Opened again after that: the whole wait, on the new page's own clock.
    vi.resetModules();
    const again = await import('./lock');
    expect(again.waitLeft()).toBe(30_000);
    wait(30_000);
    expect(again.waitLeft()).toBe(0);
    expect(await again.check('1234')).toBe('ok');
  });

  it("keeps counting at 1000 wrong tries, so the wait doesn't start over", async () => {
    await L.turnOn('1234');
    L.update({ fails: 1000, until: Date.now() + 3600_000 });
    expect(L.read()!.fails).toBe(1000);
    expect(L.waitLeft()).toBe(3600_000);
    wait(3600_000);
    expect(await L.check('0000')).toBe('wrong');
    expect(saved().fails).toBe(1000);
    expect(L.waitLeft()).toBe(3600_000);
    L.update({ fails: 5000 });
    expect(L.read()!.fails).toBe(1000);
  });

  it('checks one passcode at a time, so more tabs at once get no more tries', async () => {
    const queue = new Map<string, Promise<unknown>>();
    const locks = {
      request: (name: string, fn: () => Promise<unknown>) => {
        const p = (queue.get(name) ?? Promise.resolve()).then(fn);
        queue.set(name, p.catch(() => {}));
        return p;
      },
    };
    Object.defineProperty(navigator, 'locks', { configurable: true, value: locks });
    try {
      await L.turnOn('1234');
      for (let i = 0; i < 4; i++) await L.check('0000');
      expect(await Promise.all(['0000', '1111', '2222', '1234'].map((p) => L.check(p)))).toEqual(['wrong', 'wait', 'wait', 'wait']);
      expect(saved().fails).toBe(5);
    } finally {
      delete (navigator as { locks?: unknown }).locks;
    }
  });
});

describe('time away', () => {
  it('asks again after the chosen minutes', () => {
    const t = Date.now();
    expect(L.awayTooLong(t, t + 1, 0)).toBe(true);
    expect(L.awayTooLong(t, t + 59_000, 1)).toBe(false);
    expect(L.awayTooLong(t, t + 60_000, 1)).toBe(true);
    expect(L.awayTooLong(t, t + 14 * 60_000, 15)).toBe(false);
    expect(L.awayTooLong(t, t + 15 * 60_000, 15)).toBe(true);
    expect(L.AWAY).toEqual([0, 1, 5, 15]);
  });
});

describe('Face ID / Touch ID', () => {
  const id = b64u(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
  // A device that answers with these flags (0x01: present, 0x04: verified) for this credential.
  function device(flags: number, { rawId = id, challenge }: { rawId?: string; challenge?: string } = {}) {
    const get = vi.fn(async ({ publicKey }: { publicKey: PublicKeyCredentialRequestOptions }) => {
      const data = new Uint8Array(37);
      data[32] = flags;
      const client = { type: 'webauthn.get', challenge: challenge ?? b64u(new Uint8Array(publicKey.challenge as ArrayBuffer)), origin: location.origin };
      return {
        rawId: Uint8Array.from(atob(rawId.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)).buffer,
        response: { clientDataJSON: new TextEncoder().encode(JSON.stringify(client)).buffer, authenticatorData: data.buffer },
      };
    });
    Object.defineProperty(navigator, 'credentials', { value: { get }, configurable: true });
    return get;
  }

  it('unlocks only when the device verified the person, for this credential and this request', async () => {
    const get = device(0x05);
    expect(await L.bioVerify(id)).toBe(true);
    const asked = get.mock.calls[0][0].publicKey;
    expect(asked).toMatchObject({ userVerification: 'required', rpId: location.hostname });
    expect((asked.challenge as Uint8Array).length).toBe(32);

    device(0x01);
    expect(await L.bioVerify(id)).toBe(false); // present, not verified
    device(0x05, { rawId: b64u(new Uint8Array([9, 9])) });
    expect(await L.bioVerify(id)).toBe(false); // another credential
    device(0x05, { challenge: 'old' });
    expect(await L.bioVerify(id)).toBe(false); // an old answer
    Object.defineProperty(navigator, 'credentials', { value: { get: () => Promise.reject(new DOMException('', 'NotAllowedError')) }, configurable: true });
    expect(await L.bioVerify(id)).toBe(false); // cancelled
  });

  it('is only offered for the site it was set up on', async () => {
    await L.turnOn('1234', { bio: id });
    expect(L.bioUsable(L.read())).toBe(true);
    L.update({ rp: 'elsewhere.example' });
    expect(L.bioUsable(L.read())).toBe(false);
  });

  it('is not there without a platform authenticator', async () => {
    expect(await L.bioAvailable()).toBe(false); // jsdom has no PublicKeyCredential
  });
});

describe('this device only', () => {
  async function store() {
    vi.resetModules();
    return import('../store');
  }

  it('is not in a backup', async () => {
    await L.turnOn('1234', { bio: 'abc' });
    const S = await store();
    const backup = JSON.stringify(S.exportData());
    expect(backup).not.toContain(saved().hash);
    expect(backup).not.toContain(saved().salt);
    expect(backup).not.toMatch(/lock/i);
  });

  it("can't be brought in or turned off by a backup or synced data", async () => {
    await L.turnOn('1234');
    const before = localStorage.getItem(L.KEY);
    const S = await store();
    const other = { salt: 'AAAA', hash: 'BBBB', iter: 310_000, digits: 4, away: 0, bio: '', rp: '', fails: 0, until: 0 };
    S.importData({ sessions: [], lock: other, 'arise-lock': other, settings: { lock: other, appLock: true } });
    S.adoptState({ sessions: [], lock: null, settings: { appLock: false } });
    expect(localStorage.getItem(L.KEY)).toBe(before);
    expect(JSON.stringify(S.state)).not.toMatch(/lock/i);
    expect(JSON.stringify(S.clean({ lock: other, settings: { lock: other } }))).not.toMatch(/lock/i);
  });

  it('is kept apart from the saved data: erasing the data leaves it, turnOff removes it', async () => {
    await L.turnOn('1234');
    const S = await store();
    S.resetAll();
    expect(L.isOn()).toBe(true); // the app turns it off itself when it erases (see app.js)
    L.turnOff();
    expect(localStorage.getItem(L.KEY)).toBe(null);
  });
});
