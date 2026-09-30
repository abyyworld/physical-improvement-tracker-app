// Offline support. App files are refreshed in the background on every launch;
// bump VERSION when adding or removing files in SHELL.
const VERSION = 'arise-v4';
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
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
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
    // App files: answer from the cache right away and refresh it in the background,
    // so the app opens instantly (even offline) and updates on the next launch.
    e.respondWith(
      caches.open(VERSION).then(async (c) => {
        const key = req.mode === 'navigate' ? 'index.html' : req;
        const hit = await c.match(key, { ignoreSearch: true });
        const fresh = fetch(req)
          .then((res) => {
            if (res.ok) c.put(key, res.clone());
            return res;
          })
          .catch(() => hit || Response.error());
        if (hit) {
          e.waitUntil(fresh);
          return hit;
        }
        return fresh;
      }),
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
