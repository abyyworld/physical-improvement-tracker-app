// @vitest-environment jsdom
// The iPhone app's own updates: the bundle the Deploy workflow publishes, and the app checking,
// downloading, switching to and keeping (or rolling back) a new version. Capacitor's Filesystem
// and WebView are simulated in memory, following Capacitor's iOS code.

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeBundle } from '../scripts/native-bundle.mjs';
import type { Latest } from './native-update';

const SITE = 'https://example.test/app/';
const NATIVE = '@capacitor/filesystem@8.1,@capacitor/ios@8.5';
const RUNNING = { commit: 'aaa1111', built: '2026-10-01T00:00:00.000Z', native: NATIVE };
const SNAPSHOTS = '/var/Library/NoCloud/ionic_built_snapshots';
const OWN_COPY = '/var/containers/Bundle/Application/X/App.app/public';

function builtSite(commit: string, built: string, native = NATIVE) {
  const dist = mkdtempSync(join(tmpdir(), 'arise-dist-'));
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Arise</title>');
  writeFileSync(join(dist, 'assets', 'app.js'), 'console.log("hi")');
  writeFileSync(join(dist, 'assets', 'app.js.map'), '{}');
  writeFileSync(join(dist, 'version.json'), JSON.stringify({ version: '2.1.0', commit, built, native }));
  return makeBundle(dist) as { zip: Uint8Array; file: string; latest: Latest };
}

// The iPhone app's side: storage under Library, the folder the web view runs from, and the one
// it opens with next time.
function fakeApp(plugins = ['Filesystem', 'LocalNotifications', 'Share', 'WebView']) {
  const files = new Map<string, string>();
  const app = { files, base: OWN_COPY, persisted: '', reloads: [] as string[] };
  const lib = (p: string) => `/var/Library/${p}`;
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
  };
  (globalThis as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => true,
    PluginHeaders: plugins.map((name) => ({ name })),
    nativePromise: async (plugin: string, method: string, options: Record<string, string> = {}) => {
      const fn = handlers[`${plugin}.${method}`];
      if (!fn) throw new Error(`${plugin}.${method} isn't simulated`);
      return fn(options);
    },
  };
  return app;
}

const fetched: string[] = [];
function serve(bundle: { zip: Uint8Array; file: string; latest: Latest }, { corrupt = false } = {}) {
  const zip = Uint8Array.from(bundle.zip, (b, i) => (corrupt && i === 100 ? b ^ 1 : b));
  vi.stubGlobal('fetch', async (url: string) => {
    fetched.push(url);
    if (url === `${SITE}native/latest.json`) return new Response(JSON.stringify(bundle.latest));
    if (url === `${SITE}native/${bundle.file}`) return new Response(zip);
    return new Response('', { status: 404 });
  });
}

async function load() {
  vi.resetModules();
  return import('./native-update');
}

// A version starting up: what native-boot.ts does first, then the start-up check.
async function start(commit: string, { crashes = false } = {}) {
  if (localStorage.getItem('arise-native-pending') === commit) localStorage.setItem('arise-native-tried', commit);
  if (!crashes) await (await load()).confirmStarted(commit, SITE);
}
// The app is closed and opened again: it opens with the folder it was told to keep.
const reopen = (app: ReturnType<typeof fakeApp>) => void (app.base = app.persisted || OWN_COPY);

async function switchTo(commit: string) {
  const N = await load();
  const { latest } = await N.check(RUNNING, SITE);
  expect(latest?.commit).toBe(commit);
  await N.download(latest!, SITE);
  await N.apply(latest!);
}

beforeEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
  fetched.length = 0;
});

describe('the bundle the Deploy workflow publishes', () => {
  it('holds the built app without source maps, with a checksum and the iPhone app it needs', () => {
    const b = builtSite('bbb2222', '2026-10-09T00:00:00.000Z');
    expect(Object.keys(unzipSync(b.zip)).sort()).toEqual(['assets/app.js', 'index.html', 'version.json']);
    expect(b.latest).toMatchObject({ version: '2.1.0', commit: 'bbb2222', native: NATIVE, file: 'bbb2222.zip', size: b.zip.length });
    expect(b.latest.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('the iPhone app updating itself', () => {
  it('finds a newer version, downloads and checks it, switches to it, and keeps it once it has started', async () => {
    const app = fakeApp();
    serve(builtSite('bbb2222', '2026-10-09T00:00:00.000Z'));
    expect((await load()).supported(SITE)).toBe(true);
    await switchTo('bbb2222');
    expect(app.files.has(`${SNAPSHOTS}/bbb2222/index.html`)).toBe(true);
    expect(app.reloads).toEqual([`${SNAPSHOTS}/bbb2222`]);
    expect(app.persisted).toBe(''); // not kept until it has started
    await start('bbb2222');
    expect(app.persisted).toBe(`${SNAPSHOTS}/bbb2222`);
    reopen(app);
    expect(app.base).toBe(`${SNAPSHOTS}/bbb2222`);
  });

  it("goes back to the version before if the new one began to run but failed, and doesn't try it again", async () => {
    const app = fakeApp();
    serve(builtSite('bbb2222', '2026-10-09T00:00:00.000Z'));
    await switchTo('bbb2222');
    await start('bbb2222', { crashes: true });
    reopen(app);
    expect(app.base).toBe(OWN_COPY);
    await start(RUNNING.commit);
    expect(app.persisted).toBe('');
    expect((await (await load()).check(RUNNING, SITE)).latest).toBeNull();
    expect([...app.files.keys()]).toEqual([]); // cleared out
  });

  it('tries again if the app was closed before the new version could load, and gives up after the second time', async () => {
    const app = fakeApp();
    serve(builtSite('bbb2222', '2026-10-09T00:00:00.000Z'));
    await switchTo('bbb2222');
    reopen(app); // closed before the new version ran at all
    await start(RUNNING.commit);
    expect(app.files.has(`${SNAPSHOTS}/bbb2222/index.html`)).toBe(true); // kept for the next go
    fetched.length = 0;
    await switchTo('bbb2222');
    expect(fetched).toEqual([`${SITE}native/latest.json`]); // not downloaded again
    reopen(app);
    await start(RUNNING.commit);
    expect((await (await load()).check(RUNNING, SITE)).latest).toBeNull();
  });

  it('never keeps its own copy as a downloaded one, even when a new Arise.ipa has the same version as the one pending', async () => {
    const app = fakeApp();
    serve(builtSite('bbb2222', '2026-10-09T00:00:00.000Z'));
    await switchTo('bbb2222');
    // The app is closed, and Arise.ipa (built from bbb2222 too) is installed: Capacitor starts it
    // from its own copy and forgets the folder to open with.
    app.base = OWN_COPY;
    await start('bbb2222');
    expect(app.persisted).toBe('');
    reopen(app);
    expect(app.base).toBe(OWN_COPY);
    expect(localStorage.getItem('arise-native-bad')).toBeNull();
  });

  it("refuses a download that doesn't match its checksum", async () => {
    fakeApp();
    serve(builtSite('bbb2222', '2026-10-09T00:00:00.000Z'), { corrupt: true });
    const N = await load();
    const { latest } = await N.check(RUNNING, SITE);
    await expect(N.download(latest!, SITE)).rejects.toThrow(/didn't download correctly/);
  });

  it("refuses an update that would write outside its own folder, or that doesn't contain the app", async () => {
    for (const [entries, error] of [
      [{ 'index.html': 'x', '../../Preferences/evil.plist': 'x' }, /doesn't look right/],
      [{ 'assets/app.js': 'x' }, /doesn't contain the app/],
    ] as const) {
      const app = fakeApp();
      const zip = zipSync(Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, new Uint8Array(strToU8(v))])));
      const latest = { version: '2.1.0', commit: 'bbb2222', built: '2026-10-09T00:00:00.000Z', native: NATIVE, file: 'bbb2222.zip', size: zip.length, sha256: createHash('sha256').update(zip).digest('hex') };
      serve({ zip, file: latest.file, latest });
      const N = await load();
      await expect(N.download((await N.check(RUNNING, SITE)).latest!, SITE)).rejects.toThrow(error);
      expect([...app.files.keys()].filter((k) => !k.startsWith(`${SNAPSHOTS}/bbb2222/`))).toEqual([]);
      expect(app.files.has(`${SNAPSHOTS}/bbb2222/.arise-complete`)).toBe(false);
    }
  });

  it('ignores the same or an older version', async () => {
    fakeApp();
    serve(builtSite('aaa1111', '2026-10-09T00:00:00.000Z'));
    expect((await (await load()).check(RUNNING, SITE)).latest).toBeNull();
    serve(builtSite('ccc3333', '2026-09-01T00:00:00.000Z'));
    expect((await (await load()).check(RUNNING, SITE)).latest).toBeNull();
  });

  it('waits for a new Arise.ipa when the update needs other native parts than this app has', async () => {
    fakeApp();
    serve(builtSite('bbb2222', '2026-10-09T00:00:00.000Z', `${NATIVE},@capacitor/haptics@8.0`));
    expect(await (await load()).check(RUNNING, SITE)).toEqual({ latest: null, needsInstall: true });
    serve(builtSite('bbb2222', '2026-10-09T00:00:00.000Z', '@capacitor/filesystem@8.1,@capacitor/ios@9.0'));
    expect(await (await load()).check(RUNNING, SITE)).toEqual({ latest: null, needsInstall: true });
  });

  it('clears out versions it no longer needs', async () => {
    const app = fakeApp();
    app.files.set(`${SNAPSHOTS}/old0000/index.html`, 'x');
    app.files.set(`${SNAPSHOTS}/bbb2222/index.html`, 'x');
    app.base = `${SNAPSHOTS}/bbb2222`;
    await start('bbb2222');
    expect([...app.files.keys()]).toEqual([`${SNAPSHOTS}/bbb2222/index.html`]);
  });

  it("isn't used in a browser, or in an app that wasn't built by GitHub", async () => {
    fakeApp();
    expect((await load()).supported('')).toBe(false);
    (globalThis as { Capacitor?: unknown }).Capacitor = undefined;
    expect((await load()).supported(SITE)).toBe(false);
  });
});

describe('the first thing a version does', () => {
  it('notes that it began to run, if it is the one just switched to', async () => {
    localStorage.setItem('arise-native-pending', 'other00');
    vi.resetModules();
    await import('./native-boot');
    expect(localStorage.getItem('arise-native-tried')).toBeNull();
    localStorage.setItem('arise-native-pending', __APP_COMMIT__);
    vi.resetModules();
    await import('./native-boot');
    expect(localStorage.getItem('arise-native-tried')).toBe(__APP_COMMIT__);
  });
});
