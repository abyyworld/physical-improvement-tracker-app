# Arise's web connector

Arise for AI apps on the web: claude.ai, ChatGPT, Gemini and any app that takes a remote MCP server address (Streamable HTTP). It runs the same tools as the MCP server for desktop apps (`mcp/core.mjs`) for one app's me link, plus `search`, `fetch` and, if the person allowed it, `add_note`.

- **Address:** `https://arise-connector.<you>.workers.dev/mcp/<id>.<key>`, which Arise shows for each app once the web is on for it. The address holds the link's key, so it's the only secret.
- **Only when allowed:** a link's page works here only if it says so (`web` in the page, which only the person's account can write), and only until the date they picked.
- **What it keeps:** for each link, a log of which tools the app used and when, and the notes it added, sealed with keys made from the link's key (`src/lib/feed.ts`), plus a SHA-256 of the token Arise reads them with. Arise takes them and they're deleted; anything left goes after 60 days unused. No request logs.
- **Less private:** while it answers, this Worker (and Cloudflare) could read what that app gets. The app says so before it can be turned on.

## Set it up

`bash scripts/setup-workers.sh` deploys it with the other two Workers and puts its address into `src/connector-config.ts`. Nothing to create first: the Durable Object and rate limits come from `wrangler.toml`.

By hand: `cd worker/connector && npx -y wrangler@4 deploy`, then put the address it prints into `src/connector-config.ts`.

Check it: `curl https://arise-connector.<you>.workers.dev/health` answers `{"ok":true,"name":"arise-connector",…}`.
