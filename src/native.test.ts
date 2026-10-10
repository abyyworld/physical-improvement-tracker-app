// @vitest-environment jsdom
// Files the iPhone app hands to the share sheet (backups, the calendar file). A backup is all of
// someone's data in plain text, so no copy may stay behind in the app's cache. And the copy of
// the data it keeps, which the Files app doesn't show while the app lock is on. Capacitor's
// Filesystem and Share are simulated in memory.

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Options = Record<string, string>;

function fakeApp({ share = (): unknown => ({}) } = {}) {
  const cache = new Map<string, string>();
  const files = new Map<string, string>(); // the other folders: "DOCUMENTS/name"
  const shared: string[] = [];
  const handlers: Record<string, (o: Options) => unknown> = {
    'Filesystem.writeFile': (o) => {
      if (o.directory === 'CACHE') cache.set(o.path, o.data);
      else files.set(`${o.directory}/${o.path}`, o.data);
      return { uri: `file:///var/Library/Caches/${o.path}` };
    },
    'Filesystem.readFile': (o) => {
      const data = files.get(`${o.directory}/${o.path}`);
      if (data === undefined) throw new Error('missing');
      return { data };
    },
    'Filesystem.readdir': (o) => ({ files: o.directory === 'CACHE' ? [...cache.keys()].map((name) => ({ name, type: 'file' })) : [] }),
    'Filesystem.deleteFile': (o) => {
      if (o.directory === 'CACHE') cache.delete(o.path);
      else if (!files.delete(`${o.directory}/${o.path}`)) throw new Error('missing');
    },
    'Share.share': (o) => {
      if (o.files) shared.push(...(o.files as unknown as string[]));
      else shared.push(o.url);
      return share();
    },
  };
  (globalThis as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => true,
    PluginHeaders: ['Filesystem', 'Share'].map((name) => ({ name })),
    nativePromise: async (plugin: string, method: string, options: Options = {}) => {
      const fn = handlers[`${plugin}.${method}`];
      if (!fn) throw new Error(`${plugin}.${method} isn't simulated`);
      return fn(options);
    },
  };
  return { cache, files, shared };
}

async function load() {
  vi.resetModules();
  return import('./native.js');
}

beforeEach(() => localStorage.clear());

describe('sharing a file from the iPhone app', () => {
  it('hands it to the share sheet, then deletes the copy in the cache', async () => {
    const app = fakeApp();
    await (await load()).shareFile('arise-backup-2026-10-09.json', '{"everything":1}');
    expect(app.shared).toEqual(['file:///var/Library/Caches/arise-backup-2026-10-09.json']);
    expect([...app.cache.keys()]).toEqual([]);
  });

  it('deletes it when the share sheet is cancelled, or fails', async () => {
    const cancelled = fakeApp({
      share: () => {
        throw new Error('Share canceled');
      },
    });
    await (await load()).shareFile('arise-backup-2026-10-09.json', '{}');
    expect([...cancelled.cache.keys()]).toEqual([]);

    const failed = fakeApp({
      share: () => {
        throw new Error('No room');
      },
    });
    await expect((await load()).shareFile('arise-daily-quests.ics', 'BEGIN:VCALENDAR')).rejects.toThrow('No room');
    expect([...failed.cache.keys()]).toEqual([]);
  });

  it("hands a shared goal's link to the share sheet, where cancelling is fine", async () => {
    const url = `https://abyyworld.github.io/physical-improvement-tracker-app/#share=${'a'.repeat(22)}.${'b'.repeat(43)}`;
    const app = fakeApp();
    const N = await load();
    expect(N.canShareLink()).toBe(true);
    await N.shareLink({ title: 'Arise', text: 'My progress on Learn Spanish', url });
    expect(app.shared).toEqual([url]);
    expect([...app.cache.keys()]).toEqual([]);
    fakeApp({
      share: () => {
        throw new Error('Share canceled');
      },
    });
    await expect((await load()).shareLink({ title: 'Arise', text: '', url })).resolves.toBeUndefined();
  });

  it('clears copies left behind earlier when the app starts, and nothing else', async () => {
    const app = fakeApp();
    app.cache.set('arise-backup-2026-09-01.json', '{"old":1}');
    app.cache.set('arise-daily-quests.ics', 'BEGIN:VCALENDAR');
    app.cache.set('WebKit', '');
    await (await load()).initNative();
    await vi.waitFor(() => expect([...app.cache.keys()]).toEqual(['WebKit']));
  });
});

describe('the copy of the data in the iPhone app', () => {
  const data = (n: number) => JSON.stringify({ sessions: [], settings: { name: `Player ${n}` } });

  it("is in the Files app, and kept out of it while the app lock is on", async () => {
    const app = fakeApp();
    localStorage.setItem('pit-data-v1', data(80));
    const N = await load();
    await N.initNative();
    await vi.waitFor(() => expect([...app.files.keys()]).toEqual(['DOCUMENTS/Arise data.json']));
    expect(app.files.get('DOCUMENTS/Arise data.json')).toContain('Player 80');

    const L = await import('./lib/lock');
    await L.turnOn('1234', { away: 5 });
    await N.lockChanged();
    expect([...app.files.keys()].sort()).toEqual(['LIBRARY/Arise data.json', 'LIBRARY/Arise lock.json']);
    expect(app.files.get('LIBRARY/Arise data.json')).toContain('Player 80');
    expect(JSON.parse(app.files.get('LIBRARY/Arise lock.json')!)).toEqual(L.read());

    L.turnOff();
    await N.lockChanged();
    expect([...app.files.keys()]).toEqual(['DOCUMENTS/Arise data.json']);
  });

  it('comes back with the app lock when iOS cleared the storage', async () => {
    const app = fakeApp();
    const L = await import('./lib/lock');
    await L.turnOn('1234', { away: 5 });
    app.files.set('LIBRARY/Arise data.json', data(81));
    app.files.set('LIBRARY/Arise lock.json', localStorage.getItem(L.KEY)!);
    localStorage.clear();
    const reload = vi.fn();
    vi.stubGlobal('location', { ...location, reload });
    try {
      await (await load()).initNative();
    } finally {
      vi.unstubAllGlobals();
    }
    expect(reload).toHaveBeenCalled();
    expect(localStorage.getItem('pit-data-v1')).toContain('Player 81');
    expect(L.isOn()).toBe(true);

    // Without the lock on, from the Files app's copy, as before.
    const plain = fakeApp();
    localStorage.clear();
    plain.files.set('DOCUMENTS/Arise data.json', data(82));
    vi.stubGlobal('location', { ...location, reload });
    try {
      await (await load()).initNative();
    } finally {
      vi.unstubAllGlobals();
    }
    expect(localStorage.getItem('pit-data-v1')).toContain('Player 82');
    expect(L.isOn()).toBe(false);
  });
});
