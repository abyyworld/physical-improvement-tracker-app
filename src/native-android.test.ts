// @vitest-environment jsdom
// The phone extras (native.js) in the Android app: the copy of the data stays inside the app
// (Android's Documents folder is one other apps can read), reminders don't need exact alarms, and
// the iPhone app does exactly what it did. Capacitor's plugins are simulated in memory.

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Options = Record<string, unknown>;

function fakeApp(platform: 'android' | 'ios') {
  const files = new Map<string, string>(); // "DIRECTORY/name"
  const scheduled: Options[] = [];
  const calls: string[] = [];
  const handlers: Record<string, (o: Options) => unknown> = {
    'Filesystem.writeFile': (o) => void files.set(`${o.directory}/${o.path}`, String(o.data)),
    'Filesystem.readFile': (o) => {
      const data = files.get(`${o.directory}/${o.path}`);
      if (data === undefined) throw new Error('missing');
      return { data };
    },
    'Filesystem.readdir': () => ({ files: [] }),
    'Filesystem.deleteFile': (o) => {
      if (!files.delete(`${o.directory}/${o.path}`)) throw new Error('missing');
    },
    'LocalNotifications.checkPermissions': () => ({ display: 'granted' }),
    'LocalNotifications.cancelAll': () => ({}),
    'LocalNotifications.schedule': (o) => void scheduled.push(...(o.notifications as Options[])),
    'SystemBars.setStyle': () => ({}),
  };
  (globalThis as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => platform,
    PluginHeaders: ['Filesystem', 'LocalNotifications', 'Share', 'SystemBars'].map((name) => ({ name })),
    nativePromise: async (plugin: string, method: string, options: Options = {}) => {
      calls.push(`${plugin}.${method}`);
      const fn = handlers[`${plugin}.${method}`];
      if (!fn) throw new Error(`${plugin}.${method} isn't simulated`);
      return fn(options);
    },
  };
  return { files, scheduled, calls };
}

async function load() {
  vi.resetModules();
  return import('./native.js');
}

const data = (n: number) => JSON.stringify({ sessions: [], settings: { name: `Player ${n}` } });

beforeEach(() => localStorage.clear());

describe('the copy of the data in the Android app', () => {
  it('stays inside the app, with or without the app lock, and never goes to Documents', async () => {
    const app = fakeApp('android');
    localStorage.setItem('pit-data-v1', data(90));
    const N = await load();
    expect(N.isAndroid).toBe(true);
    await N.initNative();
    await vi.waitFor(() => expect([...app.files.keys()]).toEqual(['LIBRARY/Arise data.json']));

    const L = await import('./lib/lock');
    await L.turnOn('1234', { away: 5 });
    await N.lockChanged();
    expect([...app.files.keys()].sort()).toEqual(['LIBRARY/Arise data.json', 'LIBRARY/Arise lock.json']);
    L.turnOff();
    await N.lockChanged();
    expect([...app.files.keys()]).toEqual(['LIBRARY/Arise data.json']);
    expect(app.calls).not.toContain('Filesystem.readFile'); // nothing to restore: the data was there
  });

  it('comes back from the copy inside the app if the storage was cleared', async () => {
    const app = fakeApp('android');
    app.files.set('LIBRARY/Arise data.json', data(91));
    app.files.set('DOCUMENTS/Arise data.json', data(1)); // (never read on Android)
    const reload = vi.fn();
    vi.stubGlobal('location', { ...location, reload });
    try {
      await (await load()).initNative();
    } finally {
      vi.unstubAllGlobals();
    }
    expect(reload).toHaveBeenCalled();
    expect(localStorage.getItem('pit-data-v1')).toContain('Player 91');
  });

  it('shows light status bar icons on the dark app', async () => {
    const app = fakeApp('android');
    await (await load()).initNative();
    expect(app.calls).toContain('SystemBars.setStyle');
    const ios = fakeApp('ios');
    await (await load()).initNative();
    expect(ios.calls).not.toContain('SystemBars.setStyle');
  });
});

describe('reminders in the Android app', () => {
  it("are planned without exact alarms (no settings screen pops up), with Arise's small icon", async () => {
    const app = fakeApp('android');
    const N = await load();
    const S = await import('./store');
    S.state.settings.notify = true;
    await N.syncNotifications(true);
    expect(app.scheduled.length).toBeGreaterThan(0);
    for (const n of app.scheduled) expect(n).toMatchObject({ isExactNotification: false, smallIcon: 'ic_stat_arise' });
    // A tap on one of the journal's opens that day's journal there too.
    expect(app.scheduled.some((n) => (n.extra as Options | undefined)?.open === 'journal')).toBe(true);
    expect(N.BLOCKED_HELP).toContain('Apps, then Arise');
  });

  it('are planned on iPhone exactly as before', async () => {
    const app = fakeApp('ios');
    const N = await load();
    const S = await import('./store');
    S.state.settings.notify = true;
    await N.syncNotifications(true);
    expect(app.scheduled.length).toBeGreaterThan(0);
    const before = ['body', 'id', 'schedule', 'sound', 'threadIdentifier', 'title'];
    // The journal's notifications also carry the day a tap opens; nothing else is added.
    for (const n of app.scheduled) expect(Object.keys(n).sort()).toEqual(n.extra ? [...before, 'extra'].sort() : before);
    expect(app.scheduled.some((n) => !n.extra)).toBe(true);
    expect(app.scheduled.filter((n) => n.extra).every((n) => (n.extra as Options).open === 'journal')).toBe(true);
    expect(N.BLOCKED_HELP).toContain('iPhone Settings app');
  });
});
