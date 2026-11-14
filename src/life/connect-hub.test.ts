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

// A browser that can have web reminders.
function pushable(on = true) {
  const w = window as unknown as Record<string, unknown>;
  if (on) {
    Object.defineProperty(navigator, 'serviceWorker', { value: { addEventListener() {}, getRegistration: async () => undefined }, configurable: true });
    w.PushManager = function PushManager() {};
    w.Notification = function Notification() {};
  } else {
    delete (navigator as unknown as Record<string, unknown>).serviceWorker;
    delete w.PushManager;
    delete w.Notification;
  }
}

afterEach(() => {
  delete (globalThis as { Capacitor?: unknown }).Capacitor;
  userAgent(UA);
  pushable(false);
});

// ---------- the screen on its own

async function screen(step = 'connections') {
  vi.resetModules();
  const HUB = await import('./connect-hub.js');
  HUB.openStep(step);
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
    expect(text('.kicker')).toBe('Setup and connections');
    expect(text('.hub-lead')).toBe("Connect what you use, and Arise writes your days from it. Everything stays private: it's read on your devices and only leaves them encrypted.");
    expect(titles()).toEqual(['Your phone', 'Accounts', 'This computer', 'Your history', 'AI apps']);

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

  it('starts with your setup: where each part stands, how far along you are, and what to do next', async () => {
    pushable();
    await screen('review');
    expect(text('#hubSetup .panel-title')).toMatch(/^Your setup \d+ of \d+$/);
    const names = [...document.querySelectorAll('#hubSetup .setup-item .engine-head b')].map((b) => b.textContent);
    expect(names).toEqual(['Account and sync', 'AI coach', 'Reminders', 'Your phone', 'App lock', 'Linked accounts', 'This computer', 'Your history', 'AI apps and other apps']);
    expect(text('#hubSetup .panel-title')).toBe('Your setup 0 of 9');
    expect($('#hubSetup .setup-bar')!.getAttribute('aria-valuenow')).toBe('0');
    expect(text('#hubSetup .setup-next')).toBe('Next: Account and sync. The same Arise on all your devices, and a copy in the cloud that only you can read. Set it up');
    expect(text('#setup-account')).toContain('Recommended');
    expect(text('#setup-lock')).not.toContain('Recommended');
    const go = (id: string) => $(`#setup-${id} [data-act="hub-go"]`)!.dataset;
    expect(go('account')).toMatchObject({ v: 'connect', step: 'account', to: 'accountPanel' });
    expect(go('ai')).toMatchObject({ v: 'connect', step: 'ai', to: 'aiSettings' });
    expect(go('reminders')).toMatchObject({ v: 'settings', to: 'remindersPanel' });
    expect(go('history')).toMatchObject({ v: 'connect', to: 'hubHistory' });
    expect(go('apps')).toMatchObject({ v: 'knows', to: 'meApps' });
    await vi.waitFor(() => expect(text('#setup-history')).toContain('Nothing brought in yet'));
    expect($('#setup-ai [data-act="hub-go"]')!.getAttribute('aria-label')).toBe('Pick one: AI coach');
  });

  it('leaves out web reminders where this browser can never have them', async () => {
    await screen('review');
    expect($('#setup-reminders')).toBeNull();
    expect(text('#hubSetup .panel-title')).toBe('Your setup 0 of 8');
  });

  it('marks what is set up, and less private choices', async () => {
    localStorage.setItem('arise-lock', JSON.stringify({ salt: 'A'.repeat(22), hash: 'A'.repeat(43), iter: 310000, away: 0 }));
    const web = { notes: false, id: 'c'.repeat(22), key: 'd'.repeat(43), tok: 'e'.repeat(43), fh: '0'.repeat(64) };
    localStorage.setItem('arise-me-links', JSON.stringify([{ id: 'a'.repeat(22), key: 'b'.repeat(43), app: 'Claude', at: 1, choice: { sections: ['goals'], tier: 1 }, web }]));
    pushable();
    await screen('review');
    expect(text('#hubSetup .panel-title')).toBe('Your setup 2 of 9');
    expect($('#setup-lock')!.classList.contains('done')).toBe(true);
    expect(text('#setup-lock')).toContain('On');
    expect(text('#setup-apps')).toContain('1 app connected, 1 on the web');
    expect(text('#setup-apps')).toContain('Less private');
    localStorage.clear();
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
    const again = await import('./connect-hub.js');
    again.openStep('connections');
    again.renderConnect($('#app')!);
    expect(text('#macPanel .panel-title')).toBe('Mac Connected');
    expect($('#macPanel [data-act="mac-pull"]')).not.toBeNull();
  });

  it("in the iPhone app: the iPhone's own switches, and this computer says where", async () => {
    phone('ios', ['AriseSense']);
    await screen();
    expect(titles()).toEqual(['Your phone', 'Accounts', 'This computer', 'Your history', 'AI apps']);
    expect($('#hubPhone')).toBeNull();
    expect([...document.querySelectorAll<HTMLElement>('#lifePanel [data-act="life-toggle"]')].map((b) => b.dataset.src)).toEqual(['health', 'motion', 'calendar', 'places', 'shortcuts']);
    expect($('#browserPanel')).toBeNull();
    expect(text('#hub-browser')).toBe('Browser On a computer The sites you visit, what you search, and your time on each site. Open Arise in Chrome, Edge, Brave, Arc or Firefox on your computer to add it.');
    expect(text('#hub-mac')).toContain('Mac only');
  });

  it("in the Android app: the Android app's own panel", async () => {
    phone('android');
    const HUB = await screen('review');
    expect(text('#setup-phone')).toContain('In the Android app');
    expect($('#setup-phone [data-act="hub-go"]')!.dataset.to).toBe('androidLifePanel');
    HUB.openStep('connections');
    HUB.renderConnect($('#app')!);
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
const toStep = async (s: string) => {
  click(`.wiz-rail [data-s="${s}"]`);
  await vi.waitFor(() => expect($(`.wiz-rail [data-s="${s}"]`)!.classList.contains('on')).toBe(true));
};

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
    expect(text('#app > .hub-entry')).toBe('Setup and connections See where everything stands. Connect your phone, accounts, this computer, your history and AI apps. Open →');
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
    await toStep('connections');
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

  it('takes each part of the setup to where it is set up', async () => {
    pushable();
    await boot('connect');
    await toStep('review');
    click('#setup-ai [data-act="hub-go"]');
    await vi.waitFor(() => expect($('#aiSettings')).not.toBeNull());
    expect(location.hash).toBe('#connect'); // the AI step of the setup, here
    expect(text('.wiz-head h2')).toBe('Your AI coach');
    expect($('#aiSettings')!.classList.contains('flash')).toBe(true);
    await toStep('review');
    click('#setup-account [data-act="hub-go"]');
    await vi.waitFor(() => expect($('#accountPanel')!.classList.contains('flash')).toBe(true));
    expect(text('.wiz-head h2')).toBe('Your account');
    await toStep('review');
    click('#setup-reminders [data-act="hub-go"]');
    await vi.waitFor(() => expect(location.hash).toBe('#settings'));
    click('#tabs [data-v="days"]');
    click('#app > .hub-entry');
    await toStep('review');
    click('#setup-history [data-act="hub-go"]');
    await vi.waitFor(() => expect($('#hubHistory')!.classList.contains('flash')).toBe(true));
    expect(location.hash).toBe('#connect');
    await toStep('review');
    click('#setup-apps [data-act="hub-go"]');
    await vi.waitFor(() => expect(location.hash).toBe('#knows'));
    expect($('#meApps')).not.toBeNull();
  });

  it('walks through the setup in steps, with a guide for each and the panels that do it', async () => {
    await boot('connect');
    // Not signed in: it starts at the account.
    expect([...document.querySelectorAll('.wiz-step')].map((b) => b.textContent!.trim())).toEqual(['1Your account', '2Your AI coach', '3Connections', '4Review']);
    expect($('.wiz-step.on')!.getAttribute('aria-current')).toBe('step');
    expect(text('.wiz-top')).toContain('Step 1 of 4');
    expect(text('.wiz-head')).toContain('Recommended');
    expect(text('.wiz-head')).toContain('Not set up yet');
    expect(text('.wiz-guide h3')).toBe('Make an account');
    click('[data-act="hub-page"][data-n="1"]');
    await vi.waitFor(() => expect(text('.wiz-guide h3')).toBe('Keep your recovery code'));
    expect(text('.wiz-pager')).toContain('2 / 4');
    click('[data-act="hub-tab"][data-t="connect"]');
    await vi.waitFor(() => expect($('.wiz-body #accountPanel')).not.toBeNull());
    expect($('.wiz-body #lockPanel')).not.toBeNull();
    click('.wiz-foot .btn.primary');
    await vi.waitFor(() => expect(text('.wiz-top')).toContain('Step 2 of 4'));
    expect(text('.wiz-guide h3')).toBe('Pick where your coach thinks');
    click('.wiz-foot .btn.primary');
    await vi.waitFor(() => expect(text('.wiz-top')).toContain('Step 3 of 4'));
    expect($('#hubPhone')).not.toBeNull();
    expect(text('.wiz-foot .btn.primary')).toBe('Review setup');
    click('.wiz-foot .btn.primary');
    await vi.waitFor(() => expect($('#hubSetup')).not.toBeNull());
    expect(text('.wiz-foot .btn.primary')).toBe('Go to Today');
  });

  it("redraws the browser panel as Connect's, when it changes", async () => {
    await boot('connect');
    await toStep('connections');
    const old = $('#browserPanel')!;
    const b = document.createElement('button');
    b.dataset.act = 'bl-cancel';
    document.body.append(b);
    b.click();
    await vi.waitFor(() => expect($('#browserPanel')).not.toBe(old));
    expect(text('#browserPanel .panel-title')).toBe('Browser Off');
  });

  it("leaves the Me tab's own Your life panel alone when the iPhone panel redraws", async () => {
    await boot('progress');
    const mine = $('#lifePanel')!;
    expect(mine.classList.contains('life-panel')).toBe(true);
    (await import('./sense-ui')).refresh();
    expect($('#lifePanel')).toBe(mine);
  });
});
