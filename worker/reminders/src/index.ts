// Arise reminders (a Cloudflare Worker): notifications for the web app.
//
// The iPhone app plans its notifications on the phone itself. A web app can't, so this small
// server sends each device a push at its reminder times. What it keeps about a device: its push
// address (and the keys to encrypt to it), its time zone, its reminder times and weekdays, and
// the last day the app said was done (that day's evening check is skipped). Never a name, a goal
// or what a reminder says: a push carries only which reminder it is and the date
// ({kind, date}), encrypted so only that browser can read it. The app's service worker shows the
// text the app left for it on the device (src/lib/reminder-texts.ts).
//
// One Durable Object holds every device in SQLite, with an alarm set for the next reminder due,
// so there's no cron and nothing to create first. It makes its own VAPID key pair the first time
// it needs one, so there's no secret to set up either. It keeps no logs.

import { ALL_DAYS, DATE, TIME, addDays, localDate, nextDue, timeZone, type Kind, type Schedule } from './schedule';
import { browserKey, encrypt, fromB64url, importVapid, newVapidJwk, toB64url, vapidHeader, type Vapid } from './webpush';

export interface Env {
  ALLOWED_ORIGINS: string; // comma-separated, e.g. https://abyyworld.github.io,http://localhost:5173
  CONTACT?: string; // a mailto: or https: address push services can use to reach whoever runs this
  MAX_SUBSCRIPTIONS?: string; // devices in all, default 5000
  PER_IP: RateLimiter;
  REMINDERS: DurableObjectNamespaceLike;
}

// Minimal shapes of the Cloudflare bindings used here, so this file needs no extra type package.
export interface RateLimiter {
  limit(o: { key: string }): Promise<{ success: boolean }>;
}
export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(input: string, init?: RequestInit): Promise<Response> };
}
export interface SqlLike {
  exec(query: string, ...bindings: (string | number | null)[]): { toArray(): Record<string, unknown>[] };
}
export interface StateLike {
  storage: { sql: SqlLike; setAlarm(time: number): Promise<void>; deleteAlarm(): Promise<void> };
}

const te = new TextEncoder();

// ---------- what the app may send

// The push services of the browser makers: Google (Chrome, Edge on Android, most others),
// Mozilla (Firefox), Apple (Safari, and home screen apps on iPhone and iPad) and Microsoft (Edge
// on Windows). Any other address is refused, so nobody can make this server send requests
// anywhere else.
const PUSH_HOST = /^(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9-]+\.push\.apple\.com|[a-z0-9-]+\.notify\.windows\.com)$/;

export function pushAddress(endpoint: unknown): string {
  if (typeof endpoint !== 'string' || endpoint.length > 2048) return '';
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return '';
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || !PUSH_HOST.test(u.hostname)) return '';
  return u.href;
}

export class Invalid extends Error {}

interface Subscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export type Op =
  | { op: 'vapid' }
  | { op: 'subscribe'; sub: Subscription; schedule: Schedule }
  | { op: 'update'; id: string; token: string; sub: Subscription | null; schedule: Schedule }
  | { op: 'unsubscribe'; id: string; token: string }
  | { op: 'done'; id: string; token: string; date: string; done: boolean };

const ID = /^[A-Za-z0-9_-]{22}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

async function subscription(v: unknown): Promise<Subscription> {
  if (!isObject(v)) throw new Invalid('The push subscription is missing.');
  const endpoint = pushAddress(v.endpoint);
  if (!endpoint) throw new Invalid("That push address isn't from a browser's push service.");
  const keys = isObject(v.keys) ? v.keys : {};
  try {
    const p256dh = fromB64url(String(keys.p256dh ?? ''));
    const auth = fromB64url(String(keys.auth ?? ''));
    if (auth.length !== 16) throw new Error('auth');
    await browserKey(p256dh);
    return { endpoint, p256dh: toB64url(p256dh), auth: toB64url(auth) };
  } catch {
    throw new Invalid("The push subscription's keys aren't valid.");
  }
}

function schedule(b: Record<string, unknown>): Schedule {
  const tz = timeZone(b.tz);
  if (!tz) throw new Invalid('Unknown time zone.');
  const { morning, evening = null, days } = b;
  if (typeof morning !== 'string' || !TIME.test(morning)) throw new Invalid('The morning time must look like 07:30.');
  if (evening !== null && (typeof evening !== 'string' || !TIME.test(evening))) throw new Invalid('The evening time must look like 20:00.');
  if (evening !== null && evening <= morning) throw new Invalid('The evening check must be later than the morning reminder.');
  if (days !== undefined && (!Array.isArray(days) || days.length > 7 || !days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6))) {
    throw new Invalid('Days must be a list of weekdays from 0 (Sunday) to 6 (Saturday).');
  }
  return { tz, morning, evening, days: days ? (days as number[]).reduce((m, d) => m | (1 << d), 0) : ALL_DAYS };
}

export async function parse(op: string, body: unknown): Promise<Op> {
  if (op === 'vapid') return { op };
  if (!isObject(body)) throw new Invalid('Bad request.');
  if (op === 'subscribe') return { op, sub: await subscription(body.subscription), schedule: schedule(body) };
  const id = typeof body.id === 'string' && ID.test(body.id) ? body.id : '';
  const token = typeof body.token === 'string' && TOKEN.test(body.token) ? body.token : '';
  if (!id || !token) throw new Invalid('Unknown device.');
  if (op === 'update') return { op, id, token, sub: body.subscription === undefined ? null : await subscription(body.subscription), schedule: schedule(body) };
  if (op === 'unsubscribe') return { op, id, token };
  if (op !== 'done') throw new Invalid('Not found.');
  const { date, done = true } = body;
  // (A date that doesn't exist, like 2026-02-30, comes back from addDays as another one.)
  if (typeof date !== 'string' || !DATE.test(date) || addDays(date, 0) !== date) throw new Invalid('The date must look like 2026-10-09.');
  if (typeof done !== 'boolean') throw new Invalid('Bad request.');
  return { op: 'done', id, token, date, done };
}

// ---------- the Worker: checks each request, then hands it to the one Durable Object

const ROUTES = new Map([
  ['/v1/vapid', 'GET'],
  ['/v1/subscribe', 'POST'],
  ['/v1/update', 'POST'],
  ['/v1/unsubscribe', 'POST'],
  ['/v1/done', 'POST'],
]);
const MAX_BODY = 4096;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const origin = req.headers.get('origin') || '';
    const allowed = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
    const cors = corsHeaders(allowed.includes(origin) ? origin : '');
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const fail = (status: number, message: string) => json(status, { error: { message } }, cors);

    if (!allowed.includes(origin)) return fail(403, 'This origin may not use Arise reminders.');
    const path = new URL(req.url).pathname;
    const method = ROUTES.get(path);
    if (!method) return fail(404, 'Not found.');
    if (req.method !== method) return fail(405, 'Method not allowed.');
    const ip = req.headers.get('cf-connecting-ip') || 'unknown';
    if (!(await env.PER_IP.limit({ key: ip })).success) return fail(429, 'Too many requests right now. Try again in a minute.');

    let body: unknown = null;
    if (method === 'POST') {
      if (Number(req.headers.get('content-length')) > MAX_BODY) return fail(413, 'Too much data.');
      const text = await req.text();
      if (text.length > MAX_BODY) return fail(413, 'Too much data.');
      try {
        body = JSON.parse(text);
      } catch {
        return fail(400, 'Bad request.');
      }
    }
    let op: Op;
    try {
      op = await parse(path.slice('/v1/'.length), body);
    } catch (err) {
      return fail(400, err instanceof Invalid ? err.message : 'Bad request.');
    }
    const store = env.REMINDERS.get(env.REMINDERS.idFromName('all'));
    const res = await store.fetch('https://reminders/', { method: 'POST', body: JSON.stringify(op) });
    return json(res.status, await res.json(), cors);
  },
};

function corsHeaders(origin: string): Headers {
  const h = new Headers({ vary: 'origin' });
  if (!origin) return h;
  h.set('access-control-allow-origin', origin);
  h.set('access-control-allow-methods', 'GET, POST, OPTIONS');
  h.set('access-control-allow-headers', 'content-type');
  h.set('access-control-max-age', '86400');
  return h;
}

const json = (status: number, body: unknown, base: Headers) => {
  const headers = new Headers(base);
  headers.set('content-type', 'application/json');
  headers.set('cache-control', 'no-store');
  return new Response(JSON.stringify(body), { status, headers });
};

// ---------- the Durable Object: every device, and the alarm for the next reminder

interface Row {
  id: string;
  token: string; // SHA-256 of the device's token; the token itself is only on the device
  endpoint: string;
  p256dh: string;
  auth: string;
  tz: string;
  morning: string;
  evening: string | null;
  days: number;
  done: string | null; // the last day the app said was done
  sent: string | null; // the last reminder sent, as 'date kind'
  due: number | null; // the next reminder, or null for none
  kind: Kind | null;
  date: string | null;
}

// Pushes per alarm run. Cloudflare's free plan allows 50 outgoing requests per run; the rest wait
// for the next run, straight after.
export const BATCH = 40;
// A reminder more than this late (say the server was down) is skipped, not sent at a silly time.
const LATE = 3600_000;
// How long a push service keeps trying to deliver to a device that's off or offline.
const TTL: Record<Kind, number> = { morning: 4 * 3600, evening: 2 * 3600 };
const DEFAULT_CONTACT = 'https://github.com/abyyworld/physical-improvement-tracker-app';

const random = (n: number) => toB64url(globalThis.crypto.getRandomValues(new Uint8Array(n)));
const hash = async (token: string) => toB64url(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', te.encode(token))));
const reply = (status: number, body: unknown) => ({ status, body });
const notFound = () => reply(404, { error: { message: 'This device is not signed up for reminders.' } });

export class Reminders {
  private sql: SqlLike;
  private vapid: Promise<Vapid> | null = null;
  private tokens = new Map<string, { header: Promise<string>; until: number }>();

  constructor(
    private state: StateLike,
    private env: Pick<Env, 'CONTACT' | 'MAX_SUBSCRIPTIONS'>,
  ) {
    this.sql = state.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS subs (
      id TEXT PRIMARY KEY, token TEXT NOT NULL, endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
      tz TEXT NOT NULL, morning TEXT NOT NULL, evening TEXT, days INTEGER NOT NULL,
      done TEXT, sent TEXT, due INTEGER, kind TEXT, date TEXT)`);
    this.sql.exec('CREATE INDEX IF NOT EXISTS subs_due ON subs (due)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS keys (name TEXT PRIMARY KEY, value TEXT NOT NULL)');
  }

  async fetch(req: Request): Promise<Response> {
    let out: { status: number; body: unknown };
    try {
      out = await this.handle((await req.json()) as Op);
    } catch {
      out = reply(500, { error: { message: 'Something went wrong. Try again later.' } });
    }
    await this.rearm();
    return new Response(JSON.stringify(out.body), { status: out.status, headers: { 'content-type': 'application/json' } });
  }

  private async handle(op: Op) {
    const now = Date.now();
    if (op.op === 'vapid') return reply(200, { key: (await this.keys()).publicKey });
    if (op.op === 'subscribe') {
      const token = random(32);
      const r: Row = { id: random(16), token: await hash(token), ...op.sub, ...op.schedule, done: null, sent: null, due: null, kind: null, date: null };
      // (No awaiting from here on, so no other request can come in between.)
      const count = Number(this.sql.exec('SELECT COUNT(*) AS n FROM subs WHERE endpoint != ?', r.endpoint).toArray()[0].n);
      if (count >= (Number(this.env.MAX_SUBSCRIPTIONS) || 5000)) return reply(503, { error: { message: 'Reminders are full right now. Try again another day.' } });
      // The same browser signing up again (its app lost what it knew) replaces its old record.
      this.sql.exec('DELETE FROM subs WHERE endpoint = ?', r.endpoint);
      this.sql.exec('INSERT INTO subs (id, token, endpoint, p256dh, auth, tz, morning, evening, days) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', r.id, r.token, r.endpoint, r.p256dh, r.auth, r.tz, r.morning, r.evening, r.days);
      this.save(r, now);
      return reply(200, { id: r.id, token });
    }
    const hashed = await hash(op.token);
    const row = this.row(op.id);
    if (!row || row.token !== hashed) return notFound();
    if (op.op === 'unsubscribe') {
      this.sql.exec('DELETE FROM subs WHERE id = ?', row.id);
      return reply(200, { ok: true });
    }
    if (op.op === 'update') {
      if (op.sub) this.sql.exec('DELETE FROM subs WHERE endpoint = ? AND id != ?', op.sub.endpoint, row.id);
      this.save({ ...row, ...op.sub, ...op.schedule }, now);
      return reply(200, { ok: true });
    }
    // done: only around today where the device is, so a wrong clock can't silence other days.
    const today = localDate(now, row.tz);
    if (op.date < addDays(today, -1) || op.date > addDays(today, 1)) return reply(400, { error: { message: "That date isn't today." } });
    const done = op.done ? op.date : row.done === op.date ? null : row.done;
    this.save({ ...row, done }, now);
    return reply(200, { ok: true });
  }

  private row(id: string): Row | null {
    return (this.sql.exec('SELECT * FROM subs WHERE id = ?', id).toArray()[0] as unknown as Row | undefined) || null;
  }

  // Writes a device's record, with its next reminder worked out again.
  private save(r: Row, now: number) {
    const [date, kind] = (r.sent || '').split(' ');
    const next = nextDue({ tz: r.tz, morning: r.morning, evening: r.evening, days: r.days }, now, { sent: r.sent ? { date, kind: kind as Kind } : null, done: r.done });
    this.sql.exec(
      'UPDATE subs SET endpoint = ?, p256dh = ?, auth = ?, tz = ?, morning = ?, evening = ?, days = ?, done = ?, sent = ?, due = ?, kind = ?, date = ? WHERE id = ?',
      r.endpoint, r.p256dh, r.auth, r.tz, r.morning, r.evening, r.days, r.done, r.sent, next?.at ?? null, next?.kind ?? null, next?.date ?? null, r.id,
    );
  }

  // The alarm goes off at the next reminder due.
  private async rearm() {
    const due = this.sql.exec('SELECT MIN(due) AS due FROM subs').toArray()[0]?.due;
    if (typeof due === 'number') await this.state.storage.setAlarm(due);
    else await this.state.storage.deleteAlarm();
  }

  // Cloudflare runs this at the time set above.
  async alarm(): Promise<void> {
    const now = Date.now();
    const rows = this.sql.exec('SELECT * FROM subs WHERE due <= ? ORDER BY due LIMIT ?', now, BATCH).toArray() as unknown as Row[];
    const sends: Promise<void>[] = [];
    for (const r of rows) {
      // Recorded as sent before it's sent, so nothing that runs meanwhile can send it again.
      this.save({ ...r, sent: `${r.date} ${r.kind}` }, now);
      if (now - r.due! <= LATE) sends.push(this.deliver(r, { kind: r.kind!, date: r.date! }));
    }
    await Promise.all(sends);
    await this.rearm();
  }

  private async deliver(r: Row, message: { kind: Kind; date: string }) {
    try {
      const res = await this.send(r, message);
      await res.body?.cancel().catch(() => {});
      // The browser unsubscribed, or the app or browser was removed: that address is gone for good.
      if (res.status === 404 || res.status === 410) this.sql.exec('DELETE FROM subs WHERE id = ? AND endpoint = ?', r.id, r.endpoint);
    } catch {
      // Not reachable just now. The next reminder comes at its time as usual.
    }
  }

  async send(r: Pick<Row, 'endpoint' | 'p256dh' | 'auth'>, message: { kind: Kind; date: string }): Promise<Response> {
    if (!pushAddress(r.endpoint)) throw new Error('push address');
    const body = await encrypt(te.encode(JSON.stringify(message)), fromB64url(r.p256dh), fromB64url(r.auth));
    return fetch(r.endpoint, {
      method: 'POST',
      // A push service never needs to send this anywhere else.
      redirect: 'manual',
      headers: {
        authorization: await this.authorization(r.endpoint),
        ttl: String(TTL[message.kind]),
        urgency: 'normal',
        // A reminder still waiting for a device that's offline is replaced by the next of its kind.
        topic: message.kind,
        'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream',
      },
      body,
    });
  }

  // One signed token per push service, made again every half hour (each lasts an hour). Pushes
  // go out together, so they share the one being made.
  private authorization(endpoint: string): Promise<string> {
    const aud = new URL(endpoint).origin;
    const kept = this.tokens.get(aud);
    if (kept && kept.until > Date.now()) return kept.header;
    const contact = this.env.CONTACT && /^(mailto:|https:\/\/)\S+$/.test(this.env.CONTACT) ? this.env.CONTACT : DEFAULT_CONTACT;
    const header = this.keys().then((keys) => vapidHeader(keys, endpoint, contact));
    this.tokens.set(aud, { header, until: Date.now() + 30 * 60_000 });
    header.catch(() => this.tokens.delete(aud));
    return header;
  }

  // This server's VAPID key pair: made the first time it's needed, then kept for good. Every
  // browser's subscription is tied to its public key, so it must never change.
  private keys(): Promise<Vapid> {
    this.vapid ??= (async () => {
      const read = () => this.sql.exec("SELECT value FROM keys WHERE name = 'vapid'").toArray()[0]?.value as string | undefined;
      if (!read()) this.sql.exec("INSERT OR IGNORE INTO keys (name, value) VALUES ('vapid', ?)", JSON.stringify(await newVapidJwk()));
      return importVapid(JSON.parse(read()!));
    })().catch((err) => {
      this.vapid = null;
      throw err;
    });
    return this.vapid;
  }
}
