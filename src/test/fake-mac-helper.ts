// The front door of a pretend Mac helper, for tests of src/life: like mac-helper/src/server.mjs, it
// hands out one-time numbers at /v1/hello, checks each request's proof of the pairing code (with the
// helper's own auth.mjs), and proves each answer. What the answer says is up to the test.

import { HEADER, askMac, newNonce, replyMac, sameHex } from '../../mac-helper/src/auth.mjs';

export interface Asked {
  method: string;
  path: string;
  auth: string | null;
  body: unknown;
}

export interface Answer {
  status?: number;
  body: unknown;
}

// A fetch for useHelper(). `answer` gets each request that proved `code`; any other gets 401.
export function helperFetch(code: string, answer: (a: Asked) => Answer, asked: Asked[] = []) {
  const nonces = new Set<string>();
  return async (url: string | URL | Request, init: RequestInit = {}) => {
    const u = new URL(String(url));
    if (u.pathname === '/v1/hello') {
      const nonce = newNonce();
      nonces.add(nonce);
      return new Response(JSON.stringify({ app: 'arise-helper', nonce }), { status: 200 });
    }
    const method = init.method || 'GET';
    const path = u.pathname + u.search;
    const auth = new Headers(init.headers).get('authorization');
    const text = init.body ? String(init.body) : '';
    const a: Asked = { method, path, auth, body: text ? JSON.parse(text) : undefined };
    asked.push(a);
    const m = HEADER.exec(auth || '');
    if (!m || !nonces.delete(m[1]) || !sameHex(m[3], askMac(code, { nonce: m[1], cnonce: m[2], method, path, body: text }))) {
      return new Response(JSON.stringify({ error: 'code' }), { status: 401 });
    }
    const { status = 200, body } = answer(a);
    const reply = JSON.stringify(body);
    return new Response(reply, { status, headers: { 'content-type': 'application/json', 'X-Arise-Proof': replyMac(code, { nonce: m[1], cnonce: m[2], status, body: reply }) } });
  };
}
