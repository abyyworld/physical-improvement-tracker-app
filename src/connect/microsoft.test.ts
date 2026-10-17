// @vitest-environment jsdom
// Outlook mail and calendar through Microsoft Graph: answers shaped like Graph's reference turned
// into life events, delta links carried from one sync to the next, the sign-in's tokens renewed
// (and what happens when they can't be), and the iPhone app's device code sign-in.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeNet, useNative, useWeb, type Net } from '../test/fake-http';
import { fakeLife } from '../test/fake-life';
import { MICROSOFT } from '../connect-config';
import * as MS from './microsoft';
import * as IDS from './ids';
import { challenge } from './oauth';
import { hash } from './sink';
import { blank, type SvcState } from './state';

const NOW = Date.parse('2026-10-17T12:00:00Z');
const GRAPH = 'https://graph.microsoft.com/v1.0';
const web = { save: vi.fn(), native: false };
const phone = { save: vi.fn(), native: true };

function signedIn(parts = ['mail', 'calendar']): SvcState {
  return { ...blank(), on: true, parts, account: 'me@outlook.com', auth: { token: 'eyJ.access', expires: NOW + 50 * 60_000, refresh: 'M.C5.refresh' } };
}

// ---------- fixtures, as Graph's reference shows them

const lunch = {
  '@odata.type': '#microsoft.graph.message',
  '@odata.etag': 'W/"CQAAABYAAAARn2vdzPIRQ7TwKFcI6qhwAAAOtUrT"',
  id: 'AAkALgAAAAAAHYQDEapmEc2byACqAC-EWg0AYa2_xG2tGU2JcjeKWiKdLQAAAOujaAAA',
  subject: 'Lunch next week?',
  receivedDateTime: '2026-10-15T09:12:00Z',
  sentDateTime: '2026-10-15T09:11:58Z',
  bodyPreview: 'Hey, are you free for lunch on Tuesday?',
  isRead: false,
  isDraft: false,
  importance: 'normal',
  categories: ['Friends'],
  from: { emailAddress: { name: 'Alex Wilber', address: 'AlexW@contoso.com' } },
  toRecipients: [{ emailAddress: { name: 'Me', address: 'me@outlook.com' } }],
};
const reply = {
  ...lunch,
  id: 'AAkALgAAAAAAHYQDEapmEc2byACqAC-EWg0AYa2_xG2tGU2JcjeKWiKdLQAAAOujbBBB',
  subject: 'RE: Lunch next week?',
  sentDateTime: '2026-10-15T10:00:00Z',
  receivedDateTime: '2026-10-15T10:00:01Z',
  isRead: true,
  from: { emailAddress: { name: 'Me', address: 'me@outlook.com' } },
  toRecipients: [{ emailAddress: { name: 'Alex Wilber', address: 'AlexW@contoso.com' } }],
};
const teamSync = {
  '@odata.type': '#microsoft.graph.event',
  '@odata.etag': 'W/"EZ9r3czxY0m2jz8c45czkwAAFXcvIw=="',
  id: 'AAMkADNkNAAAgEOAAA=',
  subject: 'Team sync',
  isAllDay: false,
  isCancelled: false,
  start: { dateTime: '2026-10-19T15:00:00.0000000', timeZone: 'UTC' },
  end: { dateTime: '2026-10-19T15:30:00.0000000', timeZone: 'UTC' },
  location: { displayName: 'Room 4', locationType: 'default' },
  responseStatus: { response: 'accepted', time: '2026-10-10T08:00:00Z' },
  webLink: 'https://outlook.live.com/owa/?itemid=AAMkADNkNAAAgEOAAA%3D&exvsurl=1&path=/calendar/item',
  attendees: [{ type: 'required', status: { response: 'accepted' }, emailAddress: { name: 'Alex Wilber', address: 'AlexW@contoso.com' } }],
};
const holiday = { ...teamSync, id: 'AAMkHOLIDAY=', subject: 'Holiday', isAllDay: true, start: { dateTime: '2026-10-23T00:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-10-24T00:00:00.0000000', timeZone: 'UTC' }, location: {}, attendees: [] };
const tokens = (extra: Record<string, unknown> = {}) => ({ token_type: 'Bearer', scope: 'Mail.Read Calendars.Read User.Read', expires_in: 3599, ext_expires_in: 3599, access_token: 'eyJ.new', refresh_token: 'M.C5.new', ...extra });
const graphError = (code: string, status: number) => ({ status, body: { error: { code, message: code, innerError: { date: '2026-10-17T12:00:00', 'request-id': 'x' } } } });

let net: Net;
let life: ReturnType<typeof fakeLife>;

beforeEach(() => {
  MICROSOFT.clientId = 'client-123';
  net = fakeNet();
  useWeb(net);
  life = fakeLife();
  IDS.resetForTests();
  web.save.mockClear();
});
afterEach(() => {
  MICROSOFT.clientId = '';
});

describe('turning Graph answers into life events', () => {
  it('maps a received email: who wrote, subject, date and preview, as the most private tier', () => {
    expect(MS.outlookEvent(lunch, 'inbox')).toEqual({
      id: `email:outlook:${hash(lunch.id)}`,
      source: 'email',
      kind: 'message',
      at: Date.parse('2026-10-15T09:12:00Z'),
      title: 'Email from Alex Wilber: Lunch next week?',
      detail: 'Hey, are you free for lunch on Tuesday?',
      tier: 3,
      meta: { app: 'outlook', folder: 'Inbox', unread: true, from: 'Alex Wilber <AlexW@contoso.com>', labels: 'Friends' },
    });
  });

  it('maps a sent email, and skips drafts and removed ones', () => {
    expect(MS.outlookEvent(reply, 'sentitems')).toMatchObject({ title: 'Emailed Alex Wilber: RE: Lunch next week?', at: Date.parse('2026-10-15T10:00:00Z'), meta: { folder: 'Sent', to: 'AlexW@contoso.com' } });
    expect(MS.outlookEvent({ ...lunch, isDraft: true }, 'inbox')).toBeNull();
    expect(MS.outlookEvent({ id: lunch.id, '@removed': { reason: 'deleted' } }, 'inbox')).toBeNull();
  });

  it('maps calendar events in UTC, all-day ones as local days, and skips cancelled or declined ones', () => {
    expect(MS.outlookCalendarEvent(teamSync)).toEqual({
      id: `calendar:ms:${hash(teamSync.id)}`,
      source: 'calendar',
      kind: 'event',
      at: Date.parse('2026-10-19T15:00:00Z'),
      end: Date.parse('2026-10-19T15:30:00Z'),
      title: 'Team sync',
      detail: 'At Room 4',
      url: teamSync.webLink,
      tier: 2,
      meta: { app: 'outlook-calendar', location: 'Room 4', people: 1 },
    });
    expect(MS.outlookCalendarEvent(holiday)).toMatchObject({ at: new Date(2026, 9, 23).getTime(), end: new Date(2026, 9, 24).getTime(), meta: { allDay: true } });
    expect(MS.outlookCalendarEvent({ ...teamSync, isCancelled: true })).toBeNull();
    expect(MS.outlookCalendarEvent({ ...teamSync, responseStatus: { response: 'declined' } })).toBeNull();
  });
});

describe('signing in to Microsoft', () => {
  it('uses PKCE (RFC 7636 test vector) with no client secret', async () => {
    expect(await challenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    const u = new URL(MS.authUrl({ state: 's', challenge: 'E9M', redirect: 'https://abyyworld.github.io/physical-improvement-tracker-app/' }));
    expect(u.origin + u.pathname).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ client_id: 'client-123', response_type: 'code', response_mode: 'fragment', code_challenge: 'E9M', code_challenge_method: 'S256', scope: 'offline_access User.Read Mail.Read Calendars.Read' });
    // Only what the parts picked need.
    expect(new URL(MS.authUrl({ state: 's', challenge: 'c', redirect: 'https://x/', parts: ['calendar'] })).searchParams.get('scope')).toBe('offline_access User.Read Calendars.Read');
  });

  it('swaps the code for tokens with the verifier', async () => {
    net.on(/oauth2\/v2\.0\/token/, (c) => {
      expect(Object.fromEntries(new URLSearchParams(c.body))).toEqual({ client_id: 'client-123', grant_type: 'authorization_code', code: 'abc', code_verifier: 'ver', redirect_uri: 'https://x/', scope: 'offline_access User.Read Mail.Read' });
      return { body: tokens() };
    });
    const st = blank();
    await MS.redeem(st, 'abc', 'ver', 'https://x/', ['mail'], NOW);
    expect(st.auth).toEqual({ token: 'eyJ.new', expires: NOW + 3599_000, refresh: 'M.C5.new' });
  });

  it("signs in on the iPhone with a code typed on Microsoft's page", async () => {
    useNative(net);
    net.on(/devicecode/, { body: { user_code: 'FMRF9X2Q4', device_code: 'FAQABAAEAAAD', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900, interval: 5, message: 'To sign in…' } });
    let polls = 0;
    net.on(/oauth2\/v2\.0\/token/, (c) => {
      expect(new URLSearchParams(c.body).get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code');
      return ++polls < 3 ? { status: 400, body: { error: 'authorization_pending', error_description: 'AADSTS70016' } } : { body: tokens() };
    });
    const dc = await MS.deviceCode(['calendar', 'mail'], NOW);
    expect(dc).toMatchObject({ code: 'FMRF9X2Q4', url: 'https://microsoft.com/devicelogin', interval: 5000, expires: NOW + 900_000 });
    const st = blank();
    expect(await MS.devicePoll(st, dc, NOW)).toBe('wait');
    expect(await MS.devicePoll(st, dc, NOW)).toBe('wait');
    expect(await MS.devicePoll(st, dc, NOW)).toBe('done');
    expect(st.auth.refresh).toBe('M.C5.new');
    net.on(/oauth2\/v2\.0\/token/, { status: 400, body: { error: 'authorization_declined' } });
    await expect(MS.devicePoll(blank(), dc, NOW)).rejects.toMatchObject({ kind: 'auth' });
  });
});

describe('syncing with delta links', () => {
  it('follows the pages, keeps the delta link, and next time asks only for what changed', async () => {
    const nextLink = `${GRAPH}/me/mailFolders('inbox')/messages/delta?$skiptoken=GwcBoTmPuoTQWfcsAbkYM`;
    const deltaLink = `${GRAPH}/me/mailFolders('inbox')/messages/delta?$deltatoken=LztZwWjo5IivWBhyxw5rACKxf7mPm0oW6JZZ7fvKxYPS_67JnEYmfQQMPccy6FRun0DWJF5775dvuXxlZnMYhBubC1v4SBVT9ZjO8f7acZI.uCdGKSBS4YxPEbn_Q5zxLSq91WhpGeT3MiFx0bxqtq3D`;
    net.on(/\/me\/mailFolders\/inbox\/messages\/delta\?/, (c) => {
      const u = decodeURIComponent(c.url);
      expect(u).toContain('$filter=receivedDateTime ge 2026-07-19T12:00:00Z');
      expect(u).toContain('$select=subject,from,toRecipients,receivedDateTime');
      expect(c.headers.Prefer).toContain('odata.maxpagesize=50');
      return { body: { value: [lunch], '@odata.nextLink': nextLink } };
    });
    net.on(/skiptoken/, { body: { value: [{ ...lunch, id: 'AAkSECOND=', subject: 'Second' }], '@odata.deltaLink': deltaLink } });
    net.on(/\/sentitems\/messages\/delta/, { body: { value: [reply], '@odata.deltaLink': `${GRAPH}/me/mailFolders('sentitems')/messages/delta?$deltatoken=s1` } });
    const st = signedIn(['mail']);
    await MS.sync(st, web, NOW);
    expect(life.titles()).toEqual(['Email from Alex Wilber: Lunch next week?', 'Email from Alex Wilber: Second', 'Emailed Alex Wilber: RE: Lunch next week?']);
    expect(st.cursors['mail.inbox']).toBe(deltaLink);

    net.calls.length = 0;
    net.on(/deltatoken=LztZ/, { body: { value: [{ '@odata.type': '#microsoft.graph.message', id: lunch.id, '@removed': { reason: 'deleted' } }], '@odata.deltaLink': deltaLink } });
    net.on(/deltatoken=s1/, { body: { value: [], '@odata.deltaLink': `${GRAPH}/me/mailFolders('sentitems')/messages/delta?$deltatoken=s1` } });
    await MS.sync(st, web, NOW + 600_000);
    expect(net.urls()).toEqual([deltaLink, `${GRAPH}/me/mailFolders('sentitems')/messages/delta?$deltatoken=s1`]);
    // An email that left the Inbox stays: the delta can't tell archived or filed from deleted.
    expect(life.titles()).toEqual(['Email from Alex Wilber: Lunch next week?', 'Email from Alex Wilber: Second', 'Emailed Alex Wilber: RE: Lunch next week?']);
  });

  it('keeps an email that was archived or filed out of the Inbox, as Gmail does', async () => {
    const deltaLink = `${GRAPH}/me/mailFolders('inbox')/messages/delta?$deltatoken=d1`;
    net.on(/\/me\/mailFolders\/inbox\/messages\/delta\?/, { body: { value: [lunch], '@odata.deltaLink': deltaLink } });
    const st = signedIn(['mail']);
    net.on(/sentitems/, { body: { value: [], '@odata.deltaLink': `${GRAPH}/me/mailFolders('sentitems')/messages/delta?$deltatoken=s1` } });
    await MS.sync(st, web, NOW);
    // Archived: Graph reports it removed from the Inbox ('deleted' is the only reason it gives).
    net.on(/deltatoken=d1/, { body: { value: [{ '@odata.type': '#microsoft.graph.message', id: lunch.id, '@removed': { reason: 'deleted' } }], '@odata.deltaLink': deltaLink } });
    await MS.sync(st, web, NOW + 600_000);
    expect(life.titles()).toEqual(['Email from Alex Wilber: Lunch next week?']);
    expect(await IDS.list('microsoft')).toEqual([`email:outlook:${hash(lunch.id)}`]);
  });

  it('looks a year each way for the calendar, then follows its delta link', async () => {
    net.on(/calendarView\/delta\?startDateTime/, (c) => {
      expect(c.url).toContain('startDateTime=2025-10-17T12:00:00Z&endDateTime=2027-10-17T12:00:00Z');
      expect(c.headers.Prefer).toContain('outlook.timezone="UTC"');
      return { body: { value: [teamSync, holiday], '@odata.deltaLink': `${GRAPH}/me/calendarView/delta?$deltatoken=R0usmci39O` } };
    });
    const st = signedIn(['calendar']);
    await MS.sync(st, web, NOW);
    expect(life.titles()).toEqual(['Team sync', 'Holiday']);
    net.on(/deltatoken=R0us/, { body: { value: [{ ...teamSync, subject: 'Team sync (moved)', start: { dateTime: '2026-10-20T15:00:00.0000000', timeZone: 'UTC' } }, { id: holiday.id, '@removed': { reason: 'deleted' } }], '@odata.deltaLink': `${GRAPH}/me/calendarView/delta?$deltatoken=R1` } });
    await MS.sync(st, web, NOW + 600_000);
    expect(life.titles()).toEqual(['Team sync (moved)']);
    expect(st.cursors.cal).toBe(`${GRAPH}/me/calendarView/delta?$deltatoken=R1`);
  });

  it('starts a part again when its delta link ran out', async () => {
    const st = signedIn(['calendar']);
    st.cursors = { cal: `${GRAPH}/me/calendarView/delta?$deltatoken=OLD`, 'cal.at': String(NOW - 86400_000) };
    net.on(/deltatoken=OLD/, graphError('SyncStateNotFound', 410));
    net.on(/calendarView\/delta\?startDateTime/, { body: { value: [teamSync], '@odata.deltaLink': `${GRAPH}/me/calendarView/delta?$deltatoken=NEW` } });
    await MS.sync(st, web, NOW);
    expect(st.cursors.cal).toContain('NEW');
    expect(life.titles()).toEqual(['Team sync']);
  });

  it("doesn't follow links that aren't Graph's", async () => {
    const st = signedIn(['calendar']);
    net.on(/calendarView\/delta/, { body: { value: [], '@odata.deltaLink': 'https://evil.example/steal' } });
    await MS.sync(st, web, NOW);
    expect(st.cursors.cal || '').not.toContain('evil');
  });
});

describe('tokens running out', () => {
  it('renews an access token that ran out, and keeps the new refresh token', async () => {
    const st = signedIn(['calendar']);
    st.auth.expires = NOW - 1000;
    net.on(/oauth2\/v2\.0\/token/, (c) => {
      expect(Object.fromEntries(new URLSearchParams(c.body))).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'M.C5.refresh' });
      return { body: tokens() };
    });
    net.on(/calendarView\/delta/, (c) => {
      expect(c.headers.Authorization).toBe('Bearer eyJ.new');
      return { body: { value: [], '@odata.deltaLink': `${GRAPH}/me/calendarView/delta?$deltatoken=x` } };
    });
    await MS.sync(st, web, NOW);
    expect(st.auth.refresh).toBe('M.C5.new');
    expect(web.save).toHaveBeenCalled();
  });

  it('tries once more with a fresh token when Graph says 401', async () => {
    const st = signedIn(['calendar']);
    let n = 0;
    net.on(/calendarView\/delta/, () => (n++ === 0 ? graphError('InvalidAuthenticationToken', 401) : { body: { value: [], '@odata.deltaLink': `${GRAPH}/me/calendarView/delta?$deltatoken=x` } }));
    net.on(/oauth2\/v2\.0\/token/, { body: tokens() });
    await MS.sync(st, web, NOW);
    expect(n).toBe(2);
  });

  it('asks for a tap in the web app when the 24-hour sign-in is over, and to connect again on the iPhone', async () => {
    const st = signedIn(['calendar']);
    st.auth.expires = NOW - 1000;
    net.on(/oauth2\/v2\.0\/token/, { status: 400, body: { error: 'invalid_grant', error_description: 'AADSTS700084: The refresh token was issued to a single page app (SPA), and therefore has a fixed, limited lifetime of 1.00:00:00' } });
    await expect(MS.sync(st, web, NOW)).rejects.toMatchObject({ kind: 'tap' });
    useNative(net);
    await expect(MS.sync(signedIn(['calendar']), phone, NOW + 3600_000)).rejects.toMatchObject({ kind: 'auth' });
  });

  it('backs off as long as Graph asks when throttled (429)', async () => {
    net.on(/calendarView\/delta/, { ...graphError('ApplicationThrottled', 429), headers: { 'retry-after': '30' } });
    await expect(MS.sync(signedIn(['calendar']), web, NOW)).rejects.toMatchObject({ kind: 'rate', retryAfter: 30_000 });
  });

  it('asks who it is again after a sign-in: another account starts afresh, the same one carries on', async () => {
    const old = `${GRAPH}/me/calendarView/delta?$deltatoken=OLD`;
    net.on(/calendarView\/delta\?startDateTime/, { body: { value: [], '@odata.deltaLink': `${GRAPH}/me/calendarView/delta?$deltatoken=NEW` } });
    net.on(/deltatoken=OLD/, { body: { value: [], '@odata.deltaLink': old } });
    net.on(/\/me\?/, { body: { displayName: 'Work', mail: 'work@company.com' } });
    // Signed in again (the name is cleared then), but to a work account this time.
    const st: SvcState = { ...signedIn(['calendar']), account: '', user: 'me@outlook.com', cursors: { cal: old, 'cal.at': String(NOW - 86400_000) } };
    await MS.sync(st, web, NOW);
    expect(st).toMatchObject({ account: 'work@company.com', user: 'work@company.com' });
    expect(net.urls()).not.toContain(old);
    expect(st.cursors.cal).toContain('NEW');

    // The same account again (written another way): it carries on where it left off.
    const same: SvcState = { ...signedIn(['calendar']), account: '', user: 'Work@Company.com', cursors: { cal: old, 'cal.at': String(NOW - 86400_000) } };
    net.calls.length = 0;
    await MS.sync(same, web, NOW);
    expect(net.urls()).toContain(old);
    expect(same.account).toBe('work@company.com');
  });

  it('asks who it is once, for the account name', async () => {
    const st = signedIn([]);
    st.account = '';
    net.on(/\/me\?/, { body: { displayName: 'Me', mail: null, userPrincipalName: 'me@outlook.com' } });
    await MS.sync(st, web, NOW);
    expect(st.account).toBe('me@outlook.com');
  });
});
