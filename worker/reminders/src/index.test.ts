// The reminders server: what it accepts, who may use it, and the pushes it sends when.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as entry from './index';
import worker, { Reminders, pushAddress, type Env } from './index';
import { browser, decrypt, fakeStorage, type Browser } from './test/helpers';
import { fromB64url } from './webpush';

const ORIGIN = 'https://abyyworld.github.io';
const FCM = 'https://fcm.googleapis.com/fcm/send/device-1';
const at = (s: string) => vi.setSystemTime(new Date(`${s}Z`));

interface Sent {
  url: string;
  init: RequestInit;
  headers: Headers;
}

// A server with its Durable Object (on SQLite in memory), and the pushes it sends.
function server(over: Partial<Env> = {}, answer: (url: string) => Response | Promise<Response> = () => new Response(null, { status: 201 })) {
  const storage = fakeStorage();
  let object = new Reminders(storage, { CONTACT: 'mailto:owner@example.com', ...over });
  const limited: string[] = [];
  const signUpsLimited: string[] = [];
  const env: Env = {
    ALLOWED_ORIGINS: `${ORIGIN}, http://localhost:5173`,
    PER_IP: { limit: async ({ key }) => ({ success: !limited.includes(key) }) },
    PER_IP_SIGNUP: { limit: async ({ key }) => ({ success: !signUpsLimited.includes(key) }) },
    REMINDERS: { idFromName: (n) => n, get: () => ({ fetch: (url, init) => object.fetch(new Request(url, init)) }) },
    ...over,
  };
  const sent: Sent[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    sent.push({ url, init, headers: new Headers(init.headers) });
    return answer(url);
  });
  const call = async (path: string, body?: unknown, { origin = ORIGIN, method = body === undefined ? 'GET' : 'POST', ip = '203.0.113.7', raw }: { origin?: string; method?: string; ip?: string; raw?: string } = {}) => {
    const headers: Record<string, string> = { 'cf-connecting-ip': ip, 'content-type': 'application/json' };
    if (origin) headers.origin = origin;
    const res = await worker.fetch(new Request(`https://arise-reminders.example.workers.dev${path}`, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) }), env);
    return { status: res.status, body: res.status === 204 ? null : await res.json(), headers: res.headers };
  };
  const rows = () => storage.storage.sql.exec('SELECT * FROM subs ORDER BY id').toArray();
  return {
    env,
    call,
    sent,
    rows,
    limited,
    signUpsLimited,
    storage,
    alarm: () => object.alarm(),
    // Every alarm due up to `until`, as Cloudflare would run them.
    alarmsUntil: async (until: string) => {
      for (let i = 0; i < 1000 && storage.alarm !== null && storage.alarm <= Date.parse(`${until}Z`); i++) {
        vi.setSystemTime(storage.alarm);
        await object.alarm();
      }
      at(until);
    },
    // The Durable Object starting again (Cloudflare restarts them whenever it likes).
    restart: () => {
      object = new Reminders(storage, { CONTACT: 'mailto:owner@example.com', ...over });
    },
  };
}

let b: Browser;
const schedule = { tz: 'Europe/London', morning: '07:30', evening: '20:00' };
const signUp = (s: ReturnType<typeof server>, extra: object = {}, endpoint = FCM, ip?: string) => s.call('/v1/subscribe', { subscription: b.subscription(endpoint), ...schedule, ...extra }, { ip });
const alarmAt = (s: ReturnType<typeof server>) => (s.storage.alarm ? new Date(s.storage.alarm).toISOString().slice(0, 16) : null);
const message = async (p: Sent) => JSON.parse(await decrypt(new Uint8Array(p.init.body as ArrayBuffer), b));

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  at('2026-10-09T05:00'); // Friday, 06:00 in London
  b = await browser();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('exports only what the Workers runtime can start with: handlers and classes', () => {
  // A number among them, and the Worker doesn't start at all.
  for (const [name, value] of Object.entries(entry)) {
    expect(typeof value === 'function' || (name === 'default' && typeof value === 'object'), name).toBe(true);
  }
});

describe('who may use it', () => {
  it('answers the app with CORS headers', async () => {
    const s = server();
    const pre = await s.call('/v1/subscribe', undefined, { method: 'OPTIONS' });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(pre.headers.get('access-control-allow-headers')).toBe('content-type');
    const dev = await s.call('/v1/vapid', undefined, { origin: 'http://localhost:5173' });
    expect(dev.status).toBe(200);
    expect(dev.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
  });

  it('refuses other websites, and requests from no website', async () => {
    const s = server();
    for (const origin of ['https://evil.example', 'https://abyyworld.github.io.evil.example', 'null', '']) {
      const res = await s.call('/v1/subscribe', { subscription: b.subscription(FCM), ...schedule }, { origin });
      expect(res.status, origin).toBe(403);
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    }
    expect((await s.call('/v1/vapid', undefined, { origin: 'https://evil.example', method: 'OPTIONS' })).headers.get('access-control-allow-origin')).toBeNull();
    expect(s.rows()).toEqual([]);
  });

  it('only has its own paths and methods', async () => {
    const s = server();
    expect((await s.call('/v1/everything')).status).toBe(404);
    expect((await s.call('/v1/__proto__')).status).toBe(404);
    expect((await s.call('/v1/subscribe')).status).toBe(405);
    expect((await s.call('/v1/vapid', {})).status).toBe(405);
  });

  it('limits requests per IP address', async () => {
    const s = server();
    s.limited.push('198.51.100.1');
    const res = await signUp(s);
    expect(res.status).toBe(200);
    const busy = await s.call('/v1/subscribe', { subscription: b.subscription(FCM), ...schedule }, { ip: '198.51.100.1' });
    expect(busy.status).toBe(429);
    expect(busy.body.error.message).toMatch(/Too many requests/);
  });

  it('limits sign-ups per IP address much more, as a browser signs up rarely', async () => {
    const s = server();
    const { body } = await signUp(s, {}, `${FCM}-a`);
    s.signUpsLimited.push('203.0.113.7');
    expect((await signUp(s, {}, `${FCM}-b`)).status).toBe(429);
    // Everything else goes on as usual.
    expect((await s.call('/v1/update', { ...body, ...schedule, morning: '06:00' })).status).toBe(200);
    expect((await s.call('/v1/vapid')).status).toBe(200);
    expect((await signUp(s, {}, `${FCM}-c`, '198.51.100.1')).status).toBe(200);
    expect(s.rows()).toHaveLength(2);
  });

  it('has room for a limited number of devices, and a device signing up again still fits', async () => {
    const s = server({ MAX_SUBSCRIPTIONS: '2' });
    expect((await signUp(s, {}, `${FCM}-a`)).status).toBe(200);
    expect((await signUp(s, {}, `${FCM}-b`)).status).toBe(200);
    const full = await signUp(s, {}, `${FCM}-c`);
    expect(full.status).toBe(503);
    expect((await signUp(s, {}, `${FCM}-b`)).status).toBe(200);
    expect((await signUp(s, {}, `${FCM}-b`)).status).toBe(200);
    expect(s.rows()).toHaveLength(2);
    expect((await signUp(s, {}, `${FCM}-c`)).status).toBe(503);
  });

  it('makes room again as devices go, however they go', async () => {
    const s = server({ MAX_SUBSCRIPTIONS: '2' }, (url) => new Response(null, { status: url.endsWith('-gone') ? 410 : 201 }));
    const a = await signUp(s, {}, `${FCM}-a`);
    await signUp(s, {}, `${FCM}-gone`);
    expect((await signUp(s, {}, `${FCM}-c`)).status).toBe(503);
    // Turned off.
    await s.call('/v1/unsubscribe', a.body);
    const c = await signUp(s, {}, `${FCM}-c`);
    expect(c.status).toBe(200);
    expect((await signUp(s, {}, `${FCM}-d`)).status).toBe(503);
    // The push service says the address is gone.
    at('2026-10-09T06:30');
    await s.alarm();
    const d = await signUp(s, {}, `${FCM}-d`);
    expect(d.status).toBe(200);
    // A browser's new address taking the place of another device's record.
    expect((await s.call('/v1/update', { ...c.body, ...schedule, subscription: b.subscription(`${FCM}-d`) })).status).toBe(200);
    expect(s.rows()).toHaveLength(1);
    expect((await signUp(s, {}, `${FCM}-e`)).status).toBe(200);
    expect((await signUp(s, {}, `${FCM}-f`)).status).toBe(503);
    // And the count is still right when the Durable Object starts again.
    s.restart();
    expect((await signUp(s, {}, `${FCM}-f`)).status).toBe(503);
  });

  it('signs a device up without reading every device there is', async () => {
    // Cloudflare's free plan allows so many rows read a day: counting every device for each
    // sign-up would let one IP address use them up, and then no reminders go out at all.
    const s = server();
    for (let i = 0; i < 20; i++) await signUp(s, {}, `${FCM}-${i}`);
    s.storage.queries.length = 0;
    const { body } = await signUp(s, {}, `${FCM}-new`);
    await signUp(s, {}, `${FCM}-new`); // the same browser again
    await s.call('/v1/update', { ...body, ...schedule });
    expect(s.storage.queries.length).toBeGreaterThan(3);
    const scans = s.storage.queries.flatMap(({ query, bindings }) => s.storage.plan(query, bindings)).filter((step) => /^SCAN subs\b/.test(step));
    expect(scans).toEqual([]);
  });
});

describe('what it accepts', () => {
  it('only sends to the push services of the browser makers', () => {
    for (const ok of [
      FCM,
      'https://updates.push.services.mozilla.com/wpush/v2/gAAAAABk',
      'https://web.push.apple.com/QGuQyavXutnMH8tRX',
      'https://wns2-par02p.notify.windows.com/w/?token=BQYAAAB%2bx%3d',
      'https://FCM.googleapis.com:443/fcm/send/x',
    ]) {
      expect(pushAddress(ok), ok).not.toBe('');
    }
    // Copies of a real address, which the push service would deliver to the same browser.
    for (const copy of [`${FCM}#1`, `${FCM}#`, `${FCM}?copy=1`, `${FCM}?`, 'https://fcm.googleapis.com/fcm/send/%64evice-1', 'https://wns2-par02p.notify.windows.com/w/?token=BQYAAAB#2']) {
      expect(pushAddress(copy), copy).toBe('');
    }
    for (const bad of [
      'http://fcm.googleapis.com/fcm/send/x',
      'https://fcm.googleapis.com.evil.example/x',
      'https://evil.example/fcm.googleapis.com',
      'https://evil.example/?https://fcm.googleapis.com/',
      'https://user:pass@fcm.googleapis.com/x',
      'https://fcm.googleapis.com:8443/x',
      'https://fcm.googleapis.com./x',
      'https://notify.windows.com/x',
      'https://a.b.notify.windows.com/x',
      'https://apple.com/x',
      'https://127.0.0.1/x',
      'https://localhost/x',
      'javascript:alert(1)',
      `https://fcm.googleapis.com/${'x'.repeat(3000)}`,
      '',
      42,
      null,
    ]) {
      expect(pushAddress(bad), String(bad)).toBe('');
    }
  });

  it('checks every field and stores nothing that fails', async () => {
    const s = server();
    const good = { subscription: b.subscription(FCM), ...schedule };
    const offCurve = new Uint8Array(65).fill(9);
    offCurve[0] = 4;
    const cases: [string, unknown][] = [
      ['another host', { ...good, subscription: b.subscription('https://evil.example/push') }],
      ['plain http', { ...good, subscription: b.subscription('http://fcm.googleapis.com/fcm/send/x') }],
      ['no subscription', { ...schedule }],
      ['a short key', { ...good, subscription: { endpoint: FCM, keys: { p256dh: 'BAAA', auth: good.subscription.keys.auth } } }],
      ['a key off the curve', { ...good, subscription: { endpoint: FCM, keys: { p256dh: Buffer.from(offCurve).toString('base64url'), auth: good.subscription.keys.auth } } }],
      ['a short auth secret', { ...good, subscription: { endpoint: FCM, keys: { ...good.subscription.keys, auth: 'AAAA' } } }],
      ['an unknown time zone', { ...good, tz: 'Moon/Tranquility' }],
      ['a morning time like 7:30', { ...good, morning: '7:30' }],
      ['a morning time of 24:00', { ...good, morning: '24:00' }],
      ['an evening before the morning', { ...good, evening: '07:00' }],
      ['an evening as a number', { ...good, evening: 2000 }],
      ['a weekday 7', { ...good, days: [1, 7] }],
      ['days as text', { ...good, days: 'all' }],
      ['too many days', { ...good, days: [0, 1, 2, 3, 4, 5, 6, 0] }],
      ['a list', [good]],
    ];
    for (const [what, body] of cases) {
      const res = await s.call('/v1/subscribe', body);
      expect(res.status, what).toBe(400);
      expect(res.body.error.message, what).toBeTruthy();
    }
    expect((await s.call('/v1/subscribe', undefined, { method: 'POST', raw: '{not json' })).status).toBe(400);
    expect((await s.call('/v1/subscribe', undefined, { method: 'POST', raw: JSON.stringify({ ...good, pad: 'x'.repeat(5000) }) })).status).toBe(413);
    expect(s.rows()).toEqual([]);
    expect(s.sent).toEqual([]);
  });

  it('stops reading a body that is too big, even one sent in pieces with no length given', async () => {
    const s = server();
    let read = 0;
    const piece = new Uint8Array(1024).fill(32);
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        read += piece.length;
        if (read > 50 * 1024 * 1024) c.close();
        else c.enqueue(piece);
      },
    });
    const req = new Request('https://arise-reminders.example.workers.dev/v1/subscribe', { method: 'POST', headers: { origin: ORIGIN, 'cf-connecting-ip': '203.0.113.7' }, body, duplex: 'half' } as RequestInit);
    expect(req.headers.get('content-length')).toBeNull();
    const res = await worker.fetch(req, s.env);
    expect(res.status).toBe(413);
    expect(read).toBeLessThan(64 * 1024);
    // A body that fits, in pieces, still works.
    const json = JSON.stringify({ subscription: b.subscription(FCM), ...schedule });
    const small = new ReadableStream<Uint8Array>({
      start(c) {
        const bytes = new TextEncoder().encode(json);
        c.enqueue(bytes.slice(0, 100));
        c.enqueue(bytes.slice(100));
        c.close();
      },
    });
    const ok = await worker.fetch(new Request('https://arise-reminders.example.workers.dev/v1/subscribe', { method: 'POST', headers: { origin: ORIGIN }, body: small, duplex: 'half' } as RequestInit), s.env);
    expect(ok.status).toBe(200);
  });

  it("keeps a device's token secret, even from itself", async () => {
    const s = server();
    const { status, body } = await signUp(s, { days: [1, 2, 3, 4, 5] });
    expect(status).toBe(200);
    expect(body.id).toMatch(/^[\w-]{22}$/);
    expect(body.token).toMatch(/^[\w-]{43}$/);
    const [row] = s.rows();
    expect(row).toMatchObject({ id: body.id, endpoint: FCM, tz: 'Europe/London', morning: '07:30', evening: '20:00', days: 0b0111110 });
    expect(JSON.stringify(row)).not.toContain(body.token);
    // Nothing about the person: only what's needed to send the reminder.
    expect(Object.keys(row).sort()).toEqual(['auth', 'date', 'days', 'done', 'due', 'endpoint', 'evening', 'id', 'kind', 'morning', 'p256dh', 'reached', 'sent', 'token', 'tz']);
  });

  it('gives out one VAPID public key, made once and kept', async () => {
    const s = server();
    const { body } = await s.call('/v1/vapid');
    expect(fromB64url(body.key)).toHaveLength(65);
    s.restart();
    expect((await s.call('/v1/vapid')).body.key).toBe(body.key);
    // Another server has its own.
    expect((await server().call('/v1/vapid')).body.key).not.toBe(body.key);
  });
});

describe('changing and stopping', () => {
  it('needs the right token for every change', async () => {
    const s = server();
    const { body } = await signUp(s);
    const other = await signUp(s, {}, `${FCM}-2`);
    const wrong = { id: body.id, token: other.body.token };
    expect((await s.call('/v1/update', { ...wrong, ...schedule, morning: '05:00' })).status).toBe(404);
    expect((await s.call('/v1/done', { ...wrong, date: '2026-10-09' })).status).toBe(404);
    expect((await s.call('/v1/unsubscribe', wrong)).status).toBe(404);
    expect((await s.call('/v1/unsubscribe', { id: 'short', token: body.token })).status).toBe(400);
    expect((await s.call('/v1/unsubscribe', { id: body.id })).status).toBe(400);
    expect(s.rows()).toHaveLength(2);
    expect(s.rows().find((r) => r.id === body.id)).toMatchObject({ morning: '07:30', done: null });
  });

  it('moves the alarm when the times change', async () => {
    const s = server();
    const { body } = await signUp(s);
    expect(alarmAt(s)).toBe('2026-10-09T06:30');
    expect((await s.call('/v1/update', { id: body.id, token: body.token, tz: 'America/New_York', morning: '06:45', evening: null })).status).toBe(200);
    expect(alarmAt(s)).toBe('2026-10-09T10:45');
    expect(s.rows()[0]).toMatchObject({ tz: 'America/New_York', evening: null, kind: 'morning', date: '2026-10-09' });
  });

  it('takes a new push address when the browser changes it', async () => {
    const s = server();
    const { body } = await signUp(s);
    const fresh = await browser();
    const sub = fresh.subscription('https://fcm.googleapis.com/fcm/send/device-1-new');
    expect((await s.call('/v1/update', { id: body.id, token: body.token, subscription: sub, ...schedule })).status).toBe(200);
    expect(s.rows()[0]).toMatchObject({ endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth });
  });

  it('forgets a device that turns reminders off', async () => {
    const s = server();
    const { body } = await signUp(s);
    expect((await s.call('/v1/unsubscribe', { id: body.id, token: body.token })).status).toBe(200);
    expect(s.rows()).toEqual([]);
    expect(s.storage.alarm).toBeNull();
    expect((await s.call('/v1/update', { id: body.id, token: body.token, ...schedule })).status).toBe(404);
  });

  it('replaces the old record when the same browser signs up again', async () => {
    const s = server();
    const first = await signUp(s);
    const second = await signUp(s, { morning: '08:00' });
    expect(s.rows()).toHaveLength(1);
    expect(s.rows()[0]).toMatchObject({ id: second.body.id, morning: '08:00' });
    expect((await s.call('/v1/unsubscribe', first.body)).status).toBe(404);
  });
});

describe('sending', () => {
  it('sends the morning reminder and the evening check, encrypted, at their times', async () => {
    const s = server();
    const { key } = (await s.call('/v1/vapid')).body;
    await signUp(s);
    at('2026-10-09T06:30');
    await s.alarm();
    expect(s.sent).toHaveLength(1);
    const [push] = s.sent;
    expect(push.url).toBe(FCM);
    expect(push.init.method).toBe('POST');
    expect(push.init.redirect).toBe('manual');
    expect(push.headers.get('authorization')).toMatch(new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${key}$`));
    expect(push.headers.get('content-encoding')).toBe('aes128gcm');
    expect(push.headers.get('ttl')).toBe(String(4 * 3600));
    expect(push.headers.get('urgency')).toBe('normal');
    expect(push.headers.get('topic')).toBe('morning');
    // All a push says: which reminder, for which day.
    expect(await message(push)).toEqual({ kind: 'morning', date: '2026-10-09' });
    expect(alarmAt(s)).toBe('2026-10-09T19:00');

    at('2026-10-09T19:00');
    await s.alarm();
    expect(s.sent).toHaveLength(2);
    expect(await message(s.sent[1])).toEqual({ kind: 'evening', date: '2026-10-09' });
    expect(s.sent[1].headers.get('topic')).toBe('evening');
    expect(alarmAt(s)).toBe('2026-10-10T06:30');
  });

  it("skips the evening check once the app says the day's done, and brings it back if it isn't", async () => {
    const s = server();
    const { body } = await signUp(s);
    at('2026-10-09T06:30');
    await s.alarm();
    at('2026-10-09T12:00');
    expect((await s.call('/v1/done', { ...body, date: '2026-10-09' })).status).toBe(200);
    expect(alarmAt(s)).toBe('2026-10-10T06:30');
    at('2026-10-09T19:00');
    await s.alarm();
    expect(s.sent).toHaveLength(1);

    // Unticked again before the evening: the check is back on.
    at('2026-10-09T18:00');
    expect((await s.call('/v1/done', { ...body, date: '2026-10-09', done: false })).status).toBe(200);
    expect(alarmAt(s)).toBe('2026-10-09T19:00');
  });

  it('sends nothing at all on a day done before the morning', async () => {
    const s = server();
    const { body } = await signUp(s);
    await s.call('/v1/done', { ...body, date: '2026-10-09' });
    expect(alarmAt(s)).toBe('2026-10-10T06:30');
    expect(s.rows()[0]).toMatchObject({ done: '2026-10-09', kind: 'morning', date: '2026-10-10' });
  });

  it('only takes done for around today', async () => {
    const s = server();
    const { body } = await signUp(s);
    for (const date of ['2026-10-12', '2026-09-09', '2026-02-30', '09/10/2026']) {
      expect((await s.call('/v1/done', { ...body, date })).status, date).toBe(400);
    }
    expect((await s.call('/v1/done', { ...body, date: '2026-10-09', done: 'yes' })).status).toBe(400);
    expect(s.rows()[0].done).toBeNull();
  });

  it('only on the chosen weekdays', async () => {
    const s = server();
    await signUp(s, { evening: null, days: [1, 2, 3, 4, 5] });
    at('2026-10-09T06:30');
    await s.alarm();
    expect(alarmAt(s)).toBe('2026-10-12T06:30'); // Friday, then Monday
  });

  it('forgets an address the push service says is gone', async () => {
    for (const status of [404, 410]) {
      const s = server({}, () => new Response('gone', { status }));
      await signUp(s);
      at('2026-10-09T06:30');
      await s.alarm();
      expect(s.sent).toHaveLength(1);
      expect(s.rows(), String(status)).toEqual([]);
      expect(s.storage.alarm).toBeNull();
      at('2026-10-09T05:00');
    }
  });

  it('keeps it through other failures', async () => {
    for (const answer of [() => new Response('busy', { status: 429 }), () => new Response('oops', { status: 500 }), () => Promise.reject(new Error('offline'))]) {
      const s = server({}, answer);
      await signUp(s);
      at('2026-10-09T06:30');
      await s.alarm();
      expect(s.rows()).toHaveLength(1);
      expect(alarmAt(s)).toBe('2026-10-09T19:00');
      at('2026-10-09T05:00');
    }
  });

  it('forgets a device no push has got through to for two weeks', async () => {
    const working = 'https://web.push.apple.com/working';
    const s = server({}, (url) => {
      if (url === working) return new Response(null, { status: 201 });
      if (url.includes('push.apple.com')) return Promise.reject(new TypeError('fetch failed')); // a name that doesn't exist
      return new Response(null, { status: Number(url.split('-').at(-1)) });
    });
    await signUp(s, {}, working);
    for (const status of [400, 403, 429, 500]) await signUp(s, {}, `${FCM}-${status}`);
    await signUp(s, {}, 'https://made-up.push.apple.com/x');
    // A week of failures: still kept, in case it's the push service.
    await s.alarmsUntil('2026-10-16T12:00');
    expect(s.rows()).toHaveLength(6);
    await s.alarmsUntil('2026-10-23T12:00');
    expect(s.rows().map((r) => r.endpoint)).toEqual([working]);
    // The one that works keeps getting them.
    await s.alarmsUntil('2026-11-30T12:00');
    expect(s.rows().map((r) => r.endpoint)).toEqual([working]);
    expect(await message(s.sent.filter((p) => p.url === working).at(-1)!)).toEqual({ kind: 'morning', date: '2026-11-30' });
  });

  it('forgets a device with nothing to send for two weeks', async () => {
    const s = server();
    const { body } = await signUp(s, { days: [] });
    expect(s.rows()[0]).toMatchObject({ kind: null });
    // Telling it something doesn't put it off.
    at('2026-10-20T12:00');
    await s.call('/v1/update', { ...body, ...schedule, days: [] });
    expect(alarmAt(s)).toBe('2026-10-23T05:00');
    await s.alarmsUntil('2026-10-23T05:00');
    expect(s.rows()).toEqual([]);
    expect(s.sent).toEqual([]);
    expect(s.storage.alarm).toBeNull();
    // Its app signs up again when it next has something to tell the server.
    expect((await s.call('/v1/update', { ...body, ...schedule })).status).toBe(404);
  });

  it('frees up a cap filled with made-up and copied addresses from one IP address', async () => {
    const s = server({ MAX_SUBSCRIPTIONS: '6' }, (url) => (url.includes('push.apple.com') ? Promise.reject(new TypeError('fetch failed')) : new Response(null, { status: Number(url.split('-').at(-1)) })));
    // Copies of one address aren't taken at all.
    for (const copy of [`${FCM}-201#1`, `${FCM}-201#2`, `${FCM}-201?3`]) expect((await signUp(s, {}, copy)).status).toBe(400);
    for (const junk of ['https://a1.push.apple.com/x', 'https://a2.push.apple.com/x', 'https://api.push.apple.com/x', `${FCM}-400`, `${FCM}-403`, `${FCM}-500`]) {
      expect((await signUp(s, { evening: null, days: [0] }, junk)).status).toBe(200);
    }
    expect((await signUp(s, {}, `${FCM}-201`)).status).toBe(503);
    await s.alarmsUntil('2026-10-26T12:00');
    expect(s.rows()).toEqual([]);
    expect((await signUp(s, {}, `${FCM}-201`)).status).toBe(200);
  });

  it('sends in batches when many are due at once', async () => {
    const s = server();
    for (let i = 0; i < Reminders.BATCH + 5; i++) await signUp(s, { evening: null }, `${FCM}-${i}`);
    at('2026-10-09T06:30');
    await s.alarm();
    expect(s.sent).toHaveLength(Reminders.BATCH);
    expect(s.storage.alarm).toBe(Date.parse('2026-10-09T06:30Z')); // straight away again
    await s.alarm();
    expect(s.sent).toHaveLength(Reminders.BATCH + 5);
    expect(new Set(s.sent.map((p) => p.url)).size).toBe(Reminders.BATCH + 5);
    expect(alarmAt(s)).toBe('2026-10-10T06:30');
  });

  it('skips a reminder that is more than an hour late, without losing the next', async () => {
    const s = server();
    await signUp(s);
    at('2026-10-09T09:00');
    await s.alarm();
    expect(s.sent).toEqual([]);
    expect(alarmAt(s)).toBe('2026-10-09T19:00');
  });

  it("never sends the same day's reminder twice when the times change", async () => {
    const s = server();
    const { body } = await signUp(s);
    at('2026-10-09T06:30');
    await s.alarm();
    at('2026-10-09T06:40');
    await s.call('/v1/update', { ...body, ...schedule, morning: '08:00' });
    expect(alarmAt(s)).toBe('2026-10-09T19:00');
  });

  it('signs once per push service, not once per push', async () => {
    const s = server();
    await signUp(s, { evening: null }, `${FCM}-a`);
    await signUp(s, { evening: null }, `${FCM}-b`);
    await signUp(s, { evening: null }, 'https://updates.push.services.mozilla.com/wpush/v2/x');
    at('2026-10-09T06:30');
    await s.alarm();
    const auth = (url: string) => s.sent.find((p) => p.url === url)!.headers.get('authorization');
    expect(auth(`${FCM}-a`)).toBe(auth(`${FCM}-b`));
    expect(auth(`${FCM}-a`)).not.toBe(auth('https://updates.push.services.mozilla.com/wpush/v2/x'));
    const claims = (h: string | null) => JSON.parse(Buffer.from(h!.split('.')[1], 'base64url').toString());
    expect(claims(auth(`${FCM}-a`))).toMatchObject({ aud: 'https://fcm.googleapis.com', sub: 'mailto:owner@example.com' });
    expect(claims(auth('https://updates.push.services.mozilla.com/wpush/v2/x')).aud).toBe('https://updates.push.services.mozilla.com');
  });
});
