// How Arise and the helper show each other they know the pairing code, without ever sending it.
//
// The helper listens on a fixed port of 127.0.0.1, and any program on the Mac, even another
// person's account, can listen there while the helper isn't running. So the code itself never
// crosses: whoever answers on that port learns nothing from a request, can't use one again, and
// can't fake an answer.
//
//   1. GET /v1/hello gives a fresh one-time number (nonce), good for a minute.
//   2. The request carries  Authorization: Arise <nonce>.<cnonce>.<mac>,  where cnonce is a
//      one-time number of the asker's own and mac = HMAC-SHA256(code, the lines of ask(...)):
//      what it asks for, and a hash of what it sends.
//   3. The answer carries  X-Arise-Proof: HMAC-SHA256(code, the lines of reply(...)),  over its
//      status and a hash of its body, so the asker knows it came from the helper with its code.
//
// src/life/mac-link.ts does the same in the browser (with WebCrypto); helper.mjs's `status` uses
// ask() below. The code is used as typed in normalizeCode's form: 20 characters, upper case.

import crypto from 'node:crypto';
import { normalizeCode } from './config.mjs';

export const HEADER = /^Arise ([0-9a-f]{32})\.([0-9a-f]{32})\.([0-9a-f]{64})$/;
export const NONCE = /^[0-9a-f]{32}$/;
export const PROOF = 'X-Arise-Proof';

export const newNonce = () => crypto.randomBytes(16).toString('hex');
const sha256 = (/** @type {string | Buffer} */ s) => crypto.createHash('sha256').update(s).digest('hex');
const hmac = (/** @type {string} */ code, /** @type {string[]} */ lines) => crypto.createHmac('sha256', code).update(lines.join('\n')).digest('hex');

/** @param {string} code @param {{ nonce: string, cnonce: string, method: string, path: string, body: string | Buffer }} a */
export const askMac = (code, { nonce, cnonce, method, path, body }) => hmac(code, ['arise-helper/1 ask', nonce, cnonce, method, path, sha256(body)]);

/** @param {string} code @param {{ nonce: string, cnonce: string, status: number, body: string }} a */
export const replyMac = (code, { nonce, cnonce, status, body }) => hmac(code, ['arise-helper/1 reply', nonce, cnonce, String(status), sha256(body)]);

// Same length hex, compared in constant time.
export function sameHex(a, b) {
  const x = Buffer.from(String(a), 'hex');
  const y = Buffer.from(String(b), 'hex');
  return x.length === 32 && y.length === 32 && crypto.timingSafeEqual(x, y);
}

/**
 * Asks the helper at `base` for `path`, as Arise does. Resolves with its answer, or rejects with an
 * Error whose `status` is the HTTP status (0: no answer, or not the helper with this code).
 * @param {string} base like http://127.0.0.1:47613
 * @param {string} typed the pairing code
 * @param {string} path like /v1/status
 * @param {unknown} [body] sent as JSON with POST; GET without
 * @param {Record<string, string>} [headers]
 */
export async function ask(base, typed, path, body, headers = {}) {
  const code = normalizeCode(typed);
  const fail = (status, why) => Object.assign(new Error(why), { status });
  for (let tries = 0; ; tries++) {
    const hello = await fetch(`${base}/v1/hello`, { headers });
    const nonce = hello.ok ? /** @type {any} */ (await hello.json().catch(() => null))?.nonce : null;
    if (typeof nonce !== 'string' || !NONCE.test(nonce)) throw fail(hello.ok ? 0 : hello.status, 'hello');
    const cnonce = newNonce();
    const method = body === undefined ? 'GET' : 'POST';
    const text = body === undefined ? '' : JSON.stringify(body);
    const mac = askMac(code, { nonce, cnonce, method, path, body: text });
    const r = await fetch(`${base}${path}`, {
      method,
      headers: { ...headers, Authorization: `Arise ${nonce}.${cnonce}.${mac}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : text,
    });
    const reply = await r.text();
    // The helper started again between the two: once more.
    if (r.status === 401 && tries === 0 && /"nonce"/.test(reply)) continue;
    if (r.status === 401 || r.status === 429) throw fail(r.status, 'code');
    if (!sameHex(r.headers.get(PROOF), replyMac(code, { nonce, cnonce, status: r.status, body: reply }))) throw fail(0, 'not the helper');
    if (!r.ok) throw fail(r.status, 'failed');
    return JSON.parse(reply);
  }
}
