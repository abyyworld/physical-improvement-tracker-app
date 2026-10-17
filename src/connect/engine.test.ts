// @vitest-environment jsdom
// Running the linked accounts: where each one can be used, what a sync leaves behind when it
// works or fails, a sign-in coming back to Arise, disconnecting, and deleting what came from one.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeNet, offline, useNative, useWeb, type Net } from '../test/fake-http';
import { fakeLife } from '../test/fake-life';
import { GOOGLE, MICROSOFT } from '../connect-config';
import * as E from './engine';
import * as IDS from './ids';
import { handleOAuthReturn, isOAuthReturn, PENDING, RETURN } from './return';
import { takeReturn } from './oauth';
import { blank, load, save, type SvcState } from './state';
import { setLifeStore } from '../life/store-port';

let net: Net;
let life: ReturnType<typeof fakeLife>;

const googleOn = (extra: Partial<SvcState> = {}): SvcState => ({ ...blank(), on: true, parts: ['calendar'], account: 'me@example.com', user: 'me@example.com', auth: { token: 'ya29.t', expires: Date.now() + 3000_000 }, ...extra });

beforeEach(() => {
  localStorage.clear();
  GOOGLE.clientId = 'g-client';
  MICROSOFT.clientId = 'ms-client';
  net = fakeNet();
  useWeb(net);
  life = fakeLife();
  IDS.resetForTests();
});
afterEach(() => {
  GOOGLE.clientId = '';
  MICROSOFT.clientId = '';
  delete (globalThis as { Capacitor?: unknown }).Capacitor;
});

describe('where each account can be used', () => {
  it('says "not set up" until the owner adds a client ID', () => {
    GOOGLE.clientId = '';
    MICROSOFT.clientId = '';
    expect(E.available('google')).toBe('setup');
    expect(E.available('microsoft')).toBe('setup');
    useNative(net);
    expect(E.available('google')).toBe('setup');
    expect(E.available('microsoft')).toBe('setup');
  });

  it('web app: Google and Microsoft; Steam and PlayStation are iPhone only', () => {
    expect(['google', 'microsoft', 'steam', 'psn'].map((id) => E.available(id as never))).toEqual(['ok', 'ok', 'iphone', 'iphone']);
  });

  it("iPhone app: Microsoft, Steam and PlayStation; Google is on the web", () => {
    useNative(net);
    expect(['google', 'microsoft', 'steam', 'psn'].map((id) => E.available(id as never))).toEqual(['web', 'ok', 'ok', 'ok']);
    // An old iPhone app without its own HTTP can't reach Steam or Sony.
    useNative(net, ['Filesystem']);
    expect(E.available('steam')).toBe('iphone');
  });
});

describe('what a sync leaves behind', () => {
  const calendarRoutes = () => {
    net.on(/calendarList/, { body: { items: [{ id: 'me@example.com', summary: 'me', primary: true, selected: true }] } });
    net.on(/\/events\?/, { body: { items: [{ id: 'evt1', status: 'confirmed', summary: 'Gym', start: { dateTime: '2026-10-16T07:00:00Z' }, end: { dateTime: '2026-10-16T08:00:00Z' } }], nextSyncToken: 's1' } });
  };

  it('works: the time, the count and the cursor are kept', async () => {
    calendarRoutes();
    save('google', googleOn());
    await E.syncNow('google');
    const st = load('google');
    expect(st.last).toBeGreaterThan(0);
    expect(st.count).toBe(1);
    expect(st.error).toBe('');
    expect(Object.values(st.cursors)).toContain('s1');
    expect(life.titles()).toEqual(['Gym']);
  });

  it('a sign-in that ran out waits for a tap, and automatic syncs leave it alone', async () => {
    save('google', googleOn({ auth: { token: 'old', expires: Date.now() - 1 } }));
    await E.syncNow('google');
    expect(load('google').needs).toBe('tap');
    net.calls.length = 0;
    E.syncDue(Date.now() + 3600_000);
    await Promise.resolve();
    expect(net.calls).toEqual([]);
  });

  it('revoked access asks to connect again, in plain words', async () => {
    net.on(/calendarList/, { status: 403, body: { error: { code: 403, errors: [{ reason: 'forbidden' }], status: 'PERMISSION_DENIED' } } });
    save('google', googleOn());
    await E.syncNow('google');
    expect(load('google')).toMatchObject({ needs: 'reconnect', error: "Google didn't allow it. Connect again." });
  });

  it('too many requests: no error, and no automatic sync before the wait is over', async () => {
    net.on(/calendarList/, { status: 429, body: {}, headers: { 'retry-after': '600' } });
    save('google', googleOn());
    const before = Date.now();
    await E.syncNow('google');
    const st = load('google');
    expect(st.error).toBe('');
    expect(st.next).toBeGreaterThanOrEqual(before + 600_000);
    net.calls.length = 0;
    E.syncDue(Date.now() + 60_000);
    expect(net.calls).toEqual([]);
  });

  it('offline: quietly tries again later', async () => {
    offline();
    save('google', googleOn());
    await E.syncNow('google');
    const st = load('google');
    expect(st.error).toBe('');
    expect(st.needs).toBe('');
    expect(st.next).toBeGreaterThan(Date.now());
  });

  it('fetches nothing until the life log is ready, and tries again later', async () => {
    setLifeStore(null);
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    save('google', googleOn());
    const p = E.syncNow('google');
    await vi.advanceTimersByTimeAsync(9000);
    await p;
    vi.useRealTimers();
    expect(net.calls).toEqual([]);
    expect(load('google')).toMatchObject({ error: '', needs: '', last: 0 });
    expect(load('google').next).toBeGreaterThan(Date.now());
  });

  it("a disconnect during a sync isn't undone by it", async () => {
    let release = () => {};
    net.on(/calendarList/, () => new Promise((r) => (release = () => r({ body: { items: [] } }))));
    save('google', googleOn());
    const p = E.syncNow('google');
    await new Promise((r) => setTimeout(r, 0));
    E.disconnect('google');
    release();
    await p;
    expect(load('google').on).toBe(false);
    expect(load('google').auth).toEqual({});
  });

  // A calendar whose second page waits until the test lets it through.
  const slowCalendar = () => {
    const gate = { release: () => {} };
    const event = (id: string, summary: string, day: number) => ({ id, status: 'confirmed', summary, start: { dateTime: `2026-10-${day}T07:00:00Z` }, end: { dateTime: `2026-10-${day}T08:00:00Z` } });
    net.on(/calendarList/, { body: { items: [{ id: 'me@example.com', summary: 'me', primary: true, selected: true }] } });
    net.on(/\/events\?/, (c) =>
      new URL(c.url).searchParams.get('pageToken') === 'p2'
        ? new Promise((r) => (gate.release = () => r({ body: { items: [event('evt2', 'Run', 15)], nextSyncToken: 's1' } })))
        : { body: { items: [event('evt1', 'Gym', 14)], nextPageToken: 'p2' } },
    );
    net.on(/revoke/, { body: '' });
    return gate;
  };
  const waitingForPage2 = () => vi.waitFor(() => expect(net.urls().some((u) => u.includes('pageToken=p2'))).toBe(true));

  it('a sync stopped by Disconnect hands nothing more over, and what it did hand over can be deleted', async () => {
    const gate = slowCalendar();
    save('google', googleOn());
    const p = E.syncNow('google');
    await waitingForPage2();
    expect(life.titles()).toEqual(['Gym']);
    const off = E.disconnect('google');
    gate.release();
    await p;
    await off;
    expect(life.titles()).toEqual(['Gym']);
    // What it got before it stopped is counted, so "Delete what Arise got from it" shows.
    expect(load('google')).toMatchObject({ on: false, count: 1 });
    expect(await E.deleteData('google')).toBe('done');
    expect(life.titles()).toEqual([]);
    expect(await IDS.count('google')).toBe(0);
  });

  it('"Delete what Arise got from it" waits for a sync still running, so nothing it hands over is missed', async () => {
    const gate = slowCalendar();
    save('google', googleOn());
    const p = E.syncNow('google');
    await waitingForPage2();
    const del = E.deleteData('google');
    gate.release();
    expect(await del).toBe('done');
    await p;
    expect(life.titles()).toEqual([]);
    expect(load('google').count).toBe(0);
  });

  it('erasing during a sync stops it: nothing more comes in, and no list of it is left', async () => {
    const gate = slowCalendar();
    save('google', googleOn());
    const p = E.syncNow('google');
    await waitingForPage2();
    const erase = E.forgetAll();
    expect(localStorage.getItem('arise-connect-google')).toBeNull(); // the sign-in goes at once
    gate.release();
    await erase;
    await p;
    expect(life.titles()).toEqual(['Gym']);
    expect(await IDS.count('google')).toBe(0);
    expect(localStorage.getItem('arise-connect-google')).toBeNull();
    expect(net.urls().filter((u) => u.includes('googleapis.com/calendar')).length).toBe(3); // nothing asked for after
  });

  it('only syncs an account whose turn it is', async () => {
    calendarRoutes();
    save('google', googleOn({ last: Date.now() - 60_000 }));
    E.syncDue();
    expect(net.calls).toEqual([]);
    save('google', googleOn({ last: Date.now() - 11 * 60_000 }));
    E.syncDue();
    await vi.waitFor(() => expect(load('google').count).toBe(1));
  });
});

describe('a sign-in coming back', () => {
  const pending = (mode: 'popup' | 'redirect', service = 'google', at = Date.now()) => localStorage.setItem(PENDING, JSON.stringify({ state: 'st8', service, mode, parts: ['calendar', 'mail'], verifier: 'v'.repeat(43), at }));

  it('knows a sign-in answer when it sees one', () => {
    expect(isOAuthReturn('#state=x&access_token=y')).toBe(true);
    expect(isOAuthReturn('#code=abc&state=x')).toBe(true);
    expect(isOAuthReturn('#error=access_denied&state=x')).toBe(true);
    expect(isOAuthReturn('#settings')).toBe(false);
    expect(isOAuthReturn('#access_token=y')).toBe(false);
  });

  it('in the pop-up: passes the answer on, takes it out of the address bar, and closes', () => {
    pending('popup');
    history.replaceState(null, '', '/physical-improvement-tracker-app/#state=st8&access_token=ya29.secret&expires_in=3599&scope=x');
    const close = vi.spyOn(window, 'close').mockImplementation(() => {});
    expect(handleOAuthReturn()).toBe(true);
    expect(close).toHaveBeenCalled();
    expect(location.hash).toBe('#settings');
    expect(JSON.parse(localStorage.getItem(RETURN)!)).toMatchObject({ state: 'st8' });
  });

  it("after a whole-page sign-in: the app starts and picks it up once", () => {
    pending('redirect');
    history.replaceState(null, '', '/physical-improvement-tracker-app/#state=st8&access_token=ya29.secret');
    expect(handleOAuthReturn()).toBe(false);
    expect(location.href).not.toContain('ya29');
    const done = takeReturn()!;
    expect(done.pending.service).toBe('google');
    expect(done.params.get('access_token')).toBe('ya29.secret');
    expect(takeReturn()).toBeNull();
  });

  it("ignores answers to sign-ins this device didn't start, and old ones", () => {
    pending('redirect');
    history.replaceState(null, '', '/physical-improvement-tracker-app/#state=forged&access_token=ya29.evil');
    expect(handleOAuthReturn()).toBe(false);
    expect(localStorage.getItem(RETURN)).toBeNull();
    expect(location.href).not.toContain('evil');
    pending('redirect', 'google', Date.now() - 20 * 60_000);
    localStorage.setItem(RETURN, JSON.stringify({ state: 'st8', params: 'state=st8&access_token=old', at: Date.now() }));
    expect(takeReturn()).toBeNull();
  });

  it('Google: keeps the token and the parts allowed, then syncs', async () => {
    net.on(/calendarList/, { body: { items: [] } });
    const ok = await E.finish({ pending: { state: 's', service: 'google', mode: 'popup', parts: ['calendar', 'mail'], at: Date.now() }, params: new URLSearchParams({ state: 's', access_token: 'ya29.new', expires_in: '3599', scope: 'https://www.googleapis.com/auth/calendar.readonly' }) });
    expect(ok).toBe(true);
    expect(load('google')).toMatchObject({ on: true, parts: ['calendar'], auth: { token: 'ya29.new' } });
  });

  it('Microsoft: swaps the code, with the PKCE verifier kept for it', async () => {
    net.on(/oauth2\/v2\.0\/token/, (c) => {
      expect(new URLSearchParams(c.body).get('code_verifier')).toBe('v'.repeat(43));
      return { body: { access_token: 'eyJ.a', refresh_token: 'M.r', expires_in: 3599 } };
    });
    net.on(/graph\.microsoft\.com/, { body: { value: [], mail: 'me@outlook.com', '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/x' } });
    const ok = await E.finish({ pending: { state: 's', service: 'microsoft', mode: 'redirect', parts: ['calendar'], verifier: 'v'.repeat(43), at: Date.now() }, params: new URLSearchParams({ code: 'c0de', state: 's' }) });
    expect(ok).toBe(true);
    expect(load('microsoft')).toMatchObject({ on: true, parts: ['calendar'], auth: { refresh: 'M.r' } });
  });

  it("says no plainly when the Player didn't say yes", async () => {
    const toast = vi.fn();
    E.initEngine({ toast });
    expect(await E.finish({ pending: { state: 's', service: 'google', mode: 'popup', parts: ['mail'], at: Date.now() }, params: new URLSearchParams({ state: 's', error: 'access_denied' }) })).toBe(false);
    expect(toast).toHaveBeenCalledWith("You didn't say yes, so nothing was linked.");
    expect(load('google').on).toBe(false);
  });
});

describe('disconnecting and deleting', () => {
  it('disconnecting forgets the sign-in and takes it back at Google, but keeps what came in', () => {
    net.on(/revoke/, { body: '' });
    save('google', googleOn({ count: 12, cursors: { x: 'y' } }));
    E.disconnect('google');
    expect(load('google')).toMatchObject({ on: false, auth: {}, cursors: {}, count: 12 });
    const revoke = net.calls.find((c) => c.url === 'https://oauth2.googleapis.com/revoke');
    expect(revoke?.body).toBe('token=ya29.t');
  });

  it('deletes only what came from that account', async () => {
    await life.store.addEvents([
      { id: 'google:gmail:aaaa', source: 'google', kind: 'message', at: 1, title: 'Email', tier: 3 },
      { id: 'google:search:zz', source: 'google', kind: 'search', at: 2, title: 'Searched "x" (from an import)', tier: 3 },
    ]);
    await IDS.add('google', ['google:gmail:aaaa']);
    save('google', googleOn({ count: 1 }));
    expect(await E.deleteData('google')).toBe('done');
    expect([...life.events.keys()]).toEqual(['google:search:zz']);
    expect(load('google').count).toBe(0);
  });

  it("says when the life log can't remove things yet", async () => {
    fakeLife({ full: false });
    await IDS.add('steam', ['steam:1:2']);
    expect(await E.deleteData('steam')).toBe('later');
  });

  it('"Erase all data" forgets every sign-in', async () => {
    net.on(/revoke/, { body: '' });
    save('google', googleOn());
    save('steam', { ...blank(), on: true, auth: { token: 'K'.repeat(32) }, user: '76561197960435530' });
    await IDS.add('steam', ['steam:1:2']);
    await E.forgetAll();
    expect(localStorage.getItem('arise-connect-google')).toBeNull();
    expect(localStorage.getItem('arise-connect-steam')).toBeNull();
    expect(await IDS.count('steam')).toBe(0);
  });
});

describe('what is kept on the device', () => {
  it('rebuilds it field by field, dropping anything odd', () => {
    localStorage.setItem('arise-connect-psn', JSON.stringify({ on: 'yes', account: '<b>x</b>', auth: { token: 42, refresh: 'r' }, parts: ['mail', 'evil'], cursors: { 'ok.key': 'v', 'bad key': 'v', n: 3 }, snap: { a: 5, b: -1, c: 'x' }, count: -3, needs: 'hack', extra: 1 }));
    expect(load('psn')).toEqual({ ...blank(), account: '<b>x</b>', auth: { refresh: 'r' }, parts: ['mail'], cursors: { 'ok.key': 'v' }, snap: { a: 5 } });
    localStorage.setItem('arise-connect-psn', '{not json');
    expect(load('psn')).toEqual(blank());
  });
});
