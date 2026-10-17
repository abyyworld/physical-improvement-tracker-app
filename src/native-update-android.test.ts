// @vitest-environment jsdom
// The Android app's own updates: the same live update of the web app as the iPhone app (Capacitor's
// WebView.setServerBasePath, which works the same way on Android), but checked against the
// Android app's own native parts, and a new Arise.apk when an update needs one. Capacitor's
// Filesystem and WebView are simulated in memory, following Capacitor's Android code (the app's
// own copy is served from "public"; LIBRARY is the app's files folder).

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeBundle } from '../scripts/native-bundle.mjs';
import type { Latest } from './native-update';

const SITE = 'https://example.test/app/';
const IOS = '@capacitor/filesystem@8.1,@capacitor/ios@8.5';
const ANDROID = '@capacitor/android@8.5,@capacitor/filesystem@8.1,arise-android@0123456789ab';
const RUNNING = { commit: 'aaa1111', built: '2026-10-01T00:00:00.000Z', native: ANDROID };
const FILES = '/data/user/0/com.abyyworld.arise/files';
const SNAPSHOTS = `${FILES}/NoCloud/ionic_built_snapshots`;
const OWN_COPY = 'public';

function builtSite(commit: string, built: string, natives: { native?: string; nativeAndroid?: string } = { native: IOS, nativeAndroid: ANDROID }) {
  const dist = mkdtempSync(join(tmpdir(), 'arise-dist-'));
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Arise</title>');
  writeFileSync(join(dist, 'assets', 'app.js'), 'console.log("hi")');
  writeFileSync(join(dist, 'version.json'), JSON.stringify({ version: '2.1.0', commit, built, ...natives }));
  return makeBundle(dist) as { zip: Uint8Array; file: string; latest: Latest };
}

function fakeApp({ platform = 'android', plugins = ['AriseLife', 'Filesystem', 'LocalNotifications', 'Share', 'WebView'], openUrl = (_url: string): unknown => ({}) } = {}) {
  const files = new Map<string, string>();
  const app = { files, base: OWN_COPY, persisted: '', reloads: [] as string[], opened: [] as string[] };
  const lib = (p: string) => `${FILES}/${p}`;
  const handlers: Record<string, (o: Record<string, string>) => unknown> = {
    'Filesystem.writeFile': (o) => void files.set(lib(o.path), o.data),
    'Filesystem.stat': (o) => {
      if (!files.has(lib(o.path))) throw new Error('missing');
      return {};
    },
    'Filesystem.rmdir': (o) => {
      for (const k of [...files.keys()]) if (k.startsWith(`${lib(o.path)}/`)) files.delete(k);
    },
    'Filesystem.readdir': (o) => {
      const names = new Set([...files.keys()].filter((k) => k.startsWith(`${lib(o.path)}/`)).map((k) => k.slice(lib(o.path).length + 1).split('/')[0]));
      return { files: [...names].map((name) => ({ name })) };
    },
    'Filesystem.getUri': (o) => ({ uri: `file://${lib(o.path)}` }),
    'WebView.setServerBasePath': (o) => {
      app.base = o.path;
      app.reloads.push(o.path);
    },
    'WebView.getServerBasePath': () => ({ path: app.base }),
    'WebView.persistServerBasePath': () => void (app.persisted = app.base),
    'AriseLife.openUrl': (o) => {
      app.opened.push(o.url);
      return openUrl(o.url);
    },
  };
  (globalThis as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => platform,
    PluginHeaders: plugins.map((name) => ({ name })),
    nativePromise: async (plugin: string, method: string, options: Record<string, string> = {}) => {
      const fn = handlers[`${plugin}.${method}`];
      if (!fn) throw new Error(`${plugin}.${method} isn't simulated`);
      return fn(options);
    },
  };
  return app;
}

function serve(bundle: { zip: Uint8Array; file: string; latest: Latest }) {
  vi.stubGlobal('fetch', async (url: string) => {
    if (url === `${SITE}native/latest.json`) return new Response(JSON.stringify(bundle.latest));
    if (url === `${SITE}native/${bundle.file}`) return new Response(new Uint8Array(bundle.zip));
    return new Response('', { status: 404 });
  });
}

async function load() {
  vi.resetModules();
  return import('./native-update');
}

beforeEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('the bundle the Deploy workflow publishes', () => {
  it("says which native parts the Android app needs, next to the iPhone app's", () => {
    expect(builtSite('bbb2222', '2026-10-09T00:00:00.000Z').latest).toMatchObject({ native: IOS, nativeAndroid: ANDROID });
  });
});

describe('the Android app updating itself', () => {
  it('downloads a newer version for the same native parts, switches to it, and keeps it once it has started', async () => {
    const app = fakeApp();
    serve(builtSite('bbb2222', '2026-10-09T00:00:00.000Z'));
    const N = await load();
    expect(N.isAndroid()).toBe(true);
    expect(N.supported(SITE)).toBe(true);
    const { latest, needsInstall } = await N.check(RUNNING, SITE);
    expect(needsInstall).toBe(false);
    await N.download(latest!, SITE);
    await N.apply(latest!);
    expect(app.files.has(`${SNAPSHOTS}/bbb2222/index.html`)).toBe(true);
    expect(app.reloads).toEqual([`${SNAPSHOTS}/bbb2222`]);
    expect(app.persisted).toBe('');
    // The new version starts (native-boot.ts, then the start-up check).
    localStorage.setItem('arise-native-tried', 'bbb2222');
    await (await load()).confirmStarted('bbb2222', SITE);
    expect(app.persisted).toBe(`${SNAPSHOTS}/bbb2222`);
  });

  it("goes by the Android app's native parts, not the iPhone app's", async () => {
    fakeApp();
    // A new iPhone plugin: nothing changes for Android.
    serve(builtSite('bbb2222', '2026-10-09T00:00:00.000Z', { native: `${IOS},@capacitor/haptics@8.0`, nativeAndroid: ANDROID }));
    expect((await (await load()).check(RUNNING, SITE)).latest?.commit).toBe('bbb2222');
    // New Android code: a new Arise.apk is needed.
    serve(builtSite('bbb2222', '2026-10-09T00:00:00.000Z', { native: IOS, nativeAndroid: '@capacitor/android@8.5,@capacitor/filesystem@8.1,arise-android@ffffffffffff' }));
    expect(await (await load()).check(RUNNING, SITE)).toEqual({ latest: null, needsInstall: true });
  });

  it("doesn't take or ask for anything when an update says nothing about the Android app", async () => {
    fakeApp();
    serve(builtSite('bbb2222', '2026-10-09T00:00:00.000Z', { native: IOS }));
    expect(await (await load()).check(RUNNING, SITE)).toEqual({ latest: null, needsInstall: false });
  });

  it("leaves the iPhone app going by its own native parts", async () => {
    fakeApp({ platform: 'ios', plugins: ['Filesystem', 'WebView'] });
    serve(builtSite('bbb2222', '2026-10-09T00:00:00.000Z', { native: IOS, nativeAndroid: 'something-else' }));
    const N = await load();
    expect(N.isAndroid()).toBe(false);
    expect((await N.check({ ...RUNNING, native: IOS }, SITE)).latest?.commit).toBe('bbb2222');
    expect(N.apkUrl()).toBe('');
  });
});

describe('getting a new Android app', () => {
  const APK = 'https://github.com/owner/repo/releases/download/android-latest/Arise.apk';

  it("opens the newest Arise.apk in the browser, where Android's installer takes over", async () => {
    const app = fakeApp();
    expect(await (await load()).getNewApp(APK)).toBe(true);
    expect(app.opened).toEqual([APK]);
  });

  it("falls back to the web view's own way of opening another site", async () => {
    const app = fakeApp({ plugins: ['Filesystem', 'WebView'] });
    const open = vi.fn();
    vi.stubGlobal('open', open);
    expect(await (await load()).getNewApp(APK)).toBe(true);
    expect(app.opened).toEqual([]);
    expect(open).toHaveBeenCalledWith(APK, '_blank');
  });

  it('only opens https links, and nothing in a build that has no address for it', async () => {
    const app = fakeApp();
    const N = await load();
    expect(await N.getNewApp('http://example.test/Arise.apk')).toBe(false);
    expect(await N.getNewApp('')).toBe(false);
    expect(await N.getNewApp()).toBe(false); // (a test build doesn't update itself)
    expect(app.opened).toEqual([]);
  });
});
