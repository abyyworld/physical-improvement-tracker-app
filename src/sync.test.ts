// @vitest-environment jsdom
// Accounts and sync end to end: several simulated devices (each its own copy of the app's
// modules and its own storage) sharing one in-memory cloud that enforces the database rules.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cloud, resetCloud } from './test/fake-firebase';

vi.mock('./lib/firebase', () => import('./test/fake-firebase'));
// Fewer key-stretching rounds, so the tests run in seconds. The real count is tested in crypto.test.ts.
vi.mock('./lib/crypto', async (orig) => {
  const real = await orig<typeof import('./lib/crypto')>();
  return { ...real, deriveMaster: (p: string, id: string) => real.deriveMaster(p, id, 1000) };
});

type Store = typeof import('./store');
type Sync = typeof import('./sync');
interface Device {
  S: Store;
  SYNC: Sync;
  name: string;
}

const storage = new Map<string, Map<string, string>>();
let current = '';

// Swap localStorage to this device's, and load a fresh copy of the app's modules for it.
function use(name: string) {
  if (current) storage.set(current, new Map(Object.entries({ ...localStorage })));
  localStorage.clear();
  for (const [k, v] of storage.get(name) || []) localStorage.setItem(k, v);
  current = name;
}

async function device(name: string): Promise<Device> {
  use(name);
  vi.resetModules();
  const S = await import('./store');
  const SYNC = await import('./sync');
  await SYNC.initSync({ render: () => {}, changed: () => {}, checkForUpdate: () => {} });
  return { S, SYNC, name };
}

async function on<T>(d: Device, fn: () => Promise<T> | T): Promise<T> {
  use(d.name);
  return fn();
}

const PW = 'correct horse battery';
const session = (id: string, date = '2026-10-01') => ({ id, workout: 'a', date, started: 1, finished: 2, easy: false, items: [{ ex: 'band_row', setup: '', sets: [{ r: 10, done: true }] }] });
const cloudText = () => JSON.stringify([...cloud.docs.values()]);

beforeEach(() => {
  resetCloud();
  storage.clear();
  current = '';
  localStorage.clear();
  document.body.innerHTML = '<div id="sheet" hidden><div class="sheet-panel"><button class="sheet-close"></button><div class="sheet-body"></div></div></div><div id="toast"></div><main id="app"></main><nav id="tabs"></nav>';
});

describe('a new account', () => {
  it('backs up the data end-to-end encrypted, with keys and a recovery record', async () => {
    const a = await device('phone');
    a.S.importData({ sessions: [session('s1')], logs: { '2026-10-01': { t: 'my secret journal entry', at: 1 } } });
    await a.SYNC.submit('up', { email: 'Me@Example.com', password: PW, password2: PW });
    expect(a.SYNC.status.error).toBe('');
    expect(a.SYNC.status.user?.id).toBe('me@example.com');
    expect(a.SYNC.status.pending?.recoveryCode).toMatch(/^([0-9A-Z]{4}-){7}[0-9A-Z]{4}$/);
    const paths = [...cloud.docs.keys()].sort();
    expect(paths).toEqual(['recovery/me@example.com', 'users/uid1/arise/keys', 'users/uid1/arise/meta', 'users/uid1/arise/part0']);
    // Nothing readable in the cloud: not the journal, not the exercise names, not the password.
    expect(cloudText()).not.toContain('secret journal');
    expect(cloudText()).not.toContain('band_row');
    expect(cloudText()).not.toContain(PW);
    expect(cloud.users.get('uid1')!.password).not.toContain('horse');
  });

  it('refuses a short password and mismatched passwords', async () => {
    const a = await device('phone');
    await a.SYNC.submit('up', { email: 'me@example.com', password: 'short', password2: 'short' });
    expect(a.SYNC.status.error).toMatch(/at least 10/);
    await a.SYNC.submit('up', { email: 'me@example.com', password: PW, password2: `${PW}x` });
    expect(a.SYNC.status.error).toMatch(/don't match/);
    expect(cloud.users.size).toBe(0);
  });
});

describe('a second device', () => {
  it('gets the data after signing in with the password, and not with a wrong one', async () => {
    const a = await device('phone');
    a.S.importData({ sessions: [session('s1')] });
    await a.SYNC.submit('up', { email: 'me@example.com', password: PW, password2: PW });

    const b = await device('laptop');
    await b.SYNC.submit('in', { id: 'me@example.com', password: 'wrong password!' });
    expect(b.SYNC.status.error).toMatch(/Wrong email/);
    expect(b.S.state.sessions).toEqual([]);
    await b.SYNC.submit('in', { id: 'ME@example.com', password: PW });
    expect(b.SYNC.status.error).toBe('');
    expect(b.S.state.sessions.map((s) => s.id)).toEqual(['s1']);
  });

  it('works with a no-email account code', async () => {
    const a = await device('phone');
    a.S.importData({ sessions: [session('s1')] });
    a.SYNC.status.noEmail = true;
    await a.SYNC.submit('up', { password: PW, password2: PW });
    const code = a.SYNC.status.pending!.accountCode!;
    expect(code).toMatch(/^ARISE(-[0-9A-Z]{4}){4}$/);
    expect([...cloud.users.values()][0].email).toBe(`${code.toLowerCase()}@code.arise.invalid`);

    const b = await device('laptop');
    await b.SYNC.submit('in', { id: code.toLowerCase(), password: PW });
    expect(b.SYNC.status.error).toBe('');
    expect(b.S.state.sessions.map((s) => s.id)).toEqual(['s1']);
  });
});

describe('two devices editing', () => {
  async function pair() {
    const a = await device('phone');
    a.S.importData({ sessions: [session('s1'), session('s2', '2026-10-02')] });
    await a.SYNC.submit('up', { email: 'me@example.com', password: PW, password2: PW });
    const b = await device('laptop');
    await b.SYNC.submit('in', { id: 'me@example.com', password: PW });
    return { a, b };
  }

  it("doesn't bring back a workout deleted on one device while the other changed something", async () => {
    const { a, b } = await pair();
    await on(a, async () => {
      a.S.deleteSession('s2');
      await a.SYNC.syncNow();
    });
    await on(b, async () => {
      b.S.toggleFootball('2026-10-05');
      await b.SYNC.syncNow();
      expect(b.S.state.sessions.map((s) => s.id)).toEqual(['s1']);
      expect(b.S.state.football).toEqual(['2026-10-05']);
    });
    await on(a, async () => {
      await a.SYNC.syncNow();
      expect(a.S.state.sessions.map((s) => s.id)).toEqual(['s1']);
      expect(a.S.state.football).toEqual(['2026-10-05']);
    });
  });

  it("keeps an edit made while the cloud copy was downloading (the audit's lost-edit race)", async () => {
    const { a, b } = await pair();
    await on(b, async () => {
      b.S.toggleFootball('2026-10-06');
      await b.SYNC.syncNow();
    });
    await on(a, async () => {
      cloud.hook = (op, path) => {
        if (op === 'getDoc' && path.endsWith('/part0')) {
          cloud.hook = null;
          a.S.setLog('2026-10-07', { t: 'typed during the download' });
        }
      };
      await a.SYNC.syncNow();
      expect(a.S.state.logs['2026-10-07']?.t).toBe('typed during the download');
      expect(a.S.state.football).toEqual(['2026-10-06']);
      await a.SYNC.syncNow(); // sends the edit up
    });
    await on(b, async () => {
      await b.SYNC.syncNow();
      expect(b.S.state.logs['2026-10-07']?.t).toBe('typed during the download');
    });
  });

  it('keeps device-only settings (AI service, notifications) on each device', async () => {
    const { a, b } = await pair();
    await on(a, async () => {
      a.S.state.settings.aiProvider = 'custom';
      a.S.state.settings.aiBase = 'https://evil.example/v1';
      a.S.state.settings.restBig = 90;
      a.S.save();
      await a.SYNC.syncNow();
    });
    await on(b, async () => {
      await b.SYNC.syncNow();
      expect(b.S.state.settings.restBig).toBe(90);
      expect(b.S.state.settings.aiProvider).toBe('');
      expect(b.S.state.settings.aiBase).toBe('');
    });
  });
});

describe('forgotten password', () => {
  it('sets a new password with the recovery code, and the data is still there', async () => {
    const a = await device('phone');
    a.S.importData({ sessions: [session('s1')] });
    await a.SYNC.submit('up', { email: 'me@example.com', password: PW, password2: PW });
    const code = a.SYNC.status.pending!.recoveryCode;

    const b = await device('new-phone');
    await b.SYNC.submit('recover', { id: 'me@example.com', code: 'AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA', password: 'a brand new password', password2: 'a brand new password' });
    expect(b.SYNC.status.error).toMatch(/recovery code isn't the right one/);
    await b.SYNC.submit('recover', { id: 'me@example.com', code: code.toLowerCase(), password: 'a brand new password', password2: 'a brand new password' });
    expect(b.SYNC.status.error).toBe('');
    expect(b.S.state.sessions.map((s) => s.id)).toEqual(['s1']);

    const c = await device('laptop');
    await c.SYNC.submit('in', { id: 'me@example.com', password: PW });
    expect(c.SYNC.status.error).toMatch(/Wrong email/);
    await c.SYNC.submit('in', { id: 'me@example.com', password: 'a brand new password' });
    expect(c.SYNC.status.error).toBe('');
    expect(c.S.state.sessions.map((s) => s.id)).toEqual(['s1']);
  });
});

describe('an account from before encryption', () => {
  it('is upgraded on sign-in: the plain cloud copy is encrypted and merged', async () => {
    // What the old app left behind: the plain password at Firebase and plain JSON in Firestore.
    cloud.users.set('uid9', { uid: 'uid9', email: 'old@example.com', password: 'oldpass' });
    cloud.docs.set('users/uid9/arise/meta', { rev: 'r1', parts: 1, updatedAt: 5, savedAt: 5, app: 1 });
    cloud.docs.set('users/uid9/arise/part0', { rev: 'r1', text: JSON.stringify({ sessions: [session('old1')], logs: { '2026-09-01': { t: 'old plain entry', at: 1 } } }) });

    const a = await device('phone');
    a.S.importData({ sessions: [session('new1', '2026-10-03')] });
    await a.SYNC.submit('in', { id: 'old@example.com', password: 'oldpass' });
    expect(a.SYNC.status.error).toBe('');
    expect(a.SYNC.status.pending?.recoveryCode).toBeTruthy();
    expect(a.S.state.sessions.map((s) => s.id).sort()).toEqual(['new1', 'old1']);
    expect(cloudText()).not.toContain('old plain entry');
    expect(cloud.docs.get('users/uid9/arise/meta')).toMatchObject({ enc: 1 });
    // Firebase now holds the derived password, not the plain one.
    expect(cloud.users.get('uid9')!.password).not.toBe('oldpass');

    const b = await device('laptop');
    await b.SYNC.submit('in', { id: 'old@example.com', password: 'oldpass' });
    expect(b.SYNC.status.error).toBe('');
    expect(b.S.state.logs['2026-09-01']?.t).toBe('old plain entry');
  });

  it('asks a device that was already signed in for the password once, then syncs', async () => {
    cloud.users.set('uid9', { uid: 'uid9', email: 'old@example.com', password: 'oldpass' });
    use('phone');
    localStorage.setItem('arise-sync', JSON.stringify({ uid: 'uid9', email: 'old@example.com', rev: 'x', hash: 'x' }));
    vi.resetModules();
    const fake = await import('./lib/firebase');
    const S = await import('./store');
    const SYNC = await import('./sync');
    // Firebase kept the old session; this device has no key yet.
    const A = await import('./account');
    await A.load(() => {});
    (fake as unknown as typeof import('./test/fake-firebase')).restoreSession('uid9');
    await SYNC.initSync({ render: () => {}, changed: () => {}, checkForUpdate: () => {} });
    expect(SYNC.status.locked).toBe(true);
    S.importData({ sessions: [session('s1')] });
    await SYNC.submit('unlock', { password: 'oldpass' });
    expect(SYNC.status.error).toBe('');
    expect(SYNC.status.locked).toBe(false);
    expect(cloud.docs.get('users/uid9/arise/meta')).toMatchObject({ enc: 1 });
  });
});

describe('leaving', () => {
  it('"Erase all data" signs out and clears this device, but keeps the cloud copy for other devices', async () => {
    const a = await device('phone');
    a.S.importData({ sessions: [session('s1')] });
    await a.SYNC.submit('up', { email: 'me@example.com', password: PW, password2: PW });
    const before = cloudText();
    await on(a, async () => {
      await a.SYNC.eraseThisDevice();
      expect(a.S.state.sessions).toEqual([]);
      expect(a.SYNC.status.user).toBeNull();
    });
    expect(cloudText()).toBe(before);
    const b = await device('laptop');
    await b.SYNC.submit('in', { id: 'me@example.com', password: PW });
    expect(b.S.state.sessions.map((s) => s.id)).toEqual(['s1']);
  });

  it('deleting the account removes everything in the cloud and never uploads again', async () => {
    const a = await device('phone');
    a.S.importData({ sessions: [session('s1')] });
    await a.SYNC.submit('up', { email: 'me@example.com', password: PW, password2: PW });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await a.SYNC.submit('delete', { password: 'not it at all' });
    expect(a.SYNC.status.error).toMatch(/password isn't right/);
    expect(cloud.docs.size).toBe(4);
    await a.SYNC.submit('delete', { password: PW });
    confirmSpy.mockRestore();
    expect(a.SYNC.status.error).toBe('');
    expect(cloud.docs.size).toBe(0);
    expect(cloud.users.size).toBe(0);
    a.S.toggleFootball('2026-10-09');
    await a.SYNC.syncNow();
    expect(cloud.docs.size).toBe(0);
    expect(a.S.state.sessions.map((s) => s.id)).toEqual(['s1']); // this device keeps its data
  });
});

describe('changing the password', () => {
  it('works on other devices with the new password and gives a new recovery code', async () => {
    const a = await device('phone');
    a.S.importData({ sessions: [session('s1')] });
    await a.SYNC.submit('up', { email: 'me@example.com', password: PW, password2: PW });
    const firstCode = a.SYNC.status.pending!.recoveryCode;
    await a.SYNC.submit('password', { old: PW, password: 'another long password', password2: 'another long password' });
    expect(a.SYNC.status.error).toBe('');
    expect(a.SYNC.status.pending!.recoveryCode).not.toBe(firstCode);
    const b = await device('laptop');
    await b.SYNC.submit('in', { id: 'me@example.com', password: 'another long password' });
    expect(b.SYNC.status.error).toBe('');
    expect(b.S.state.sessions.map((s) => s.id)).toEqual(['s1']);
  });
});

describe('versions', () => {
  it("won't touch data saved by a newer version of the app", async () => {
    const a = await device('phone');
    a.S.importData({ sessions: [session('s1')] });
    await a.SYNC.submit('up', { email: 'me@example.com', password: PW, password2: PW });
    const meta = cloud.docs.get('users/uid1/arise/meta')!;
    cloud.docs.set('users/uid1/arise/meta', { ...meta, schema: 99 });
    a.S.toggleFootball('2026-10-09');
    await a.SYNC.syncNow();
    expect(a.SYNC.status.error).toMatch(/newer version/);
    expect(cloud.docs.get('users/uid1/arise/meta')).toMatchObject({ schema: 99, rev: meta.rev });
  });
});
