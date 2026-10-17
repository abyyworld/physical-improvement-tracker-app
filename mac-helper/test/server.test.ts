// The helper's local server: who may talk to it (Arise's origin, with proof of the pairing code,
// through 127.0.0.1 only), the browser's preflights (CORS and Chrome's Private Network Access), and
// the queue of events it hands over.

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from '../src/server.mjs';
import { Outbox } from '../src/outbox.mjs';
import { formatCode, newCode, normalizeCode } from '../src/config.mjs';
import { ask, askMac, replyMac } from '../src/auth.mjs';

const ORIGIN = 'https://abyyworld.github.io';
const CODE = 'ABCDE12345FGHJK67890';
const WRONG = 'WRONGWRONGWRONGWRONG';
const CNONCE = 'c0ffee'.padEnd(32, '0');

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: any;
  raw: string;
}

interface Signed {
  code?: string;
  body?: unknown;
  headers?: Record<string, string>;
  origin?: string | null;
}

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function start() {
  let t = 1_000_000;
  const handlers = {
    status: vi.fn(() => ({ app: 'arise-helper' })),
    settings: vi.fn((b: unknown) => ({ got: b })),
    events: vi.fn((after: number, limit: number) => ({ events: [], next: after, more: false, limit })),
    ack: vi.fn((upTo: number) => ({ waiting: 0, upTo })),
  };
  const server = createServer({ origins: [ORIGIN], code: () => CODE, handlers, now: () => t });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const req = (method: string, path: string, { headers = {}, body }: { headers?: Record<string, string>; body?: unknown } = {}) =>
    new Promise<Reply>((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: d ? JSON.parse(d) : null, raw: d }));
      });
      r.on('error', reject);
      if (body !== undefined) r.write(typeof body === 'string' ? body : JSON.stringify(body));
      r.end();
    });
  // As Arise asks: a one-time number from /v1/hello, then the request with its proof of the code.
  // `proved`: the answer proves it came from a helper with the right code.
  const signed = async (method: string, path: string, { code = CODE, body, headers = {}, origin = ORIGIN }: Signed = {}) => {
    const hello = await req('GET', '/v1/hello', { headers: origin ? { origin } : {} });
    const nonce = hello.body.nonce as string;
    const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    const mac = askMac(normalizeCode(code), { nonce, cnonce: CNONCE, method, path, body: text });
    const r = await req(method, path, { headers: { ...(origin ? { origin } : {}), authorization: `Arise ${nonce}.${CNONCE}.${mac}`, ...headers }, body: body === undefined ? undefined : text });
    return { ...r, nonce, mac, proved: r.headers['x-arise-proof'] === replyMac(CODE, { nonce, cnonce: CNONCE, status: r.status, body: r.raw }) };
  };
  return { port, req, signed, handlers, later: (ms: number) => (t += ms) };
}

describe('the browser asking first', () => {
  it("answers Arise's preflight, with Private Network Access when Chrome asks for it", async () => {
    const { req } = await start();
    const asks = { origin: ORIGIN, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' };
    const r = await req('OPTIONS', '/v1/status', { headers: { ...asks, 'access-control-request-private-network': 'true' } });
    expect(r.status).toBe(204);
    expect(r.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(r.headers['access-control-allow-headers']).toMatch(/Authorization/);
    expect(r.headers['access-control-allow-methods']).toMatch(/POST/);
    expect(r.headers['access-control-allow-private-network']).toBe('true');
    expect(r.headers.vary).toMatch(/Origin/);
    const plain = await req('OPTIONS', '/v1/status', { headers: asks });
    expect(plain.headers['access-control-allow-private-network']).toBeUndefined();
  });

  it("turns away every other website's preflight", async () => {
    const { req } = await start();
    for (const origin of ['https://evil.example', 'http://abyyworld.github.io', 'null', 'https://abyyworld.github.io.evil.example']) {
      const r = await req('OPTIONS', '/v1/status', { headers: { origin, 'access-control-request-method': 'GET', 'access-control-request-private-network': 'true' } });
      expect(r.status).toBe(403);
      expect(r.headers['access-control-allow-origin']).toBeUndefined();
      expect(r.headers['access-control-allow-private-network']).toBeUndefined();
    }
  });
});

describe('who may ask', () => {
  it('answers Arise with proof of the right code, however it was typed, and proves its answer', async () => {
    const { signed, handlers } = await start();
    const r = await signed('GET', '/v1/status');
    expect(r).toMatchObject({ status: 200, body: { app: 'arise-helper' }, proved: true });
    expect(r.headers['access-control-allow-origin']).toBe(ORIGIN);
    // Arise may read the proof.
    expect(r.headers['access-control-expose-headers']).toMatch(/X-Arise-Proof/i);
    expect(r.headers['cache-control']).toBe('no-store');
    const typed = await signed('GET', '/v1/status', { code: 'abcde-12345 fghjk-67890' });
    expect(typed.status).toBe(200);
    expect(handlers.status).toHaveBeenCalledTimes(2);
  });

  it('needs proof of the code, never takes the code itself, and tells Arise when it is wrong', async () => {
    const { req, signed, handlers } = await start();
    for (const authorization of ['', 'Bearer ', `Bearer ${CODE}`, `Basic ${CODE}`, `Arise ${CODE}`, 'Arise x.y.z']) {
      const r = await req('GET', '/v1/status', { headers: { origin: ORIGIN, authorization } });
      expect(r.status).toBe(401);
      // Arise may read that answer, to say the code doesn't match.
      expect(r.headers['access-control-allow-origin']).toBe(ORIGIN);
    }
    const wrong = await signed('GET', '/v1/status', { code: WRONG });
    expect(wrong).toMatchObject({ status: 401, body: { error: 'code' } });
    expect(wrong.headers['x-arise-proof']).toBeUndefined();
    expect(handlers.status).not.toHaveBeenCalled();
  });

  it('takes each one-time number once, within a minute, for that one request', async () => {
    const { req, signed, later, handlers } = await start();
    const first = await signed('GET', '/v1/status');
    expect(first.status).toBe(200);
    // The same request again (someone saw it on its way) gets nothing.
    const again = await req('GET', '/v1/status', { headers: { origin: ORIGIN, authorization: `Arise ${first.nonce}.${CNONCE}.${first.mac}` } });
    expect(again).toMatchObject({ status: 401, body: { error: 'nonce' } });
    // Not for another path, or another body.
    const n1 = (await req('GET', '/v1/hello')).body.nonce;
    const forStatus = askMac(CODE, { nonce: n1, cnonce: CNONCE, method: 'GET', path: '/v1/status', body: '' });
    expect((await req('GET', '/v1/events', { headers: { authorization: `Arise ${n1}.${CNONCE}.${forStatus}` } })).status).toBe(401);
    const n2 = (await req('GET', '/v1/hello')).body.nonce;
    const forCalls = askMac(CODE, { nonce: n2, cnonce: CNONCE, method: 'POST', path: '/v1/settings', body: '{"calls":true}' });
    expect((await req('POST', '/v1/settings', { headers: { authorization: `Arise ${n2}.${CNONCE}.${forCalls}` }, body: '{"calls":true,"messages":true}' })).status).toBe(401);
    // Not after a minute.
    const n3 = (await req('GET', '/v1/hello')).body.nonce;
    later(60_000);
    const late = askMac(CODE, { nonce: n3, cnonce: CNONCE, method: 'GET', path: '/v1/status', body: '' });
    expect((await req('GET', '/v1/status', { headers: { authorization: `Arise ${n3}.${CNONCE}.${late}` } })).body).toEqual({ error: 'nonce' });
    expect(handlers.status).toHaveBeenCalledTimes(1);
    expect(handlers.settings).not.toHaveBeenCalled();
    expect(handlers.events).not.toHaveBeenCalled();
  });

  it("keeps Arise's one-time number while others ask for many", async () => {
    const { req } = await start();
    const mine = (await req('GET', '/v1/hello', { headers: { origin: ORIGIN } })).body.nonce;
    for (let i = 0; i < 1000; i++) await req('GET', '/v1/hello');
    const mac = askMac(CODE, { nonce: mine, cnonce: CNONCE, method: 'GET', path: '/v1/status', body: '' });
    expect((await req('GET', '/v1/status', { headers: { origin: ORIGIN, authorization: `Arise ${mine}.${CNONCE}.${mac}` } })).status).toBe(200);
  });

  it('turns away other websites even with the code', async () => {
    const { signed, handlers } = await start();
    const r = await signed('GET', '/v1/status', { headers: { origin: 'https://evil.example' } });
    expect(r.status).toBe(403);
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
    expect(handlers.status).not.toHaveBeenCalled();
  });

  it('only answers to 127.0.0.1 and localhost on its port (no DNS rebinding)', async () => {
    const { signed, port } = await start();
    expect((await signed('GET', '/v1/status', { headers: { host: `evil.example:${port}` } })).status).toBe(403);
    expect((await signed('GET', '/v1/status', { headers: { host: '127.0.0.1:1' } })).status).toBe(403);
    expect((await signed('GET', '/v1/status', { headers: { host: `localhost:${port}` } })).status).toBe(200);
  });

  it('answers a program on this Mac without a browser (no Origin), with proof of the code', async () => {
    const { signed, port } = await start();
    const r = await signed('GET', '/v1/status', { origin: null });
    expect(r.status).toBe(200);
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
    expect(await ask(`http://127.0.0.1:${port}`, formatCode(CODE), '/v1/status')).toEqual({ app: 'arise-helper' });
    await expect(ask(`http://127.0.0.1:${port}`, WRONG, '/v1/status')).rejects.toMatchObject({ status: 401 });
  });

  it('turns away wrong codes for a minute after 20, but never the right one', async () => {
    const { signed, later } = await start();
    for (let i = 0; i < 20; i++) expect((await signed('GET', '/v1/status', { code: WRONG })).status).toBe(401);
    expect((await signed('GET', '/v1/status', { code: WRONG })).status).toBe(429);
    expect((await signed('GET', '/v1/status')).status).toBe(200);
    later(61_000);
    expect((await signed('GET', '/v1/status', { code: WRONG })).status).toBe(401);
  });

  it("doesn't count requests with no code, which any web page can send (as an image), so they can't lock Arise out", async () => {
    const { req, signed } = await start();
    for (let i = 0; i < 50; i++) expect((await req('GET', `/v1/status?n=${i}`)).status).toBe(401);
    expect((await signed('GET', '/v1/status')).status).toBe(200);
    expect((await signed('GET', '/v1/status', { code: WRONG })).status).toBe(401);
  });
});

describe('something else on its port', () => {
  it("learns nothing it can use from the helper's own status command, and can't pass for the helper", async () => {
    // Another account's program, listening on the port while the helper isn't running.
    const heard: string[] = [];
    const impostor = http.createServer((q, s) => {
      let d = '';
      q.on('data', (c) => (d += c));
      q.on('end', () => {
        heard.push(`${q.method} ${q.url} ${JSON.stringify(q.headers)} ${d}`);
        s.writeHead(200, { 'content-type': 'application/json' });
        s.end(JSON.stringify(q.url === '/v1/hello' ? { nonce: 'f'.repeat(32) } : { app: 'arise-helper', waiting: 0 }));
      });
    });
    servers.push(impostor);
    await new Promise<void>((r) => impostor.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(impostor.address() as AddressInfo).port}`;
    await expect(ask(base, CODE, '/v1/status')).rejects.toMatchObject({ status: 0 });
    expect(heard).toHaveLength(2);
    expect(heard.join('\n')).not.toContain(CODE);
  });
});

describe('what it answers', () => {
  it('hands over events and takes acknowledgements, each answer proved', async () => {
    const { signed, handlers } = await start();
    const page = await signed('GET', '/v1/events?after=7&limit=50');
    expect(page).toMatchObject({ body: { events: [], next: 7, more: false, limit: 50 }, proved: true });
    expect((await signed('GET', '/v1/events?limit=99999')).body.limit).toBe(1000);
    const ack = await signed('POST', '/v1/ack', { headers: { 'content-type': 'application/json' }, body: { upTo: 12 } });
    expect(ack).toMatchObject({ body: { waiting: 0, upTo: 12 }, proved: true });
    expect((await signed('POST', '/v1/settings', { body: { calls: true } })).body).toEqual({ got: { calls: true } });
    expect(handlers.ack).toHaveBeenCalledWith(12);
  });

  it('refuses what it does not understand', async () => {
    const { signed } = await start();
    expect((await signed('POST', '/v1/ack', { body: { upTo: -1 } })).status).toBe(400);
    expect((await signed('POST', '/v1/ack', { body: 'not json' })).status).toBe(400);
    expect((await signed('POST', '/v1/settings', { body: 'x'.repeat(20_000) })).status).toBe(400);
    expect((await signed('GET', '/v1/ack')).status).toBe(404);
    expect((await signed('DELETE', '/v1/status')).status).toBe(404);
    expect((await signed('GET', '/')).status).toBe(404);
  });
});

describe('the pairing code', () => {
  it('is 20 characters nobody can misread, and is typed any way', () => {
    const c = newCode();
    expect(c).toMatch(/^[0-9A-HJKMNP-TV-Z]{20}$/);
    expect(newCode()).not.toBe(c);
    expect(formatCode('ABCDE12345FGHJK67890')).toBe('ABCDE-12345-FGHJK-67890');
    expect(normalizeCode(' abcde-12345 fghjk-67890 ')).toBe('ABCDE12345FGHJK67890');
    expect(normalizeCode('0OIl1')).toBe('00111');
  });
});

describe('the queue for Arise', () => {
  const ev = (id: string, kind = 'call') => ({ id, kind, source: 'mac', at: 1, title: id, tier: 3 });

  it('numbers events, hands them over page by page, and lets them go once acknowledged', () => {
    const o = new Outbox();
    expect(o.add([ev('a'), ev('b'), ev('c'), null])).toBe(3);
    const p1 = o.page(0, 2);
    expect(p1).toEqual({ events: [ev('a'), ev('b')], next: 2, more: true });
    expect(o.ack(p1.next)).toBe(2);
    expect(o.page(0, 2)).toEqual({ events: [ev('c')], next: 3, more: false });
    expect(o.page(3, 2)).toEqual({ events: [], next: 3, more: false });
  });

  it("doesn't queue an event twice, even after it was handed over", () => {
    const o = new Outbox();
    o.add([ev('a')]);
    o.ack(1);
    expect(o.add([ev('a'), ev('b')])).toBe(1);
    const again = new Outbox({}, JSON.parse(JSON.stringify(o)));
    expect(again.add([ev('a'), ev('b'), ev('c')])).toBe(1);
    expect(again.page().events.map((e: { id: string }) => e.id)).toEqual(['b', 'c']);
  });

  it('keeps at most so many, oldest out first', () => {
    const o = new Outbox({ max: 3 });
    o.add(['a', 'b', 'c', 'd', 'e'].map((id) => ev(id)));
    expect(o.page().events.map((e: { id: string }) => e.id)).toEqual(['c', 'd', 'e']);
    expect(o.dropped).toBe(2);
  });

  it('drops or changes what waits, and counts it per kind', () => {
    const o = new Outbox();
    o.add([ev('a'), ev('m', 'message'), ev('n', 'notification')]);
    expect(o.waiting()).toEqual({ call: 1, message: 1, notification: 1 });
    expect(o.drop((e: { kind: string }) => e.kind === 'call')).toBe(1);
    o.update((e: { title: string }) => ({ ...e, title: 'x' }));
    expect(o.page().events.every((e: { title: string }) => e.title === 'x')).toBe(true);
  });

  it('forgets what it dropped, so it can be queued again, also after a restart', () => {
    const o = new Outbox();
    o.add([ev('a'), ev('m', 'message')]);
    o.ack(1); // Arise has 'a'
    o.drop(() => true);
    const again = new Outbox({}, JSON.parse(JSON.stringify(o)));
    for (const box of [o, again]) {
      expect(box.add([ev('a'), ev('m', 'message')])).toBe(1);
      expect(box.page().events.map((e: { id: string }) => e.id)).toEqual(['m']);
    }
  });
});
