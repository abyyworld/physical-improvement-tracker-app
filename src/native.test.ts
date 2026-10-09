// @vitest-environment jsdom
// Files the iPhone app hands to the share sheet (backups, the calendar file). A backup is all of
// someone's data in plain text, so no copy may stay behind in the app's cache. Capacitor's
// Filesystem and Share are simulated in memory.

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Options = Record<string, string>;

function fakeApp({ share = (): unknown => ({}) } = {}) {
  const cache = new Map<string, string>();
  const shared: string[] = [];
  const handlers: Record<string, (o: Options) => unknown> = {
    'Filesystem.writeFile': (o) => {
      if (o.directory === 'CACHE') cache.set(o.path, o.data);
      return { uri: `file:///var/Library/Caches/${o.path}` };
    },
    'Filesystem.readFile': () => {
      throw new Error('missing');
    },
    'Filesystem.readdir': (o) => ({ files: o.directory === 'CACHE' ? [...cache.keys()].map((name) => ({ name, type: 'file' })) : [] }),
    'Filesystem.deleteFile': (o) => {
      if (o.directory === 'CACHE') cache.delete(o.path);
    },
    'Share.share': (o) => {
      shared.push(...(o.files as unknown as string[]));
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
  return { cache, shared };
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

  it('clears copies left behind earlier when the app starts, and nothing else', async () => {
    const app = fakeApp();
    app.cache.set('arise-backup-2026-09-01.json', '{"old":1}');
    app.cache.set('arise-daily-quests.ics', 'BEGIN:VCALENDAR');
    app.cache.set('WebKit', '');
    await (await load()).initNative();
    await vi.waitFor(() => expect([...app.cache.keys()]).toEqual(['WebKit']));
  });
});
