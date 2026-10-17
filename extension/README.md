# Arise browser extension

Records the sites you visit, your searches and your time on each site, seals it in the browser so only your Arise can open it, and hands it to Arise when Arise is open in the same browser. One codebase for Chrome, Edge, Brave, Arc and Firefox. The logic is in `src/lib/` and is tested with everything else (`npm test`).

`npm run ext:build` makes `dist-extension/`: `arise-chrome.zip`, `arise-edge.zip`, `arise-firefox.zip`, and `dev/` (also works with Arise on localhost). The website offers the Chrome zip for "Load unpacked" until the extension is in the stores.

## Owner: one-time steps

Get the zips: on your Mac, in a copy of the repo, `npm ci && npm run ext:build`.

### Chrome Web Store (also for Brave and Arc), unlisted

1. Open the [developer dashboard](https://chrome.google.com/webstore/devconsole), pay the one-time fee and verify your email.
2. New item: upload `arise-chrome.zip`.
3. Store listing: category Productivity, the 128 px icon from `extension/icons/`, one screenshot (1280×800) of the extension's menu.
4. Privacy: single purpose "A private log of the sites you visit and your searches, for your own Arise app." Permissions:
   - history: reads visits and searches, and the 90 days before linking.
   - tabs: sees which site is in front, for time on each site.
   - idle: stops counting time while you're away.
   - alarms: looks for new visits every minute.
   - storage, unlimitedStorage: keeps sealed data until Arise collects it.
   - content script on Arise's site: talks to Arise's page, nowhere else.
   Data: tick "Web history" and "User activity". Privacy policy: `https://abyyworld.github.io/physical-improvement-tracker-app/privacy.html`.
5. Distribution: Visibility **Unlisted**. Submit for review.
6. Once it's live, put its address in `EXTENSION_STORES.chrome` in `src/life/browser-config.ts`.

### Microsoft Edge Add-ons, hidden

1. Join at [Partner Center](https://partner.microsoft.com/dashboard/microsoftedge) (free).
2. New extension: upload `arise-edge.zip`. Visibility **Hidden**. Same listing and privacy answers as Chrome.
3. Once it's live, put its address in `EXTENSION_STORES.edge` in `src/life/browser-config.ts`.

### Firefox (unlisted, updates from the website)

1. Sign in at [addons.mozilla.org](https://addons.mozilla.org/developers/addon/api/key/) and make API keys.
2. In the GitHub repo: Settings, Secrets and variables, Actions. Add `AMO_JWT_ISSUER` (the JWT issuer) and `AMO_JWT_SECRET` (the JWT secret).
3. Run the Deploy workflow on main (Actions, Deploy, Run workflow; only main signs). It signs this version once, keeps it on the release `extension-v<version>`, and puts it on the website with `updates.json`. Arise's Settings then offers it in Firefox, and Firefox updates it by itself.

## A new version

Bump `version` in `extension/manifest.json`. Firefox gets it by itself with the next deploy. For Chrome and Edge, upload the new zips in their dashboards.

The signing tool, web-ext, is locked with its dependencies in `scripts/amo/package-lock.json`. To move to a newer web-ext: change its version in `scripts/amo/package.json`, then `npm install --package-lock-only --ignore-scripts --prefix scripts/amo`.
