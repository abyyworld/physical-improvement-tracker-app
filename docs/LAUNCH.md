# Launching Arise, and what's next

Arise (called 2.0 while it was built, released as 1.0) turns the workout tracker into a private, self-updating app for any goal. This page lists what changed, what the owner has to do before it goes live (only someone with the accounts can do these steps), and what comes after.

## What 2.0 is

- **Any goal.** Goals in any part of life, each with daily quests, optional measures and milestones. The home workout plan is now an option on a Fitness goal, and existing workout data becomes a Fitness goal automatically.
- **Private by design.**
  - Synced data is end-to-end encrypted: the server only ever holds ciphertext, and the database rules refuse anything else.
  - Accounts can be made with an email or with no personal details at all (an account code).
  - A recovery code resets a forgotten password without anyone else being able to read the data.
- **AI that's private by default.** Three options:
  - The private AI, in an attested Tinfoil enclave.
  - On this device, with Chrome's built-in model on laptops.
  - The person's own Claude, ChatGPT, Gemini or OpenRouter key, but only after they agree that the company can read what the coach sends it.
- **Updates itself everywhere.** It's an installable web app: a phone home screen, or a laptop. New versions download in the background and switch over at a safe moment, then show What's new. No app store needed. From 2.1 the sideloaded iPhone app updates itself the same way, and Settings has an **App updates** section with **Check for updates** and **Update now**.
- **Built like a product.** TypeScript, about 100 automated tests, CI on every pull request, and deploys from `main`. Security fixes came from an audit: a strict validator for all imported data, a Content-Security-Policy, and pinned CI actions.

## Before merging into `main` (in this order)

1. **Publish the new database rules.** New accounts can't save their keys until you do. Run `npx firebase-tools login` and then `npx firebase-tools deploy --only firestore:rules` from the repo, or paste `firestore.rules` into Firebase console, Firestore Database, Rules, then Publish. The current live app keeps working for reading, but it can't upload after this. That's intended: it updates itself to 2.0 as soon as 2.0 is live.
2. **Switch GitHub Pages to deploy from Actions.** Go to repo Settings, Pages, Build and deployment, and set Source to **GitHub Actions**. The site is now built (`.github/workflows/deploy.yml`) instead of served as plain files. The current version stays up until the first deploy replaces it. Do this before merging: if Pages still serves the `main` branch as files when 2.0 lands, the site shows a blank page until you switch and re-run **Deploy** from the Actions tab.
3. **If this goes live after 1 November 2026,** move `XP_CAP_FROM` in `src/store.ts` to a few weeks after the release day. Workouts finished before that date keep the XP they had in 1.x.
4. **Merge the pull request.** The **Checks** workflow must pass. Within a few minutes the **Deploy** workflow publishes the site, and everyone's installed app updates itself.
5. **Check it live.** Open the site, make a new account with an email and another with **No email**, and sign in on a second device. Firebase must accept the no-email login form (`arise-xxxx-…@code.arise.invalid`); if it refuses that, change `CODE_DOMAIN` in `src/account.ts` to a domain you control that never receives mail. Then make one with **Email reset**, sign out, and use **Forgot password?**, **Email me a reset link**: the email should arrive (check spam), its page should set a new password, and signing in with that should say "Password changed. You're signed in." with the data there.

## Turning on the private AI

Done on 9 October 2026: the proxy runs at https://arise-ai.abyyworld.workers.dev and `src/ai-config.ts` points to it. To redo it (another Cloudflare or Tinfoil account, a new key), run the one command below again. Steps are in `worker/ai-proxy/README.md`:

1. Make a [Tinfoil](https://tinfoil.sh) account, set up billing, create an API key, and set a spending limit.
2. Make a free Cloudflare account and deploy the Worker in `worker/ai-proxy` with `wrangler`, adding the key as a secret.
3. Put the Worker's address in `src/ai-config.ts` (`proxy`), check the `model` is one Tinfoil serves, and push.

Costs: Tinfoil bills per token. With the default limits one very active account can make at most 150 requests a day.

**One command for both servers.** On a Mac, `bash scripts/setup-workers.sh` in a copy of the repo (a downloaded .zip works, no git needed) does step 2 for the AI proxy and also deploys the reminders server below. It logs in to Cloudflare once, asks for the Tinfoil key without showing it, and puts both addresses into `src/ai-config.ts` and `src/reminders-config.ts` on GitHub (with `gh`), or prints them. With Node.js older than 20 it fetches Node.js 22 for that run only.

## Turning on web reminders

Live since 1.0: the web app's notifications (a morning reminder and an evening check) come from a small Worker in `worker/reminders`, deployed at https://arise-reminders.abyyworld.workers.dev. It needs no keys and nothing to create first. Steps, to redo it, are in `worker/reminders/README.md`:

1. Deploy it (with `scripts/setup-workers.sh` above, or `npx -y wrangler@4 deploy` in `worker/reminders`).
2. Put its address in `src/reminders-config.ts` (`server`) and push.
3. Check it live: on an iPhone, add Arise to the Home Screen, open it from there, and turn on Settings, **Reminders**, **Notifications on this device**. Set the morning time a couple of minutes ahead and wait for it. Do the same on Android and on a laptop.

## Turning on linked accounts

Settings, Your life, Accounts reads Google Calendar and Gmail, and Outlook mail and calendar, straight from each person's device. Until you register Arise once with Google and Microsoft, each says "Not set up yet". Steam and PlayStation need nothing from you. No client secret is used anywhere.

**Google** (the web app; the iPhone app sends people to the web for it):

1. In Google Cloud console, make a project and turn on the **Google Calendar API** and the **Gmail API**.
2. Google Auth Platform: audience **External**, left in **Testing**. Add the scopes `https://www.googleapis.com/auth/calendar.readonly` and `https://www.googleapis.com/auth/gmail.readonly`. Add each person as a test user (up to 100).
3. Clients, create a **Web application** client. Authorized JavaScript origins: `https://abyyworld.github.io`. Authorized redirect URIs: `https://abyyworld.github.io/physical-improvement-tracker-app/` (with the slash). For `npm run dev`, also `http://localhost:5173` and `http://localhost:5173/`.
4. Put its Client ID in `src/connect-config.ts` (`GOOGLE.clientId`) and push.

In Testing, only test users can connect, Google warns that it hasn't verified the app (they choose Continue), and it asks them to say yes again every 7 days. The app tells them. Gmail read access is a restricted scope: opening it to everyone means publishing the app, Google's verification and a paid security assessment. Then set `GOOGLE.testing` to `false`.

**Microsoft** (the web app and the iPhone app):

1. Azure portal, Microsoft Entra ID, App registrations, **New registration**, for **Accounts in any organizational directory and personal Microsoft accounts**.
2. Authentication: add a **Single-page application** platform with the redirect URI `https://abyyworld.github.io/physical-improvement-tracker-app/` (and `http://localhost:5173/` for development). Set **Allow public client flows** to **Yes**: the iPhone app signs in with a code typed at microsoft.com/devicelogin.
3. API permissions, Microsoft Graph, Delegated: `User.Read`, `Mail.Read`, `Calendars.Read`, `offline_access`.
4. Put the Application (client) ID in `src/connect-config.ts` (`MICROSOFT.clientId`) and push.

Some work or school accounts need their admin to allow the app, and some block the code sign-in.

## Signing the Android app (once)

GitHub builds Arise.apk on every push to `main` (`.github/workflows/android.yml`), but only publishes it once the repo has a signing key. Android only installs an update signed with the same key as the app on the phone, so make it once and keep a copy somewhere safe, like a password manager. If it's lost, everyone has to uninstall the app and install it again.

1. On a Mac: `keytool -genkeypair -keystore arise-release.keystore -alias arise -keyalg RSA -keysize 4096 -validity 36500 -dname "CN=Arise"`, and choose a strong password when it asks. (No Java? `brew install openjdk`, then use `$(brew --prefix openjdk)/bin/keytool` instead of `keytool`.)
2. `base64 -i arise-release.keystore | pbcopy` copies the key.
3. In the repo, Settings, Secrets and variables, Actions, add four repository secrets: `ANDROID_KEYSTORE` (paste), `ANDROID_KEYSTORE_PASSWORD` (the password), `ANDROID_KEY_ALIAS` (`arise`) and `ANDROID_KEY_PASSWORD` (the same password).
4. Actions, **Android app**, **Run workflow**. Arise.apk then appears on the [android-latest release](https://github.com/abyyworld/physical-improvement-tracker-app/releases/tag/android-latest).
5. **Update the AI server once**, even if you ran it for 1.3. The Android app talks to the AI from its own address (`https://localhost`), and the AI server only accepts it after it's deployed again. Until then the private and free AI refuse every question from the Android app, while the website and the iPhone app keep working. Run `bash scripts/setup-workers.sh` from a copy of the repo (or the one command in `CLAUDE.md`). Press Return at the Tinfoil key to keep it, and answer **n** to putting the addresses on GitHub.

## Updating the Mac helper

The Mac helper is one signed program, the only thing that gets Full Disk Access (`mac-helper/README.md`). GitHub builds it for Apple silicon and Intel Macs whenever `mac-helper/` changes (`.github/workflows/mac-helper.yml`). Pull requests only build it and try it out. On `main` it's published to the [mac-helper-latest release](https://github.com/abyyworld/physical-improvement-tracker-app/releases/tag/mac-helper-latest).

The installer doesn't take the newest build by itself. It installs the build its own lines name, checked against the checksums next to them. So after a change to the helper:

1. Merge the change. Wait for the **Mac helper** workflow on `main` to finish.
2. Its summary shows three lines (`helper_build=…`, `helper_sha_arm64=…`, `helper_sha_x64=…`). Put them in place of the same lines in `mac-helper/install.sh`, in a pull request. Its **pin** check confirms the files and that the workflow built them from `main`.
3. Merge it. Each Mac then needs the install command again, and Full Disk Access again: macOS ties it to the exact build. The installer says how.

**The first time** (the change that made the helper one signed program), do the same: until those lines are filled in, the install command stops with "doesn't name a build yet". Helpers already installed keep running as they are, and their commands (`bash ~/.arise-helper/arise-helper.sh code`, `new-code`, `status`, `restart`) keep working, even after an older copy of the installer was run. Pin the first build soon after merging: the Mac panel already asks people with the older helper to run the install command again. On each Mac that has the older helper, run the install command once more: it replaces it, keeps the pairing code and switches, and shows how to move Full Disk Access from "node" to "arise-helper". Until "node" is out of that list, any Node.js put back in its place would have Full Disk Access again, so the helper checks (once it has Full Disk Access itself), and its status and the Mac panel warn about it.

The release keeps the 10 newest builds, and always the one `mac-helper/install.sh` names, however old. A published build is never replaced: if a run on `main` is run again in full, it stops before publishing. For a new build, start a new run instead (Actions, **Mac helper**, **Run workflow**). Changes to the helper's tests, README or `install.sh` alone don't make a new build.

A newer Node.js for the helper: change `NODE_VERSION` and its two SHA-256s at the top of the workflow (from `https://nodejs.org/dist/v<version>/SHASUMS256.txt`, signed by a Node.js release key), then the steps above.

## Recommended soon after

- **Protect `main`.** Done: the **Checks** workflow and a pull request are required before merging.
- **Firebase App Check** (reCAPTCHA Enterprise for the web). It stops scripts from creating accounts and using the free quota. Turn it on in the Firebase console, then add it to `src/lib/firebase.ts`. **Don't enforce it for Cloud Firestore**, only for Authentication: a friend opening a shared goal's link fetches its page from Firestore without App Check (`src/lib/share.ts`), so enforcing it there would make every shared link say "Couldn't load it". The friend's page can't use App Check either: it would keep a token on their device, and the page promises to keep nothing.
- **Budget alerts** in Google Cloud for the Firebase project, and in Tinfoil. They're the safeguard for `shares/` too: any signed-in account can make pages there (up to 20,000 characters each, base64 only, and no limit on how many), and anyone with a page's id can read it without signing in, so those reads are billed to the project.
- **A privacy policy page on the website.** Done: [privacy.html](https://abyyworld.github.io/physical-improvement-tracker-app/privacy.html) (`public/privacy.html`), linked from Settings, Privacy and the README. It's needed before the app is listed anywhere. Keep it in step with the app whenever what the app keeps or sends changes. Before listing the app, add a private email for privacy requests to its Contact section. Until then, people ask in a GitHub issue and you reply with a private way to reach you.
- **No other website under `abyyworld.github.io`, or an address of Arise's own.** Browsers keep websites apart by the start of the address (`https://abyyworld.github.io`), not by the path after it. So every GitHub Pages site of this account, in any repo, counts as the same website as Arise: a page there could open Arise and use what Arise keeps on the device, including the keys of linked browsers (and so their browsing history). Don't turn on Pages in another repo of this account. Before the browser extension goes to many people, better still: give Arise a domain of its own (repo Settings, Pages, Custom domain), then change `ARISE_URL` in `scripts/extension-manifest.mjs` and the extension's version.
- **Deleting an account for someone who can't sign in.** The policy promises this. In the Firebase console, under Authentication, find the sign-in email (`arise-xxxx-…@code.arise.invalid` for an account code) and copy its User UID. In Firestore, delete every document in `users/<UID>/arise` (`meta`, `keys`, `part0` and so on), `recovery/<sign-in email>`, and turn off every document in `shares` whose `owner` is that UID (the pages of goals they shared): don't delete it, but delete its `owner`, `iv`, `ct` and `updated` fields and add `off` as a boolean set to true. A deleted one would free its id, and anyone with its old link could then put a page of their own there. Then delete the user in Authentication. For an email account, only do this when the request comes from that address.
- **Deleting your own account and making it again with the same email, keeping the data.** First open Arise once on every device that has the account, after this version is live, so each one updates: a device that learns of the deletion while it still runs an older version can't tell that the account made again had its email, and signing in there then offers only to replace its data. On a device you can't update first, save a backup before signing in and load it afterwards. Then, in the app on the device with the newest data: Settings, Account, More, **Delete my account and cloud copy**, then **Create an account** with the same email (it takes the data on that device without asking). Each other device is signed out when it next syncs: sign in there with the new password and answer OK to "Add it to this account?".

## What's next

Roughly in order of value:

1. **Reminders for the web app.** Done in 1.0 (see [Turning on web reminders](#turning-on-web-reminders)). Push notifications to installed apps (iOS 16.4+, Android, desktop) from a small Worker with a Durable Object alarm. The server only knows a push address, a time zone, the reminder times and the last day done. The words stay on the device: the service worker shows texts the app left for it, so they're as personal as the iPhone app's.
2. **Browser tests in CI.** The real-browser checks used during this work (Playwright: the intro, ticking quests, the goal editor, workouts, offline, accessibility) can become a CI job.
3. **App lock.** An optional passcode or Face ID / Touch ID (WebAuthn) that also encrypts the data stored on the device, for people who share or lose their phone.
4. **A day off for quests.** Done: the first missed day each week no longer breaks the streak (Settings, Streak). Each quest's own flame streak still counts every due day; it could get the free day too.
5. **AI on phones: not planned.** The private AI and people's own keys already cover phones, with much better answers than a model small enough to download. Worth another look only if the private AI's cost grows or people ask for offline answers.
6. **The iPhone app.** It updates itself, but a free Apple ID still means re-signing it every 7 days. A paid Apple Developer account ($99 a year) makes a build last a year and opens up TestFlight.
7. **Accountability.** Done in 1.3: share a goal's progress with a friend, end-to-end encrypted (see the README, Sharing a goal with a friend). **Publish the database rules again for it** (`npx firebase-tools deploy --only firestore:rules`): they now have `shares/`, and making a link, or deleting an account, fails without them.
8. **Smaller items:**
   - streaks that remember which plan was active on past days;
   - a notification when a rest timer ends while the phone is locked;
   - moving storage to IndexedDB for very long histories;
   - translations.

## Known limits

- Web reminders are per device. If a day is finished on another device, this one's evening check still comes unless its app was opened since (it then sees the synced day and tells the server). The texts kept for the service worker cover two weeks; after that without opening the app, reminders come with a plain text.
- On a slow connection, a phone updating from 1.x can show a blank screen for a few seconds the first time it opens 2.0. It reloads into 2.0 by itself once the new version has downloaded, and the 1.x copy keeps working offline until then.
- On-device AI only exists in desktop Chrome 148 or later.
- The Mac helper's Full Disk Access belongs to one signed program. It takes no options from outside, nothing Node.js reads from the environment it's started with makes it run other code or write files where that says, and macOS ties the permission to its signature, so a changed program loses it. But it's signed ad hoc, and macOS doesn't enforce the hardened runtime's library rules for ad-hoc signatures: a library put in with `DYLD_INSERT_LIBRARIES` runs inside it (the build's test shows this on GitHub's Macs). Signing it with a paid Apple Developer ID ($99 a year, which also ends the iPhone app's 7-day re-signing) would stop that. Also remaining: other apps running as that person can still read the pairing code (from the browser's saved data, or from `~/.arise-helper`) and use it to turn on anything the helper can read (messages, email and their words too) and get it, and they can read what waits for Arise in `~/.arise-helper`. The switches in Arise show what's on, whoever turned it on. The installer, its README and the Mac panel say so. Closing that would need the helper to tell Arise apart from other programs on the Mac, which a website can't prove.
- Between the installer's check and the moment the person gives Full Disk Access, another app running as them could put its own program at `~/.arise-helper/bin/arise-helper`, and macOS would give the permission to that one. In Terminal, the installer waits while they do it, then checks that the file is unchanged and that the helper has the permission, and says what to do if not. Closing it fully would need the program in a folder only an administrator can change, so an installer with admin rights.
- The helper is signed ad hoc (no paid Apple account), so each new build needs Full Disk Access again. A certificate of our own would keep it across updates, but then that certificate's key, if it ever leaked, would let anyone's program keep the permission too.
- Only Arise's website may talk to the Mac helper, and it's known by its origin, `https://abyyworld.github.io`. Every GitHub Pages site of the abyyworld account shares that origin, and with it Arise's saved pairing link. So don't publish any other GitHub Pages site from this account. To have one, first give Arise a domain of its own and change `ORIGIN` in `mac-helper/src/config.mjs` to it.
- If someone loses both their password and their recovery code, their cloud copy can't be opened by anyone. That's the price of nobody else being able to read it. Their device keeps its own copy, and backups still work.
- What the server can still see: the sign-in email (none with an account code), when a device syncs, the size of the encrypted data, and IP addresses. The AI proxy sees which account asked and when, never what was asked.
