// Pages on the site that aren't the app, like the privacy policy (public/privacy.html).
//
// The service worker answers every navigation with the app (sw.ts), so it has to let these
// through. Matched against the path and query, the way Workbox's NavigationRoute checks them.
export const OWN_PAGES: RegExp[] = [/^[^?]*\/privacy(\.html)?(\?|$)/];

// Their files, which the offline copy leaves out (vite.config.ts), so they always come from the
// network: a stored copy of the policy would stay old until the app next updated itself.
export const OWN_PAGE_FILES = ['privacy.html'];

// The privacy policy on the website. The web app links to its own copy (./privacy.html). In the
// iPhone app that copy would open inside the app with no way back, so it links here instead,
// which iOS opens in Safari.
export const PRIVACY_URL = 'https://abyyworld.github.io/physical-improvement-tracker-app/privacy.html';
