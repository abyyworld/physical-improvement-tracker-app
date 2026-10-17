// The helper's small web server, for Arise open in a browser on this Mac.
//
// - It listens on 127.0.0.1 only: nothing on the network can reach it.
// - The Host must be 127.0.0.1 or localhost on its port, so a website can't reach it through a
//   name of its own that points here (DNS rebinding).
// - A browser only lets the Arise website read its answers (CORS for that one origin), and every
//   request but /v1/hello needs proof of the pairing code (auth.mjs: the code itself is never
//   sent, and each answer proves it came from the helper). Sending that Authorization header makes
//   the browser ask first (a preflight), which only Arise's origin passes, so other websites can't
//   even send a guess.
// - Chrome's Private Network Access preflight (a public website asking to reach this computer) is
//   answered with Access-Control-Allow-Private-Network. Newer Chrome asks the person instead.
// - After 20 wrong codes in a minute, wrong ones are turned away for that minute without being
//   checked. The right code always works, and a request with no code at all (any web page can send
//   those, as an image) isn't a wrong code, so none of that can lock Arise out.

import http from 'node:http';
import { HEADER, PROOF, askMac, newNonce, replyMac, sameHex } from './auth.mjs';

const MAX_BODY = 16 * 1024;
const MAX_FAILS = 20;
const NONCE_LIFE = 60000;
const MAX_NONCES = 100;

/**
 * @typedef {{
 *   status(): any,
 *   settings(body: any): any,
 *   events(after: number, limit: number): any,
 *   ack(upTo: number): any,
 * }} Handlers
 */

/**
 * @param {{ origins: string[], code: () => string, handlers: Handlers, now?: () => number, log?: (s: string) => void }} opts
 */
export function createServer({ origins, code, handlers, now = Date.now, log = () => {} }) {
  /** @type {number[]} */
  let fails = [];
  // One-time numbers handed out by /v1/hello, and when.
  /** @type {Map<string, number>} */
  const nonces = new Map();

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      log(`Request failed: ${e?.message || e}`);
      if (!res.headersSent) send(res, 500, { error: 'failed' });
      else res.end();
    });
  });

  /** @param {http.IncomingMessage} req @param {http.ServerResponse} res */
  async function handle(req, res) {
    const addr = server.address();
    const port = addr && typeof addr === 'object' ? addr.port : 0;
    const host = String(req.headers.host || '').toLowerCase();
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(res, 403, { error: 'host' });

    // Only Arise, or no browser at all (curl, the helper's own status command).
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
    if (origin && !origins.includes(origin)) return send(res, 403, { error: 'origin' });
    /** @type {Record<string, string>} */
    const cors = origin ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Expose-Headers': PROOF, Vary: 'Origin' } : { Vary: 'Origin' };

    if (req.method === 'OPTIONS') {
      const h = {
        ...cors,
        'Access-Control-Allow-Methods': 'GET, POST',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Max-Age': '600',
      };
      if (String(req.headers['access-control-request-private-network']).toLowerCase() === 'true') h['Access-Control-Allow-Private-Network'] = 'true';
      res.writeHead(204, h);
      return res.end();
    }

    const t = now();
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const route = `${req.method} ${url.pathname}`;
    if (route === 'GET /v1/hello') {
      for (const [n, at] of nonces) {
        if (t - at < NONCE_LIFE && nonces.size < MAX_NONCES) break;
        nonces.delete(n);
      }
      const nonce = newNonce();
      nonces.set(nonce, t);
      return send(res, 200, { app: 'arise-helper', nonce }, cors);
    }

    // No proof at all isn't a wrong code: it doesn't count.
    const m = HEADER.exec(String(req.headers.authorization || ''));
    if (!m) return send(res, 401, { error: 'code' }, cors);
    const [, nonce, cnonce, mac] = m;
    const issued = nonces.get(nonce);
    nonces.delete(nonce);
    if (issued === undefined || t - issued >= NONCE_LIFE) return send(res, 401, { error: 'nonce' }, cors);
    const raw = req.method === 'POST' ? await readBody(req) : Buffer.alloc(0);
    if (raw === undefined) return send(res, 400, { error: 'body' }, cors);
    const want = code();
    if (!want || !sameHex(mac, askMac(want, { nonce, cnonce, method: String(req.method), path: req.url || '/', body: raw }))) {
      fails = fails.filter((f) => t - f < 60000);
      if (fails.length >= MAX_FAILS) return send(res, 429, { error: 'wait' }, cors);
      fails.push(t);
      return send(res, 401, { error: 'code' }, cors);
    }
    // Every answer from here on proves it comes from the helper with this code.
    const reply = (/** @type {number} */ status, /** @type {any} */ body) => send(res, status, body, cors, (text) => replyMac(want, { nonce, cnonce, status, body: text }));

    if (route === 'GET /v1/status') return reply(200, await handlers.status());
    if (route === 'GET /v1/events') {
      const after = Math.max(0, Number(url.searchParams.get('after')) || 0);
      const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 500));
      return reply(200, await handlers.events(after, limit));
    }
    if (route === 'POST /v1/settings' || route === 'POST /v1/ack') {
      const body = json(raw);
      if (body === undefined) return reply(400, { error: 'body' });
      if (route === 'POST /v1/settings') return reply(200, await handlers.settings(body));
      const upTo = Number(body?.upTo);
      if (!Number.isFinite(upTo) || upTo < 0) return reply(400, { error: 'upTo' });
      return reply(200, await handlers.ack(upTo));
    }
    return reply(404, { error: 'not found' });
  }

  return server;
}

/** @param {Buffer} raw */
function json(raw) {
  try {
    return JSON.parse(raw.toString('utf8') || '{}');
  } catch {
    return undefined;
  }
}

// The body as sent, at most 16 KB, or undefined.
/** @param {http.IncomingMessage} req @returns {Promise<Buffer | undefined>} */
function readBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    /** @type {Buffer[]} */
    const parts = [];
    let done = false;
    req.on('data', (chunk) => {
      if (done) return; // too big: the rest is read and thrown away
      size += chunk.length;
      if (size > MAX_BODY) {
        done = true;
        parts.length = 0;
        resolve(undefined);
      } else parts.push(chunk);
    });
    req.on('end', () => {
      if (!done) resolve(Buffer.concat(parts));
    });
    req.on('error', () => !done && resolve(undefined));
  });
}

/**
 * @param {http.ServerResponse} res @param {number} status @param {any} body @param {Record<string, string>} [extra]
 * @param {(text: string) => string} [prove] the proof for this answer
 */
function send(res, status, body, extra = {}, prove) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
    ...(prove ? { [PROOF]: prove(text) } : {}),
  });
  res.end(text);
}
