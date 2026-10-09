// @vitest-environment jsdom
// The iPhone app's own updates: the bundle the Deploy workflow publishes, and the app checking,
// downloading, switching to and keeping (or rolling back) a new version. Capacitor's Filesystem
// and WebView are simulated in memory.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeBundle, nativePlugins } from '../scripts/native-bundle.mjs';

const SITE = 'https://example.test/app/';

function builtSite(commit: string, built: string, index = '<!doctype html><title>Arise</title>') {
  const dist = mkdtempSync(join(tmpdir(), 'arise-dist-'));
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'index.html'), index);
  writeFileSync(join(dist, 'assets', 'app.js'), 'console.log("hi")');
  writeFileSync(join(dist, 'assets', 'app.js.map'), '{}');
  writeFileSync(join(dist, 'version.json'), JSON.stringify({ version: '2.1.0', commit, built }));
  const pkg = { dependencies: { '@capacitor/core': '8', '@capacitor/filesystem': '8', '@capacitor/local-notifications': '8', '@capacitor/share': '8', firebase: '12' } };
  return makeBundle(dist, pkg) as { zip: Uint8Array; file: string; latest: import('./native-update').Latest };
}

// The iPhone app's side: storage under Library, and the web view's current folder.
function fakeApp(plugins = ['Filesystem', 'LocalNotifications', 'Share', 'WebView']) {
  const files = new Map<string, string>();
  const app = { files, base: '/app/public', persisted: '', reloads: [] as string[] };
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

function serve(bundle: ReturnType<typeof builtSite>, { corrupt = false } = {}) {
  const zip = Uint8Array.from(bundle.zip, (b, i) => (corrupt && i === 100 ? b ^ 1 : b));
  vi.stubGlobal('fetch', async (url: string) => {
    if (url === `${SITE}native/latest.json`) return new Response(JSON.stringify(bundle.latest));
    if (url === `${SITE}native/${bundle.file}`) return new Response(zip);
    return new Response('', { status: 404 });
  });
}

async function load() {
  vi.resetModules();
  return import('./native-update');
}

const RUNNING = { commit: 'aaa1111', built: '2026-10-01T00:00:00.000Z' };

beforeEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('the bundle the Deploy workflow publishes', () => {
  it('holds the built app without source maps, with a checksum and the native parts it needs', () => {
    const b = builtSite('bbb2222', '2026-10-09T00:00:00.000Z');
    const files = unzipSync(b.zip);
    expect(Object.keys(files).sort()).toEqual(['assets/app.js', 'index.html', 'version.json']);
    expect(b.latest).toMatchObject({ version: '2.1.0', commit: 'bbb2222', file: 'bbb2222.zip', size: b.zip.length });
    expect(b.latest.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(b.latest.plugins).toEqual(['Filesystem', 'LocalNotifications', 'Share', 'WebView']);
  });

  it('names native parts the way Capacitor does', () => {
    expect(nativePlugins({ dependencies: { '@capacitor/local-notifications': '1', '@capacitor/ios': '1', '@capacitor/push-notifications': '1' } })).toEqual(['LocalNotifications', 'PushNotifications', 'WebView']);
  });
});

describe('the iPhone app updating itself', () => {
  it('finds a newer version, downloads and checks it, switches to it, and keeps it once it has started', async () => {
    const app = fakeApp();
    const b = builtSite('bbb2222', '2026-10-09T00:00:00.000Z');
    serve(b);
    const N = await load();
    expect(N.supported()).toBe(true);
    const { latest } = await N.check(RUNNING, SITE);
    expect(latest?.commit).toBe('bbb2222');
    await N.download(latest!, SITE);
    expect(app.files.has('/var/Library/NoCloud/ionic_built_snapshots/bbb2222/index.html')).toBe(true);
    await N.apply(latest!);
    expect(app.reloads).toEqual(['/var/Library/NoCloud/ionic_built_snapshots/bbb2222']);
    expect(app.persisted).toBe(''); // not kept until it has started
    // The new version starts up.
    await (await load()).confirmStarted('bbb2222');
    expect(app.persisted).toBe('/var/Library/NoCloud/ionic_built_snapshots/bbb2222');
  });

  it("goes back to the version before if the new one never started, and doesn't try it again", async () => {
    const app = fakeApp();
    const b = builtSite('bbb2222', '2026-10-09T00:00:00.000Z');
    serve(b);
    const N = await load();
    const { latest } = await N.check(RUNNING, SITE);
    await N.download(latest!, SITE);
    await N.apply(latest!);
    // It crashed before confirming; the app was reopened and runs the old version again.
    app.base = '/app/public';
    await (await load()).confirmStarted(RUNNING.commit);
    expect(app.persisted).toBe('');
    expect((await (await load()).check(RUNNING, SITE)).latest).toBeNull();
  });

  it('refuses a download that doesn\'t match its checksum', async () => {
    fakeApp();
    const b = builtSite('bbb2222', '2026-10-09T00:00:00.000Z');
    serve(b, { corrupt: true });
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
      const latest = { version: '2.1.0', commit: 'bbb2222', built: '2026-10-09T00:00:00.000Z', file: 'bbb2222.zip', size: zip.length, sha256: createHash('sha256').update(zip).digest('hex'), plugins: ['WebView'] };
      serve({ zip, file: latest.file, latest });
      const N = await load();
      await expect(N.download((await N.check(RUNNING, SITE)).latest!, SITE)).rejects.toThrow(error);
      expect([...app.files.keys()].filter((k) => !k.includes('/ionic_built_snapshots/bbb2222/'))).toEqual([]);
      expect(app.files.has('/var/Library/NoCloud/ionic_built_snapshots/bbb2222/.arise-complete')).toBe(false);
    }
  });

  it('ignores the same or an older version', async () => {
    fakeApp();
    serve(builtSite('aaa1111', '2026-10-09T00:00:00.000Z'));
    expect((await (await load()).check(RUNNING, SITE)).latest).toBeNull();
    serve(builtSite('ccc3333', '2026-09-01T00:00:00.000Z'));
    expect((await (await load()).check(RUNNING, SITE)).latest).toBeNull();
  });

  it('waits for a new Arise.ipa when the update needs a native part this app lacks', async () => {
    fakeApp(['Filesystem', 'WebView']);
    serve(builtSite('bbb2222', '2026-10-09T00:00:00.000Z'));
    expect(await (await load()).check(RUNNING, SITE)).toEqual({ latest: null, needsInstall: true });
  });

  it('clears out versions it no longer needs', async () => {
    const app = fakeApp();
    app.files.set('/var/Library/NoCloud/ionic_built_snapshots/old0000/index.html', 'x');
    app.files.set('/var/Library/NoCloud/ionic_built_snapshots/bbb2222/index.html', 'x');
    app.base = '/var/Library/NoCloud/ionic_built_snapshots/bbb2222';
    await (await load()).confirmStarted('bbb2222');
    expect([...app.files.keys()]).toEqual(['/var/Library/NoCloud/ionic_built_snapshots/bbb2222/index.html']);
  });

  it("isn't used in a browser", async () => {
    (globalThis as { Capacitor?: unknown }).Capacitor = undefined;
    expect((await load()).supported()).toBe(false);
  });
});
