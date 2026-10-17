// The extension's manifest for each browser, made from extension/manifest.json (the Chrome one).
// Used by scripts/build-extension.mjs, and checked by extension/src/manifest.test.ts.

// Where Arise lives. The extension talks only to pages under it.
export const ARISE_URL = 'https://abyyworld.github.io/physical-improvement-tracker-app/';
// A development build also talks to Arise's own dev server (npm run dev, npx vite preview).
export const DEV_URLS = ['http://localhost/', 'http://127.0.0.1/'];
// Firefox's id for the extension, and where it checks for updates of a copy signed by Mozilla.
export const GECKO_ID = 'arise-browser@abyyworld.github.io';
export const UPDATES_URL = `${ARISE_URL}extension/updates.json`;
export const XPI_URL = `${ARISE_URL}extension/arise-firefox.xpi`;

export const TARGETS = ['chrome', 'edge', 'firefox'];

const matchOf = (prefix) => `${prefix}*`;

// The addresses the extension's code knows as Arise's.
export const ariseUrls = ({ dev = false } = {}) => (dev ? [ARISE_URL, ...DEV_URLS] : [ARISE_URL]);

export function manifestFor(base, target, { dev = false } = {}) {
  const m = structuredClone(base);
  if (dev) {
    m.name = `${m.name} (development)`;
    m.content_scripts[0].matches = ariseUrls({ dev }).map(matchOf);
  }
  if (target === 'firefox') {
    // Firefox runs the background as an event page, not a service worker.
    m.background = { scripts: ['background.js'] };
    delete m.minimum_chrome_version;
    m.browser_specific_settings = {
      gecko: {
        id: GECKO_ID,
        strict_min_version: '140.0',
        update_url: UPDATES_URL,
        // What Firefox tells the person at install: it reads browsing activity and searches (and
        // hands them, sealed, to their own Arise).
        data_collection_permissions: { required: ['browsingActivity', 'searchTerms'] },
      },
    };
  }
  return m;
}

// The file Firefox checks for updates of the signed copy.
export function updatesJson(version, sha256) {
  return { addons: { [GECKO_ID]: { updates: [{ version, update_link: XPI_URL, update_hash: `sha256:${sha256}` }] } } };
}
