# Arise: notes for working on this repo

Arise is a private, self-updating app for daily quests toward any goal (fitness has a full workout plan). Live at https://abyyworld.github.io/physical-improvement-tracker-app/. Version is in `package.json`. README.md is the user guide, `docs/LAUNCH.md` the owner's setup steps and the roadmap, `public/privacy.html` the privacy policy.

## Commands

- `npm ci`, then `npm run check` (typecheck, every test, production build). This is exactly what the required CI check `check` runs. Node 22 or newer.
- `npm run dev` for a local server. Tests are Vitest under jsdom; the worker tests live in `worker/*/src` and run with the rest.

## How a change ships

1. Work on a branch, open a pull request to `main`. `main` is protected: the **Checks** workflow (`check`) must pass and changes go through a pull request.
2. Merging to `main` runs `deploy.yml` (GitHub Pages) and `ios.yml` (the unsigned `Arise.ipa` on the `ios-latest` release). Every installed copy (web, home screen, laptop, sideloaded iPhone app) then updates itself; nobody reinstalls.
3. A change people will notice: bump `version` in `package.json` and add an entry at the top of `src/changelog.ts`. That's the "What's new" sheet after the update.

## Map

- `src/main.ts` boots the app (`src/app.js` is the UI; `src/share-view.ts` is the page a friend sees from a share link). `src/native-boot.ts` must stay the first import.
- Data: `src/store.ts`; every field coming from storage, sync or a backup goes through `src/lib/validate.ts`, so a new setting or field needs a `clean*` rule there too.
- Sync, end-to-end encrypted: `src/sync.ts`, `src/account.ts`, `src/lib/crypto.ts`, `src/lib/keystore.ts`, `src/lib/merge.ts`. Bump `SCHEMA` in `src/sync.ts` when the shape of synced data changes in a way an older app would lose.
- Database rules: `firestore.rules`. The server only ever holds ciphertext and the rules refuse anything else.
- AI: `src/ai.js` (engines: private Tinfoil enclave through `worker/ai-proxy`, free Workers AI marked less private, on-device Chrome on laptops, the person's own key). Addresses in `src/ai-config.ts`.
- Reminders: texts in `src/reminders.js`; web push through `src/web-reminders.ts` and `worker/reminders` (a Durable Object alarm); the iPhone app schedules its own in `src/native.js`.
- Updates: `src/update.ts` (service worker `src/sw.ts` on the web, `src/native-update.ts` in the iPhone app), `scripts/native-bundle.mjs`.
- App lock: `src/lib/lock.ts`, `src/app-lock.js`. Sharing: `src/share.ts`, `src/lib/share.ts`.
- Importers (Google Takeout, Maps Timeline, Spotify, Netflix, Apple Health, WhatsApp, bank CSV): `src/life/import/` (one parser per source, `index.ts` has `detect`/`importFile`, run in the worker `worker.ts` through `client.ts`), screen `src/life/import-ui.js`. Events go to the life log through `src/life/store-port.ts`.
- Browser extension (Manifest V3, Chrome/Edge/Firefox): `extension/` (pure logic in `extension/src/lib/`, built by `npm run ext:build` into the Pages site); Arise side `src/life/browser-link.ts`, `src/life/browser-ui.js`.
- Mac helper (calls, notifications, Messages, Safari, app use; a LaunchAgent serving 127.0.0.1 with an HMAC handshake): `mac-helper/` (install with `mac-helper/install.sh`); Arise side `src/life/mac-link.ts`, `src/life/mac-panel.js`.
- What the iPhone app reads for the life log (Apple Health, motion, calendar, places, Shortcuts "Log to Arise"): `src/life/sense.ts`, events made in `src/life/sense-map.ts`, Settings panel in `src/life/sense-ui.ts` (hidden, and nothing read, until the build has the life log: `hasLifeStore()` in `src/life/store-port.ts`). Native side: `ios/App/App/AriseSense.swift`, `AriseInbox.swift`, `LogToArise.swift`, plus `@capgo/capacitor-health`. Pull requests build the iPhone app too (`ios.yml`, no publishing), so Swift is compiled before it reaches `main`.

## Things only the owner can do

Claude can't reach Firebase, Cloudflare or Tinfoil from a cloud session, so changes to these need the owner to run a command on their Mac:

- **`firestore.rules` changed:** `npx -y firebase-tools@13.35.1 deploy --only firestore:rules --project arise-a7349`. Test rules first with the emulator (needs Java): `npx -y firebase-tools@13.35.1 emulators:exec --only firestore --project demo-arise "<test command>"`.
- **`worker/` changed:** `bash scripts/setup-workers.sh` from a copy of the repo (press Return at the Tinfoil key to keep it, and answer **n** to putting the addresses on GitHub, since they're already there).

The one command that does both, straight from GitHub:

```
cd "$(mktemp -d)" && curl -sL https://github.com/abyyworld/physical-improvement-tracker-app/archive/refs/heads/main.tar.gz | tar xz && cd physical-improvement-tracker-app-* && bash scripts/setup-workers.sh && npx -y firebase-tools@13.35.1 login && npx -y firebase-tools@13.35.1 deploy --only firestore:rules --project arise-a7349 && echo "All set."
```

## Open items (October 2026)

- **Owner: run the command above once for 1.3**, if it hasn't been run since 1.3 went live. The rules for email-reset accounts and share links, and the free AI (its Workers AI binding and second model), need it. Until then those three don't work.
- **Owner: Tinfoil credit.** The private AI answers "out of credit" until the Tinfoil account has billing credit.
- **Owner: delete an obsolete old account** in the Firebase console (Authentication, Users, ⋮, Delete account). The owner knows which one.
- **Firebase App Check: on hold.** reCAPTCHA doesn't run inside the iPhone app (`capacitor://localhost`) and App Attest needs a paid Apple account; also never enforce it for Firestore, or share links break (see `docs/LAUNCH.md`).
- The rest of the roadmap is in `docs/LAUNCH.md`, What's next.

## Ground rules

- Never remove, skip or weaken a test to get a change through; fix the code.
- Plain words in anything a person reads (app text, README, LAUNCH): no jargon, short sentences.
- The owner prefers fast turnaround: one build and one review pass, not long review loops, and small changes without a separate review.
- Don't put anyone's email address or other personal details in the repo.

## Gotchas

- Byte arrays under jsdom: wrap Node `Buffer`s and fflate output in `new Uint8Array(...)`, or `instanceof Uint8Array` fails.
- `scripts/setup-workers.sh` must work in bash and zsh (macOS): no variable called `path` (zsh ties it to `PATH`).
- Adding a Capacitor plugin with iOS code changes the native key (`__APP_NATIVE__` in `vite.config.ts`). Phones then need the new `Arise.ipa` installed by hand once before they can take further updates.
- Arise's own Swift code in `ios/App/App` isn't a plugin, so the native key can't see it change: raise `OWN_NATIVE` in `vite.config.ts` whenever that code, `Info.plist` or `App.entitlements` changes in a way the web app relies on. Batch such changes, since each one means a reinstall.
