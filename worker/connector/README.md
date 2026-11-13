# Arise's web connector

Arise for AI apps on the web: claude.ai, ChatGPT, Gemini and any app that takes a remote MCP server address (Streamable HTTP). It runs the same tools as the MCP server for desktop apps (`mcp/core.mjs`) for one app's me link, plus `search`, `fetch` and, if the person allowed it, `add_note`.

- **Address:** `https://arise-connector.<you>.workers.dev/mcp/<id>.<key>`, which Arise shows for each app once the web is on for it. It's a page of its own (a `shares/<id>` page like a me link's), apart from the app's link, so the AI app never gets the link. Turning the web off empties that page for good; so does Arise after the end date. The address is the only secret.
- **Only when allowed:** a page works here only if it says so (`web` in the page, which only the person's account can write), and only until the date they picked.
- **What it keeps:** for each address, a log of which tools the app used and when, and the notes it added, sealed with a key made from the page's key (`src/lib/feed.ts`). Reading the log back, or letting it go, needs a token only the person's Arise has; the page holds its SHA-256, and the connector checks against that, so the AI app can't read or wipe its own log. Arise takes them and they're deleted; anything left goes after 60 days unused (only a count stays). No request logs.
- **Less private:** while it answers, this Worker (and Cloudflare) could read what that app gets. The app says so before it can be turned on.

## Set it up

`bash scripts/setup-workers.sh` deploys it with the other two Workers and puts its address into `src/connector-config.ts`. Nothing to create first: the Durable Object and rate limits come from `wrangler.toml`.

By hand: `cd worker/connector && npx -y wrangler@4 deploy`, then put the address it prints into `src/connector-config.ts`.

Check it: `curl https://arise-connector.<you>.workers.dev/health` answers `{"ok":true,"name":"arise-connector",…}`.
