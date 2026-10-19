# Private AI proxy

Arise's private AI is an open model running in [Tinfoil](https://tinfoil.sh)'s secure enclaves (confidential-computing GPUs). Before the app sends anything, it checks the enclave's attestation: that it's running the exact published code and model, on genuine confidential-computing hardware. It then encrypts each request body to that enclave's key ([EHBP](https://github.com/tinfoilsh/encrypted-http-body-protocol)). Nothing in between can read it: not this proxy, not Cloudflare, not Tinfoil's operators, not the people who run Arise.

This Worker sits between the app and the enclave because the Tinfoil API key must not ship inside the app. It:

- checks the request comes from a signed-in Arise account (a Firebase ID token),
- limits use: 20 requests a minute per account, 60 per IP address, and a day per account 5 without Arise Private or 150 with it (see below),
- swaps the account token for the Tinfoil API key,
- passes the encrypted body to the enclave and the encrypted answer back, untouched.

It only ever forwards to `*.tinfoil.sh`, keeps no logs, and can't decrypt anything. What it does see: which account asked (the Firebase ID token it checks includes the sign-in email), from which IP, when, and how big the request was. All it keeps is each account's count for the day, deleted at midnight UTC, and for an account that has (or had) Arise Private, the small record below.

## Arise Private (the paid plan)

Everyone signed in gets `PRIVATE_FREE_LIMIT` (default 5) private AI questions a day. Arise Private, sold by [Lemon Squeezy](https://www.lemonsqueezy.com) for $5 a month or $48 a year, gives an account the whole `DAILY_LIMIT` (default 150, for fair use). Both are counted on the same counter, so buying it partway through a day carries on from there. A request the enclave doesn't answer (an error, or the enclave can't be reached) gives its one back.

- **`POST /billing/lemon`**: Lemon Squeezy's webhook. No CORS and no sign-in: it checks the `X-Signature` header, the hex HMAC-SHA256 of the raw body with `LEMON_WEBHOOK_SECRET` (compared in constant time), and refuses everything (401) while that secret isn't set. It takes the `subscription_*` events, finds the account in `meta.custom_data.uid` (the app adds it to the checkout link), and keeps the subscription's `status`, `variant_name`, `renews_at`, `ends_at`, `urls.customer_portal` and `updated_at` in that account's `Plan` Durable Object. A message older than what it has (by `updated_at`) changes nothing. `subscription_payment_success` carries the invoice, not the subscription, so it changes nothing (Lemon Squeezy sends `subscription_updated` with it). Answers 200, or 400/401 for something it can't use.
- The plan counts as active when its status is `active`, `on_trial` or `past_due`, or `cancelled` with `ends_at` still ahead.
- **`GET /v1/plan`** (signed in, CORS like the rest, not counted): `{ plan: 'private' | 'free', left, limit, renewsAt, endsAt, portal, checkout: { monthly, yearly } }`. The checkout links are `LEMON_CHECKOUT_MONTHLY` and `LEMON_CHECKOUT_YEARLY` (empty until they're set; the app then says "Arise Private is coming soon").
- When an account without the plan has used its free questions, the private AI answers 429 with `{ error: { message, code: 'plan' }, code: 'plan' }`: "You've used today's 5 free private questions. Arise Private gives you the private AI all day for $5 a month." (Or, before the checkout links are set, that they start again at midnight UTC.) The app shows it with a button to get the plan, and lets the AI on the device answer if there is one.
- The record per account: its status, the variant, when it renews or ends, the link to manage it, and when Lemon Squeezy last changed it. No name, no email, no card. It's deleted 30 days after the plan ends.

The three Lemon Squeezy settings are Worker secrets, so a deploy never clears them: `scripts/setup-workers.sh` asks for them (Return keeps what's there), or `wrangler secret put LEMON_WEBHOOK_SECRET` (and `LEMON_CHECKOUT_MONTHLY`, `LEMON_CHECKOUT_YEARLY`) from this folder. The steps in Lemon Squeezy are in `docs/LAUNCH.md`, Selling Arise Private.

## The free AI (less private)

The same Worker also serves a free option at `/free/v1/chat/completions` (and `/free/v1/models`, which lists the models it takes). It runs `@cf/openai/gpt-oss-120b`, or `@cf/openai/gpt-oss-20b` if the Player picks it, on [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/) through the `AI` binding in `wrangler.toml`. The app only uses it when the Player picks it and says yes to it being less private: the body isn't encrypted to an enclave, so Cloudflare's servers read it to answer (and this Worker parses it to pass it on).

- Same sign-in check, CORS and per-minute limits as the private AI.
- Its own daily allowance per account, `FREE_DAILY_LIMIT` (default 15), counted apart from the private AI's (`free:<account>` in the same `Quota` counter, also deleted at midnight UTC). A request Workers AI refuses, or makes on a day its allocation is gone, gives its one back.
- It passes on only `messages`, `stream`, `stream_options`, `response_format`, `max_tokens`, `temperature` and `reasoning_effort`, and only uses a model on its list (`FREE_MODELS` in `src/index.ts`, the first is the default). Any other model the app asks for gets the default. gpt-oss-20b uses less of the free allowance for each answer than gpt-oss-120b.
- One request can be at most 100,000 characters (a 413 otherwise), and gets at most 8,000 tokens out (`max_tokens`, also the default).
- When Workers AI's daily allocation is used up, or it's busy, the app gets a 429 with a plain message, like "The free AI has used up today's allowance. It resets at midnight UTC."

Costs: on the Workers Free plan, Workers AI gives 10,000 neurons a day, shared by everyone using the free AI, and it stops when they're used up (until 00:00 UTC). A typical coach request is about 5,000 to 8,000 tokens in plus the answer, roughly 200 to 300 neurons, so that's about 30 to 50 requests a day for all Players together (worked out from Cloudflare's prices, not measured). `FREE_DAILY_LIMIT` and the size caps limit what one account can use, but a few active Players can still use up the day. For more, move to the Workers Paid plan, which bills for neurons above the free 10,000 a day, and set a budget alert in Cloudflare.

## Setting it up (once)

You need a Tinfoil account with an API key and billing set up, and a free Cloudflare account.

1. Install and log in: `npm i -g wrangler` then `wrangler login`.
2. From this folder: `wrangler secret put TINFOIL_API_KEY` and paste the key.
3. Check `wrangler.toml`: `FIREBASE_PROJECT_ID` is the Firebase project, `ALLOWED_ORIGINS` lists where the app runs (the GitHub Pages address, `capacitor://localhost` for the iPhone app, `https://localhost` for the Android app, and `http://localhost:5173` for development), `DAILY_LIMIT` is the per-account daily allowance for the private AI with Arise Private, `PRIVATE_FREE_LIMIT` the one without it, and `FREE_DAILY_LIMIT` the one for the free AI. The `[ai]` binding needs nothing else: Workers AI comes with every Cloudflare account.
4. Deploy: `wrangler deploy`. It prints the Worker's address, like `https://arise-ai.<you>.workers.dev`.
5. In `src/ai-config.ts`, set `proxy` to that address plus `/v1/` (for example `https://arise-ai.<you>.workers.dev/v1/`), and check `model` is one Tinfoil currently serves. The app finds the free AI at the same address plus `/free/v1`. Push to `main`; every installed app picks it up by itself.

Costs: Tinfoil bills per token for the model you pick. With the default limits, one very active account can make at most 5 requests a day, or 150 with Arise Private; set a spending limit in Tinfoil's dashboard too. Cloudflare's free plan covers 100,000 requests a day.

## Testing

`npm test` in the repo root runs this Worker's tests (`worker/ai-proxy/src/index.test.ts`) along with the app's: token checks, the enclave allowlist, CORS, the rate limits and the daily allowance, Arise Private (the webhook's signature, statuses and order, the two daily limits, `/v1/plan` and the record kept), and for the free AI (with a stand-in for Workers AI) the sign-in, the allowed fields and models, its own allowance, streaming and the error messages.
