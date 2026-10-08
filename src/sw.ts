/// <reference lib="webworker" />
// Offline support and updates.
//
// Every build lists its files (the precache manifest below). A new version downloads in the
// background while the old one keeps running; the app then decides when to switch over
// (src/update.ts), so an update never interrupts a workout or a half-typed note.

import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { CacheFirst, StaleWhileRevalidate } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';
import { CacheableResponsePlugin } from 'workbox-cacheable-response';

declare const self: ServiceWorkerGlobalScope;

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
registerRoute(new NavigationRoute(createHandlerBoundToURL('index.html')));

// Exercise photos (public domain, fetched with CORS so failures aren't cached) and video
// thumbnails. Both are capped, so they can't fill up the phone.
registerRoute(
  ({ url }) => url.origin === 'https://raw.githubusercontent.com' && url.pathname.startsWith('/yuhonas/free-exercise-db/'),
  new CacheFirst({
    cacheName: 'arise-photos',
    plugins: [new CacheableResponsePlugin({ statuses: [200] }), new ExpirationPlugin({ maxEntries: 150, purgeOnQuotaError: true })],
  }),
);
registerRoute(
  ({ url }) => url.origin === 'https://i.ytimg.com',
  new StaleWhileRevalidate({
    cacheName: 'arise-thumbs',
    plugins: [new CacheableResponsePlugin({ statuses: [0, 200] }), new ExpirationPlugin({ maxEntries: 60, maxAgeSeconds: 30 * 86400, purgeOnQuotaError: true })],
  }),
);

// Caches from the version before the move to Vite. If they're here, this device is running
// that old version, which expects a new service worker to take over straight away.
const LEGACY = /^arise-(v\d+|media)$/;

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      if (keys.some((k) => LEGACY.test(k))) return self.skipWaiting();
    }),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => LEGACY.test(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// The app sends this when it's a good moment to switch to the new version.
self.addEventListener('message', (e) => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
