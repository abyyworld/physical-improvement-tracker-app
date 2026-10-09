# Launching Arise 2.0, and what's next

Arise 2.0 turns the workout tracker into a private, self-updating app for any goal. This page lists what changed, what the owner has to do before it goes live (only someone with the accounts can do these steps), and what comes after.

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
5. **Check it live.** Open the site, make a new account with an email and another with **No email**, and sign in on a second device. Firebase must accept the no-email login form (`arise-xxxx-…@code.arise.invalid`); if it refuses that, change `CODE_DOMAIN` in `src/account.ts` to a domain you control that never receives mail. Then sign in with an older account: the first try says the password is wrong and offers "I made my account before Arise 2.0". Tick it and sign in again; it should show a recovery code and say it's now encrypted.

## Turning on the private AI

Done on 9 October 2026: the proxy runs at https://arise-ai.abyyworld.workers.dev and `src/ai-config.ts` points to it. To redo it (another Cloudflare or Tinfoil account, a new key), run the one command below again. Steps are in `worker/ai-proxy/README.md`:

1. Make a [Tinfoil](https://tinfoil.sh) account, set up billing, create an API key, and set a spending limit.
2. Make a free Cloudflare account and deploy the Worker in `worker/ai-proxy` with `wrangler`, adding the key as a secret.
3. Put the Worker's address in `src/ai-config.ts` (`proxy`), check the `model` is one Tinfoil serves, and push.

Costs: Tinfoil bills per token. With the default limits one very active account can make at most 150 requests a day.

**One command for both servers.** On a Mac, `bash scripts/setup-workers.sh` in a copy of the repo (a downloaded .zip works, no git needed) does step 2 for the AI proxy and also deploys the reminders server below. It logs in to Cloudflare once, asks for the Tinfoil key without showing it, and puts both addresses into `src/ai-config.ts` and `src/reminders-config.ts` on GitHub (with `gh`), or prints them. With Node.js older than 20 it fetches Node.js 22 for that run only.

## Turning on web reminders

Live since 2.3: the web app's notifications (a morning reminder and an evening check) come from a small Worker in `worker/reminders`, deployed at https://arise-reminders.abyyworld.workers.dev. It needs no keys and nothing to create first. Steps, to redo it, are in `worker/reminders/README.md`:

1. Deploy it (with `scripts/setup-workers.sh` above, or `npx -y wrangler@4 deploy` in `worker/reminders`).
2. Put its address in `src/reminders-config.ts` (`server`) and push.
3. Check it live: on an iPhone, add Arise to the Home Screen, open it from there, and turn on Settings, **Reminders**, **Notifications on this device**. Set the morning time a couple of minutes ahead and wait for it. Do the same on Android and on a laptop.

## Recommended soon after

- **Protect `main`.** Settings, Branches: require the **Checks** workflow and a pull request before merging.
- **Firebase App Check** (reCAPTCHA Enterprise for the web). It stops scripts from creating accounts and using the free quota. Turn it on in the Firebase console, then add it to `src/lib/firebase.ts`.
- **Budget alerts** in Google Cloud for the Firebase project, and in Tinfoil.
- **A privacy policy page on the website.** Done: [privacy.html](https://abyyworld.github.io/physical-improvement-tracker-app/privacy.html) (`public/privacy.html`), linked from Settings, Privacy and the README. It's needed before the app is listed anywhere. Keep it in step with the app whenever what the app keeps or sends changes. Before listing the app, add a private email for privacy requests to its Contact section. Until then, people ask in a GitHub issue and you reply with a private way to reach you.
- **Deleting an account for someone who can't sign in.** The policy promises this. In the Firebase console, under Authentication, find the sign-in email (`arise-xxxx-…@code.arise.invalid` for an account code) and copy its User UID. In Firestore, delete every document in `users/<UID>/arise` (`meta`, `keys`, `part0` and so on) and `recovery/<sign-in email>`. Then delete the user in Authentication. For an email account, only do this when the request comes from that address.
- **Deleting your own account and making it again with the same email, keeping the data.** First open Arise once on every device that has the account, after this version is live, so each one updates: a device that learns of the deletion while it still runs an older version can't tell that the account made again had its email, and signing in there then offers only to replace its data. On a device you can't update first, save a backup before signing in and load it afterwards. Then, in the app on the device with the newest data: Settings, Account, More, **Delete my account and cloud copy**, then **Create an account** with the same email (it takes the data on that device without asking). Each other device is signed out when it next syncs: sign in there with the new password and answer OK to "Add it to this account?".

## What's next

Roughly in order of value:

1. **Reminders for the web app.** Done in 2.3 (see [Turning on web reminders](#turning-on-web-reminders)). Push notifications to installed apps (iOS 16.4+, Android, desktop) from a small Worker with a Durable Object alarm. The server only knows a push address, a time zone, the reminder times and the last day done. The words stay on the device: the service worker shows texts the app left for it, so they're as personal as the iPhone app's.
2. **Browser tests in CI.** The real-browser checks used during this work (Playwright: the intro, ticking quests, the goal editor, workouts, offline, accessibility) can become a CI job.
3. **App lock.** An optional passcode or Face ID / Touch ID (WebAuthn) that also encrypts the data stored on the device, for people who share or lose their phone.
4. **A day off for quests.** Done in 2.2: the first missed day each week no longer breaks the streak (Settings, Streak). Each quest's own flame streak still counts every due day; it could get the free day too.
5. **AI on phones: not planned.** The private AI and people's own keys already cover phones, with much better answers than a model small enough to download. Worth another look only if the private AI's cost grows or people ask for offline answers.
6. **The iPhone app.** It updates itself since 2.1, but a free Apple ID still means re-signing it every 7 days. A paid Apple Developer account ($99 a year) makes a build last a year and opens up TestFlight.
7. **Accountability.** Share a goal's progress with a friend, end-to-end encrypted.
8. **Smaller items:**
   - streaks that remember which plan was active on past days;
   - a notification when a rest timer ends while the phone is locked;
   - moving storage to IndexedDB for very long histories;
   - translations.

## Known limits

- The private AI and the web app's notifications aren't live until the steps above are done.
- Web reminders are per device. If a day is finished on another device, this one's evening check still comes unless its app was opened since (it then sees the synced day and tells the server). The texts kept for the service worker cover two weeks; after that without opening the app, reminders come with a plain text.
- On a slow connection, a phone updating from 1.x can show a blank screen for a few seconds the first time it opens 2.0. It reloads into 2.0 by itself once the new version has downloaded, and the 1.x copy keeps working offline until then.
- On-device AI only exists in desktop Chrome 148 or later.
- If someone loses both their password and their recovery code, their cloud copy can't be opened by anyone. That's the price of nobody else being able to read it. Their device keeps its own copy, and backups still work.
- What the server can still see: the sign-in email (none with an account code), when a device syncs, the size of the encrypted data, and IP addresses. The AI proxy sees which account asked and when, never what was asked.
