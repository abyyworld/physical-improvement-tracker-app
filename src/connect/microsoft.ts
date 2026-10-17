// Outlook mail and calendar through Microsoft Graph, for work, school and personal Microsoft
// accounts (Outlook.com, Hotmail), straight from this device.
//
// Sign-in, written out by hand rather than with Microsoft's msal-browser library: the flow is
// small (about 100 lines here), msal-browser would add a big download and runs its own hidden
// frames, and Arise needs the same code to work with the iPhone app's own HTTP too.
// - Web app: the authorization code flow with PKCE, for an app registered as a single-page app
//   (no client secret). Microsoft gives a refresh token that works for 24 hours in a browser, so
//   the app syncs by itself for a day; after that, a tap on "Sync now" signs in again.
// - iPhone app: Microsoft's device code flow. The Player opens microsoft.com/devicelogin in Safari
//   and types a short code; nothing about the app has to change. Its refresh token keeps working
//   while it's used (up to 90 days between uses).
//
// Mail: the Inbox and Sent Items, 90 days back, then only what's new (delta links): who wrote,
// the subject, the date and Outlook's short preview. Never the body. An email that leaves the
// folder later (archived, filed or deleted) stays in the life log, as with Gmail. Calendar: a year
// back and a year ahead, then only what changed.

import { MICROSOFT } from '../connect-config';
import type { LifeEvent } from '../life/types';
import { ConnectError, arr, form, obj, request, retryAfter, text, type Res } from './http';
import { goOn, hand, hash, takeBack } from './sink';
import type { SvcState } from './state';

// Only what the parts the Player picked need (User.Read: the account's name, to show it).
export const scopeFor = (parts: string[]) => ['offline_access', 'User.Read', ...(parts.includes('mail') ? ['Mail.Read'] : []), ...(parts.includes('calendar') ? ['Calendars.Read'] : [])].join(' ');
const ALL = ['calendar', 'mail'];
const partsOf = (st: SvcState) => (st.parts.length ? st.parts : ALL);
const DAY = 86_400_000;
export const MAIL_BACK = 90 * DAY;
export const CAL_SPAN = 365 * DAY;
const CAL_REFRESH = 30 * DAY;
const PAGES = 20; // per part and sync, so a sync never runs long; the next one carries on
const GRAPH = 'https://graph.microsoft.com/v1.0';
export const FOLDERS = ['inbox', 'sentitems'];

export const TAP = 'Microsoft needs a tap to sync again.';
const SIGNED_OUT = 'Microsoft signed Arise out. Connect again.';

export interface Ctx {
  save(): void;
  native: boolean;
}

export const configured = () => !!MICROSOFT.clientId;
const login = (path: string) => `https://login.microsoftonline.com/${MICROSOFT.tenant || 'common'}/oauth2/v2.0/${path}`;

// ---------- signing in

export function authUrl({ state, challenge, hint, redirect, parts = ALL }: { state: string; challenge: string; hint?: string; redirect: string; parts?: string[] }): string {
  const u = new URL(login('authorize'));
  u.searchParams.set('client_id', MICROSOFT.clientId);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('redirect_uri', redirect);
  u.searchParams.set('response_mode', 'fragment');
  u.searchParams.set('scope', scopeFor(parts));
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  if (hint) u.searchParams.set('login_hint', hint);
  else u.searchParams.set('prompt', 'select_account');
  return u.href;
}

function tokenError(res: Res, native: boolean): ConnectError {
  const err = String(obj(res.data).error || '');
  if (res.status === 429) return new ConnectError('rate', 'Microsoft is busy. Arise will try again later.', retryAfter(res), 429);
  if (res.status >= 500 || res.status === 0) return new ConnectError('net', "Microsoft didn't answer. Arise will try again later.", 0, res.status);
  // invalid_grant: the refresh token ran out (24 hours in a browser) or was revoked.
  if (err === 'invalid_grant' || err === 'interaction_required') return native ? new ConnectError('auth', SIGNED_OUT, 0, res.status) : new ConnectError('tap', TAP, 0, res.status);
  return new ConnectError('auth', SIGNED_OUT, 0, res.status);
}

const keep = (st: SvcState, data: unknown, now: number) => {
  const d = obj(data);
  if (typeof d.access_token !== 'string' || !d.access_token) throw new ConnectError('auth', SIGNED_OUT);
  const secs = Number(d.expires_in);
  st.auth.token = d.access_token;
  st.auth.expires = now + (Number.isFinite(secs) && secs > 0 ? Math.min(secs, 86400) : 3600) * 1000;
  // Microsoft hands over a new refresh token each time; the old one is forgotten.
  if (typeof d.refresh_token === 'string' && d.refresh_token) st.auth.refresh = d.refresh_token;
};

async function token(body: Record<string, string>, native: boolean): Promise<Res> {
  // The web app's requests carry its address (Origin), which Microsoft checks against the
  // single-page app registration; the iPhone app's don't, as a public app.
  const res = await request({ url: login('token'), method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ client_id: MICROSOFT.clientId, ...body }) });
  if (res.status >= 200 && res.status < 300) return res;
  throw tokenError(res, native);
}

// Web app: the code that came back, for tokens.
export async function redeem(st: SvcState, code: string, verifier: string, redirect: string, parts = ALL, now = Date.now()) {
  const res = await token({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirect, scope: scopeFor(parts) }, false);
  keep(st, res.data, now);
}

async function refresh(st: SvcState, ctx: Ctx, now: number) {
  if (!st.auth.refresh) throw ctx.native ? new ConnectError('auth', SIGNED_OUT) : new ConnectError('tap', TAP);
  const res = await token({ grant_type: 'refresh_token', refresh_token: st.auth.refresh, scope: scopeFor(partsOf(st)) }, ctx.native);
  keep(st, res.data, now);
  ctx.save();
}

// iPhone app: the device code flow.
export interface DeviceCode {
  device: string;
  code: string; // what the Player types
  url: string; // where: https://microsoft.com/devicelogin
  expires: number;
  interval: number; // ms between checks
}

export async function deviceCode(parts = ALL, now = Date.now()): Promise<DeviceCode> {
  const res = await request({ url: login('devicecode'), method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ client_id: MICROSOFT.clientId, scope: scopeFor(parts) }) });
  const d = obj(res.data);
  if (res.status !== 200 || typeof d.device_code !== 'string' || typeof d.user_code !== 'string') throw tokenError(res, true);
  const url = typeof d.verification_uri === 'string' && /^https:\/\/[\w./-]+$/.test(d.verification_uri) ? d.verification_uri : 'https://microsoft.com/devicelogin';
  return { device: d.device_code, code: text(d.user_code, 20), url, expires: now + (Number(d.expires_in) || 900) * 1000, interval: Math.max(1, Number(d.interval) || 5) * 1000 };
}

// One check: 'wait' until the Player has signed in, then 'done' (the tokens are in `st`).
export async function devicePoll(st: SvcState, dc: DeviceCode, now = Date.now()): Promise<'wait' | 'slow' | 'done'> {
  const res = await request({
    url: login('token'),
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ client_id: MICROSOFT.clientId, grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: dc.device }),
  });
  if (res.status === 200) {
    keep(st, res.data, now);
    return 'done';
  }
  const err = String(obj(res.data).error || '');
  if (err === 'authorization_pending') return 'wait';
  if (err === 'slow_down') return 'slow';
  if (err === 'authorization_declined') throw new ConnectError('auth', "You didn't say yes, so nothing was linked.");
  if (err === 'expired_token' || err === 'code_expired') throw new ConnectError('auth', 'The code ran out. Try again.');
  throw tokenError(res, true);
}

// ---------- requests

function graphError(res: Res, native: boolean): ConnectError {
  const code = String(obj(obj(res.data).error).code || '');
  if (res.status === 401) return native ? new ConnectError('auth', SIGNED_OUT, 0, 401) : new ConnectError('tap', TAP, 0, 401);
  if (res.status === 429 || res.status === 503) return new ConnectError('rate', 'Microsoft is busy. Arise will try again later.', retryAfter(res), res.status);
  if (res.status === 410 || /syncStateNotFound|syncStateInvalid|resyncRequired/i.test(code)) return new ConnectError('gone', 'Starting that part again.', 0, res.status);
  if (res.status === 403) return new ConnectError('auth', "Microsoft didn't allow it. Connect again.", 0, 403);
  if (res.status === 404) return new ConnectError('gone', 'Starting that part again.', 0, 404);
  if (res.status >= 500 || res.status === 0) return new ConnectError('net', "Microsoft didn't answer. Arise will try again later.", 0, res.status);
  return new ConnectError('other', `Microsoft said no (${res.status}).`, 0, res.status);
}

const PREFER = 'odata.maxpagesize=50, IdType="ImmutableId", outlook.timezone="UTC"';

async function graph(st: SvcState, ctx: Ctx, url: string, now: number): Promise<Record<string, unknown>> {
  goOn('microsoft');
  if (!st.auth.token || (st.auth.expires || 0) - 60_000 < now) await refresh(st, ctx, now);
  for (let tries = 0; ; tries++) {
    goOn('microsoft');
    const res = await request({ url, headers: { Authorization: `Bearer ${st.auth.token}`, Prefer: PREFER } });
    if (res.status >= 200 && res.status < 300) return obj(res.data);
    // The access token ran out early: once, a fresh one.
    if (res.status === 401 && tries === 0 && st.auth.refresh) {
      await refresh(st, ctx, now);
      continue;
    }
    throw graphError(res, ctx.native);
  }
}

// Only Graph's own addresses are followed (nextLink and deltaLink come from Graph).
const graphLink = (v: unknown) => (typeof v === 'string' && v.startsWith(`${GRAPH}/`) && v.length < 8000 ? v : '');

export async function sync(st: SvcState, ctx: Ctx, now = Date.now()) {
  // Who it is, after each sign-in (engine.ts clears the name). Signed in to another account than
  // before: nothing of the old one's (where its syncs left off) is used for it.
  if (!st.account) {
    const me = await graph(st, ctx, `${GRAPH}/me?$select=displayName,mail,userPrincipalName`, now);
    const name = text(me.mail || me.userPrincipalName, 200);
    if (name) {
      if (st.user && st.user.toLowerCase() !== name.toLowerCase()) st.cursors = {};
      st.account = st.user = name;
    }
  }
  if (st.parts.includes('mail')) for (const f of FOLDERS) await syncFolder(st, ctx, f, now);
  if (st.parts.includes('calendar')) await syncCalendar(st, ctx, now);
}

// Follows one round of delta pages. Saves where it got to after each page.
async function deltaRound(st: SvcState, ctx: Ctx, key: string, first: string, now: number, onPage: (items: Record<string, unknown>[]) => Promise<void>) {
  let url = st.cursors[key] || first;
  for (let page = 0; page < PAGES; page++) {
    let data: Record<string, unknown>;
    try {
      data = await graph(st, ctx, url, now);
    } catch (e) {
      // The link ran out: start this part's round again.
      if (!(e instanceof ConnectError && e.kind === 'gone') || url === first) throw e;
      delete st.cursors[key];
      url = first;
      continue;
    }
    await onPage(arr(data.value).map(obj));
    const next = graphLink(data['@odata.nextLink']);
    const delta = graphLink(data['@odata.deltaLink']);
    st.cursors[key] = next || delta || st.cursors[key] || '';
    ctx.save();
    if (!next) return;
    url = next;
  }
}

// ---------- mail

const address = (v: unknown) => {
  const e = obj(obj(v).emailAddress);
  return { name: text(e.name, 120), addr: text(e.address, 200) };
};
const who = (v: unknown) => {
  const a = address(v);
  return a.name || a.addr || 'someone';
};

// One message (from a mail folder's delta) as a life event, or null.
export function outlookEvent(raw: unknown, folder: string): LifeEvent | null {
  const m = obj(raw);
  const id = typeof m.id === 'string' && m.id.length < 1000 ? m.id : '';
  if (!id || m['@removed'] || m.isDraft === true) return null;
  const sent = folder === 'sentitems';
  const at = Date.parse(String((sent ? m.sentDateTime : m.receivedDateTime) || m.receivedDateTime || ''));
  if (!Number.isFinite(at) || at <= 0) return null;
  const subject = text(m.subject, 200) || '(no subject)';
  const to = arr(m.toRecipients);
  const title = sent ? `Emailed ${to.length ? who(to[0]) : 'someone'}${to.length > 1 ? ` and ${to.length - 1} more` : ''}: ${subject}` : `Email from ${who(m.from)}: ${subject}`;
  const from = address(m.from);
  const meta: Record<string, string | number | boolean> = { app: 'outlook', folder: sent ? 'Sent' : 'Inbox', unread: m.isRead === false };
  if (from.addr) meta.from = from.name ? `${from.name} <${from.addr}>` : from.addr;
  if (sent && to.length) meta.to = to.map((r) => address(r).addr).filter(Boolean).join(', ').slice(0, 300);
  const cats = arr(m.categories).filter((c): c is string => typeof c === 'string');
  if (cats.length) meta.labels = cats.join(', ').slice(0, 300);
  if (m.importance === 'high') meta.important = true;
  const out: LifeEvent = { id: `other:outlook:${hash(id)}`, source: 'other', kind: 'message', at, title: title.slice(0, 300), tier: 3, meta };
  const preview = text(m.bodyPreview, 400);
  if (preview) out.detail = preview;
  return out;
}

const SELECT = 'subject,from,toRecipients,receivedDateTime,sentDateTime,bodyPreview,categories,isRead,isDraft,importance';

// A folder's delta reports an email moved out of it (archived, filed) as '@removed', the same way
// as a deleted one, so '@removed' takes nothing back: archiving an Inbox email keeps it.
async function syncFolder(st: SvcState, ctx: Ctx, folder: string, now: number) {
  const key = `mail.${folder}`;
  const since = new Date(now - MAIL_BACK).toISOString().replace(/\.\d+Z$/, 'Z');
  const first = `${GRAPH}/me/mailFolders/${folder}/messages/delta?$select=${SELECT}&$filter=${encodeURIComponent(`receivedDateTime ge ${since}`)}`;
  await deltaRound(st, ctx, key, first, now, async (items) => {
    await hand('microsoft', items.map((m) => outlookEvent(m, folder)).filter((e): e is LifeEvent => !!e));
  });
}

// ---------- calendar

// Graph's times with the "UTC" preference: 2026-10-17T09:00:00.0000000
const utc = (v: unknown) => {
  const x = obj(v);
  if (typeof x.dateTime !== 'string') return NaN;
  const zone = String(x.timeZone || 'UTC');
  const iso = x.dateTime.replace(/(\.\d{3})\d+$/, '$1');
  return Date.parse(/^(UTC|Etc\/UTC|GMT)$/i.test(zone) && !/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? `${iso}Z` : iso);
};
// An all-day event is a whole local day, wherever the Player is.
const localDay = (v: unknown) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(obj(v).dateTime || ''));
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : NaN;
};

const isGone = (e: Record<string, unknown>) => !!e['@removed'] || e.isCancelled === true || obj(e.responseStatus).response === 'declined';

export function outlookCalendarEvent(raw: unknown): LifeEvent | null {
  const e = obj(raw);
  const id = typeof e.id === 'string' && e.id.length < 1000 ? e.id : '';
  if (!id || isGone(e)) return null;
  const allDay = e.isAllDay === true;
  const at = allDay ? localDay(e.start) : utc(e.start);
  const end = allDay ? localDay(e.end) : utc(e.end);
  if (!Number.isFinite(at) || at <= 0) return null;
  const meta: Record<string, string | number | boolean> = { app: 'outlook-calendar' };
  const out: LifeEvent = { id: `calendar:ms:${hash(id)}`, source: 'calendar', kind: 'event', at, title: text(e.subject, 200) || 'Busy', tier: 2, meta };
  if (Number.isFinite(end) && end >= at) out.end = end;
  const place = text(obj(e.location).displayName, 200);
  if (place) {
    out.detail = `At ${place}`;
    meta.location = place;
  }
  if (allDay) meta.allDay = true;
  const people = arr(e.attendees).length;
  if (people) meta.people = people;
  if (typeof e.webLink === 'string' && /^https:\/\/[^\s"'<>`]{1,1500}$/.test(e.webLink)) out.url = e.webLink;
  return out;
}

async function syncCalendar(st: SvcState, ctx: Ctx, now: number) {
  const key = 'cal';
  // The window is fixed when a round starts; once a month it moves on with a fresh round.
  if (st.cursors[key] && now - (Number(st.cursors['cal.at']) || 0) > CAL_REFRESH) delete st.cursors[key];
  if (!st.cursors[key]) st.cursors['cal.at'] = String(now);
  const from = Number(st.cursors['cal.at']) || now;
  const iso = (t: number) => new Date(t).toISOString().replace(/\.\d+Z$/, 'Z');
  const first = `${GRAPH}/me/calendarView/delta?startDateTime=${iso(from - CAL_SPAN)}&endDateTime=${iso(from + CAL_SPAN)}`;
  await deltaRound(st, ctx, key, first, now, async (items) => {
    await hand('microsoft', items.map(outlookCalendarEvent).filter((e): e is LifeEvent => !!e), { replace: true });
    await takeBack('microsoft', items.filter((e) => isGone(e) && typeof e.id === 'string').map((e) => `calendar:ms:${hash(e.id as string)}`));
  });
}
