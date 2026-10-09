// Updates for the iPhone app, without the App Store and without installing a new Arise.ipa.
//
// The iPhone app carries its own copy of the web app. Every deploy also publishes that copy as a
// zip next to the website (scripts/native-bundle.mjs). This checks for a newer one, downloads it,
// checks it against its SHA-256, unpacks it into the app's own storage and switches to it, using
// Capacitor's built-in support for this (WebView.setServerBasePath). update.ts decides when.
//
// A new version only becomes the one the app opens with once it has started up properly
// (`confirmStarted`, which runs on its first start). If it ever failed to start, closing and
// reopening the app goes back to the version before, and that update isn't tried again.
// Installing a new Arise.ipa always starts from that build's own copy (Capacitor resets it).

export const SITE = 'https://abyyworld.github.io/physical-improvement-tracker-app/';
// Capacitor reopens a version kept here (by folder name) when the app starts.
const DIR = 'NoCloud/ionic_built_snapshots';
const PENDING = 'arise-native-pending'; // switched to, not yet started properly
const BAD = 'arise-native-bad'; // switched to, but it never started

export interface Latest {
  version: string;
  commit: string;
  built: string;
  file: string;
  size: number;
  sha256: string;
  plugins: string[];
}

interface Cap {
  isNativePlatform?: () => boolean;
  PluginHeaders?: { name: string }[];
  nativePromise: (plugin: string, method: string, options?: object) => Promise<Record<string, unknown>>;
}
const cap = () => (globalThis as { Capacitor?: Cap }).Capacitor;
const call = (plugin: string, method: string, options: object = {}) => cap()!.nativePromise(plugin, method, options);
const has = (name: string) => !!cap()?.PluginHeaders?.some((h) => h.name === name);
export const isNative = () => !!cap()?.isNativePlatform?.();
export const supported = () => isNative() && has('WebView') && has('Filesystem');

const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string | null) => {
    try {
      if (v == null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch {}
  },
};

// On every start: a version just switched to that got this far has started properly, so it
// becomes the one the app opens with. Then old versions are cleared out.
export async function confirmStarted(commit: string) {
  if (!supported()) return;
  const pending = store.get(PENDING);
  if (pending === commit) await call('WebView', 'persistServerBasePath');
  else if (pending) store.set(BAD, pending); // it never got here: it's the version before running
  store.set(PENDING, null);
  try {
    const current = String((await call('WebView', 'getServerBasePath')).path || '').split('/').pop();
    const { files } = (await call('Filesystem', 'readdir', { path: DIR, directory: 'LIBRARY' })) as { files: { name: string }[] };
    for (const f of files) if (f.name !== current) await call('Filesystem', 'rmdir', { path: `${DIR}/${f.name}`, directory: 'LIBRARY', recursive: true });
  } catch {
    // Nothing kept yet.
  }
}

const HEX64 = /^[0-9a-f]{64}$/;
const SAFE = /^[0-9a-z]{1,40}$/i;

// The newest version, if it's newer than this one and this app can run it. `needsInstall`: there
// is a newer version, but it needs a newer Arise.ipa.
export async function check(running: { commit: string; built: string }, site = SITE): Promise<{ latest: Latest | null; needsInstall: boolean }> {
  const res = await fetch(`${site}native/latest.json`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Couldn't check for updates (${res.status}).`);
  const l = (await res.json()) as Latest;
  const valid =
    l &&
    typeof l.version === 'string' &&
    SAFE.test(l.commit) &&
    typeof l.built === 'string' &&
    l.file === `${l.commit}.zip` &&
    Number.isInteger(l.size) &&
    l.size > 0 &&
    l.size < 50e6 &&
    HEX64.test(l.sha256) &&
    Array.isArray(l.plugins);
  if (!valid) throw new Error("The update information doesn't look right.");
  if (l.commit === running.commit || !(l.built > running.built) || store.get(BAD) === l.commit) return { latest: null, needsInstall: false };
  if (!l.plugins.every((p) => typeof p === 'string' && has(p))) return { latest: null, needsInstall: true };
  return { latest: l, needsInstall: false };
}

const folder = (l: Latest) => `${DIR}/${l.commit}`;
const COMPLETE = '.arise-complete';

async function staged(l: Latest) {
  try {
    await call('Filesystem', 'stat', { path: `${folder(l)}/${COMPLETE}`, directory: 'LIBRARY' });
    return true;
  } catch {
    return false;
  }
}

function toBase64(bytes: Uint8Array) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// Downloads, checks and unpacks a version, ready to switch to. Safe to call again: a version
// already unpacked isn't downloaded twice.
export async function download(l: Latest, site = SITE) {
  if (await staged(l)) return;
  const res = await fetch(`${site}native/${l.file}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Couldn't download the update (${res.status}).`);
  const zip = new Uint8Array(await res.arrayBuffer());
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', zip));
  const hex = [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
  if (zip.length !== l.size || hex !== l.sha256) throw new Error("The update didn't download correctly. It will try again later.");
  const { unzipSync } = await import('fflate');
  const files = unzipSync(zip);
  if (!files['index.html']) throw new Error("The update doesn't contain the app.");
  // Start from an empty folder, in case an earlier try stopped halfway.
  await call('Filesystem', 'rmdir', { path: folder(l), directory: 'LIBRARY', recursive: true }).catch(() => {});
  for (const [name, data] of Object.entries(files)) {
    if (name.endsWith('/')) continue;
    if (name.startsWith('/') || name.split('/').some((p) => p === '..' || p === '')) throw new Error("The update doesn't look right.");
    await call('Filesystem', 'writeFile', { path: `${folder(l)}/${name}`, data: toBase64(data), directory: 'LIBRARY', recursive: true });
  }
  await call('Filesystem', 'writeFile', { path: `${folder(l)}/${COMPLETE}`, data: btoa(l.sha256), directory: 'LIBRARY', recursive: true });
}

// Switches to a downloaded version: the app reloads into it straight away.
export async function apply(l: Latest) {
  const { uri } = (await call('Filesystem', 'getUri', { path: folder(l), directory: 'LIBRARY' })) as { uri: string };
  const path = decodeURIComponent(new URL(uri).pathname);
  store.set(PENDING, l.commit);
  await call('WebView', 'setServerBasePath', { path });
}
