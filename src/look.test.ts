// @vitest-environment jsdom
// The two looks: the Arise look for everyone by default, and the System look (the original Solo
// Leveling one) for whoever picks it, each with its own words, and on screen from the first paint.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./lib/firebase', () => import('./test/fake-firebase'));

const session = (date: string, workout = 'a') => ({ id: `s${date.replace(/-/g, '')}`, workout, date, started: 1, finished: 2, easy: false, items: [{ ex: 'band_row', setup: '', sets: [{ r: 10, done: true }] }] });
const someone = { sessions: [session('2026-10-07'), session('2026-10-08', 'b')], profile: { name: 'Sam', onboarded: true } };

// Starts the app on `view` with this saved data (and anything else already on the device).
async function boot(view: string, data: object | null, device: Record<string, string> = {}) {
  vi.resetModules();
  localStorage.clear();
  if (data) localStorage.setItem('pit-data-v1', JSON.stringify(data));
  for (const [k, v] of Object.entries(device)) localStorage.setItem(k, v);
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-mode');
  document.body.innerHTML = '<nav id="tabs"></nav><main id="app"></main><div id="restbar" hidden></div><div id="sheet" hidden><div class="sheet-panel"><button class="sheet-close"></button><div class="sheet-body"></div></div></div><div id="toast"></div><input type="file" id="importFile" hidden>';
  history.replaceState(null, '', `#${view}`);
  const S = await import('./store');
  await import('./app.js');
  return S;
}
const $ = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const text = (sel: string) => $(sel)?.textContent?.trim();
const tab = (v: string) => text(`#tabs [data-v="${v}"]`);
const click = (sel: string) => $(sel)!.click();

let dark = false;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 9, 12)); // Friday 9 October 2026
  dark = false;
  window.matchMedia = ((q: string) => ({ matches: dark && q.includes('dark'), addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
});

describe('the look', () => {
  it('starts everyone, old and new, on the Arise look, with its plain words', async () => {
    const S = await boot('today', someone);
    expect(S.state.settings.look).toBe('auto');
    expect(document.documentElement.dataset.theme).toBe('arise');
    expect(document.documentElement.dataset.mode).toBeUndefined(); // follows the device
    expect(tab('coach')).toBe('Coach');
    expect($('.glance')).not.toBeNull(); // the day at a glance leads
    expect(text('.glance-hi')).toBe('Good afternoon, Sam');
    expect(text('.sysmsg .sys-line')).toBe('From your coach');
    expect(text('.sysmsg-text')).not.toMatch(/\[|Player|System/);
    expect(text('.quest .panel-title')).toBe("Today's workout");
    expect(text('.quest .btn.primary')).toBe('Start workout');
    expect(text('.status .panel-title')).toBe('Your progress');
    expect(document.body.textContent).not.toMatch(/Hunter|\[System|Daily Quest/);
  });

  it('switches to the System look, words and all, and back', async () => {
    const S = await boot('settings', someone, { 'arise-look-hint': 'seen' });
    expect($('#lookPanel [data-v="auto"]')!.getAttribute('aria-pressed')).toBe('true');
    click('#lookPanel [data-v="system"]');
    expect(S.state.settings.look).toBe('system');
    expect(document.documentElement.dataset.theme).toBe('system');
    expect(localStorage.getItem('arise-look')).toBe('system'); // for the next start, before the first paint
    expect(tab('coach')).toBe('System');
    expect(text('#app .panel-title span')).toBe('Look');
    expect(document.body.textContent).toContain('Name on your status window');

    click('#tabs [data-v="today"]');
    expect($('.glance')).toBeNull();
    expect(text('.sysmsg .sys-line')).toBe('[System message]');
    expect(text('.quest .sys-line')).toBe('[Daily Quest: C · Speed & legs] has arrived.');
    expect(text('.quest .btn.primary')).toBe('Start quest');
    expect(text('.status .panel-title')).toBe('Status');
    expect(text('.status-meta')).toContain('Rank');

    click('#tabs [data-v="settings"]');
    click('#lookPanel [data-v="dark"]');
    expect(document.documentElement.dataset.theme).toBe('arise');
    expect(document.documentElement.dataset.mode).toBe('dark');
    expect(tab('coach')).toBe('Coach');
    expect(document.querySelector('meta[name="theme-color"]')!.getAttribute('content')).toBe('#121110');
  });

  it('says once, to people who used the old look, where it went', async () => {
    await boot('today', someone);
    expect(localStorage.getItem('arise-look-hint')).toBe('pending');
    expect(text('.look-hint .panel-title')).toBe('A new look for Arise');
    click('.look-hint [data-act="look-hint-ok"]');
    expect($('.look-hint')).toBeNull();
    expect(localStorage.getItem('arise-look-hint')).toBe('seen');

    // "Use the System look" right from the card.
    const S = await boot('today', someone);
    click('.look-hint [data-v="system"]');
    expect(S.state.settings.look).toBe('system');
    expect($('.look-hint')).toBeNull();
    expect(localStorage.getItem('arise-look-hint')).toBe('seen');
  });

  it("doesn't tell someone new about a look they never saw", async () => {
    await boot('today', null);
    expect(localStorage.getItem('arise-look-hint')).toBe('seen');
    expect($('.look-hint')).toBeNull();
  });

  it('shows a look picked on another device once it syncs in', async () => {
    const S = await boot('today', someone, { 'arise-look-hint': 'seen' });
    S.state.settings.look = 'system'; // as a sync brings it
    S.save();
    click('#tabs [data-v="goals"]');
    expect(document.documentElement.dataset.theme).toBe('system');
    expect(tab('coach')).toBe('System');
  });
});

describe('before the first paint', () => {
  const boot = readFileSync(join(process.cwd(), 'public', 'look.js'), 'utf8'); // (jsdom has no file URL here)
  const reset = () => {
    for (const a of ['data-theme', 'data-mode']) document.documentElement.removeAttribute(a);
    for (const m of document.head.querySelectorAll('meta')) m.remove();
  };
  const seen = () => ({
    theme: document.documentElement.dataset.theme,
    mode: document.documentElement.dataset.mode,
    bar: document.head.querySelector('meta[name="theme-color"]')?.getAttribute('content'),
    scheme: document.head.querySelector('meta[name="color-scheme"]')?.getAttribute('content'),
  });

  it('shows the same look the app does, for every choice and both device settings', async () => {
    const { applyLook } = await import('./look');
    for (const device of [false, true]) {
      dark = device;
      for (const look of ['auto', 'light', 'dark', 'system'] as const) {
        reset();
        localStorage.setItem('arise-look', look);
        new Function(boot)();
        const early = seen();
        reset();
        applyLook(look);
        expect(early, `${look}, device ${device ? 'dark' : 'light'}`).toEqual(seen());
      }
    }
  });

  it('falls back to the Arise look for anything it doesn\'t know, or no storage at all', () => {
    for (const v of ['<b>', 'System', '']) {
      reset();
      localStorage.setItem('arise-look', v);
      new Function(boot)();
      expect(seen()).toMatchObject({ theme: 'arise', mode: undefined, bar: '#f5f4f0' });
    }
    reset();
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    new Function(boot)();
    get.mockRestore();
    expect(seen()).toMatchObject({ theme: 'arise', bar: '#f5f4f0' });
  });

  it("keeps the iPhone app's status bar readable when the look isn't the phone's", async () => {
    const { applyLook } = await import('./look');
    (window as { Capacitor?: object }).Capacitor = { isNativePlatform: () => true };
    try {
      // The status bar's text follows the phone: white in dark mode, black in light mode.
      const cases: [boolean, 'auto' | 'light' | 'dark' | 'system', string | undefined][] = [
        [true, 'auto', undefined],
        [true, 'light', 'dark'], // a light page under white text: a dark strip behind it
        [true, 'system', undefined],
        [false, 'auto', undefined],
        [false, 'dark', 'light'],
        [false, 'system', 'light'],
      ];
      for (const [device, look, strip] of cases) {
        dark = device;
        applyLook(look);
        expect(document.documentElement.dataset.statusbar, `${look} on a ${device ? 'dark' : 'light'} phone`).toBe(strip);
      }
    } finally {
      delete (window as { Capacitor?: object }).Capacitor;
    }
    applyLook('light');
    expect(document.documentElement.dataset.statusbar).toBeUndefined(); // only in the iPhone app
  });

  it("sets the iPhone home-screen app's status bar for a light or dark page", () => {
    const style = () => document.head.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')?.getAttribute('content');
    for (const [look, want] of [['light', 'default'], ['dark', 'black-translucent'], ['system', 'black-translucent']]) {
      reset();
      localStorage.setItem('arise-look', look);
      new Function(boot)();
      expect(style()).toBe(want);
    }
  });
});
