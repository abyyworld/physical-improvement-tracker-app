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
import { OWN_PAGES } from './lib/pages';

declare const self: ServiceWorkerGlobalScope;

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
// Every other address opens the app. The site's own pages (the privacy policy) are served from
// the precache above, or from the network when the address has extras the precache doesn't know.
registerRoute(new NavigationRoute(createHandlerBoundToURL('index.html'), { denylist: OWN_PAGES }));

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
    (async () => {
      const legacy = (await caches.keys()).filter((k) => LEGACY.test(k));
      await Promise.all(legacy.map((k) => caches.delete(k)));
      await self.clients.claim();
      // Pages of the old version reload into this one. One may be blank: the old worker can show
      // its cached page, whose scripts no longer exist on the server. (A workout in progress is
      // saved, and this version offers to resume it.) Pages already running this version answer
      // when asked and are left alone, so nothing typed there is lost.
      if (!legacy.length) return;
      const pages = await self.clients.matchAll({ type: 'window' });
      const current = new Set<string>();
      const answer = (m: ExtendableMessageEvent) => {
        if (m.data?.type === 'ARISE_2' && m.source && 'id' in m.source) current.add(m.source.id);
      };
      self.addEventListener('message', answer);
      for (const c of pages) c.postMessage({ type: 'ARISE_WHO' });
      await new Promise((r) => setTimeout(r, 1500));
      self.removeEventListener('message', answer);
      for (const c of pages) {
        if (current.has(c.id)) continue;
        // Without the #view part, so it's a real reload even if only that changed since it opened.
        const url = new URL(c.url);
        url.hash = '';
        c.navigate(url.href).catch(() => {});
      }
    })(),
  );
});

// The app sends this when it's a good moment to switch to the new version.
self.addEventListener('message', (e) => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
