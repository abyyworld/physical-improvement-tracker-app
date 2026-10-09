# Reminders server

The iPhone app plans its notifications on the phone itself. A web app can't, so this small Cloudflare Worker sends the web app's reminders with Web Push: a morning reminder at the time each person picks, and an evening check on days that aren't done yet. It works for the app installed from the website on iPhone and iPad (iOS 16.4 or later, from the Home Screen), on Android, and in desktop Chrome, Edge, Firefox and Safari.

## What it knows, and what it doesn't

For each device that turns reminders on, it keeps:

- the push address the browser gave it, and the keys to encrypt to that browser,
- the device's time zone, its reminder times and which weekdays have anything due,
- the last day the app said was done, so that day's evening check is skipped.

That's all. No account, no name, no goals, and nothing about what a reminder says. A push carries only which reminder it is and the date (`{"kind": "morning", "date": "2026-10-09"}`), encrypted so only that browser can read it (RFC 8291). The words come from the device: the app keeps the next two weeks of its reminder texts in its own cache, and the service worker shows the one for the push it gets.

The push itself is delivered by the push service of the browser's maker: Apple for Safari and the iPhone, Google for Chrome and most others, Mozilla for Firefox, Microsoft for Edge on Windows. It only ever sends to those, never to any other address. It keeps no logs. A device's record is deleted when the app turns reminders off, and when the push service says the address is gone (the app or browser was removed, or notifications were turned off).

## How it works

- One Durable Object holds every device in its own SQLite database. Each device has its next reminder time worked out in UTC from its time zone, so a 07:30 reminder stays at 07:30 when the clocks change (`src/schedule.ts`).
- An alarm is set for the next reminder due. When it goes off, it sends what's due (40 at a time) and sets the alarm again. No cron, nothing to create first.
- The first time it's needed, it makes its own VAPID key pair (RFC 8292) and keeps it. The app gets the public key from `GET /v1/vapid`. There's no secret to set up. (If the Durable Object's data were ever lost, each app signs up again by itself, with the new key, the next time it has something to tell the server.)
- Messages are encrypted and signed with nothing but WebCrypto (`src/webpush.ts`).

The app talks to it with JSON:

| Request | What it does |
| --- | --- |
| `GET /v1/vapid` | The server's public key, `{key}`. |
| `POST /v1/subscribe` | `{subscription, tz, morning, evening, days?}` signs a device up and returns `{id, token}`. `evening` is `null` for no evening check; `days` lists weekdays from 0 (Sunday) to 6. |
| `POST /v1/update` | `{id, token, tz, morning, evening, days?, subscription?}` changes the times, or the push address. |
| `POST /v1/unsubscribe` | `{id, token}` forgets the device. |
| `POST /v1/done` | `{id, token, date, done?}` says a day is done (`done: false` says it isn't after all). What's left of that day is skipped. |

The token is a random secret only the device has (the server keeps a hash of it). Everything is checked strictly, only the app's own websites may call it, and each IP address can make 30 requests a minute.

## Setting it up (once)

You need a free Cloudflare account. Nothing else: no keys, no database to create.

The quick way, for both Workers at once, is `scripts/setup-workers.sh` in the repo (see the main README). By hand:

1. From this folder: `npx -y wrangler@4 login`, then `npx -y wrangler@4 deploy`. It prints the Worker's address, like `https://arise-reminders.<you>.workers.dev`.
2. Check `wrangler.toml`: `ALLOWED_ORIGINS` lists where the app runs (the GitHub Pages address, and `http://localhost:5173` for development), `CONTACT` is where push services can reach you, and `MAX_SUBSCRIPTIONS` caps how many devices it takes.
3. In `src/reminders-config.ts`, set `server` to that address. Push to `main`; every installed app picks it up by itself, and Settings, **Reminders** shows **Notifications on this device**.

Costs: Cloudflare's free plan covers it for a small app. Each device makes two pushes a day at most, plus a few requests when its times change.

## Testing

`npm test` in the repo root runs this Worker's tests along with the app's:

- `src/webpush.test.ts`: the encryption against RFC 8291's own example, a browser decrypting what it gets, and VAPID signatures that check out with the public key.
- `src/schedule.test.ts`: local times in many time zones, through clocks going forward and back.
- `src/index.test.ts`: what it accepts (push services only), CORS, the rate limit and the cap, tokens, sending at the right times, `/done` skipping the evening check, and forgetting addresses the push service says are gone.

`npx -y wrangler@4 deploy --dry-run` checks it builds, without deploying.
