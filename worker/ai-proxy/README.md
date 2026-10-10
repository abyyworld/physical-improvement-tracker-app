# Private AI proxy

Arise's private AI is an open model running in [Tinfoil](https://tinfoil.sh)'s secure enclaves (confidential-computing GPUs). Before the app sends anything, it checks the enclave's attestation: that it's running the exact published code and model, on genuine confidential-computing hardware. It then encrypts each request body to that enclave's key ([EHBP](https://github.com/tinfoilsh/encrypted-http-body-protocol)). Nothing in between can read it: not this proxy, not Cloudflare, not Tinfoil's operators, not the people who run Arise.

This Worker sits between the app and the enclave because the Tinfoil API key must not ship inside the app. It:

- checks the request comes from a signed-in Arise account (a Firebase ID token),
- limits use: 20 requests a minute per account, 60 per IP address, 150 a day per account,
- swaps the account token for the Tinfoil API key,
- passes the encrypted body to the enclave and the encrypted answer back, untouched.

It only ever forwards to `*.tinfoil.sh`, keeps no logs, and can't decrypt anything. What it does see: which account asked (the Firebase ID token it checks includes the sign-in email), from which IP, when, and how big the request was. All it keeps is each account's count for the day, deleted at midnight UTC.

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
3. Check `wrangler.toml`: `FIREBASE_PROJECT_ID` is the Firebase project, `ALLOWED_ORIGINS` lists where the app runs (the GitHub Pages address, `capacitor://localhost` for the iPhone app, and `http://localhost:5173` for development), `DAILY_LIMIT` is the per-account daily allowance for the private AI, and `FREE_DAILY_LIMIT` the one for the free AI. The `[ai]` binding needs nothing else: Workers AI comes with every Cloudflare account.
4. Deploy: `wrangler deploy`. It prints the Worker's address, like `https://arise-ai.<you>.workers.dev`.
5. In `src/ai-config.ts`, set `proxy` to that address plus `/v1/` (for example `https://arise-ai.<you>.workers.dev/v1/`), and check `model` is one Tinfoil currently serves. The app finds the free AI at the same address plus `/free/v1`. Push to `main`; every installed app picks it up by itself.

Costs: Tinfoil bills per token for the model you pick. With the default limits, one very active account can make at most 150 requests a day; set a spending limit in Tinfoil's dashboard too. Cloudflare's free plan covers 100,000 requests a day.

## Testing

`npm test` in the repo root runs this Worker's tests (`worker/ai-proxy/src/index.test.ts`) along with the app's: token checks, the enclave allowlist, CORS, the rate limits and the daily allowance, and for the free AI (with a stand-in for Workers AI) the sign-in, the allowed fields and models, its own allowance, streaming and the error messages.
