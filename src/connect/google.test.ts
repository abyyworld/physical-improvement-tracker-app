// @vitest-environment jsdom
// Google Calendar and Gmail: their real answers (shapes from Google's API reference) turned into
// life events, the sync picking up where it left off, and what happens when the sign-in runs
// out, Google is busy, or a cursor is too old.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeNet, useWeb, type Net } from '../test/fake-http';
import { fakeLife } from '../test/fake-life';
import * as G from './google';
import * as IDS from './ids';
import { ConnectError } from './http';
import { hash } from './sink';
import { blank, type SvcState } from './state';

const NOW = Date.parse('2026-10-17T12:00:00Z');
const ctx = { save: vi.fn() };

function signedIn(parts = ['calendar', 'mail']): SvcState {
  return { ...blank(), on: true, parts, auth: { token: 'ya29.token', expires: NOW + 50 * 60_000 } };
}

// ---------- fixtures, as Google's API reference shows them

const calendarList = {
  kind: 'calendar#calendarList',
  items: [
    { kind: 'calendar#calendarListEntry', id: 'en.uk#holiday@group.v.calendar.google.com', summary: 'Holidays in United Kingdom', selected: true, accessRole: 'reader' },
    { kind: 'calendar#calendarListEntry', id: 'football123@group.calendar.google.com', summary: 'Football', selected: true, accessRole: 'owner' },
    { kind: 'calendar#calendarListEntry', id: 'old@group.calendar.google.com', summary: 'Old', hidden: true, accessRole: 'owner' },
    { kind: 'calendar#calendarListEntry', id: 'me@example.com', summary: 'me@example.com', primary: true, selected: true, accessRole: 'owner' },
  ],
};

const dentist = {
  kind: 'calendar#event',
  etag: '"3181161784712000"',
  id: '4eahs9ghkhrvkld72hogu9ph3e',
  status: 'confirmed',
  htmlLink: 'https://www.google.com/calendar/event?eid=NGVhaHM5Z2hraHJ2a2xkNzJob2d1OXBoM2U',
  created: '2026-10-01T10:00:00.000Z',
  updated: '2026-10-01T10:00:00.000Z',
  summary: 'Dentist',
  location: '12 High Street',
  creator: { email: 'me@example.com', self: true },
  organizer: { email: 'me@example.com', self: true },
  start: { dateTime: '2026-10-20T09:30:00+01:00', timeZone: 'Europe/London' },
  end: { dateTime: '2026-10-20T10:15:00+01:00', timeZone: 'Europe/London' },
  iCalUID: '4eahs9ghkhrvkld72hogu9ph3e@google.com',
  sequence: 0,
  reminders: { useDefault: true },
  eventType: 'default',
};
const trip = { kind: 'calendar#event', id: 'trip2026', status: 'confirmed', summary: 'Trip to Rome', start: { date: '2026-10-24' }, end: { date: '2026-10-27' } };
const declined = {
  kind: 'calendar#event',
  id: 'standup_20261019T080000Z',
  status: 'confirmed',
  summary: 'Standup',
  start: { dateTime: '2026-10-19T08:00:00Z' },
  end: { dateTime: '2026-10-19T08:15:00Z' },
  attendees: [
    { email: 'boss@example.com', organizer: true, responseStatus: 'accepted' },
    { email: 'me@example.com', self: true, responseStatus: 'declined' },
  ],
};

const message = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  threadId: id,
  labelIds: ['UNREAD', 'CATEGORY_PERSONAL', 'INBOX', 'Label_12'],
  snippet: 'Hi! Don&#39;t forget the match on Saturday &amp; bring boots.',
  payload: {
    mimeType: 'multipart/alternative',
    headers: [
      { name: 'From', value: '"Jane Doe" <jane@example.com>' },
      { name: 'To', value: 'me@example.com' },
      { name: 'Subject', value: 'Saturday' },
    ],
  },
  sizeEstimate: 5123,
  historyId: '123460',
  internalDate: String(Date.parse('2026-10-16T18:30:00Z')),
  ...extra,
});
const labels = { labels: [{ id: 'INBOX', name: 'INBOX', type: 'system' }, { id: 'Label_12', name: 'Football', type: 'user' }] };
const errorBody = (code: number, reason: string, status: string) => ({ error: { code, message: 'x', errors: [{ message: 'x', domain: 'global', reason }], status } });

let net: Net;
let life: ReturnType<typeof fakeLife>;

beforeEach(() => {
  net = fakeNet();
  useWeb(net);
  life = fakeLife();
  IDS.resetForTests();
  ctx.save.mockClear();
});

describe('turning Google answers into life events', () => {
  it('maps a timed calendar event', () => {
    expect(G.calendarEvent(dentist, { name: 'me@example.com' }, NOW)).toEqual({
      id: 'calendar:g:4eahs9ghkhrvkld72hogu9ph3e',
      source: 'calendar',
      kind: 'event',
      at: Date.parse('2026-10-20T08:30:00Z'),
      end: Date.parse('2026-10-20T09:15:00Z'),
      title: 'Dentist',
      detail: 'At 12 High Street',
      url: dentist.htmlLink,
      tier: 2,
      meta: { app: 'google-calendar', calendar: 'me@example.com', location: '12 High Street' },
    });
  });

  it('maps an all-day event to whole local days', () => {
    const e = G.calendarEvent(trip, { name: 'Travel' }, NOW)!;
    expect(e.at).toBe(new Date(2026, 9, 24).getTime());
    expect(e.end).toBe(new Date(2026, 9, 27).getTime());
    expect(e.meta).toMatchObject({ allDay: true });
  });

  it('leaves out cancelled and declined events, and far-off copies of recurring ones', () => {
    expect(G.calendarEvent({ ...dentist, status: 'cancelled' }, { name: 'x' }, NOW)).toBeNull();
    expect(G.calendarEvent(declined, { name: 'x' }, NOW)).toBeNull();
    expect(G.calendarEvent({ ...dentist, start: { dateTime: '2028-06-01T09:00:00Z' } }, { name: 'x' }, NOW)).toBeNull();
    expect(G.goneIds([{ id: 'abc', status: 'cancelled' }, declined, dentist])).toEqual(['calendar:g:abc', 'calendar:g:standup_20261019T080000Z']);
  });

  it('maps an email: who wrote, subject, labels and the preview, as the most private tier', () => {
    expect(G.gmailEvent(message('18c2f0a1b2c3d4e5'), new Map([['Label_12', 'Football']]))).toEqual({
      id: 'google:gmail:18c2f0a1b2c3d4e5',
      source: 'google',
      kind: 'message',
      at: Date.parse('2026-10-16T18:30:00Z'),
      title: 'Email from Jane Doe: Saturday',
      detail: "Hi! Don't forget the match on Saturday & bring boots.",
      tier: 3,
      meta: { app: 'gmail', from: '"Jane Doe" <jane@example.com>', unread: true, labels: 'Unread, Primary, Inbox, Football', thread: '18c2f0a1b2c3d4e5' },
    });
  });

  it('names who a sent email went to, and skips drafts, spam and trash', () => {
    const sent = message('18c2f0a1b2c3d4e6', {
      labelIds: ['SENT'],
      payload: { headers: [{ name: 'From', value: 'me@example.com' }, { name: 'To', value: 'Sam <sam@example.com>, kim@example.com' }, { name: 'Subject', value: 'Plans' }] },
    });
    expect(G.gmailEvent(sent)!.title).toBe('Emailed Sam and 1 more: Plans');
    for (const l of ['DRAFT', 'SPAM', 'TRASH']) expect(G.gmailEvent(message('18c2f0a1b2c3d4e7', { labelIds: [l] }))).toBeNull();
    expect(G.gmailEvent({ id: '<script>' })).toBeNull();
  });

  it('reads names out of email headers', () => {
    expect(G.person('"Doe, Jane" <jane@example.com>')).toBe('Doe, Jane');
    expect(G.person('bob@example.com')).toBe('bob@example.com');
    expect(G.person('')).toBe('someone');
    expect(G.decode('Tom &amp; Jerry &#x1F600; &bogus;')).toBe('Tom & Jerry 😀 &bogus;');
  });
});

describe('signing in to Google', () => {
  it('asks for read-only access, with no secret, back to Arise', () => {
    const u = new URL(G.authUrl({ state: 's1', parts: ['calendar', 'mail'], hint: 'me@example.com', redirect: 'https://abyyworld.github.io/physical-improvement-tracker-app/' }));
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(u.searchParams.get('response_type')).toBe('token');
    expect(u.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/gmail.readonly');
    expect(u.searchParams.get('redirect_uri')).toBe('https://abyyworld.github.io/physical-improvement-tracker-app/');
    expect(u.searchParams.get('login_hint')).toBe('me@example.com');
    expect(u.searchParams.has('client_secret')).toBe(false);
  });

  it('keeps only the parts Google allowed, and when the token runs out', () => {
    const p = new URLSearchParams({ state: 's1', access_token: 'ya29.x', token_type: 'Bearer', expires_in: '3599', scope: 'https://www.googleapis.com/auth/calendar.readonly' });
    expect(G.readToken(p, ['calendar', 'mail'], NOW)).toEqual({ token: 'ya29.x', expires: NOW + 3599_000, parts: ['calendar'] });
    expect(() => G.readToken(new URLSearchParams({ state: 's1', access_token: 'x', scope: 'email' }), ['mail'], NOW)).toThrow(/didn't allow any/);
    expect(() => G.readToken(new URLSearchParams({ state: 's1', error: 'access_denied' }), ['mail'], NOW)).toThrow(ConnectError);
  });
});

describe('syncing Calendar', () => {
  it('looks a year back the first time, then asks only for what changed', async () => {
    net.on(/calendarList/, { body: calendarList });
    net.on(/calendars\/me%40example\.com\/events/, (c) =>
      new URL(c.url).searchParams.get('syncToken') === 'sync-1'
        ? { body: { items: [{ id: dentist.id, status: 'cancelled' }, { ...trip, summary: 'Trip to Rome and Naples' }], nextSyncToken: 'sync-2' } }
        : new URL(c.url).searchParams.get('pageToken') === 'p2'
          ? { body: { items: [trip, declined], nextSyncToken: 'sync-1' } }
          : { body: { items: [dentist], nextPageToken: 'p2' } },
    );
    net.on(/calendars\/football123/, { body: { items: [], nextSyncToken: 'foot-1' } });
    const st = signedIn(['calendar']);

    await G.sync(st, ctx, NOW);
    const first = new URL(net.urls().find((u) => u.includes('me%40example.com/events'))!);
    expect(first.searchParams.get('timeMin')).toBe('2025-10-17T12:00:00.000Z');
    expect(first.searchParams.get('singleEvents')).toBe('true');
    expect(net.urls().some((u) => u.includes('holiday') || u.includes('old%40'))).toBe(false);
    expect(life.titles()).toEqual(['Dentist', 'Trip to Rome']);
    expect(st.account).toBe('me@example.com');
    expect(Object.values(st.cursors)).toContain('sync-1');
    expect(net.calls.every((c) => c.headers.Authorization === 'Bearer ya29.token')).toBe(true);

    net.calls.length = 0;
    await G.sync(st, ctx, NOW + 600_000);
    const again = new URL(net.urls().find((u) => u.includes('me%40example.com/events'))!);
    expect(again.searchParams.get('syncToken')).toBe('sync-1');
    expect(again.searchParams.has('timeMin')).toBe(false);
    // The dentist was cancelled (taken back out); the trip was renamed (replaced).
    expect(life.titles()).toEqual(['Trip to Rome and Naples']);
    expect(await IDS.list('google')).not.toContain('calendar:g:4eahs9ghkhrvkld72hogu9ph3e');
  });

  it('starts that calendar again when Google says its sync token ran out (410)', async () => {
    net.on(/calendarList/, { body: { items: [calendarList.items[3]] } });
    net.on(/events/, (c) => (new URL(c.url).searchParams.get('syncToken') ? { status: 410, body: errorBody(410, 'fullSyncRequired', 'GONE') } : { body: { items: [dentist], nextSyncToken: 'fresh' } }));
    const st = signedIn(['calendar']);
    st.last = NOW - 3600_000;
    const key = `cal.${hash('me@example.com')}`;
    st.cursors[key] = 'old-token';
    st.cursors[`${key}.at`] = String(NOW - 86400_000);
    await G.sync(st, ctx, NOW);
    expect(Object.values(st.cursors)).toContain('fresh');
    expect(life.titles()).toEqual(['Dentist']);
  });
});

describe('syncing Gmail', () => {
  beforeEach(() => {
    net.on(/\/labels$/, { body: labels });
    net.on(/\/profile$/, { body: { emailAddress: 'me@example.com', messagesTotal: 1200, threadsTotal: 900, historyId: '123456' } });
    net.on(/\/messages\/([0-9a-f]+)\?/, (c) => {
      const id = /messages\/([0-9a-f]+)\?/.exec(c.url)![1];
      return { body: message(id) };
    });
  });

  it('gets 90 days back in turns, asking only for headers and the preview', async () => {
    let n = 0;
    net.on(/\/messages\?/, (c) => {
      const page = Number(new URL(c.url).searchParams.get('pageToken') || 0);
      const ids = Array.from({ length: 100 }, () => `18c2f0a1b2${(n++).toString(16).padStart(6, '0')}`);
      return { body: { messages: ids.map((id) => ({ id, threadId: id })), nextPageToken: page < 5 ? String(page + 1) : undefined } };
    });
    const st = signedIn(['mail']);
    await G.sync(st, ctx, NOW);
    const list = new URL(net.urls().find((u) => u.includes('/messages?'))!);
    expect(list.searchParams.get('q')).toBe(`after:${Math.floor((NOW - G.MAIL_BACK) / 1000)}`);
    expect(net.urls().filter((u) => /messages\/[0-9a-f]+\?/.test(u)).every((u) => u.includes('format=metadata'))).toBe(true);
    expect(net.urls().some((u) => /format=(full|raw)/.test(u))).toBe(false);
    // One turn takes MAIL_RUN emails; the rest wait for the next sync.
    expect(life.events.size).toBe(G.MAIL_RUN);
    expect(st.cursors['mail.back']).toBe('3');
    expect(st.cursors['mail.history']).toBe('123456');
    expect(st.account).toBe('me@example.com');
    net.on(/\/history\?/, { body: { historyId: '123480' } });
    await G.sync(st, ctx, NOW + 600_000);
    expect(life.events.size).toBe(600);
    expect(st.cursors['mail.history']).toBe('123480');
    expect(st.cursors['mail.back']).toBeUndefined();
    expect([...life.events.values()].every((e) => e.tier === 3)).toBe(true);
  });

  it('then asks only for what arrived since (history ids)', async () => {
    const st = signedIn(['mail']);
    st.cursors = { 'mail.history': '123456' };
    st.last = NOW - 3600_000;
    net.on(/\/history\?/, (c) => {
      expect(new URL(c.url).searchParams.get('startHistoryId')).toBe('123456');
      return {
        body: {
          history: [
            { id: '123461', messagesAdded: [{ message: { id: '18c2f0a1b2c3d4e5', threadId: '18c2f0a1b2c3d4e5', labelIds: ['UNREAD', 'INBOX'] } }] },
            { id: '123462', messagesAdded: [{ message: { id: '18c2f0a1b2c3d4e9', threadId: '18c2f0a1b2c3d4e9', labelIds: ['DRAFT'] } }] },
          ],
          historyId: '123470',
        },
      };
    });
    await G.sync(st, ctx, NOW);
    expect([...life.events.keys()]).toEqual(['google:gmail:18c2f0a1b2c3d4e5']);
    expect(st.cursors['mail.history']).toBe('123470');
    expect(net.urls().some((u) => u.includes('/messages?'))).toBe(false);
  });

  it('catches up by date when Google no longer has the history (404)', async () => {
    const st = signedIn(['mail']);
    st.cursors = { 'mail.history': '1' };
    st.last = NOW - 10 * 86400_000;
    net.on(/\/history\?/, { status: 404, body: errorBody(404, 'notFound', 'NOT_FOUND') });
    net.on(/\/messages\?/, { body: { messages: [{ id: '18c2f0a1b2c3d4e5', threadId: '18c2f0a1b2c3d4e5' }] } });
    await G.sync(st, ctx, NOW);
    const list = new URL(net.urls().find((u) => u.includes('/messages?'))!);
    expect(list.searchParams.get('q')).toBe(`after:${Math.floor((st.last - 86400_000) / 1000)}`);
    expect(st.cursors['mail.history']).toBe('123456');
    expect(life.events.size).toBe(1);
  });

  it('skips an email deleted between listing and fetching it', async () => {
    const st = signedIn(['mail']);
    net.on(/\/messages\?/, { body: { messages: [{ id: 'aaaaaaaaaaaaaaaa' }, { id: 'bbbbbbbbbbbbbbbb' }] } });
    net.on(/messages\/aaaaaaaaaaaaaaaa\?/, { status: 404, body: errorBody(404, 'notFound', 'NOT_FOUND') });
    await G.sync(st, ctx, NOW);
    expect([...life.events.keys()]).toEqual(['google:gmail:bbbbbbbbbbbbbbbb']);
  });
});

describe('when things go wrong', () => {
  it("doesn't call Google with a token that ran out: it asks for a tap", async () => {
    const st = signedIn();
    st.auth.expires = NOW + 30_000;
    await expect(G.sync(st, ctx, NOW)).rejects.toMatchObject({ kind: 'tap' });
    expect(net.calls).toEqual([]);
  });

  it('asks for a tap when Google says the token is no good (401)', async () => {
    net.on(/calendarList/, { status: 401, body: errorBody(401, 'authError', 'UNAUTHENTICATED') });
    await expect(G.sync(signedIn(['calendar']), ctx, NOW)).rejects.toMatchObject({ kind: 'tap' });
  });

  it('waits as long as Google asks when it is busy', async () => {
    net.on(/calendarList/, { status: 429, body: errorBody(429, 'rateLimitExceeded', 'RESOURCE_EXHAUSTED'), headers: { 'retry-after': '120' } });
    await expect(G.sync(signedIn(['calendar']), ctx, NOW)).rejects.toMatchObject({ kind: 'rate', retryAfter: 120_000 });
    net.on(/calendarList/, { status: 403, body: errorBody(403, 'userRateLimitExceeded', 'PERMISSION_DENIED') });
    await expect(G.sync(signedIn(['calendar']), ctx, NOW)).rejects.toMatchObject({ kind: 'rate' });
  });

  it('asks to connect again when access was taken away (403)', async () => {
    net.on(/calendarList/, { status: 403, body: errorBody(403, 'insufficientPermissions', 'PERMISSION_DENIED') });
    await expect(G.sync(signedIn(['calendar']), ctx, NOW)).rejects.toMatchObject({ kind: 'auth' });
  });

  it('keeps nothing back when the life log is not ready, so nothing is skipped', async () => {
    vi.resetModules();
    const fresh = await import('./google');
    const port = await import('../life/store-port');
    port.setLifeStore(null);
    net.on(/calendarList/, { body: { items: [calendarList.items[3]] } });
    net.on(/events/, { body: { items: [dentist], nextSyncToken: 's' } });
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const st = signedIn(['calendar']);
    const p = fresh.sync(st, ctx, NOW);
    const caught = p.catch((e) => e);
    await vi.advanceTimersByTimeAsync(9000);
    vi.useRealTimers();
    expect(await caught).toMatchObject({ kind: 'net' });
    expect(Object.keys(st.cursors)).toEqual([]);
  });
});
