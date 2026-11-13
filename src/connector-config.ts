// Arise for AI apps on the web (claude.ai, ChatGPT, Gemini) goes through the small connector in
// worker/connector. `server` is its address once it's deployed (scripts/setup-workers.sh puts it
// here), like https://arise-connector.<you>.workers.dev. Until it answers, Arise says the web
// isn't ready yet and offers only the desktop apps' way (mcp/).

export const CONNECTOR = {
  server: 'https://arise-connector.abyyworld.workers.dev',
};
