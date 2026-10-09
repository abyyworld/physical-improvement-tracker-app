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
      a.S.state.settings.dayOff = false; // the account's, so streaks read the same everywhere
      a.S.save();
      await a.SYNC.syncNow();
    });
    await on(b, async () => {
      await b.SYNC.syncNow();
      expect(b.S.state.settings.restBig).toBe(90);
      expect(b.S.state.settings.dayOff).toBe(false);
      expect(b.S.state.settings.aiProvider).toBe('');
      expect(b.S.state.settings.aiBase).toBe('');
    });
  });
});

describe('goals on two devices', () => {
  it('keeps goals and ticks from both devices', async () => {
    const a = await device('phone');
    a.S.saveGoal({ id: 'g1', title: 'Learn Spanish', category: 'learning', quests: [{ id: 'q1', title: 'Study', schedule: { kind: 'daily' }, created: '2026-10-01' }, { id: 'q2', title: 'Flashcards', schedule: { kind: 'daily' }, created: '2026-10-01' }] });
    await a.SYNC.submit('up', { email: 'me@example.com', password: PW, password2: PW });
    const b = await device('laptop');
    await b.SYNC.submit('in', { id: 'me@example.com', password: PW });
    expect(b.S.state.goals.map((g) => g.title)).toEqual(['Learn Spanish']);
    await on(a, async () => {
      a.S.tick('q1', { done: true }, '2026-10-08');
      await a.SYNC.syncNow();
    });
    await on(b, async () => {
      b.S.tick('q2', { done: true }, '2026-10-08');
      b.S.saveGoal({ id: 'g2', title: 'Save $10,000', category: 'money' });
      await b.SYNC.syncNow();
      expect(Object.keys(b.S.state.checks['2026-10-08']).sort()).toEqual(['q1', 'q2']);
    });
    await on(a, async () => {
      await a.SYNC.syncNow();
      expect(Object.keys(a.S.state.checks['2026-10-08']).sort()).toEqual(['q1', 'q2']);
      expect(a.S.state.goals.map((g) => g.title)).toEqual(['Learn Spanish', 'Save $10,000']);
    });
    expect(cloudText()).not.toContain('Spanish');
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
    // The typed password only goes to Firebase once the Player says the account is from before 2.0.
    await a.SYNC.submit('in', { id: 'old@example.com', password: 'oldpass' });
    expect(a.SYNC.status.error).toMatch(/Wrong email/);
    expect(a.SYNC.status.offerLegacy).toBe(true);
    expect(a.SYNC.panel()).toContain('name="legacy"');
    await a.SYNC.submit('in', { id: 'old@example.com', password: 'oldpass', legacy: '1' });
    expect(a.SYNC.status.error).toBe('');
    expect(a.SYNC.status.pending?.recoveryCode).toBeTruthy();
    expect(a.S.state.sessions.map((s) => s.id).sort()).toEqual(['new1', 'old1']);
    expect(cloudText()).not.toContain('old plain entry');
    expect(cloud.docs.get('users/uid9/arise/meta')).toMatchObject({ enc: 1 });
    // Firebase now holds the derived password, not the plain one.
    expect(cloud.users.get('uid9')!.password).not.toBe('oldpass');

    const b = await device('laptop');
    await b.SYNC.submit('in', { id: 'old@example.com', password: 'oldpass' }); // encrypted now: the usual way works
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

  it('marks copies with the weekly day off as newer than 2.1, which would drop the setting', async () => {
    const a = await device('phone');
    a.S.importData({ sessions: [session('s1')], settings: { dayOff: false } });
    await a.SYNC.submit('up', { email: 'me@example.com', password: PW, password2: PW });
    // Arise 2.1 (schema 1) keeps only the settings it knows, so it must not take this copy in.
    expect(cloud.docs.get('users/uid1/arise/meta')!.schema).toBeGreaterThan(1);
  });

  // Sync info left by an older version: its fingerprint was taken of data shaped differently
  // (before dayOff was synced), so it can't match now even where nothing changed.
  const updated = () => {
    const { schema: _s, ...m } = JSON.parse(localStorage.getItem('arise-sync')!);
    localStorage.setItem('arise-sync', JSON.stringify({ ...m, hash: 'f00d', seenHash: 'f00d' }));
  };

  it("doesn't send a device's old settings over newer ones on its first sync after an update", async () => {
    const a = await device('phone');
    a.S.importData({ sessions: [session('s1')] });
    await a.SYNC.submit('up', { email: 'me@example.com', password: PW, password2: PW });
    const b = await device('tablet');
    await b.SYNC.submit('in', { id: 'me@example.com', password: PW });
    await on(b, updated);
    await on(a, async () => {
      a.S.state.settings.dayOff = false;
      a.S.state.settings.restBig = 90;
      a.S.save();
      await a.SYNC.syncNow();
    });
    await on(b, async () => {
      await b.SYNC.syncNow();
      expect(b.S.state.settings).toMatchObject({ dayOff: false, restBig: 90 });
    });
    await on(a, async () => {
      await a.SYNC.syncNow();
      expect(a.S.state.settings).toMatchObject({ dayOff: false, restBig: 90 });
    });
  });

  it('still sends changes made before the update, and knows when nothing changed', async () => {
    const a = await device('phone');
    a.S.importData({ sessions: [session('s1')] });
    await a.SYNC.submit('up', { email: 'me@example.com', password: PW, password2: PW });
    updated();
    const rev = cloud.docs.get('users/uid1/arise/meta')!.rev;
    await a.SYNC.syncNow();
    expect(cloud.docs.get('users/uid1/arise/meta')!.rev).toBe(rev); // nothing to send
    const ask = vi.spyOn(window, 'confirm').mockReturnValue(false);
    expect(await a.SYNC.eraseThisDevice()).toBe(true); // and nothing that hasn't reached the cloud
    expect(ask).not.toHaveBeenCalled();
    ask.mockRestore();

    const b = await device('laptop');
    await b.SYNC.submit('in', { id: 'me@example.com', password: PW });
    await new Promise((r) => setTimeout(r, 5)); // so the change below is after that sync
    b.S.toggleFootball('2026-10-05'); // the old version closed before sending this
    updated();
    await b.SYNC.syncNow();
    const c = await device('tablet');
    await c.SYNC.submit('in', { id: 'me@example.com', password: PW });
    expect(c.S.state.football).toEqual(['2026-10-05']);
  });
});

// ---------- from the pre-merge review

describe("a device that holds another account's data", () => {
  async function leftBehind() {
    const a = await device('shared');
    a.S.importData({ sessions: [session('x1')] });
    await a.SYNC.submit('up', { email: 'x@example.com', password: PW, password2: PW });
    await a.SYNC.handleAction('sync-code-done');
    await a.SYNC.handleAction('sync-out');
    a.S.importData({ sessions: [session('x2', '2026-10-05')] }); // logged after signing out: only here
    return a;
  }

  it('asks before a new account starts empty, and keeps the data on Cancel', async () => {
    const a = await leftBehind();
    const ask = vi.spyOn(window, 'confirm').mockReturnValue(false);
    a.SYNC.status.noEmail = true;
    await a.SYNC.submit('up', { password: PW, password2: PW });
    expect(ask).toHaveBeenCalledTimes(1);
    ask.mockRestore();
    expect(a.SYNC.status.error).toBe('');
    expect(a.S.state.sessions.map((s) => s.id).sort()).toEqual(['x1', 'x2']);
    const b = await device('laptop');
    await b.SYNC.submit('in', { id: a.SYNC.status.pending!.accountCode!, password: PW });
    expect(b.S.state.sessions.map((s) => s.id).sort()).toEqual(['x1', 'x2']);
  });

  it('starts the new account empty when the Player says so', async () => {
    const a = await leftBehind();
    const ask = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await a.SYNC.submit('up', { email: 'y@example.com', password: PW, password2: PW });
    ask.mockRestore();
    expect(a.S.state.sessions).toEqual([]);
  });

  it('asks before a recovery replaces it, and keeps it on Cancel', async () => {
    const y = await device('phone');
    y.S.importData({ sessions: [session('y1')] });
    await y.SYNC.submit('up', { email: 'y@example.com', password: PW, password2: PW });
    const code = y.SYNC.status.pending!.recoveryCode;
    const a = await leftBehind();
    const ask = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await a.SYNC.submit('recover', { id: 'y@example.com', code, password: 'a brand new password', password2: 'a brand new password' });
    expect(ask).toHaveBeenCalledTimes(1);
    ask.mockRestore();
    expect(a.SYNC.status.user).toBeNull();
    expect(a.S.state.sessions.map((s) => s.id).sort()).toEqual(['x1', 'x2']);
  });

  it('still replaces it after the recovery code is needed, when the Player said to', async () => {
    const y = await device('phone');
    y.S.importData({ sessions: [session('y1')] });
    await y.SYNC.submit('up', { email: 'y@example.com', password: PW, password2: PW });
    const code = y.SYNC.status.pending!.recoveryCode;
    // The password was changed in a way that left the key wrapped for the old one.
    const C = await import('./lib/crypto');
    cloud.users.get('uid1')!.password = (await C.deriveMaster('the other password', 'y@example.com')).auth;
    const a = await leftBehind();
    const ask = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await a.SYNC.submit('in', { id: 'y@example.com', password: 'the other password' });
    ask.mockRestore();
    expect(a.SYNC.status.repair).toBe(true);
    await a.SYNC.submit('repair', { code });
    expect(a.SYNC.status.error).toBe('');
    expect(a.S.state.sessions.map((s) => s.id)).toEqual(['y1']);
  });

  it('shows the new recovery code of an upgraded older account even when the Player cancels', async () => {
    cloud.users.set('uid9', { uid: 'uid9', email: 'old@example.com', password: 'oldpass' });
    const a = await leftBehind();
    const ask = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await a.SYNC.submit('in', { id: 'old@example.com', password: 'oldpass', legacy: '1' });
    ask.mockRestore();
    expect(a.SYNC.status.user).toBeNull();
    expect(document.querySelector('.sheet-body')!.textContent).toMatch(/([0-9A-Z]{4}-){7}[0-9A-Z]{4}/);
    // Shown once, but not kept: this device belongs to someone else.
    expect(a.SYNC.status.pending).toBeNull();
  });
});

describe('passwords', () => {
  it('never sends the typed password to Firebase for an encrypted account, even after a typo', async () => {
    const a = await device('phone');
    await a.SYNC.submit('up', { email: 'me@example.com', password: PW, password2: PW });
    const sent: string[] = [];
    cloud.hook = (op, value) => {
      if (op === 'signIn' || op === 'reauth') sent.push(value);
    };
    const b = await device('laptop');
    await b.SYNC.submit('in', { id: 'me@example.com', password: 'correct horse batterz' });
    expect(b.SYNC.status.error).toMatch(/Wrong email/);
    const ask = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await on(a, () => a.SYNC.submit('delete', { password: 'my gmail password' }));
    ask.mockRestore();
    expect(a.SYNC.status.error).toMatch(/isn't right/);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent).not.toContain('correct horse batterz');
    expect(sent).not.toContain('my gmail password');
  });

  it('removes a sign-up cut off before the keys were saved, so trying again works', async () => {
    const a = await device('phone');
    a.S.importData({ sessions: [session('s1')] });
    a.SYNC.status.noEmail = true;
    cloud.hook = (op, paths) => {
      if (op === 'commit' && paths.includes('/keys')) throw Object.assign(new Error('offline'), { code: 'unavailable' });
    };
    await a.SYNC.submit('up', { password: PW, password2: PW });
    cloud.hook = null;
    expect(a.SYNC.status.error).toMatch(/weren't signed in/);
    expect(a.SYNC.status.user).toBeNull();
    expect(cloud.users.size).toBe(0); // no account left that nobody could ever reach
    await a.SYNC.submit('up', { password: PW, password2: PW });
    expect(a.SYNC.status.error).toBe('');
    expect(a.SYNC.status.pending?.accountCode).toBeTruthy();
    expect(a.SYNC.status.pending?.recoveryCode).toBeTruthy();
    expect(cloud.docs.get(`users/${a.SYNC.status.user!.uid}/arise/meta`)).toMatchObject({ enc: 1 });
  });

  it('emails a reset link only to accounts from before encryption', async () => {
    cloud.users.set('uid9', { uid: 'uid9', email: 'old@example.com', password: 'oldpass' });
    const a = await device('phone');
    await a.SYNC.submit('up', { email: 'new@example.com', password: PW, password2: PW });
    await a.SYNC.handleAction('sync-out');
    const mailed: string[] = [];
    cloud.hook = (op, email) => {
      if (op === 'reset') mailed.push(email);
    };
    await a.SYNC.submit('reset', { id: 'new@example.com' });
    expect(a.SYNC.status.error).toMatch(/recovery code/);
    await a.SYNC.submit('reset', { id: 'old@example.com' });
    expect(a.SYNC.status.error).toBe('');
    expect(mailed).toEqual(['old@example.com']);
  });
});

describe('a blank copy', () => {
  async function pair() {
    const a = await device('phone');
    a.S.importData({ sessions: [session('s1'), session('s2', '2026-10-02')] });
    await a.SYNC.submit('up', { email: 'me@example.com', password: PW, password2: PW });
    const b = await device('laptop');
    await b.SYNC.submit('in', { id: 'me@example.com', password: PW });
    return { a, b };
  }

  it("never goes over the cloud copy after 'Erase all data' while the session had expired", async () => {
    const { a, b } = await pair();
    await on(a, async () => {
      a.SYNC.status.user = null; // what Firebase does when the session expires
      await a.SYNC.eraseThisDevice();
      await a.SYNC.submit('in', { id: 'me@example.com', password: PW });
      expect(a.S.state.sessions.map((s) => s.id)).toEqual(['s1', 's2']);
    });
    await on(b, async () => {
      await b.SYNC.syncNow();
      expect(b.S.state.sessions.map((s) => s.id)).toEqual(['s1', 's2']);
    });
  });

  it('never goes over the cloud copy when this device could not read its storage', async () => {
    const { b } = await pair();
    use('phone');
    localStorage.setItem('pit-data-v1', '{not json');
    const a = await device('phone');
    expect(a.S.storageProblem()).toBe('corrupt');
    await a.SYNC.submit('in', { id: 'me@example.com', password: PW });
    expect(a.S.state.sessions.map((s) => s.id)).toEqual(['s1', 's2']);
    await on(b, async () => {
      await b.SYNC.syncNow();
      expect(b.S.state.sessions.map((s) => s.id)).toEqual(['s1', 's2']);
    });
  });

  it("from the intro on a new device doesn't replace the account's real goal or settings", async () => {
    const a = await device('phone');
    a.S.saveGoal({ id: 'fitness', title: 'Get strong', category: 'fitness', workouts: true, quests: [{ id: 'q1', title: 'Stretch', schedule: { kind: 'daily' }, created: '2026-10-01' }] });
    a.S.state.settings.perWeek = 4;
    a.S.save();
    await a.SYNC.submit('up', { email: 'me@example.com', password: PW, password2: PW });
    const t = await device('tablet');
    t.S.saveGoal({ id: 'fitness', title: 'Get fit', category: 'fitness', workouts: true, quests: [{ id: 'q9', title: 'Walk', schedule: { kind: 'daily' }, created: '2026-10-08' }] });
    t.S.state.settings.perWeek = 5;
    t.S.save();
    await t.SYNC.submit('in', { id: 'me@example.com', password: PW });
    expect(t.S.state.goals.map((g) => g.title)).toEqual(['Get strong']);
    expect(t.S.state.settings.perWeek).toBe(4);
    await on(a, async () => {
      await a.SYNC.syncNow();
      expect(a.S.state.goals.map((g) => g.title)).toEqual(['Get strong']);
      expect(a.S.state.goals[0].quests.map((q) => q.title)).toEqual(['Stretch']);
    });
  });
});

describe('sync edge cases', () => {
  it('keeps both edits when two devices save at the same moment', async () => {
    const a = await device('phone');
    a.S.importData({ sessions: [session('s1')] });
    await a.SYNC.submit('up', { email: 'me@example.com', password: PW, password2: PW });
    const b = await device('laptop');
    await b.SYNC.submit('in', { id: 'me@example.com', password: PW });
    b.S.toggleFootball('2026-10-06');
    await on(a, async () => {
      a.S.toggleFootball('2026-10-05');
      cloud.hook = async (op) => {
        if (op !== 'commit') return;
        cloud.hook = null;
        use('laptop'); // the laptop saves while the phone is about to
        await b.SYNC.syncNow();
        use('phone');
      };
      await a.SYNC.syncNow();
      expect(a.S.state.football).toEqual(['2026-10-05', '2026-10-06']);
    });
    await on(b, async () => {
      await b.SYNC.syncNow();
      expect(b.S.state.football).toEqual(['2026-10-05', '2026-10-06']);
    });
  });

  it('encrypts an older plain cloud copy on the next sync if the first try failed', async () => {
    cloud.users.set('uid9', { uid: 'uid9', email: 'old@example.com', password: 'oldpass' });
    cloud.docs.set('users/uid9/arise/meta', { rev: 'r1', parts: 1, updatedAt: 5, savedAt: 5, app: 1 });
    cloud.docs.set('users/uid9/arise/part0', { rev: 'r1', text: JSON.stringify({ sessions: [session('old1')] }) });
    const a = await device('phone');
    cloud.hook = (op, paths) => {
      if (op === 'commit' && paths.includes('part0')) {
        cloud.hook = null;
        throw Object.assign(new Error('offline'), { code: 'unavailable' });
      }
    };
    await a.SYNC.submit('in', { id: 'old@example.com', password: 'oldpass', legacy: '1' });
    expect(cloud.docs.get('users/uid9/arise/meta')).not.toMatchObject({ enc: 1 });
    await a.SYNC.syncNow();
    expect(a.SYNC.status.error).toBe('');
    expect(cloud.docs.get('users/uid9/arise/meta')).toMatchObject({ enc: 1 });
  });

  it("takes in deletions from other devices after updating from the old app (old sync info)", async () => {
    cloud.users.set('uid9', { uid: 'uid9', email: 'old@example.com', password: 'oldpass' });
    // The laptop (old app) deleted s2 and synced.
    cloud.docs.set('users/uid9/arise/meta', { rev: 'r2', parts: 1, updatedAt: 5, savedAt: 5, app: 1 });
    cloud.docs.set('users/uid9/arise/part0', { rev: 'r2', text: JSON.stringify({ sessions: [session('s1')] }) });
    use('phone');
    localStorage.setItem('pit-data-v1', JSON.stringify({ sessions: [session('s1'), session('s2', '2026-10-02')], updatedAt: 1000 }));
    localStorage.setItem('arise-sync', JSON.stringify({ uid: 'uid9', email: 'old@example.com', rev: 'r1', hash: 'abc123', at: 2000 }));
    vi.resetModules();
    const fake = await import('./lib/firebase');
    const S = await import('./store');
    const SYNC = await import('./sync');
    const A = await import('./account');
    await A.load(() => {});
    (fake as unknown as typeof import('./test/fake-firebase')).restoreSession('uid9');
    await SYNC.initSync({ render: () => {}, changed: () => {}, checkForUpdate: () => {} });
    await SYNC.submit('unlock', { password: 'oldpass' });
    expect(SYNC.status.error).toBe('');
    expect(S.state.sessions.map((s) => s.id)).toEqual(['s1']);
  });

  it("'Erase all data' asks before dropping changes that haven't reached the cloud", async () => {
    const a = await device('phone');
    a.S.importData({ sessions: [session('s1')] });
    await a.SYNC.submit('up', { email: 'me@example.com', password: PW, password2: PW });
    a.S.toggleFootball('2026-10-09');
    cloud.hook = (op) => {
      if (op === 'commit') throw Object.assign(new Error('offline'), { code: 'unavailable' });
    };
    const ask = vi.spyOn(window, 'confirm').mockReturnValue(false);
    expect(await a.SYNC.eraseThisDevice()).toBe(false);
    expect(ask).toHaveBeenCalledTimes(1);
    ask.mockRestore();
    expect(a.S.state.football).toEqual(['2026-10-09']);
  });

  it('signs out instead of recreating a cloud copy when the account was deleted on another device', async () => {
    const a = await device('phone');
    a.S.importData({ sessions: [session('s1')] });
    await a.SYNC.submit('up', { email: 'me@example.com', password: PW, password2: PW });
    const b = await device('laptop');
    await b.SYNC.submit('in', { id: 'me@example.com', password: PW });
    // The phone deletes the account. (Done to the cloud directly: the fake Firebase shares one
    // sign-in between devices, so the phone's sign-out would sign the laptop out too.)
    expect(a.SYNC.status.user).toBeTruthy();
    cloud.docs.clear();
    cloud.users.delete('uid1');
    await on(b, async () => {
      b.S.toggleFootball('2026-10-09');
      await b.SYNC.syncNow();
      expect(b.SYNC.status.user).toBeNull();
      expect(b.SYNC.status.error).toMatch(/deleted on another device/);
      expect(b.S.state.sessions.map((s) => s.id)).toEqual(['s1']);
    });
    expect(cloud.docs.size).toBe(0);
  });
});

// ---------- from the second review

describe('signing in again and first sign-ins', () => {
  async function account() {
    const a = await device('phone');
    a.S.importData({ sessions: [session('s1')] });
    a.S.saveGoal({ id: 'g1', title: 'Learn Spanish', category: 'learning', quests: [{ id: 'q1', title: 'Study', schedule: { kind: 'daily' }, created: '2026-10-01' }] });
    await a.SYNC.submit('up', { email: 'me@example.com', password: PW, password2: PW });
    await a.SYNC.handleAction('sync-code-done');
    return a;
  }

  it('keeps settings and coach chat of an account with no goals or workouts yet', async () => {
    const a = await device('phone');
    a.S.saveProfile({ skipped: true });
    await a.SYNC.submit('up', { email: 'me@example.com', password: PW, password2: PW });
    a.S.state.settings.perWeek = 3;
    a.S.state.ai.chat.push({ role: 'user', text: 'hello coach', at: Date.now() });
    a.S.save();
    await a.SYNC.syncNow();
    expect(a.S.state.settings.perWeek).toBe(3);
    expect(a.S.state.ai.chat.map((m) => m.text)).toEqual(['hello coach']);
    const b = await device('laptop');
    await b.SYNC.submit('in', { id: 'me@example.com', password: PW });
    expect(b.S.state.settings.perWeek).toBe(3);
  });

  it('keeps edits made while signed out when signing back in to the same account', async () => {
    const a = await account();
    await a.SYNC.handleAction('sync-out');
    a.S.saveGoal({ ...a.S.goalById('g1')!, title: 'Learn Spanish to B2' });
    a.S.state.settings.perWeek = 3;
    a.S.save();
    await a.SYNC.submit('in', { id: 'me@example.com', password: PW });
    expect(a.S.goalById('g1')!.title).toBe('Learn Spanish to B2');
    expect(a.S.state.settings.perWeek).toBe(3);
    const b = await device('laptop');
    await b.SYNC.submit('in', { id: 'me@example.com', password: PW });
    expect(b.S.goalById('g1')!.title).toBe('Learn Spanish to B2');
  });

  it("keeps a new device's own goals on its first sign-in", async () => {
    await account();
    const t = await device('tablet');
    t.S.saveGoal({ id: 'g7', title: 'Write a novel', category: 'creative', milestones: [{ id: 'm1', title: 'Outline', done: true }] });
    await t.SYNC.submit('in', { id: 'me@example.com', password: PW });
    expect(t.S.state.goals.map((g) => g.title).sort()).toEqual(['Get fit with home workouts', 'Learn Spanish', 'Write a novel']);
  });

  it("doesn't let a new device's intro replace the real goal of a device signing in later", async () => {
    // The phone has months of history but no account; the tablet does the intro and signs up.
    const p = await device('phone');
    p.S.importData({ sessions: [session('s1')], profile: { goal: 'Get strong', onboarded: true } });
    const real = p.S.state.goals.map((g) => g.id);
    expect(real).toEqual(['fitness']);
    const t = await device('tablet');
    t.S.markIntroGoal(t.S.saveGoal({ id: t.S.uid(), title: 'Get fit', category: 'fitness', workouts: true })!);
    await t.SYNC.submit('up', { email: 'me@example.com', password: PW, password2: PW });
    await on(p, () => p.SYNC.submit('in', { id: 'me@example.com', password: PW }));
    expect(p.S.goalById('fitness')?.title).toBe('Get strong');
  });

  it('takes the account as it is when the new device only did the intro', async () => {
    await account();
    const t = await device('tablet');
    t.S.markIntroGoal(t.S.saveGoal({ id: t.S.uid(), title: 'Get fit', category: 'fitness', workouts: true })!);
    await t.SYNC.submit('in', { id: 'me@example.com', password: PW });
    expect(t.S.state.goals.map((g) => g.title).sort()).toEqual(['Get fit with home workouts', 'Learn Spanish']);
  });

  it('lets a new account take the data of an account deleted elsewhere, without asking', async () => {
    const a = await account();
    const b = await device('laptop');
    await b.SYNC.submit('in', { id: 'me@example.com', password: PW });
    expect(a.SYNC.status.user).toBeTruthy();
    cloud.docs.clear();
    cloud.users.delete('uid1');
    await on(b, async () => {
      await b.SYNC.syncNow();
      expect(b.SYNC.status.user).toBeNull();
      const ask = vi.spyOn(window, 'confirm').mockReturnValue(true);
      await b.SYNC.submit('up', { email: 'new@example.com', password: PW, password2: PW });
      expect(ask).not.toHaveBeenCalled();
      ask.mockRestore();
      expect(b.S.state.sessions.map((s) => s.id)).toEqual(['s1']);
    });
  });

  it("never shows one account's recovery code to another", async () => {
    const a = await device('phone');
    await a.SYNC.submit('up', { email: 'x@example.com', password: PW, password2: PW });
    expect(a.SYNC.status.pending).toBeTruthy();
    a.SYNC.status.user = null; // the session ran out before the code was saved
    const b = await device('laptop');
    await b.SYNC.submit('up', { email: 'y@example.com', password: PW, password2: PW });
    await b.SYNC.handleAction('sync-code-done');
    use('phone');
    await a.SYNC.submit('in', { id: 'y@example.com', password: PW });
    expect(a.SYNC.status.user).toMatchObject({ id: 'y@example.com' });
    expect(a.SYNC.panel()).not.toContain('Save your recovery code');
  });
});

describe('a password reset by email on an encrypted account', () => {
  it('gets back in with that password and the recovery code', async () => {
    const a = await device('phone');
    a.S.importData({ sessions: [session('s1')] });
    await a.SYNC.submit('up', { email: 'me@example.com', password: PW, password2: PW });
    const code = a.SYNC.status.pending!.recoveryCode;
    cloud.users.get('uid1')!.password = 'set from the email'; // Firebase's own reset page

    const b = await device('laptop');
    await b.SYNC.submit('recover', { id: 'me@example.com', code, password: 'a brand new password', password2: 'a brand new password' });
    expect(b.SYNC.status.error).toMatch(/reset email/);
    await b.SYNC.submit('in', { id: 'me@example.com', password: 'set from the email' });
    expect(b.SYNC.status.offerLegacy).toBe(true);
    await b.SYNC.submit('in', { id: 'me@example.com', password: 'set from the email', legacy: '1' });
    expect(b.SYNC.status.repair).toBe(true);
    await b.SYNC.submit('repair', { code });
    expect(b.SYNC.status.error).toBe('');
    expect(b.S.state.sessions.map((s) => s.id)).toEqual(['s1']);
    // And the usual way works again everywhere.
    const c = await device('tablet');
    await c.SYNC.submit('in', { id: 'me@example.com', password: 'set from the email' });
    expect(c.SYNC.status.error).toBe('');
  });

  it("isn't suggested for an account code, which never gets one", async () => {
    const a = await device('phone');
    a.SYNC.status.noEmail = true;
    await a.SYNC.submit('up', { password: PW, password2: PW });
    const { accountCode, recoveryCode } = a.SYNC.status.pending!;
    cloud.users.delete('uid1'); // the login deleted in the Firebase console; its recovery record stays
    const b = await device('laptop');
    await b.SYNC.submit('recover', { id: accountCode!, code: recoveryCode, password: 'a brand new password', password2: 'a brand new password' });
    expect(b.SYNC.status.error).toBe(`The recovery code can't sign in to ${accountCode}. Maybe the account was deleted. Then make a new one with "New here? Create an account".`);
    expect(b.SYNC.status.offerLegacy).toBe(false);
  });
});

// ---------- from the third review

describe('third review', () => {
  it("an unfinished account deletion doesn't stop the next account on the device from syncing", async () => {
    const a = await device('phone');
    a.S.importData({ sessions: [session('a1')] });
    await a.SYNC.submit('up', { email: 'a@example.com', password: PW, password2: PW });
    const b = await device('laptop');
    b.S.importData({ sessions: [session('b1')] });
    await b.SYNC.submit('up', { email: 'b@example.com', password: PW, password2: PW });
    use('phone');
    cloud.hook = (op, paths) => {
      if (op === 'commit' && paths.includes('part0')) throw Object.assign(new Error('offline'), { code: 'unavailable' });
    };
    const ask = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await a.SYNC.submit('delete', { password: PW }); // fails halfway
    cloud.hook = null;
    await a.SYNC.handleAction('sync-out');
    await a.SYNC.submit('in', { id: 'b@example.com', password: PW });
    ask.mockRestore();
    expect(a.S.state.sessions.map((s) => s.id)).toEqual(['b1']);
    a.S.toggleFootball('2026-10-09');
    await a.SYNC.syncNow();
    await on(b, async () => {
      await b.SYNC.syncNow();
      expect(b.S.state.football).toEqual(['2026-10-09']);
    });
  });

  it("asks before another existing account takes the data of an account deleted elsewhere", async () => {
    const y = await device('laptop');
    y.S.importData({ sessions: [session('y1')] });
    await y.SYNC.submit('up', { email: 'y@example.com', password: PW, password2: PW });
    const x = await device('tablet');
    x.S.importData({ sessions: [session('x1')] });
    await x.SYNC.submit('up', { email: 'x@example.com', password: PW, password2: PW });
    for (const p of [...cloud.docs.keys()]) if (p.includes('uid2') || p.endsWith('x@example.com')) cloud.docs.delete(p);
    cloud.users.delete('uid2');
    await x.SYNC.syncNow();
    expect(x.SYNC.status.user).toBeNull();
    const ask = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await x.SYNC.submit('in', { id: 'y@example.com', password: PW });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0][0]).toMatch(/would be lost/);
    ask.mockRestore();
    expect(x.S.state.sessions.map((s) => s.id)).toEqual(['x1']);
  });

  it("doesn't promise the other account keeps the data once that account is gone", async () => {
    const x = await device('tablet');
    x.S.importData({ sessions: [session('x1')] });
    await x.SYNC.submit('up', { email: 'x@example.com', password: PW, password2: PW });
    await x.SYNC.handleAction('sync-out');
    for (const p of [...cloud.docs.keys()]) cloud.docs.delete(p); // deleted on another device meanwhile
    cloud.users.clear();
    const ask = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await x.SYNC.submit('up', { email: 'new@example.com', password: PW, password2: PW });
    expect(ask.mock.calls[0][0]).toMatch(/would be lost/);
    ask.mockRestore();
  });

  it("doesn't carry the 1.x unlock rule over to later accounts on the device", async () => {
    cloud.users.set('uid9', { uid: 'uid9', email: 'old@example.com', password: 'oldpass' });
    use('phone');
    localStorage.setItem('arise-sync', JSON.stringify({ uid: 'uid9', email: 'old@example.com', rev: 'x', hash: 'x' }));
    vi.resetModules();
    const fake = await import('./lib/firebase');
    const SYNC = await import('./sync');
    const A = await import('./account');
    await A.load(() => {});
    (fake as unknown as typeof import('./test/fake-firebase')).restoreSession('uid9');
    await SYNC.initSync({ render: () => {}, changed: () => {}, checkForUpdate: () => {} });
    await SYNC.submit('unlock', { password: 'oldpass' });
    expect(SYNC.status.error).toBe('');
    await SYNC.handleAction('sync-out');
    expect(JSON.parse(localStorage.getItem('arise-sync')!).email).toBeUndefined();
  });

  it('signs out again when a ticked 1.x sign-in is cut off, so trying again works', async () => {
    cloud.users.set('uid9', { uid: 'uid9', email: 'old@example.com', password: 'oldpass' });
    const a = await device('phone');
    let cut = true;
    cloud.hook = (op, path) => {
      if (cut && op === 'getDoc' && path.endsWith('/keys')) {
        cut = false;
        throw Object.assign(new Error('offline'), { code: 'unavailable' });
      }
    };
    await a.SYNC.submit('in', { id: 'old@example.com', password: 'oldpass', legacy: '1' });
    cloud.hook = null;
    expect(a.SYNC.status.error).not.toBe('');
    expect(a.SYNC.status.user).toBeNull();
    await a.SYNC.submit('in', { id: 'old@example.com', password: 'oldpass', legacy: '1' });
    expect(a.SYNC.status.error).toBe('');
    expect(a.SYNC.status.pending?.recoveryCode).toBeTruthy();
  });

  it('offers the 1.x box straight after a reset email, and explains a plain wrong password', async () => {
    cloud.users.set('uid9', { uid: 'uid9', email: 'old@example.com', password: 'oldpass' });
    const a = await device('phone');
    await a.SYNC.submit('in', { id: 'old@example.com', password: 'oldpass' });
    expect(a.SYNC.status.error).toMatch(/tick the box/);
    const link = document.createElement('button');
    link.dataset.v = 'reset';
    await a.SYNC.handleAction('sync-form', link);
    expect(a.SYNC.status.offerLegacy).toBe(false);
    await a.SYNC.submit('reset', { id: 'old@example.com' });
    expect(a.SYNC.status.form).toBe('in');
    expect(a.SYNC.panel()).toContain('name="legacy"');
  });

  it("keeps an intro goal the Player already edited on the first sign-in", async () => {
    const a = await device('phone');
    a.S.saveGoal({ id: 'g1', title: 'Learn Spanish', category: 'learning' });
    await a.SYNC.submit('up', { email: 'me@example.com', password: PW, password2: PW });
    const t = await device('tablet');
    const intro = t.S.saveGoal({ id: t.S.uid(), title: 'Run', category: 'fitness' })!;
    t.S.markIntroGoal(intro);
    await new Promise((r) => setTimeout(r, 5));
    t.S.saveGoal({ ...intro, title: 'Run the Berlin marathon in 2027' });
    await t.SYNC.submit('in', { id: 'me@example.com', password: PW });
    expect(t.S.state.goals.map((g) => g.title).sort()).toEqual(['Learn Spanish', 'Run the Berlin marathon in 2027']);
  });
});

// ---------- from the fourth review

describe('fourth review', () => {
  it("never syncs another person's data into an account while the Player is still deciding", async () => {
    const b = await device('laptop');
    b.S.importData({ sessions: [session('b1')] });
    await b.SYNC.submit('up', { email: 'b@example.com', password: PW, password2: PW });
    const a = await device('tablet');
    a.S.importData({ sessions: [session('a1')], logs: { '2026-10-01': { t: "A's private journal", at: 1 } } });
    await a.SYNC.submit('up', { email: 'a@example.com', password: PW, password2: PW });
    await a.SYNC.handleAction('sync-out');
    // The app comes back to the front while the sign-in is finishing: that tries to sync.
    cloud.hook = async (op, path) => {
      if (op === 'getDoc') process.stdout.write('HOOK ' + path + ' user=' + (a.SYNC.status.user?.id) + ' locked=' + a.SYNC.status.locked + '\n');
      if (op === 'getDoc' && path.startsWith('recovery/') && a.SYNC.status.user) await a.SYNC.syncNow();
    };
    const ask = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const before = cloud.docs.get('users/uid1/arise/meta')!.rev;
    await a.SYNC.submit('in', { id: 'b@example.com', password: PW });
    cloud.hook = null;
    expect(ask).toHaveBeenCalledTimes(1);
    ask.mockRestore();
    expect(a.SYNC.status.user).toBeNull();
    // Nothing reached B's cloud copy. (Checked there: the fake shares one sign-in between devices.)
    expect(cloud.docs.get('users/uid1/arise/meta')!.rev).toBe(before);
    expect(a.S.state.sessions.map((s) => s.id)).toEqual(['a1']);
  });

  it('notes a workout plan switched by the other device, so later days follow it', async () => {
    const a = await device('phone');
    a.S.importData({ sessions: [session('s1', '2026-09-01')] });
    await a.SYNC.submit('up', { email: 'me@example.com', password: PW, password2: PW });
    const t = await device('tablet');
    await t.SYNC.submit('in', { id: 'me@example.com', password: PW });
    await on(a, async () => {
      a.S.setGoalStatus('fitness', 'paused');
      await a.SYNC.syncNow();
    });
    await on(t, async () => {
      // The tablet's own (later) edit of the still-active goal wins the merge.
      await new Promise((r) => setTimeout(r, 5));
      t.S.saveGoal({ ...t.S.goalById('fitness')!, why: 'feel strong' });
      await t.SYNC.syncNow();
      expect(t.S.workoutsOn()).toBe(true);
      const notes = t.S.state.stamps.planDays;
      const last = Object.keys(notes).sort().pop()!;
      expect(notes[last]).toBeGreaterThan(0);
    });
  });

  it("doesn't take a new account with the same email for the old one", async () => {
    const x = await device('tablet');
    x.S.importData({ sessions: [session('x1')] });
    await x.SYNC.submit('up', { email: 'a@example.com', password: PW, password2: PW });
    await x.SYNC.handleAction('sync-out');
    for (const p of [...cloud.docs.keys()]) cloud.docs.delete(p); // deleted elsewhere...
    cloud.users.clear();
    const p = await device('phone');
    await p.SYNC.submit('up', { email: 'a@example.com', password: PW, password2: PW }); // ...and made again
    use('tablet');
    const ask = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await x.SYNC.submit('up', { email: 'b@example.com', password: PW, password2: PW });
    expect(ask.mock.calls[0][0]).toMatch(/would be lost/);
    ask.mockRestore();
  });

  it("keeps Arise 1.x's mark only for its own account", async () => {
    use('phone');
    localStorage.setItem('arise-sync', JSON.stringify({ uid: 'uid9', email: 'old@example.com', rev: 'x', hash: 'x' }));
    const a = await device('phone');
    await a.SYNC.submit('up', { email: 'new@example.com', password: PW, password2: PW });
    expect(JSON.parse(localStorage.getItem('arise-sync')!).email).toBeUndefined();
  });
});

// ---------- from the fifth review

describe('fifth review', () => {
  const days = (from: string, to: string) => {
    const out: string[] = [];
    for (let d = new Date(`${from}T12:00`); d <= new Date(`${to}T12:00`); d.setDate(d.getDate() + 1)) out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    return out;
  };

  it("doesn't rewrite the account's workout plan history when a new device signs in", async () => {
    const a = await device('phone');
    // A weekly-split user who never switched the plan: every planned day trained, Thursdays off.
    const trained = days('2026-08-01', '2026-09-30').filter((k) => new Date(`${k}T12:00`).getDay() !== 4);
    // (Without the weekly day off: with it, the football day below would rightly join the run.)
    a.S.importData({ settings: { template: 'weekly', dayOff: false }, sessions: trained.map((k) => session(`s${k.replace(/-/g, '')}`, k)) });
    const best = a.S.bestStreak();
    expect(best).toBeGreaterThan(30);
    await a.SYNC.submit('up', { email: 'me@example.com', password: PW, password2: PW });
    const t = await device('tablet');
    await t.SYNC.submit('in', { id: 'me@example.com', password: PW });
    expect(t.S.state.stamps.planDays).toEqual({});
    expect(t.S.bestStreak()).toBe(best);
    t.S.toggleFootball('2026-10-03');
    await t.SYNC.syncNow();
    await on(a, async () => {
      await a.SYNC.syncNow();
      expect(a.S.state.stamps.planDays).toEqual({});
      expect(a.S.bestStreak()).toBe(best);
    });
  });

  it('signs out a sign-in that fails partway, so the data question is never skipped', async () => {
    const b = await device('laptop');
    b.S.importData({ sessions: [session('b1')] });
    await b.SYNC.submit('up', { email: 'b@example.com', password: PW, password2: PW });
    const a = await device('tablet');
    a.S.importData({ sessions: [session('a1')] });
    await a.SYNC.submit('up', { email: 'a@example.com', password: PW, password2: PW });
    await a.SYNC.handleAction('sync-out');
    let cut = true;
    cloud.hook = (op, path) => {
      if (cut && op === 'getDoc' && path === 'users/uid1/arise/keys') {
        cut = false;
        throw Object.assign(new Error('offline'), { code: 'unavailable' });
      }
    };
    const before = cloud.docs.get('users/uid1/arise/meta')!.rev;
    await a.SYNC.submit('in', { id: 'b@example.com', password: PW });
    cloud.hook = null;
    expect(a.SYNC.status.error).not.toBe('');
    expect(a.SYNC.status.user).toBeNull();
    await a.SYNC.syncNow();
    expect(cloud.docs.get('users/uid1/arise/meta')!.rev).toBe(before);
  });

  it('stays signed in after signing back in to the same account with nothing changed', async () => {
    const a = await device('phone');
    a.S.importData({ sessions: [session('s1')] });
    await a.SYNC.submit('up', { email: 'me@example.com', password: PW, password2: PW });
    await a.SYNC.handleAction('sync-out');
    const reads: string[] = [];
    cloud.hook = (op, path) => {
      if (op === 'getDoc') reads.push(path);
    };
    await a.SYNC.submit('in', { id: 'me@example.com', password: PW });
    cloud.hook = null;
    expect(reads.filter((p) => p.startsWith('recovery/'))).toEqual([]); // no check needed for its own account
    expect(JSON.parse(localStorage.getItem('arise-sync')!).uid).toBe('uid1');
  });

  it('undoes a sign-in whose question was left open when the app closed', async () => {
    const b = await device('laptop');
    await b.SYNC.submit('up', { email: 'b@example.com', password: PW, password2: PW });
    use('tablet');
    localStorage.setItem('arise-sync', JSON.stringify({ lastUid: 'uid7', rev: 'r', hash: 'h', asking: true }));
    vi.resetModules();
    const fake = await import('./lib/firebase');
    const SYNC = await import('./sync');
    const A = await import('./account');
    await A.load(() => {});
    (fake as unknown as typeof import('./test/fake-firebase')).restoreSession('uid1');
    await SYNC.initSync({ render: () => {}, changed: () => {}, checkForUpdate: () => {} });
    expect(SYNC.status.user).toBeNull();
    expect(JSON.parse(localStorage.getItem('arise-sync')!).asking).toBeUndefined();
  });
});

// ---------- from the sixth review

describe('sixth review', () => {
  it('keeps the answer "replace this device\'s data" until a sync has carried it out', async () => {
    const b = await device('laptop');
    b.S.importData({ sessions: [session('b1')] });
    await b.SYNC.submit('up', { email: 'b@example.com', password: PW, password2: PW });
    const a = await device('tablet');
    a.S.importData({ sessions: [session('a1')], logs: { '2026-10-01': { t: "A's private journal", at: 1 } } });
    await a.SYNC.submit('up', { email: 'a@example.com', password: PW, password2: PW });
    await a.SYNC.handleAction('sync-out');
    let cut = true;
    cloud.hook = (op, path) => {
      if (cut && op === 'getDoc' && path === 'users/uid1/arise/meta') {
        cut = false;
        throw Object.assign(new Error('offline'), { code: 'unavailable' });
      }
    };
    const ask = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const before = cloud.docs.get('users/uid1/arise/meta')!.rev;
    await a.SYNC.submit('in', { id: 'b@example.com', password: PW });
    ask.mockRestore();
    cloud.hook = null;
    expect(a.SYNC.status.user?.id).toBe('b@example.com'); // signed in; only its first sync failed
    await a.SYNC.syncNow(); // back online
    expect(a.S.state.sessions.map((s) => s.id)).toEqual(['b1']);
    expect(a.S.state.logs['2026-10-01']).toBeUndefined();
    expect(cloud.docs.get('users/uid1/arise/meta')!.rev).toBe(before);
  });

  const dayKeys = (from: string, to: string) => {
    const out: string[] = [];
    for (let d = new Date(`${from}T12:00`); d <= new Date(`${to}T12:00`); d.setDate(d.getDate() + 1)) out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    return out;
  };
  const weeklyTrained = (from: string, to: string) => ({ settings: { template: 'weekly' }, sessions: dayKeys(from, to).filter((k) => new Date(`${k}T12:00`).getDay() !== 4).map((k) => session(`s${k.replace(/-/g, '')}`, k)) });

  it("doesn't let a new device's own plan notes rewrite the account's plan history", async () => {
    const a = await device('phone');
    a.S.importData(weeklyTrained('2026-08-03', '2026-10-04'));
    const best = a.S.bestStreak();
    await a.SYNC.submit('up', { email: 'me@example.com', password: PW, password2: PW });
    const l = await device('laptop');
    l.S.saveGoal({ id: 'g1', title: 'Learn Spanish', category: 'learning', quests: [{ id: 'q1', title: 'Study', schedule: { kind: 'daily' }, created: '2026-09-01' }] });
    for (const k of dayKeys('2026-09-01', '2026-10-07')) l.S.tick('q1', { done: true }, k);
    l.S.saveGoal({ id: 'g2', title: 'Get fit', category: 'fitness', workouts: true }); // its own plan, on from today
    expect(Object.keys(l.S.state.stamps.planDays).length).toBeGreaterThan(0);
    await l.SYNC.submit('in', { id: 'me@example.com', password: PW });
    await on(a, async () => {
      await a.SYNC.syncNow();
      expect(a.S.bestStreak()).toBe(best);
      expect(a.S.dayStatus('2026-09-10')).toBe('done'); // a Thursday rest day stays one
    });
  });

  it("keeps a device's own paused-plan holiday when it joins an account that's only days old", async () => {
    const l = await device('laptop');
    l.S.importData(weeklyTrained('2026-08-03', '2026-08-30'));
    l.S.saveGoal({ id: 'g1', title: 'Spanish', category: 'learning', quests: [{ id: 'q1', title: 'Study', schedule: { kind: 'daily' }, created: '2026-08-03' }] });
    for (const k of dayKeys('2026-08-03', '2026-10-07')) l.S.tick('q1', { done: true }, k);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 7, 31, 12));
    l.S.setGoalStatus('fitness', 'paused'); // a holiday
    vi.setSystemTime(new Date(2026, 8, 14, 12));
    l.S.setGoalStatus('fitness', 'active');
    vi.useRealTimers();
    for (const k of dayKeys('2026-09-14', '2026-10-07')) if (new Date(`${k}T12:00`).getDay() !== 4) l.S.importData({ sessions: [session(`t${k.replace(/-/g, '')}`, k)] });
    const holiday = l.S.dayStatus('2026-09-03'); // paused: the quest was enough
    expect(holiday).toBe('done');
    const best = l.S.bestStreak();
    const p = await device('phone');
    p.S.importData(weeklyTrained('2026-10-01', '2026-10-04'));
    await p.SYNC.submit('up', { email: 'me@example.com', password: PW, password2: PW });
    await on(l, () => l.SYNC.submit('in', { id: 'me@example.com', password: PW }));
    expect(l.S.dayStatus('2026-09-03')).toBe('done');
    expect(l.S.bestStreak()).toBe(best);
  });

  it("doesn't sign out a working session when a stale signed-out tab's sign-in fails", async () => {
    const a = await device('phone');
    await a.SYNC.submit('up', { email: 'x@example.com', password: PW, password2: PW });
    const A = await import('./account');
    expect(A.currentUid()).toBe('uid1');
    a.SYNC.status.user = null; // what a tab opened while signed out still shows
    await a.SYNC.submit('in', { id: 'x@example.com', password: 'typo typo typo' });
    expect(a.SYNC.status.error).toMatch(/Wrong/);
    expect(A.currentUid()).toBe('uid1');
  });
});


// ---------- from the seventh review

describe('seventh review', () => {
  const failFirst = (path: string) => {
    let cut = true;
    cloud.hook = (op, p) => {
      if (cut && (op === 'getDoc' || op === 'commit') && p.includes(path)) {
        cut = false;
        throw Object.assign(new Error('offline'), { code: 'unavailable' });
      }
    };
  };

  async function sharedTablet() {
    const a = await device('tablet');
    a.S.importData({ sessions: [session('a1')], logs: { '2026-10-01': { t: "A's private journal", at: 1 } } });
    await a.SYNC.submit('up', { email: 'a@example.com', password: PW, password2: PW });
    await a.SYNC.handleAction('sync-code-done');
    await a.SYNC.handleAction('sync-out');
    return a;
  }

  it("never uploads a device emptied for a new account over the owner's cloud copy", async () => {
    const a = await sharedTablet();
    failFirst('part0'); // the new account's first upload fails
    const ask = vi.spyOn(window, 'confirm').mockReturnValue(true); // "Start your new account empty?"
    await a.SYNC.submit('up', { email: 'c@example.com', password: PW, password2: PW });
    ask.mockRestore();
    cloud.hook = null;
    expect(a.S.state.sessions).toEqual([]);
    await a.SYNC.handleAction('sync-out');
    await a.SYNC.submit('in', { id: 'a@example.com', password: PW }); // the owner wants their data back
    expect(a.S.state.sessions.map((s) => s.id)).toEqual(['a1']);
    const phone = await device('phone');
    await phone.SYNC.submit('in', { id: 'a@example.com', password: PW });
    expect(phone.S.state.sessions.map((s) => s.id)).toEqual(['a1']);
  });

  it('keeps what the Player did after "start empty" when the first upload failed', async () => {
    const a = await sharedTablet();
    failFirst('part0');
    const ask = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await a.SYNC.submit('up', { email: 'c@example.com', password: PW, password2: PW });
    ask.mockRestore();
    cloud.hook = null;
    a.S.importData({ sessions: [session('c1', '2026-10-08')] }); // a workout in the new account
    await a.SYNC.syncNow();
    expect(a.S.state.sessions.map((s) => s.id)).toEqual(['c1']);
    expect(a.S.state.logs['2026-10-01']).toBeUndefined();
  });

  it('keeps a workout done after "replace" while the first sync was failing, and none of the old data', async () => {
    const b = await device('laptop');
    b.S.importData({ sessions: [session('b1')] });
    await b.SYNC.submit('up', { email: 'b@example.com', password: PW, password2: PW });
    const a = await sharedTablet();
    failFirst('users/uid1/arise/meta');
    const ask = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await a.SYNC.submit('in', { id: 'b@example.com', password: PW });
    ask.mockRestore();
    cloud.hook = null;
    a.S.importData({ sessions: [session('b2', '2026-10-08')] }); // offline, a workout as B
    await a.SYNC.syncNow();
    expect(a.S.state.sessions.map((s) => s.id).sort()).toEqual(['b1', 'b2']);
    expect(a.S.state.logs['2026-10-01']).toBeUndefined();
  });

  it("doesn't take over a sign-in left from before a restart when the owner mistypes", async () => {
    const b = await device('laptop');
    await b.SYNC.submit('up', { email: 'b@example.com', password: PW, password2: PW });
    use('tablet');
    localStorage.setItem('pit-data-v1', JSON.stringify({ sessions: [session('a1')] }));
    localStorage.setItem('arise-sync', JSON.stringify({ lastUid: 'uid7', rev: 'r', hash: 'h' }));
    vi.resetModules();
    const fake = await import('./lib/firebase');
    const S = await import('./store');
    const SYNC = await import('./sync');
    const A = await import('./account');
    await A.load(() => {});
    (fake as unknown as typeof import('./test/fake-firebase')).restoreSession('uid1'); // B's session, left behind
    await SYNC.initSync({ render: () => {}, changed: () => {}, checkForUpdate: () => {} });
    await SYNC.submit('in', { id: 'a@example.com', password: 'typo typo typo' });
    expect(SYNC.status.user).toBeNull();
    expect(A.currentUid()).toBeNull();
    expect(S.state.sessions.map((s) => s.id)).toEqual(['a1']);
  });

  it("doesn't delete an account that was finished meanwhile when a sign-up's keys fail", async () => {
    const a = await device('phone');
    cloud.hook = (op, paths) => {
      if (op === 'commit' && paths.includes('/keys')) {
        cloud.hook = null;
        // Another device signed in to the brand-new account and finished it first.
        cloud.docs.set('users/uid1/arise/keys', { v: 1 });
        throw Object.assign(new Error('offline'), { code: 'unavailable' });
      }
    };
    await a.SYNC.submit('up', { email: 'race@example.com', password: PW, password2: PW });
    expect(cloud.users.size).toBe(1);
  });

  it('treats a device signed out by Arise 1.x as returning to its own account, keeping its plan record', async () => {
    cloud.users.set('uid9', { uid: 'uid9', email: 'old@example.com', password: 'oldpass' });
    cloud.docs.set('users/uid9/arise/meta', { rev: 'r1', parts: 1, updatedAt: 5, savedAt: 5, app: 1 });
    cloud.docs.set('users/uid9/arise/part0', { rev: 'r1', text: JSON.stringify({ sessions: [session('s1', '2026-08-03')] }) });
    use('phone');
    const notes = { '2026-08-30': 1, '2026-08-31': -1790000000000, '2026-09-14': 1790000000001 };
    localStorage.setItem('pit-data-v1', JSON.stringify({ sessions: [session('s1', '2026-08-03')], stamps: { planDays: notes } }));
    localStorage.setItem('arise-sync', JSON.stringify({ lastUid: 'uid9' })); // what 1.x left on sign-out
    const a = await device('phone');
    await a.SYNC.submit('in', { id: 'old@example.com', password: 'oldpass', legacy: '1' });
    expect(a.SYNC.status.error).toBe('');
    expect(a.S.state.stamps.planDays).toMatchObject(notes);
  });
});


// ---------- from the eighth review

describe('eighth review', () => {
  async function account() {
    const p = await device('phone');
    p.S.saveGoal({ id: 'fitness', title: 'Get strong', category: 'fitness', workouts: true, quests: [{ id: 'q1', title: 'Stretch', schedule: { kind: 'daily' }, created: '2026-10-01' }] });
    p.S.saveProfile({ name: 'Pat', goal: 'Get strong', why: 'For my kids', onboarded: true });
    p.S.state.settings.perWeek = 4;
    p.S.save();
    await p.SYNC.submit('up', { email: 'me@example.com', password: PW, password2: PW });
    return p;
  }

  it("a sign-out before the first sync finished doesn't make this device's data the account's", async () => {
    await account();
    const t = await device('tablet');
    t.S.saveGoal({ id: t.S.uid(), title: 'Get fit', category: 'fitness', workouts: true });
    t.S.saveProfile({ name: 'Tab', goal: 'Get fit', onboarded: true });
    t.S.state.settings.perWeek = 6;
    t.S.save();
    let cut = true;
    cloud.hook = (op, path) => {
      if (cut && op === 'getDoc' && path === 'users/uid1/arise/meta') {
        cut = false;
        throw Object.assign(new Error('offline'), { code: 'unavailable' });
      }
    };
    await t.SYNC.submit('in', { id: 'me@example.com', password: PW });
    cloud.hook = null;
    await t.SYNC.handleAction('sync-out');
    await t.SYNC.submit('in', { id: 'me@example.com', password: PW });
    expect(t.S.goalById('fitness')?.title).toBe('Get strong');
    expect(t.S.state.goals.filter((g) => g.workouts).map((g) => g.id)).toEqual(['fitness']);
    expect(t.S.state.settings.perWeek).toBe(4);
    expect(t.S.state.profile?.why).toBe('For my kids');
  });

  it('counts as signed in (so no intro) while the first sync is still to come', async () => {
    await account();
    const t = await device('tablet');
    cloud.hook = (op, path) => {
      if (op === 'getDoc' && path === 'users/uid1/arise/meta') throw Object.assign(new Error('offline'), { code: 'unavailable' });
    };
    await t.SYNC.submit('in', { id: 'me@example.com', password: PW });
    cloud.hook = null;
    expect(t.SYNC.hasAccount()).toBe(true);
  });

  it("doesn't count a sign-in still waiting for its recovery code as this device's account", async () => {
    const a = await device('phone');
    await a.SYNC.submit('up', { email: 'me@example.com', password: PW, password2: PW });
    cloud.users.get('uid1')!.password = 'set from the email';
    const b = await device('laptop');
    await b.SYNC.submit('in', { id: 'me@example.com', password: 'set from the email', legacy: '1' });
    expect(b.SYNC.status.repair).toBe(true);
    expect(JSON.parse(localStorage.getItem('arise-sync') || '{}').uid).toBeUndefined();
  });

  it('shows the recovery code when the keys were saved but the reply was lost', async () => {
    const a = await device('phone');
    let once = true;
    cloud.hook = (op, paths) => {
      if (once && op === 'commit' && paths.includes('/keys')) {
        once = false;
        return 'lost';
      }
    };
    await a.SYNC.submit('up', { email: 'me@example.com', password: PW, password2: PW });
    cloud.hook = null;
    expect(a.SYNC.status.error).toBe('');
    expect(a.SYNC.status.pending?.recoveryCode).toBeTruthy();
  });

  it("doesn't let an account that never had the workout plan rewrite a device's plan days", async () => {
    const p = await device('phone');
    p.S.saveGoal({ id: 'g1', title: 'People', category: 'relationships', quests: [{ id: 'w1', title: 'Reach out', schedule: { kind: 'weekly', times: 3 }, created: '2026-07-01' }] });
    p.S.addBodyEntry({ weight: 80 }, '2026-07-01');
    expect(p.S.workoutsOn()).toBe(false);
    await p.SYNC.submit('up', { email: 'me@example.com', password: PW, password2: PW });
    const l = await device('laptop');
    const days: string[] = [];
    for (let d = new Date('2026-08-03T12:00'); d <= new Date('2026-10-04T12:00'); d.setDate(d.getDate() + 1)) {
      if (d.getDay() !== 4) days.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    }
    l.S.importData({ settings: { template: 'weekly' }, sessions: days.map((k) => session(`s${k.replace(/-/g, '')}`, k)) });
    const best = l.S.bestStreak();
    await l.SYNC.submit('in', { id: 'me@example.com', password: PW });
    l.S.state.settings.template = 'weekly';
    l.S.save();
    expect(l.S.bestStreak()).toBe(best);
    expect(l.S.dayStatus('2026-09-10')).toBe('done');
  });
});

// ---------- from the final check

describe('final check', () => {
  it("never sends an emptied device over the old owner's cloud copy when the new account's recovery code step isn't finished", async () => {
    const y = await device('laptop');
    y.S.importData({ sessions: [session('y1')] });
    await y.SYNC.submit('up', { email: 'y@example.com', password: PW, password2: PW });
    cloud.users.get('uid1')!.password = 'set from the email';
    const x = await device('tablet');
    x.S.importData({ sessions: [session('x1'), session('x2', '2026-10-02')] });
    await x.SYNC.submit('up', { email: 'x@example.com', password: PW, password2: PW });
    await x.SYNC.handleAction('sync-code-done');
    await x.SYNC.handleAction('sync-out');
    const ask = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await x.SYNC.submit('in', { id: 'y@example.com', password: 'set from the email', legacy: '1' });
    ask.mockRestore();
    expect(x.SYNC.status.repair).toBe(true);
    expect(x.S.state.sessions).toEqual([]);
    await x.SYNC.handleAction('sync-out'); // no code at hand
    await x.SYNC.submit('in', { id: 'x@example.com', password: PW }); // the owner wants their data back
    expect(x.S.state.sessions.map((s) => s.id)).toEqual(['x1', 'x2']);
    const phone = await device('phone');
    await phone.SYNC.submit('in', { id: 'x@example.com', password: PW });
    expect(phone.S.state.sessions.map((s) => s.id)).toEqual(['x1', 'x2']);
  });

  it("asks before another account takes data that already took in an account's copy, even if its upload failed", async () => {
    const b = await device('laptop');
    b.S.importData({ sessions: [session('b1')] });
    await b.SYNC.submit('up', { email: 'b@example.com', password: PW, password2: PW });
    const c = await device('phone');
    await c.SYNC.submit('up', { email: 'c@example.com', password: PW, password2: PW });
    const t = await device('tablet');
    t.S.importData({ sessions: [session('t1')] });
    let cut = true;
    cloud.hook = (op, paths) => {
      if (cut && op === 'commit' && paths.includes('users/uid1/arise/part0')) {
        cut = false;
        throw Object.assign(new Error('offline'), { code: 'unavailable' });
      }
    };
    await t.SYNC.submit('in', { id: 'b@example.com', password: PW });
    cloud.hook = null;
    expect(t.S.state.sessions.map((s) => s.id).sort()).toEqual(['b1', 't1']);
    await t.SYNC.handleAction('sync-out');
    const ask = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await t.SYNC.submit('in', { id: 'c@example.com', password: PW });
    expect(ask).toHaveBeenCalledTimes(1);
    ask.mockRestore();
  });

  it('shows the intro again for an account that was never set up, once its data has arrived', async () => {
    const a = await device('phone');
    await a.SYNC.submit('up', { email: 'new@example.com', password: PW, password2: PW });
    expect(a.SYNC.hasAccount()).toBe(false);
  });
});

// ---------- from the last sweep

describe('last sweep', () => {
  it("a second tab takes the other tab's saves, so switching to it never sends an old copy up", async () => {
    const t1 = await device('laptop');
    t1.S.importData({ sessions: [session('s1')] });
    await t1.SYNC.submit('up', { email: 'me@example.com', password: PW, password2: PW });
    // A second tab of the app on the same laptop (same storage, its own copy in memory).
    current = '';
    use('laptop');
    vi.resetModules();
    const S2 = await import('./store');
    const SYNC2 = await import('./sync');
    // Tab 1 logs a workout and syncs; the browser tells the other tab about the save.
    use('laptop');
    t1.S.importData({ sessions: [session('s2', '2026-10-02')] });
    await t1.SYNC.syncNow();
    window.dispatchEvent(new StorageEvent('storage', { key: 'pit-data-v1', newValue: localStorage.getItem('pit-data-v1') }));
    expect(S2.state.sessions.map((s) => s.id)).toEqual(['s1', 's2']);
    // (Tab 2's sync would now find nothing new to send.)
    expect(SYNC2.status).toBeTruthy();
  });

  it('says a cut-off account deletion still has to be finished instead of "Synced."', async () => {
    const a = await device('phone');
    await a.SYNC.submit('up', { email: 'me@example.com', password: PW, password2: PW });
    cloud.hook = (op, paths) => {
      if (op === 'commit' && paths.includes('part0')) throw Object.assign(new Error('offline'), { code: 'unavailable' });
    };
    const ask = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await a.SYNC.submit('delete', { password: PW });
    ask.mockRestore();
    cloud.hook = null;
    await a.SYNC.syncNow();
    expect(a.SYNC.status.error).toMatch(/didn't finish/);
  });

  it("keeps a device's own plan settings when it joins an account that never had the plan", async () => {
    const p = await device('phone');
    p.S.saveGoal({ id: 'g1', title: 'Lose weight', category: 'health', quests: [{ id: 'q1', title: 'Walk', schedule: { kind: 'daily' }, created: '2026-10-01' }] });
    await p.SYNC.submit('up', { email: 'me@example.com', password: PW, password2: PW });
    const l = await device('laptop');
    l.S.importData({ settings: { template: 'weekly', perWeek: 4 }, sessions: [session('s1', '2026-09-01')] });
    expect(l.S.state.settings.template).toBe('weekly');
    await l.SYNC.submit('in', { id: 'me@example.com', password: PW });
    expect(l.S.state.settings.template).toBe('weekly');
    expect(l.S.state.settings.perWeek).toBe(4);
  });
});

// ---------- making an account again (see also recreate-*.test.ts)

describe('a blank first copy', () => {
  it("doesn't win the settings and profile of the device that made the account, when a device that was never used got there first", async () => {
    // The phone makes the account, but its first upload doesn't get through (offline).
    const a = await device('phone');
    a.S.importData({ settings: { template: 'weekly', perWeek: 4, restBig: 90, sound: false }, sessions: [session('s1')], profile: { goal: 'Get strong', why: 'For my kids', onboarded: true } });
    let cut = true;
    cloud.hook = (op, paths) => {
      if (cut && op === 'commit' && paths.includes('part0')) {
        cut = false;
        throw Object.assign(new Error('offline'), { code: 'unavailable' });
      }
    };
    await a.SYNC.submit('up', { email: 'me@example.com', password: PW, password2: PW });
    cloud.hook = null;
    expect(cloud.docs.has('users/uid1/arise/meta')).toBe(false);
    // Meanwhile a new tablet, with only the intro skipped, signs in: its blank copy goes up first.
    const t = await device('tablet');
    t.S.saveProfile({ skipped: true });
    await t.SYNC.submit('in', { id: 'me@example.com', password: PW });
    expect(t.SYNC.status.error).toBe('');
    const blankRev = cloud.docs.get('users/uid1/arise/meta')!.rev;
    // The phone's next sync: the blank copy chose nothing, so the phone's copy takes its place.
    await on(a, async () => {
      await a.SYNC.syncNow();
      expect(a.SYNC.status.error).toBe('');
      expect(a.S.state.settings).toMatchObject({ template: 'weekly', perWeek: 4, restBig: 90, sound: false });
      expect(a.S.state.profile).toMatchObject({ goal: 'Get strong', why: 'For my kids' });
      expect(a.S.state.sessions.map((s) => s.id)).toEqual(['s1']);
    });
    expect(cloud.docs.get('users/uid1/arise/meta')!.rev).not.toBe(blankRev);
    await on(t, async () => {
      await t.SYNC.syncNow();
      expect(t.S.state.settings).toMatchObject({ template: 'weekly', perWeek: 4, restBig: 90, sound: false });
      expect(t.S.state.profile).toMatchObject({ goal: 'Get strong', why: 'For my kids' });
      expect(t.S.state.sessions.map((s) => s.id)).toEqual(['s1']);
    });
  });

  it('is only a copy where nothing was chosen: settings set on a device with nothing else still win a first sign-in', async () => {
    const a = await device('phone');
    a.S.saveProfile({ skipped: true });
    await a.SYNC.submit('up', { email: 'me@example.com', password: PW, password2: PW });
    a.S.state.settings.perWeek = 3;
    a.S.save();
    await a.SYNC.syncNow();
    const b = await device('laptop');
    b.S.saveGoal({ id: 'g1', title: 'Learn Spanish', category: 'learning' });
    await b.SYNC.submit('in', { id: 'me@example.com', password: PW });
    expect(b.S.state.settings.perWeek).toBe(3);
    expect(b.S.state.goals.map((g) => g.id)).toEqual(['g1']);
  });

  it("doesn't give way to another account's data that came in without a question", async () => {
    // Alice's tablet: a football day and a profile with no goal (so another account signing in
    // gets no question). She signs out.
    const t = await device('tablet');
    t.S.saveProfile({ name: 'Alice', why: 'Alice private reason' });
    t.S.toggleFootball('2026-10-04');
    expect(t.S.isEmpty()).toBe(true);
    await t.SYNC.submit('up', { email: 'alice@example.com', password: PW, password2: PW });
    await t.SYNC.handleAction('sync-code-done');
    await t.SYNC.handleAction('sync-out');
    // Bob's account, made on a phone where he only skipped the intro: a blank copy.
    const b = await device('phone');
    b.S.saveProfile({ skipped: true });
    await b.SYNC.submit('up', { email: 'bob@example.com', password: PW, password2: PW });
    await b.SYNC.handleAction('sync-code-done');
    // Bob signs in on the tablet: his account's profile and settings stay his.
    await on(t, async () => {
      await t.SYNC.submit('in', { id: 'bob@example.com', password: PW });
      expect(t.SYNC.status.error).toBe('');
      expect(t.S.state.profile).not.toMatchObject({ name: 'Alice' });
      expect(t.S.state.profile).not.toMatchObject({ why: 'Alice private reason' });
      expect(t.S.state.settings.name).not.toBe('Alice');
    });
    await on(b, async () => {
      await b.SYNC.syncNow();
      expect(b.S.state.profile).not.toMatchObject({ why: 'Alice private reason' });
      expect(b.S.state.settings.name).not.toBe('Alice');
    });
  });
});
