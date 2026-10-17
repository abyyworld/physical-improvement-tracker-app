// The helper's small web server, for Arise open in a browser on this Mac.
//
// - It listens on 127.0.0.1 only: nothing on the network can reach it.
// - The Host must be 127.0.0.1 or localhost on its port, so a website can't reach it through a
//   name of its own that points here (DNS rebinding).
// - A browser only lets the Arise website read its answers (CORS for that one origin), and every
//   request needs the pairing code (Authorization: Bearer <code>). Sending that header makes the
//   browser ask first (a preflight), which only Arise's origin passes, so other websites can't even
//   send a request with a code to guess.
// - Chrome's Private Network Access preflight (a public website asking to reach this computer) is
//   answered with Access-Control-Allow-Private-Network. Newer Chrome asks the person instead.
// - Too many wrong codes in a minute and it stops checking codes for a minute.

import crypto from 'node:crypto';
import http from 'node:http';
import { normalizeCode } from './config.mjs';

const MAX_BODY = 16 * 1024;
const MAX_FAILS = 20;

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
  const digest = (s) => crypto.createHash('sha256').update(s).digest();

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
    const cors = origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : { Vary: 'Origin' };

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
    fails = fails.filter((f) => t - f < 60000);
    if (fails.length >= MAX_FAILS) return send(res, 429, { error: 'wait' }, cors);
    const auth = String(req.headers.authorization || '');
    const given = auth.startsWith('Bearer ') ? normalizeCode(auth.slice(7)) : '';
    const want = code();
    if (!given || !want || !crypto.timingSafeEqual(digest(given), digest(want))) {
      fails.push(t);
      return send(res, 401, { error: 'code' }, cors);
    }

    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const route = `${req.method} ${url.pathname}`;
    if (route === 'GET /v1/status') return send(res, 200, await handlers.status(), cors);
    if (route === 'GET /v1/events') {
      const after = Math.max(0, Number(url.searchParams.get('after')) || 0);
      const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 500));
      return send(res, 200, await handlers.events(after, limit), cors);
    }
    if (route === 'POST /v1/settings' || route === 'POST /v1/ack') {
      const body = await readBody(req);
      if (body === undefined) return send(res, 400, { error: 'body' }, cors);
      if (route === 'POST /v1/settings') return send(res, 200, await handlers.settings(body), cors);
      const upTo = Number(body?.upTo);
      if (!Number.isFinite(upTo) || upTo < 0) return send(res, 400, { error: 'upTo' }, cors);
      return send(res, 200, await handlers.ack(upTo), cors);
    }
    return send(res, 404, { error: 'not found' }, cors);
  }

  return server;
}

// JSON of at most 16 KB, or undefined.
/** @param {http.IncomingMessage} req */
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
      if (done) return;
      try {
        resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'));
      } catch {
        resolve(undefined);
      }
    });
    req.on('error', () => !done && resolve(undefined));
  });
}

/** @param {http.ServerResponse} res @param {number} status @param {any} body @param {Record<string, string>} [extra] */
function send(res, status, body, extra = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  });
  res.end(JSON.stringify(body));
}
