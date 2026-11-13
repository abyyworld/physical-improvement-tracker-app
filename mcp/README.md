# Arise MCP server

Lets Claude Desktop, Cursor and other AI apps that use MCP know you, from an Arise me link. It reads only what you picked for that link, and it can't change anything in Arise.

For Claude, ChatGPT or Gemini **on the web**, you don't need this: see [Claude, ChatGPT and Gemini on the web](#claude-chatgpt-and-gemini-on-the-web) below.

Tools: `about_me` (your first name, About me and facts), `my_goals` (your goals, why they matter, streaks, and today's quests if you shared them) and `recent_days` (if you shared your last 7 days).

## Set it up

1. In Arise: What Arise knows, Connected apps, Connect an app. Call it "Claude", pick what it gets, then Make the link and Copy link.
2. Get the server. It needs Node 20 or newer, and nothing else. Use a copy of this repo, or save these three files in one folder:

   ```
   curl -O https://raw.githubusercontent.com/abyyworld/physical-improvement-tracker-app/main/mcp/server.mjs
   curl -O https://raw.githubusercontent.com/abyyworld/physical-improvement-tracker-app/main/mcp/core.mjs
   curl -o me.mjs https://abyyworld.github.io/physical-improvement-tracker-app/me.js
   ```

3. Claude Desktop: Settings, Developer, Edit Config. Add this to `claude_desktop_config.json`, with the full path to `server.mjs` and your link. Then restart Claude Desktop.

   ```json
   {
     "mcpServers": {
       "arise": {
         "command": "node",
         "args": ["/full/path/to/server.mjs"],
         "env": { "ARISE_ME_LINK": "https://abyyworld.github.io/physical-improvement-tracker-app/#me=PASTE-THE-REST" }
       }
     }
   }
   ```

   Cursor and other MCP apps take the same command, args and env.

Keep the link private, like a password: whoever has it can read what's in it. To stop it, turn the link off in Arise. The link format is in [docs/ME-LINK.md](../docs/ME-LINK.md).

## Claude, ChatGPT and Gemini on the web

AI apps on the web can't run a program on your computer, so Arise has a connector for them: a small server ([worker/connector](../worker/connector)) that answers them for one app's link. It's **less private**, so it's off until you turn it on, for each app on its own:

1. In Arise: What Arise knows, Connected apps. Connect an app (call it "Claude", say), or open one you have.
2. Under **Use it on the web**, read what it means, pick whether the app may add notes to your days and for how long (a week, a month or no end), then **Turn it on**.
3. Copy the **connector address** and add it to the app:
   - **Claude** (claude.ai, and the Claude apps): Settings, Connectors, Add custom connector. Paste the address.
   - **ChatGPT**: Settings, Apps and connectors, Advanced settings, turn on Developer mode. Then Create, paste the address, and pick No authentication.
   - **Gemini and others**: anywhere that takes a remote MCP server address (Streamable HTTP).

Tools: `about_me`, `my_goals` and `recent_days` as above, `search` and `fetch` (what ChatGPT looks for), and `add_note` if you allowed notes. Notes show up in your day the next time you open Arise, marked with the app's name.

Arise shows what each app did (**What it did**) and when. **Why it's less private:** to answer, the connector opens your link's page for a moment, so it and Cloudflare could read what that app gets, and the AI company gets what its app reads. The connector keeps none of it, only that log and any notes, sealed with keys made from your link so only your Arise can read them, and deletes them once your Arise has them (or after 60 days unused). Everything else in Arise stays end-to-end encrypted. Keep the address private, like a password; **Turn off on the web** stops it at once.
