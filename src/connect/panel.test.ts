// @vitest-environment jsdom
// Settings, Your life, Accounts on screen: what normal people see before the owner sets a
// service up, on the web and in the iPhone app, once linked, and what the buttons do.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeNet, useNative, useWeb, type Net } from '../test/fake-http';
import { fakeLife } from '../test/fake-life';
import { GOOGLE, MICROSOFT } from '../connect-config';
import * as P from './panel';
import * as IDS from './ids';
import { PENDING, RETURN } from './return';
import { blank, load, save } from './state';

let net: Net;
let life: ReturnType<typeof fakeLife>;

const card = (id: string) => document.getElementById(`acct-${id}`)!;
const text = (id: string) => card(id).textContent!.replace(/\s+/g, ' ').trim();
const buttons = (id: string) => [...card(id).querySelectorAll('button')].map((b) => b.textContent!.trim());
const show = () => {
  document.getElementById('app')!.innerHTML = P.settingsPanel();
};
const tap = async (act: string, data: Record<string, string> = {}) => {
  const b = document.createElement('button');
  b.dataset.act = act;
  Object.assign(b.dataset, data);
  document.body.append(b);
  const handled = await P.handleAction(act, b);
  b.remove();
  return handled;
};

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '<nav id="tabs"></nav><main id="app"></main><div id="sheet" hidden><div class="sheet-panel"><button class="sheet-close"></button><div class="sheet-body"></div></div></div><div id="toast"></div>';
  net = fakeNet();
  useWeb(net);
  life = fakeLife();
  IDS.resetForTests();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => {
  GOOGLE.clientId = '';
  MICROSOFT.clientId = '';
  delete (globalThis as { Capacitor?: unknown }).Capacitor;
  vi.restoreAllMocks();
});

describe('before the owner sets things up', () => {
  it('shows "Not set up yet" and nothing else to press', () => {
    vi.stubEnv('DEV', false); // the live app
    show();
    vi.unstubAllEnvs();
    expect(text('google')).toBe('Google Not set up yet.');
    expect(text('microsoft')).toBe('Microsoft (Outlook) Not set up yet.');
    expect(buttons('google')).toEqual([]);
    expect(buttons('microsoft')).toEqual([]);
    expect(text('steam')).toContain('iPhone app only.');
    expect(text('psn')).toContain('iPhone app only.');
    expect(text('psn')).toContain('Unofficial: Sony could block it');
  });

  it("points the owner to the setup steps on their own computer (npm run dev)", () => {
    vi.stubEnv('DEV', true);
    show();
    vi.unstubAllEnvs();
    expect(text('google')).toContain('Owner: add its client ID in src/connect-config.ts (docs/LAUNCH.md, Turning on linked accounts).');
  });
});

describe('the web app, set up', () => {
  beforeEach(() => {
    GOOGLE.clientId = 'g-client';
    MICROSOFT.clientId = 'ms-client';
  });

  it('offers to connect, and says in one line what each reads', () => {
    show();
    expect(buttons('google')).toEqual(['Connect']);
    expect(buttons('microsoft')).toEqual(['Connect']);
    expect(text('google')).toContain('Never the whole email.');
    expect(text('steam')).toContain('Which games you play, and for how long.');
  });

  it('shows a linked account: who, what, the last sync and how much came from it', () => {
    save('google', { ...blank(), on: true, account: 'me@example.com', parts: ['calendar', 'mail'], last: Date.now() - 5 * 60_000, count: 1204, auth: { token: 't', expires: Date.now() + 3000_000 } });
    show();
    expect(text('google')).toContain('Connected as me@example.com (Calendar and Gmail). Last sync 5 min ago. 1,204 items so far.');
    expect(buttons('google')).toEqual(['Sync now', 'Disconnect', 'Delete what Arise got from it']);
  });

  it('asks for a tap when the hour-long Google sign-in is over', () => {
    save('google', { ...blank(), on: true, needs: 'tap', parts: ['calendar'], count: 3 });
    show();
    expect(text('google')).toContain('Google needs a tap to sync again. Tap Sync now.');
  });

  it('asks to connect again when access was taken away', () => {
    save('microsoft', { ...blank(), on: true, needs: 'reconnect', error: 'Microsoft signed Arise out. Connect again.' });
    show();
    expect(text('microsoft')).toContain('Microsoft signed Arise out. Connect again.');
    expect(buttons('microsoft')).toContain('Connect again');
  });

  it("escapes what came from a service", () => {
    save('google', { ...blank(), on: true, account: '<img src=x onerror=alert(1)>', parts: ['mail'] });
    show();
    expect(card('google').querySelector('img')).toBeNull();
  });

  it('says Google is in test mode when connecting, and opens Google in a pop-up', async () => {
    show();
    await tap('acct-connect', { s: 'google' });
    const sheet = document.querySelector('.sheet-body')!.textContent!;
    expect(sheet).toContain("only people Arise's owner adds can connect, and Google asks you to say yes again every 7 days");
    const popup = { location: { href: '' } };
    const open = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    (document.querySelectorAll<HTMLInputElement>('.acct-part')[1]).checked = false; // calendar only
    await tap('acct-go', { s: 'google' });
    expect(open).toHaveBeenCalledWith('', 'arise-connect', expect.stringContaining('popup'));
    const url = new URL(popup.location.href);
    expect(url.host).toBe('accounts.google.com');
    expect(url.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/calendar.readonly');
    expect(url.searchParams.get('redirect_uri')).toBe(`${location.origin}/`);

    // The pop-up's answer arrives: linked, and a first sync starts.
    net.on(/calendarList/, { body: { items: [] } });
    const { state } = JSON.parse(localStorage.getItem(PENDING)!);
    localStorage.setItem(RETURN, JSON.stringify({ state, params: `state=${state}&access_token=ya29.x&expires_in=3599&scope=https://www.googleapis.com/auth/calendar.readonly`, at: Date.now() }));
    window.dispatchEvent(new StorageEvent('storage'));
    await vi.waitFor(() => expect(load('google').on).toBe(true));
    expect(load('google').parts).toEqual(['calendar']);
  });

  it('goes to Google in the same page when pop-ups are blocked', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    const assign = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, href: window.location.href, assign } as unknown as Location);
    show();
    await tap('acct-connect', { s: 'google' });
    void tap('acct-go', { s: 'google' });
    await vi.waitFor(() => expect(assign).toHaveBeenCalled());
    expect(String(assign.mock.calls[0][0])).toContain('accounts.google.com');
    expect(JSON.parse(localStorage.getItem(PENDING)!).mode).toBe('redirect');
  });

  it('disconnects after asking', async () => {
    net.on(/revoke/, { body: '' });
    save('google', { ...blank(), on: true, parts: ['mail'], count: 4, auth: { token: 't' } });
    show();
    await tap('acct-off', { s: 'google' });
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('What it already got stays until you delete it.'));
    expect(load('google').on).toBe(false);
    expect(text('google')).toContain('4 items from it on this device.');
    expect(buttons('google')).toEqual(['Connect', 'Delete what Arise got from it']);
  });

  it('deletes what Arise got from it', async () => {
    await life.store.addEvents([{ id: 'google:gmail:abcdef', source: 'google', kind: 'message', at: 1, title: 'Email', tier: 3 }]);
    await IDS.add('google', ['google:gmail:abcdef']);
    save('google', { ...blank(), count: 1 });
    show();
    await tap('acct-del', { s: 'google' });
    expect(life.events.size).toBe(0);
    expect(document.getElementById('toast')!.textContent).toBe('Deleted what Arise got from Google.');
    expect(buttons('google')).toEqual(['Connect']);
  });

  it('leaves other buttons alone', async () => {
    expect(await P.handleAction('lock-toggle', document.body)).toBe(false);
  });
});

describe('the iPhone app', () => {
  beforeEach(() => {
    GOOGLE.clientId = 'g-client';
    MICROSOFT.clientId = 'ms-client';
    useNative(net);
  });

  it('sends Google to the web, and offers Microsoft, Steam and PlayStation', () => {
    show();
    expect(text('google')).toContain('Use Arise on the web for this: in Safari or on a computer.');
    expect(buttons('google')).toEqual([]);
    expect(buttons('microsoft')).toEqual(['Connect']);
    expect(buttons('steam')).toEqual(['Connect']);
    expect(buttons('psn')).toEqual(['Connect']);
  });

  it('connects Steam with a key and a profile link, then gets the games', async () => {
    net.on(/GetPlayerSummaries/, { body: { response: { players: [{ steamid: '76561197960435530', personaname: 'Robin' }] } } });
    net.on(/GetOwnedGames/, { body: { response: { game_count: 0, games: [] } } });
    net.on(/GetRecentlyPlayedGames/, { body: { response: { total_count: 0 } } });
    show();
    await tap('acct-connect', { s: 'steam' });
    document.querySelector<HTMLInputElement>('#acctKey')!.value = 'nope';
    await tap('acct-go', { s: 'steam' });
    expect(document.querySelector('#acctErr')!.textContent).toContain('32 letters and numbers');
    document.querySelector<HTMLInputElement>('#acctKey')!.value = '0123456789ABCDEF0123456789ABCDEF';
    document.querySelector<HTMLInputElement>('#acctUser')!.value = 'https://steamcommunity.com/profiles/76561197960435530';
    await tap('acct-go', { s: 'steam' });
    await vi.waitFor(() => expect(load('steam').last).toBeGreaterThan(0));
    expect(load('steam')).toMatchObject({ on: true, account: 'Robin', user: '76561197960435530' });
  });

  it('shows the code to type for Microsoft, and links when Microsoft says yes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    net.on(/devicecode/, { body: { user_code: 'FMRF9X2Q4', device_code: 'dev', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900, interval: 5 } });
    let polls = 0;
    net.on(/oauth2\/v2\.0\/token/, () => (++polls < 2 ? { status: 400, body: { error: 'authorization_pending' } } : { body: { access_token: 'a', refresh_token: 'r', expires_in: 3599 } }));
    net.on(/graph\.microsoft\.com/, { body: { value: [], mail: 'me@outlook.com' } });
    show();
    await tap('acct-connect', { s: 'microsoft' });
    const going = tap('acct-go', { s: 'microsoft' });
    await vi.waitFor(() => expect(document.getElementById('acctDevice')?.textContent).toBe('FMRF9X2Q4'));
    expect(document.querySelector('.sheet-body')!.textContent).toContain('microsoft.com/devicelogin');
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(5000);
    await going;
    vi.useRealTimers();
    expect(load('microsoft')).toMatchObject({ on: true, parts: ['calendar', 'mail'], auth: { refresh: 'r' } });
  });

  it('shows the account the code was typed into, when it is another one than before', async () => {
    save('microsoft', { ...blank(), on: true, needs: 'reconnect', parts: ['calendar'], account: 'old@outlook.com', user: 'old@outlook.com', auth: {} });
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    net.on(/devicecode/, { body: { user_code: 'FMRF9X2Q4', device_code: 'dev', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900, interval: 5 } });
    net.on(/oauth2\/v2\.0\/token/, { body: { access_token: 'a', refresh_token: 'r', expires_in: 3599 } });
    net.on(/graph\.microsoft\.com/, { body: { value: [], mail: 'work@company.com' } });
    show();
    await tap('acct-connect', { s: 'microsoft' });
    const going = tap('acct-go', { s: 'microsoft' });
    await vi.waitFor(() => expect(document.getElementById('acctDevice')?.textContent).toBe('FMRF9X2Q4'));
    await vi.advanceTimersByTimeAsync(5000);
    await going;
    vi.useRealTimers();
    await vi.waitFor(() => expect(load('microsoft').last).toBeGreaterThan(0));
    expect(load('microsoft')).toMatchObject({ on: true, account: 'work@company.com', user: 'work@company.com' });
  });
});
