# Arise and Eternal: what's missing (November 2026)

Eternal (plans.eternal.uz) is a "life OS": plans and a calendar, your own database and AI keys,
an MCP server for ChatGPT, Claude and Gemini, sync on every device, and a guided setup page. This
list is what it does that Arise doesn't, or does worse, ranked by how much it would add to Arise.
Ideas only: nothing of Eternal's code, words, look or name is used.

Arise already does more in most places: an end-to-end encrypted cloud copy on every device, a
verified private AI, a life log fed by importers (Google, Maps, Spotify, Netflix, Apple Health,
WhatsApp, bank files), the iPhone and Android apps, a browser extension, the Mac helper, linked
Google, Microsoft, Steam and PlayStation accounts, goals and quests, a coach, reminders, sharing,
an app lock, and "me" links with a local MCP server for Claude Desktop and Cursor.

Effort: S about a day, M two to five days, L a week or more.

| # | Gap | What Arise does today | What to build | Privacy | Effort |
|---|---|---|---|---|---|
| 1 | **Claude and ChatGPT on the web** can use Eternal through a connector address. | Only desktop AI apps, through the local MCP server and a me link. claude.ai and chatgpt.com can't reach Arise. | A remote MCP connector (a Cloudflare Worker) that claude.ai, ChatGPT, Gemini and any MCP client can add by its address. It serves exactly what that app's me link holds, with `search` and `fetch` too (what ChatGPT expects). | **Less private**: the connector and the AI company read what the app gets. Off by default, per app, explained first. | M |
| 2 | **Access control per app**, managed in one place. | Per-app picks (what goes in, how private) and turning a link off. | For each app: on the web or not, an end date (7 days, 30 days, never), and whether it may add things. | Shrinks what leaks. | S |
| 3 | **What each app did**: Eternal says what each connection may reach; neither says what was read. | Nothing. | An access log for each app: what it read and when. Sealed with the link's key, so the server keeps only ciphertext. | Better than Eternal. | S |
| 4 | **The AI can add things**: Eternal's MCP works on your plans. | Read-only. | With the app's "may add notes" switch, the AI can add a note to your day ("log that I ran 5 km"). It arrives sealed and lands in the life log, marked with the app's name. | Off by default. | S-M |
| 5 | **One setup page** with the status of everything: what's required, recommended and optional, connected or not, and a check for each. | The Connect screen covers the phone, accounts, this computer and imports, but not the AI, the account and sync, the app lock, reminders or AI apps. Nothing says how far along you are. | A Setup and connections center: every part with its status, a "x of y set up" bar, the next step first, and a Check button where it can be checked. | Nothing new leaves the device. | M |
| 6 | **Plans: a to-do list and calendar** with dates. | Goals, daily quests, calendar events in the life log, reminders. No one-off tasks. | Tasks with an optional date and time, on Today and in the coach's context, synced end-to-end encrypted; the AI apps' connector can add tasks too. | E2E. | M-L |
| 7 | **Sign in with Google or Microsoft.** | Email and password, or an account code. | Opt-in, labelled **Less private** (Google or Microsoft learns you use Arise); the data key stays wrapped by a password the way it is now. Needs the owner to turn on the providers in Firebase. | Less private, opt-in. | M |
| 8 | **Meaning search** over everything you've logged. | The coach reads summaries and recent days. | Search the life log by meaning on the device (small embedding model in the browser), offered to the coach and, if allowed, to the connector. | On the device. | L |
| 9 | **Backgrounds you can choose**, and a no-motion option. | Light and dark looks. | A few calm backgrounds of Arise's own, and "no motion". | Local. | S |
| 10 | **Gemini** as a connector client. | — | Comes with #1: Gemini clients that speak MCP use the same address. | Less private. | — |

Not adopting: a database whose password the service keeps (Arise's server only ever holds
ciphertext); sending prompts to providers people didn't pick; driving a Gemini tab through the
extension; visitor analytics.

## Order of work

1. **Web connector with per-app control, access log and notes** (#1-4, #10): one release.
2. **Setup and connections center** (#5).
3. **Plans** (#6), then sign-in with Google or Microsoft (#7), backgrounds (#9) and meaning
   search (#8).

What shipped is in `src/changelog.ts`; the owner's steps for each are in `docs/LAUNCH.md`.
