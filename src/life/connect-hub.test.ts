// @vitest-environment jsdom
// Connect: one place for everything Arise can read. On the web: what the iPhone and Android apps
// add and where to get them, the accounts ("Coming soon" until the owner sets them up), this
// computer (the browser extension; the Mac helper on a Mac, "Mac only" elsewhere) and history from
// files. In the iPhone or Android app: that app's own switches. The ways in (Days, Settings, Today,
// You), the Days tab lit while it's open, bringing in history and coming back, and each panel's
// own redraws keeping the name Connect gave it.

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/firebase', () => import('../test/fake-firebase'));

const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const UA = navigator.userAgent;
function userAgent(ua: string) {
  Object.defineProperty(window.navigator, 'userAgent', { value: ua, configurable: true });
  Object.defineProperty(window.navigator, 'maxTouchPoints', { value: 0, configurable: true });
}
// The iPhone or Android app (Capacitor), with or without Arise's own plugin.
function phone(platform: 'ios' | 'android', plugins: string[] = []) {
  (globalThis as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => platform,
    PluginHeaders: plugins.map((name) => ({ name })),
    nativePromise: async () => ({}),
  };
}

const $ = (sel: string) => document.querySelector<HTMLElement>(sel);
const text = (sel: string) => $(sel)?.textContent?.replace(/\s+/g, ' ').trim() || '';
const titles = () => [...document.querySelectorAll('.hub > .col > .panel > .panel-title')].map((t) => t.textContent!.trim());
const lit = () => [...document.querySelectorAll('#tabs [data-v].on')].map((b) => b.getAttribute('data-v'));

afterEach(() => {
  delete (globalThis as { Capacitor?: unknown }).Capacitor;
  userAgent(UA);
});

// ---------- the screen on its own

async function screen() {
  vi.resetModules();
  const HUB = await import('./connect-hub.js');
  HUB.renderConnect($('#app')!);
  return HUB;
}

describe('the Connect screen', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '<div id="app"></div><div id="toast"></div><div id="sheet" hidden><div class="sheet-panel"><div class="sheet-body"></div></div></div>';
  });

  it('on the web: says what each phone app adds and where to get it, the accounts, this computer and your history', async () => {
    const HUB = await screen();
    expect(text('h1')).toBe('Connect');
    expect(text('.kicker')).toBe('Your life, from everywhere');
    expect(text('.hub-lead')).toBe("Connect what you use, and Arise writes your days from it. Everything stays private: it's read on your devices and only leaves them encrypted.");
    expect(titles()).toEqual(['Your phone', 'Accounts', 'This computer', 'Your history']);

    expect(text('#hub-iphone')).toBe('iPhone Needs the iPhone app Health, sleep, steps, workouts, calendar, places and Shortcuts need the Arise app on your iPhone. How to get it');
    expect($('#hub-iphone a')!.getAttribute('href')).toBe(HUB.IPHONE_HOW);
    expect(HUB.IPHONE_HOW).toBe('https://github.com/abyyworld/physical-improvement-tracker-app#the-iphone-app');
    expect(text('#hub-android')).toBe('Android Needs the Android app Calls, missed calls, notifications, app use and Health Connect need the Arise app on your Android phone. Get the Android app');
    expect($('#hub-android a')!.getAttribute('href')).toBe('https://github.com/abyyworld/physical-improvement-tracker-app/releases/download/android-latest/Arise.apk');
    expect(text('#hubPhone')).toContain("iPhones don't let any app read missed calls or other apps' notifications. The Mac helper can, if your iPhone passes calls and notifications to your Mac.");

    // The accounts, as in Settings, and nothing for the owner to do.
    expect(text('#acct-google')).toContain('Coming soon');
    expect(text('#acct-microsoft')).toContain('Coming soon');
    expect(text('#acct-steam')).toContain('Needs the iPhone app');
    expect(text('#accountsPanel')).not.toContain('Owner');
    expect($('#accountsPanel .label')).toBeNull(); // its title says Accounts already

    // This computer: the extension's panel, and the Mac helper only on a Mac.
    expect(text('#browserPanel .panel-title')).toBe('Browser Off');
    expect(text('#browserPanel')).toContain('the sites you visit, what you search, and your time on each site');
    expect($('#macPanel')).toBeNull();
    expect(text('#hub-mac')).toBe('Mac Mac only Calls (missed ones from your iPhone too), notifications, Messages, Safari and app use, through a small helper on your Mac.');

    expect(text('#hub-history')).toBe('Files from your apps Google Takeout, Maps Timeline, Spotify, Netflix, Apple Health, WhatsApp and bank statements. Arise reads the file on this device. Bring in your history');
    expect($('#hub-history [data-act="nav"]')!.dataset.v).toBe('life-import');
  });

  it('on a Mac: the Mac helper panel, saying whether it is linked', async () => {
    userAgent(MAC);
    await screen();
    expect($('#hub-mac')).toBeNull();
    expect(text('#macPanel .panel-title')).toBe('Mac Off');
    expect($('#macPanel [data-act="mac-link"]')).not.toBeNull();
    localStorage.setItem('arise-mac', JSON.stringify({ code: 'ABCDE12345FGHJK67890', linkedAt: 1 }));
    vi.resetModules();
    (await import('./mac-link')).useHelper((async () => Promise.reject(new TypeError('offline'))) as typeof fetch);
    (await import('./connect-hub.js')).renderConnect($('#app')!);
    expect(text('#macPanel .panel-title')).toBe('Mac Connected');
    expect($('#macPanel [data-act="mac-pull"]')).not.toBeNull();
  });

  it("in the iPhone app: the iPhone's own switches, and this computer says where", async () => {
    phone('ios', ['AriseSense']);
    await screen();
    expect(titles()).toEqual(['Your phone', 'Accounts', 'This computer', 'Your history']);
    expect($('#hubPhone')).toBeNull();
    expect([...document.querySelectorAll<HTMLElement>('#lifePanel [data-act="life-toggle"]')].map((b) => b.dataset.src)).toEqual(['health', 'motion', 'calendar', 'places', 'shortcuts']);
    expect($('#browserPanel')).toBeNull();
    expect(text('#hub-browser')).toBe('Browser On a computer The sites you visit, what you search, and your time on each site. Open Arise in Chrome, Edge, Brave, Arc or Firefox on your computer to add it.');
    expect(text('#hub-mac')).toContain('Mac only');
  });

  it("in the Android app: the Android app's own panel", async () => {
    phone('android');
    await screen();
    expect(titles()[0]).toBe('Your phone');
    expect($('#androidLifePanel')).not.toBeNull();
    expect($('#lifePanel')).toBeNull();
    expect(text('#androidLifePanel')).toContain('Install the newest Arise.apk to use this.');
  });

  it("keeps each panel's name when the panel redraws itself", async () => {
    phone('ios', ['AriseSense']);
    await screen();
    const SENSE = await import('./sense-ui');
    const old = $('#lifePanel');
    SENSE.refresh();
    expect($('#lifePanel')).not.toBe(old);
    expect(text('#lifePanel .panel-title')).toBe('Your phone');

    delete (globalThis as { Capacitor?: unknown }).Capacitor;
    phone('android');
    await screen();
    const ANDROID = await import('./android-ui');
    const was = $('#androidLifePanel');
    ANDROID.refresh();
    expect($('#androidLifePanel')).not.toBe(was);
    expect(text('#androidLifePanel .panel-title')).toBe('Your phone');

    delete (globalThis as { Capacitor?: unknown }).Capacitor;
    userAgent(MAC);
    await screen();
    const CONNECT = await import('../connect');
    const accounts = $('#accountsPanel');
    CONNECT.refresh();
    expect($('#accountsPanel')).not.toBe(accounts);
    expect(text('#accountsPanel .panel-title')).toBe('Accounts');
    const MACP = await import('./mac-panel.js');
    const b = document.createElement('button');
    await MACP.handleAction('mac-unlink', b); // redraws the panel
    expect(text('#macPanel .panel-title')).toBe('Mac Off');
  });
});

// ---------- in the app

// Each boot starts the whole app again: the listeners the last one added go first.
const added: [EventTarget, string, EventListenerOrEventListenerObject, unknown][] = [];
for (const target of [document, window]) {
  const add = target.addEventListener.bind(target);
  target.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: unknown) => {
    added.push([target, type, fn, opts]);
    add(type, fn, opts as AddEventListenerOptions);
  }) as typeof target.addEventListener;
}

async function boot(view: string) {
  for (const [target, type, fn, opts] of added.splice(0)) target.removeEventListener(type, fn, opts as EventListenerOptions);
  vi.resetModules();
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
  localStorage.setItem('arise-look-hint', 'seen');
  localStorage.setItem('pit-data-v1', JSON.stringify({ sessions: [], profile: { onboarded: true, skipped: true } }));
  document.body.innerHTML = '<nav id="tabs"></nav><main id="app"></main><div id="restbar" hidden></div><div id="sheet" hidden><div class="sheet-panel"><button class="sheet-close"></button><div class="sheet-body"></div></div></div><div id="toast"></div><input type="file" id="importFile" hidden>';
  history.replaceState(null, '', `#${view}`);
  await import('../app.js');
}
const click = (sel: string) => $(sel)!.click();

describe('Connect in the app', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 17, 10));
    window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    window.scrollTo = () => {};
  });
  afterEach(() => vi.useRealTimers());

  it('opens from the top of the Days screen, with the Days tab lit, and goes back to Days', async () => {
    await boot('days');
    const entry = $('#app > .hub-entry')!;
    expect(entry.compareDocumentPosition($('#app > .cols')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(text('#app > .hub-entry')).toBe('Connect apps and devices Your phone, your accounts, this computer and your history. Open →');
    entry.click();
    expect(location.hash).toBe('#connect');
    expect(text('h1')).toBe('Connect');
    expect(lit()).toEqual(['days']);
    click('.page-head [data-act="nav"][data-v="days"]');
    expect(text('h1')).toBe('Your days');
  });

  it('opens from Settings, at the top of Your life', async () => {
    await boot('settings');
    const entry = $('.hub-entry')!;
    expect(entry.nextElementSibling!.id).toBe('accountsPanel');
    entry.click();
    expect(location.hash).toBe('#connect');
    expect(lit()).toEqual(['days']);
  });

  it('brings in your history and comes back to Connect, or to Settings when it opened from there', async () => {
    await boot('connect');
    click('#hub-history [data-act="nav"]');
    expect(location.hash).toBe('#life-import');
    expect(lit()).toEqual(['days']);
    click('.page-head [data-act="nav"]');
    expect(location.hash).toBe('#connect');

    click('#tabs [data-v="settings"]');
    click('#app [data-act="nav"][data-v="life-import"]');
    expect(lit()).toEqual(['settings']);
    click('.page-head [data-act="nav"]');
    expect(location.hash).toBe('#settings');
  });

  it("redraws the browser panel as Connect's, when it changes", async () => {
    await boot('connect');
    const old = $('#browserPanel')!;
    const b = document.createElement('button');
    b.dataset.act = 'bl-cancel';
    document.body.append(b);
    b.click();
    await vi.waitFor(() => expect($('#browserPanel')).not.toBe(old));
    expect(text('#browserPanel .panel-title')).toBe('Browser Off');
  });

  it("leaves the You tab's own Your life panel alone when the iPhone panel redraws", async () => {
    await boot('progress');
    const mine = $('#lifePanel')!;
    expect(mine.classList.contains('life-panel')).toBe(true);
    (await import('./sense-ui')).refresh();
    expect($('#lifePanel')).toBe(mine);
  });
});
