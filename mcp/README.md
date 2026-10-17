# Arise MCP server

Lets Claude Desktop, Cursor and other AI apps that use MCP know you, from an Arise me link. It reads only what you picked for that link, and it can't change anything in Arise.

Tools: `about_me` (your first name, About me and facts), `my_goals` (your goals, why they matter, streaks, and today's quests if you shared them) and `recent_days` (if you shared your last 7 days).

## Set it up

1. In Arise: What Arise knows, Connected apps, Connect an app. Call it "Claude", pick what it gets, then Make the link and Copy link.
2. Get the server. It needs Node 20 or newer, and nothing else. Use a copy of this repo, or save these two files in one folder:

   ```
   curl -O https://raw.githubusercontent.com/abyyworld/physical-improvement-tracker-app/main/mcp/server.mjs
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
