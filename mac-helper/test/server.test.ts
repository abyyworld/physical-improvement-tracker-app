// The helper's local server: who may talk to it (Arise's origin, with the pairing code, through
// 127.0.0.1 only), the browser's preflights (CORS and Chrome's Private Network Access), and the
// queue of events it hands over.

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from '../src/server.mjs';
import { Outbox } from '../src/outbox.mjs';
import { formatCode, newCode, normalizeCode } from '../src/config.mjs';

const ORIGIN = 'https://abyyworld.github.io';
const CODE = 'ABCDE12345FGHJK67890';

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: any;
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
        res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: d ? JSON.parse(d) : null }));
      });
      r.on('error', reject);
      if (body !== undefined) r.write(typeof body === 'string' ? body : JSON.stringify(body));
      r.end();
    });
  const arise = (extra: Record<string, string> = {}) => ({ origin: ORIGIN, authorization: `Bearer ${CODE}`, ...extra });
  return { port, req, arise, handlers, later: (ms: number) => (t += ms) };
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
  it('answers Arise with the right code, however it was typed', async () => {
    const { req, arise, handlers } = await start();
    const r = await req('GET', '/v1/status', { headers: arise() });
    expect(r).toMatchObject({ status: 200, body: { app: 'arise-helper' } });
    expect(r.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(r.headers['cache-control']).toBe('no-store');
    const typed = await req('GET', '/v1/status', { headers: arise({ authorization: 'Bearer abcde-12345 fghjk-67890' }) });
    expect(typed.status).toBe(200);
    expect(handlers.status).toHaveBeenCalledTimes(2);
  });

  it('needs the code, and tells Arise when it is wrong', async () => {
    const { req, arise, handlers } = await start();
    for (const authorization of ['', 'Bearer ', `Bearer ${CODE.slice(1)}`, `Basic ${CODE}`, `Bearer ${CODE}X`]) {
      const r = await req('GET', '/v1/status', { headers: arise({ authorization }) });
      expect(r.status).toBe(401);
      // Arise may read that answer, to say the code doesn't match.
      expect(r.headers['access-control-allow-origin']).toBe(ORIGIN);
    }
    expect(handlers.status).not.toHaveBeenCalled();
  });

  it('turns away other websites even with the code', async () => {
    const { req, arise, handlers } = await start();
    const r = await req('GET', '/v1/status', { headers: arise({ origin: 'https://evil.example' }) });
    expect(r.status).toBe(403);
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
    expect(handlers.status).not.toHaveBeenCalled();
  });

  it('only answers to 127.0.0.1 and localhost on its port (no DNS rebinding)', async () => {
    const { req, arise, port } = await start();
    expect((await req('GET', '/v1/status', { headers: arise({ host: `evil.example:${port}` }) })).status).toBe(403);
    expect((await req('GET', '/v1/status', { headers: arise({ host: '127.0.0.1:1' }) })).status).toBe(403);
    expect((await req('GET', '/v1/status', { headers: arise({ host: `localhost:${port}` }) })).status).toBe(200);
  });

  it('answers a program on this Mac without a browser (no Origin), with the code', async () => {
    const { req } = await start();
    const r = await req('GET', '/v1/status', { headers: { authorization: `Bearer ${CODE}` } });
    expect(r.status).toBe(200);
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('stops checking codes for a minute after 20 wrong ones', async () => {
    const { req, arise, later } = await start();
    for (let i = 0; i < 20; i++) expect((await req('GET', '/v1/status', { headers: arise({ authorization: 'Bearer WRONGWRONGWRONGWRONG' }) })).status).toBe(401);
    expect((await req('GET', '/v1/status', { headers: arise() })).status).toBe(429);
    later(61_000);
    expect((await req('GET', '/v1/status', { headers: arise() })).status).toBe(200);
  });
});

describe('what it answers', () => {
  it('hands over events and takes acknowledgements', async () => {
    const { req, arise, handlers } = await start();
    expect((await req('GET', '/v1/events?after=7&limit=50', { headers: arise() })).body).toEqual({ events: [], next: 7, more: false, limit: 50 });
    expect((await req('GET', '/v1/events?limit=99999', { headers: arise() })).body.limit).toBe(1000);
    expect((await req('POST', '/v1/ack', { headers: arise({ 'content-type': 'application/json' }), body: { upTo: 12 } })).body).toEqual({ waiting: 0, upTo: 12 });
    expect((await req('POST', '/v1/settings', { headers: arise(), body: { calls: true } })).body).toEqual({ got: { calls: true } });
    expect(handlers.ack).toHaveBeenCalledWith(12);
  });

  it('refuses what it does not understand', async () => {
    const { req, arise } = await start();
    expect((await req('POST', '/v1/ack', { headers: arise(), body: { upTo: -1 } })).status).toBe(400);
    expect((await req('POST', '/v1/ack', { headers: arise(), body: 'not json' })).status).toBe(400);
    expect((await req('POST', '/v1/settings', { headers: arise(), body: 'x'.repeat(20_000) })).status).toBe(400);
    expect((await req('GET', '/v1/ack', { headers: arise() })).status).toBe(404);
    expect((await req('DELETE', '/v1/status', { headers: arise() })).status).toBe(404);
    expect((await req('GET', '/', { headers: arise() })).status).toBe(404);
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
