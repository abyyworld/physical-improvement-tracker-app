// Google Calendar and Gmail, with one Google sign-in, straight from this device.
//
// Sign-in (web app only): Google's token flow for browser apps (oauth.ts). There's no client
// secret and no refresh token in a browser: Google hands over an access token that lasts about an
// hour. It's kept on this device, so the app syncs by itself while it's fresh; after that, a tap
// on "Sync now" signs in again in a moment (no questions, when the Google session is still on).
//
// The iPhone app can't sign in to Google: Google blocks its sign-in page inside apps (an embedded
// web view), and the fix (the system browser, a link back into the app) needs a new Arise.ipa.
// So there it says to use Arise on the web for this.
//
// Calendar: the events of the calendars shown in Google Calendar, from a year back on, then only
// what changed (sync tokens). Gmail: for each email, who wrote, the subject, the date, the labels
// and Google's short preview (the snippet). Never the body: messages are only ever asked for in
// the "metadata" format. 90 days back, then only what's new (history ids).

import { GOOGLE } from '../connect-config';
import type { LifeEvent } from '../life/types';
import { ConnectError, arr, obj, request, retryAfter, text, type Res } from './http';
import { hand, hash, takeBack } from './sink';
import type { SvcState } from './state';

export const SCOPES: Record<string, string> = {
  calendar: 'https://www.googleapis.com/auth/calendar.readonly',
  mail: 'https://www.googleapis.com/auth/gmail.readonly',
};
const DAY = 86_400_000;
export const CAL_BACK = 365 * DAY;
export const CAL_AHEAD = 400 * DAY; // recurring events: not their every future copy
const CAL_REFRESH = 30 * DAY; // a full look once a month keeps the year-back window moving
export const MAIL_BACK = 90 * DAY;
export const MAIL_RUN = 300; // emails per sync while catching up, so a sync never runs long
export const MAIL_MAX = 3000; // at most this many from before connecting
const CAL = 'https://www.googleapis.com/calendar/v3';
const GM = 'https://gmail.googleapis.com/gmail/v1/users/me';

export const TAP = 'Google needs a tap to sync again.';

export interface Ctx {
  save(): void;
}

export const configured = () => !!GOOGLE.clientId;

// ---------- signing in

export function authUrl({ state, parts, hint, redirect }: { state: string; parts: string[]; hint?: string; redirect: string }): string {
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.searchParams.set('client_id', GOOGLE.clientId);
  u.searchParams.set('redirect_uri', redirect);
  u.searchParams.set('response_type', 'token');
  u.searchParams.set('scope', parts.map((p) => SCOPES[p]).filter(Boolean).join(' '));
  u.searchParams.set('state', state);
  u.searchParams.set('include_granted_scopes', 'true');
  u.searchParams.set('enable_granular_consent', 'true');
  if (hint) u.searchParams.set('login_hint', hint);
  return u.href;
}

// The token Google sent back, when it runs out, and which of the parts asked for it allows
// (people can untick one on Google's page).
export function readToken(params: URLSearchParams, asked: string[], now = Date.now()) {
  const token = params.get('access_token') || '';
  if (!token || params.get('error')) throw new ConnectError('auth', "Google didn't link it. Try again.");
  const granted = (params.get('scope') || '').split(/\s+/);
  const parts = asked.filter((p) => granted.includes(SCOPES[p]));
  if (!parts.length) throw new ConnectError('auth', "Google didn't allow any of it, so nothing was linked.");
  const secs = Number(params.get('expires_in'));
  return { token, expires: now + (Number.isFinite(secs) && secs > 0 ? Math.min(secs, 86400) : 3600) * 1000, parts };
}

// Disconnecting takes Arise's access away at Google too. The answer can't be read from a web
// page (Google doesn't allow it), and isn't needed.
export function revoke(token: string) {
  if (!token) return;
  fetch('https://oauth2.googleapis.com/revoke', { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }).toString() }).catch(() => {});
}

// ---------- requests

export function googleError(res: Res): ConnectError {
  const err = obj(obj(res.data).error);
  const reason = String(obj(arr(err.errors)[0]).reason || err.status || '');
  if (res.status === 401) return new ConnectError('tap', TAP, 0, 401);
  if (res.status === 429 || /rate|quota/i.test(reason)) return new ConnectError('rate', 'Google is busy. Arise will try again later.', retryAfter(res), res.status);
  if (res.status === 403) return new ConnectError('auth', "Google didn't allow it. Connect again.", 0, 403);
  if (res.status === 404 || res.status === 410) return new ConnectError('gone', 'Starting that part again.', 0, res.status);
  if (res.status >= 500 || res.status === 0) return new ConnectError('net', "Google didn't answer. Arise will try again later.", 0, res.status);
  return new ConnectError('other', `Google said no (${res.status}).`, 0, res.status);
}

async function api(st: SvcState, url: string): Promise<Record<string, unknown>> {
  const res = await request({ url, headers: { Authorization: `Bearer ${st.auth.token}` } });
  if (res.status >= 200 && res.status < 300) return obj(res.data);
  throw googleError(res);
}

export async function sync(st: SvcState, ctx: Ctx, now = Date.now()) {
  if (!st.auth.token || (st.auth.expires || 0) - 60_000 < now) throw new ConnectError('tap', TAP);
  if (st.parts.includes('calendar')) await syncCalendar(st, ctx, now);
  if (st.parts.includes('mail')) await syncMail(st, ctx, now);
}

// ---------- Calendar

const NOISE = /#(holiday|contacts|weeknum)@group\.v\.calendar\.google\.com$/;

export async function calendars(st: SvcState): Promise<{ id: string; name: string; primary: boolean }[]> {
  const data = await api(st, `${CAL}/users/me/calendarList?maxResults=250`);
  const list = arr(data.items)
    .map(obj)
    .filter((c) => typeof c.id === 'string' && !c.deleted && !c.hidden && (c.primary || c.selected) && !NOISE.test(c.id as string))
    .map((c) => ({ id: c.id as string, name: text(c.summaryOverride || c.summary, 100) || 'Calendar', primary: c.primary === true }))
    .sort((a, b) => Number(b.primary) - Number(a.primary))
    .slice(0, 10);
  const main = list.find((c) => c.primary);
  if (main && /@/.test(main.id) && !st.account) st.account = st.user = main.id;
  return list;
}

const when = (v: unknown): { at: number; allDay: boolean } | null => {
  const x = obj(v);
  if (typeof x.dateTime === 'string') {
    const at = Date.parse(x.dateTime);
    return Number.isFinite(at) ? { at, allDay: false } : null;
  }
  const m = typeof x.date === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(x.date) : null;
  return m ? { at: new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime(), allDay: true } : null;
};

const cleanId = (v: unknown, max = 200) => (typeof v === 'string' && v.length <= max && /^[\x21-\x7e]+$/.test(v) ? v : '');

// One Calendar event as a life event, or null (cancelled, declined, too far ahead, unreadable).
export function calendarEvent(raw: unknown, cal: { name: string }, now = Date.now()): LifeEvent | null {
  const e = obj(raw);
  const id = cleanId(e.id);
  if (!id || e.status === 'cancelled') return null;
  if (arr(e.attendees).some((a) => obj(a).self === true && obj(a).responseStatus === 'declined')) return null;
  const start = when(e.start);
  if (!start || start.at > now + CAL_AHEAD) return null;
  const end = when(e.end);
  const meta: Record<string, string | number | boolean> = { app: 'google-calendar', calendar: cal.name };
  const out: LifeEvent = { id: `calendar:g:${id}`, source: 'calendar', kind: 'event', at: start.at, title: text(e.summary, 200) || 'Busy', tier: 2, meta };
  if (end && end.at >= start.at) out.end = end.at;
  const place = text(e.location, 200);
  if (place) {
    out.detail = `At ${place}`;
    meta.location = place;
  }
  if (start.allDay) meta.allDay = true;
  const people = arr(e.attendees).length;
  if (people) meta.people = people;
  if (typeof e.htmlLink === 'string' && /^https:\/\/[^\s"'<>`]{1,1500}$/.test(e.htmlLink)) out.url = e.htmlLink;
  return out;
}

// The ids of events that went away (cancelled, or declined), to take back out of the log.
export const goneIds = (items: unknown[]) =>
  items
    .map(obj)
    .filter((e) => cleanId(e.id) && (e.status === 'cancelled' || arr(e.attendees).some((a) => obj(a).self === true && obj(a).responseStatus === 'declined')))
    .map((e) => `calendar:g:${e.id}`);

async function syncCalendar(st: SvcState, ctx: Ctx, now: number) {
  for (const cal of await calendars(st)) {
    const key = `cal.${hash(cal.id)}`;
    let token: string | undefined = st.cursors[key];
    if (token && now - (Number(st.cursors[`${key}.at`]) || 0) > CAL_REFRESH) token = undefined;
    try {
      await calendarPages(st, cal, key, token, now);
    } catch (e) {
      // The sync token ran out (410): look at the whole year again.
      if (!(e instanceof ConnectError && e.kind === 'gone' && token)) throw e;
      await calendarPages(st, cal, key, undefined, now);
    }
    ctx.save();
  }
}

async function calendarPages(st: SvcState, cal: { id: string; name: string }, key: string, token: string | undefined, now: number) {
  let pageToken = '';
  let next = '';
  for (let page = 0; page < 60; page++) {
    const q = new URLSearchParams({ singleEvents: 'true', maxResults: '250' });
    if (token) q.set('syncToken', token);
    else q.set('timeMin', new Date(now - CAL_BACK).toISOString());
    if (pageToken) q.set('pageToken', pageToken);
    const data = await api(st, `${CAL}/calendars/${encodeURIComponent(cal.id)}/events?${q}`);
    const items = arr(data.items);
    await hand('google', items.map((e) => calendarEvent(e, cal, now)).filter((e): e is LifeEvent => !!e), { replace: true });
    await takeBack(goneIds(items));
    pageToken = typeof data.nextPageToken === 'string' ? data.nextPageToken : '';
    if (typeof data.nextSyncToken === 'string') next = data.nextSyncToken;
    if (!pageToken) break;
  }
  if (next) {
    st.cursors[key] = next;
    if (!token) st.cursors[`${key}.at`] = String(now);
  }
}

// ---------- Gmail

const SYSTEM: Record<string, string> = {
  INBOX: 'Inbox',
  SENT: 'Sent',
  IMPORTANT: 'Important',
  STARRED: 'Starred',
  UNREAD: 'Unread',
  CATEGORY_PERSONAL: 'Primary',
  CATEGORY_SOCIAL: 'Social',
  CATEGORY_PROMOTIONS: 'Promotions',
  CATEGORY_UPDATES: 'Updates',
  CATEGORY_FORUMS: 'Forums',
};
const SKIP = ['DRAFT', 'SPAM', 'TRASH', 'CHAT'];

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
// Gmail's snippet comes with HTML entities (&#39;, &amp;).
export function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (m, c: string) => {
    if (c[0] !== '#') return ENT[c.toLowerCase()] ?? m;
    const n = c[1].toLowerCase() === 'x' ? parseInt(c.slice(2), 16) : Number(c.slice(1));
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
  });
}

// "Jane Doe" <jane@example.com>, bob@example.com → Jane Doe and 1 more
export function person(header: string): string {
  const h = header.trim();
  if (!h) return 'someone';
  const m = /^\s*(?:"((?:[^"\\]|\\.)*)"|([^<,"]*?))\s*(?:<([^>]*)>)?\s*(?:,|$)/.exec(h);
  const name = (m?.[1] ?? m?.[2] ?? '').replace(/\\(.)/g, '$1').trim();
  const addr = (m?.[3] ?? '').trim();
  const who = name || addr || h.split(',')[0].trim();
  const more = (h.match(/@/g) || []).length - 1;
  return more > 0 ? `${who} and ${more} more` : who;
}

// One email (users.messages.get, format=metadata) as a life event, or null.
export function gmailEvent(raw: unknown, labels: Map<string, string> = new Map()): LifeEvent | null {
  const m = obj(raw);
  const id = typeof m.id === 'string' && /^[0-9a-f]{6,40}$/i.test(m.id) ? m.id : '';
  const labelIds = arr(m.labelIds).filter((l): l is string => typeof l === 'string');
  if (!id || labelIds.some((l) => SKIP.includes(l))) return null;
  const at = Number(m.internalDate);
  if (!(at > 0)) return null;
  const head: Record<string, string> = {};
  for (const h of arr(obj(m.payload).headers).map(obj)) if (typeof h.name === 'string' && typeof h.value === 'string') head[h.name.toLowerCase()] ??= h.value;
  const sent = labelIds.includes('SENT');
  const subject = text(head.subject, 200) || '(no subject)';
  const title = sent ? `Emailed ${person(head.to || '')}: ${subject}` : `Email from ${person(head.from || '')}: ${subject}`;
  const names = labelIds.map((l) => SYSTEM[l] || labels.get(l) || '').filter(Boolean);
  const meta: Record<string, string | number | boolean> = { app: 'gmail', from: text(head.from, 300), unread: labelIds.includes('UNREAD') };
  if (sent && head.to) meta.to = text(head.to, 300);
  if (names.length) meta.labels = names.join(', ').slice(0, 400);
  if (typeof m.threadId === 'string' && /^[0-9a-f]{6,40}$/i.test(m.threadId)) meta.thread = m.threadId;
  const out: LifeEvent = { id: `google:gmail:${id}`, source: 'google', kind: 'message', at, title: title.slice(0, 300), tier: 3, meta };
  const snippet = text(decode(typeof m.snippet === 'string' ? m.snippet : ''), 400);
  if (snippet) out.detail = snippet;
  return out;
}

async function labelNames(st: SvcState): Promise<Map<string, string>> {
  const data = await api(st, `${GM}/labels`);
  const out = new Map<string, string>();
  for (const l of arr(data.labels).map(obj)) if (typeof l.id === 'string' && l.type === 'user') out.set(l.id, text(l.name, 60));
  return out;
}

// Fetches each email's headers and preview (never the body) and hands them over.
async function fetchAndHand(st: SvcState, ids: string[], labels: Map<string, string>) {
  const fields = 'format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject';
  for (let i = 0; i < ids.length; i += 10) {
    const got = await Promise.all(
      ids.slice(i, i + 10).map((id) =>
        api(st, `${GM}/messages/${encodeURIComponent(id)}?${fields}`).catch((e) => {
          if (e instanceof ConnectError && e.kind === 'gone') return null; // deleted since
          throw e;
        }),
      ),
    );
    await hand('google', got.map((m) => (m ? gmailEvent(m, labels) : null)).filter((e): e is LifeEvent => !!e));
  }
}

async function startFrom(st: SvcState, since: number) {
  const prof = await api(st, `${GM}/profile`);
  if (typeof prof.emailAddress === 'string' && prof.emailAddress.length < 200) st.account = st.user = prof.emailAddress;
  st.cursors['mail.history'] = String(prof.historyId || '');
  st.cursors['mail.back'] = '-'; // the first page
  st.cursors['mail.since'] = String(Math.floor(since / 1000));
  st.cursors['mail.n'] = '0';
}

async function syncMail(st: SvcState, ctx: Ctx, now: number) {
  const labels = await labelNames(st);
  if (!st.cursors['mail.history']) {
    await startFrom(st, now - MAIL_BACK);
    ctx.save();
  } else {
    try {
      await mailHistory(st, labels);
    } catch (e) {
      // Google keeps history for a while only (404): catch up by date from the last sync instead.
      if (!(e instanceof ConnectError && e.kind === 'gone')) throw e;
      await startFrom(st, (st.last || now) - DAY);
    }
    ctx.save();
  }
  await mailBackfill(st, ctx, labels);
}

async function mailHistory(st: SvcState, labels: Map<string, string>) {
  const ids = new Set<string>();
  let latest = '';
  let pageToken = '';
  for (let page = 0; page < 50; page++) {
    const q = new URLSearchParams({ startHistoryId: st.cursors['mail.history'], historyTypes: 'messageAdded', maxResults: '500' });
    if (pageToken) q.set('pageToken', pageToken);
    const data = await api(st, `${GM}/history?${q}`);
    for (const h of arr(data.history).map(obj)) {
      for (const added of arr(h.messagesAdded).map(obj)) {
        const msg = obj(added.message);
        const lab = arr(msg.labelIds);
        if (typeof msg.id === 'string' && !lab.some((l) => SKIP.includes(l as string))) ids.add(msg.id);
      }
    }
    if (data.historyId) latest = String(data.historyId);
    pageToken = typeof data.nextPageToken === 'string' ? data.nextPageToken : '';
    if (!pageToken) break;
  }
  await fetchAndHand(st, [...ids], labels);
  if (latest) st.cursors['mail.history'] = latest;
}

async function mailBackfill(st: SvcState, ctx: Ctx, labels: Map<string, string>) {
  let got = 0;
  let n = Number(st.cursors['mail.n']) || 0;
  while (st.cursors['mail.back'] && got < MAIL_RUN && n < MAIL_MAX) {
    const q = new URLSearchParams({ maxResults: '100', q: `after:${st.cursors['mail.since'] || 0}` });
    if (st.cursors['mail.back'] !== '-') q.set('pageToken', st.cursors['mail.back']);
    const data = await api(st, `${GM}/messages?${q}`);
    const ids = arr(data.messages)
      .map((m) => obj(m).id)
      .filter((id): id is string => typeof id === 'string');
    await fetchAndHand(st, ids, labels);
    got += ids.length;
    n += ids.length;
    st.cursors['mail.n'] = String(n);
    if (typeof data.nextPageToken === 'string' && data.nextPageToken) st.cursors['mail.back'] = data.nextPageToken;
    else delete st.cursors['mail.back'];
    ctx.save();
  }
  if (n >= MAIL_MAX) delete st.cursors['mail.back'];
}
