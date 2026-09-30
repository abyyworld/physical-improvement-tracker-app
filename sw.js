// Offline support. App files are refreshed in the background on every launch;
// bump VERSION when adding or removing files in SHELL.
const VERSION = 'arise-v5';
const SHELL = [
  './',
  'index.html',
  'css/app.css',
  'js/app.js',
  'js/store.js',
  'js/program.js',
  'js/ui.js',
  'js/ai.js',
  'js/system.js',
  'js/reminders.js',
  'js/native.js',
  'js/sync.js',
  'js/firebase-config.js',
  'vendor/anthropic-sdk.mjs',
  'vendor/firebase.mjs',
  'manifest.webmanifest',
  'fonts/BebasNeue-400.woff2',
  'fonts/Rajdhani-600.woff2',
  'fonts/Rajdhani-700.woff2',
  'fonts/CormorantGaramond-600i.woff2',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/apple-touch-icon.png',
];
const MEDIA = 'arise-media'; // exercise photos + video thumbnails, kept across versions

self.addEventListener('install', (e) => {
  // cache: 'reload' skips the browser's own cache, so a new version never installs old files.
  e.waitUntil(
    caches
      .open(VERSION)
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== MEDIA).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === location.origin) {
    // App files: ask the server first, so a new version shows up the next time the app opens.
    // 'no-cache' makes the browser check with the server (a quick "not modified" when nothing
    // changed) instead of reusing a copy it kept for a while. Offline, or when the server takes
    // more than 3 seconds, the cached copy answers.
    e.respondWith(
      (async () => {
        const c = await caches.open(VERSION);
        const key = req.mode === 'navigate' ? 'index.html' : url.pathname.endsWith('/') ? `${url.pathname}index.html` : req;
        const network = fetch(url.href, { cache: 'no-cache', credentials: 'same-origin' }).then((res) => {
          if (res.ok) c.put(key, res.clone());
          return res;
        });
        try {
          return await Promise.race([network, new Promise((_, reject) => setTimeout(() => reject(new Error('slow')), 3000))]);
        } catch {
          const hit = await c.match(key, { ignoreSearch: true });
          if (hit) {
            e.waitUntil(network.catch(() => {}));
            return hit;
          }
          return network;
        }
      })(),
    );
    return;
  }

  if (url.hostname === 'raw.githubusercontent.com' || url.hostname === 'i.ytimg.com') {
    e.respondWith(
      caches.open(MEDIA).then((c) =>
        c.match(req).then(
          (hit) =>
            hit ||
            fetch(req).then((res) => {
              if (res.ok || res.type === 'opaque') c.put(req, res.clone());
              return res;
            }),
        ),
      ),
    );
  }
});
