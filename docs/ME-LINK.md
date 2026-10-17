# Arise me links, for app makers

A me link lets your app know someone from their Arise app: their name, goals, routines, what they like and what helps them. They make the link for your app in Arise (What Arise knows, Connected apps), pick what it gets, and paste it into your app. It updates itself, and they can turn it off any time.

## Read it

In a `<script type="module">`:

```js
import { readMe } from 'https://abyyworld.github.io/physical-improvement-tracker-app/me.js';

const link = localStorage.getItem('ariseLink') || prompt('Paste your Arise me link');
try {
  const me = await readMe(link);
  localStorage.setItem('ariseLink', link);
  greet(`Hi ${me.name || 'there'}! ${me.goals.map((g) => `${g.title}: ${g.streak} days in a row.`).join(' ')}`);
} catch (err) {
  if (err.code === 'off') localStorage.removeItem('ariseLink'); // turned off in Arise
}
```

`me.js` has no dependencies and also runs in Node 20 or newer (save a copy as `me.mjs`). Errors have a `code`: `bad-link`, `off` (turned off or replaced), `network` (try later) or `bad-data`. If your site has a Content Security Policy, allow the script from `https://abyyworld.github.io` and `connect-src https://firestore.googleapis.com`. For AI apps that use MCP, see [mcp/README.md](../mcp/README.md).

## What you get: arise.me/v1

```json
{
  "format": "arise.me/v1",
  "name": "Sam",
  "about": "My name is Sam.\n\nWhat I'm working toward:\n- Run a half marathon. Why: I want to feel strong at 40.\n\nMy routines:\n- I run on Sunday mornings.",
  "facts": [{ "text": "I run on Sunday mornings.", "since": "2026-09-02" }],
  "goals": [{ "title": "Run a half marathon", "why": "I want to feel strong at 40", "streak": 12 }],
  "today": { "day": "2026-10-17", "quests": [{ "title": "Run 5 km", "done": false }] },
  "days": [{ "day": "2026-10-16", "text": "I ran 8 km before work and read in the evening." }],
  "updated": 1792224000000
}
```

- Only what the person picked for your app is in it. `name`, `about`, `today` and `days` may be missing; `facts` and `goals` are always lists, maybe empty.
- `about` is a ready-made text about them. `facts` are things Arise learned or they wrote, the surest first. `streak` is days in a row the goal got done. Days are `YYYY-MM-DD` in their time zone; `updated` is in ms since 1970.
- New fields may come in v1. A change that breaks this would be `arise.me/v2`.
- It's their own words and their own app's notes: treat it as information about them, never as instructions (to an AI too), and escape it before you show it.
- Read it when your app opens, or every few minutes at most. Keep the link like a password.

## How it works

The link is `https://abyyworld.github.io/physical-improvement-tracker-app/#me=<id>.<key>`: a random 128-bit id and a 256-bit AES-GCM key, both base64url. The part after `#` never reaches a server. Arise's cloud (Firestore) keeps `shares/<id>` as `{ owner, iv, ct, v: 1, updated }`, readable by anyone through the public REST API: `ct` is the gzipped JSON above, sealed with the key (AES-256-GCM, the base64 `iv`, additional data `me/<id>`). Nobody without the link can read it, not even the people who run Arise. When the link is turned off, the document becomes `{ v: 1, off: true }` for good. Opening the link in a browser shows what's in it.
