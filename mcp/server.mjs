#!/usr/bin/env node
// Arise for AI apps: a small MCP server (stdio) that lets Claude Desktop, Cursor and other MCP
// clients know you, from an Arise me link. Read-only: it reads what you picked for that link in
// Arise (What Arise knows, Connected apps), and nothing else. Needs Node 20 or newer, no packages,
// and no secret beyond the link (ARISE_ME_LINK). Setup: mcp/README.md.
//
// MCP over stdio is JSON-RPC 2.0, one message per line. What it answers is in core.mjs, which the
// web connector (worker/connector) runs too.

import { realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createServer } from './core.mjs';

// The reader app makers use (public/me.js). Next to this file as me.mjs when only the two files
// were downloaded, or where it is in a copy of the repo.
async function loadReader() {
  for (const p of ['./me.mjs', '../public/me.js']) {
    try {
      return await import(new URL(p, import.meta.url).href);
    } catch (err) {
      if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
    }
  }
  throw new Error('me.js is missing. Keep this file in the mcp folder of Arise, or save me.js next to it as me.mjs.');
}

export { createServer, NAME, VERSION, SAY } from './core.mjs';

// Reads one message per line from stdin and answers on stdout. Nothing else goes to stdout.
export async function serve({ input = process.stdin, output = process.stdout, link = process.env.ARISE_ME_LINK || '' } = {}) {
  const { readMe } = await loadReader();
  const server = createServer({ link: link.trim(), read: (l) => readMe(l) });
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      output.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`);
      continue;
    }
    // One at a time is plenty, and keeps answers in order.
    const reply = await server.handle(msg).catch((err) => ({ jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32603, message: err?.message || 'Internal error' } }));
    if (reply) output.write(`${JSON.stringify(reply)}\n`);
  }
}

// Run as a program (node server.mjs), also through a symlink: Node gives this module its real
// path, and the command line the path as typed.
function isMain() {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  serve().catch((err) => {
    process.stderr.write(`${err?.stack || err}\n`);
    process.exit(1);
  });
}
