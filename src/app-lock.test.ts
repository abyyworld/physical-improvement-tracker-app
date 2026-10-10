// @vitest-environment jsdom
// The app lock on screen: it covers the app when it opens and after the time away, while a
// quest in progress carries on under it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./lib/firebase', () => import('./test/fake-firebase'));

type Store = typeof import('./store');
type Lock = typeof import('./lib/lock');

const session = (date: string) => ({ id: `s${date.replace(/-/g, '')}`, workout: 'a', date, started: 1, finished: 2, easy: false, items: [{ ex: 'band_row', setup: '', sets: [{ r: 10, done: true }] }] });

// Starts the app on `view` with this saved data and, given `lock`, the app lock on with passcode 1234.
async function boot(view: string, data: object, { lock, setup = () => {} }: { lock?: { away: number }; setup?: (S: Store) => void } = {}) {
  vi.resetModules();
  localStorage.clear();
  localStorage.setItem('pit-data-v1', JSON.stringify(data));
  document.body.innerHTML = '<nav id="tabs"></nav><main id="app"></main><div id="restbar" hidden></div><div id="sheet" hidden><div class="sheet-backdrop"></div><div class="sheet-panel"><button class="sheet-close"></button><div class="sheet-body"></div></div></div><div id="toast"></div><input type="file" id="importFile" hidden>';
  history.replaceState(null, '', `#${view}`);
  const L: Lock = await import('./lib/lock');
  if (lock) await L.turnOn('1234', lock);
  const S: Store = await import('./store');
  setup(S);
  await import('./app.js');
  const ui = await import('./ui.js');
  return { S, L, ui };
}

let vis: DocumentVisibilityState = 'visible';
const setVisible = (on: boolean) => {
  vis = on ? 'visible' : 'hidden';
  document.dispatchEvent(new Event('visibilitychange'));
};
const later = (minutes: number) => vi.setSystemTime(Date.now() + minutes * 60_000);

const lockEl = () => document.getElementById('lock');
const locked = () => !!lockEl() && !lockEl()!.hidden && document.body.classList.contains('locked');
const inert = (sel: string) => document.querySelector(sel)!.hasAttribute('inert');
const msg = () => lockEl()!.querySelector('.lock-msg')!.textContent;
const tap = (k: string) => (lockEl()!.querySelector(`[data-k="${k}"]`) as HTMLElement).click();
const key = (k: string) => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
const type = (keys: string) => [...keys].forEach(key);
const waitFor = (fn: () => void) => vi.waitFor(fn, { timeout: 5000, interval: 20 });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 9, 12));
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => vis });
  vis = 'visible';
  sessionStorage.clear();
});
afterEach(() => vi.useRealTimers());

describe('the app lock', () => {
  it('covers the app when it opens and after the time away, with the quest carrying on under it', async () => {
    const { S, L, ui } = await boot('workout', { sessions: [session('2026-10-01')] }, { lock: { away: 5 }, setup: (S) => S.startWorkout('a') });

    // Opened: locked, everything else inert, focus on the lock. The quest is there under it.
    expect(locked()).toBe(true);
    for (const sel of ['#tabs', '#app', '#restbar', '#sheet', '#toast']) expect(inert(sel)).toBe(true);
    expect(document.activeElement).toBe(lockEl());
    expect(document.body.dataset.view).toBe('workout');
    expect(lockEl()!.textContent).toContain('Arise');
    expect(lockEl()!.textContent).toContain('Forgot your passcode?');
    expect(lockEl()!.querySelector('[data-k="bio"]')).toBe(null); // no Face ID set up
    expect(lockEl()!.querySelectorAll('.lock-dots i')).toHaveLength(4);

    // A wrong passcode on the number pad, then the right one typed.
    for (const k of '1235') tap(k);
    await waitFor(() => expect(msg()).toBe('Wrong passcode. Try again.'));
    expect(locked()).toBe(true);
    type('12');
    expect(lockEl()!.querySelectorAll('.lock-dots i.on')).toHaveLength(2);
    tap('del');
    type('234');
    await waitFor(() => expect(locked()).toBe(false));
    // What's new opened under the lock (the app was updated): open now, with what's behind it inert.
    expect(document.querySelector('.sheet-body')!.textContent).toContain("What's new");
    for (const sel of ['#sheet', '#toast']) expect([sel, inert(sel)]).toEqual([sel, false]);
    for (const sel of ['#tabs', '#app', '#restbar']) expect([sel, inert(sel)]).toEqual([sel, true]);
    ui.closeSheet();
    for (const sel of ['#tabs', '#app', '#restbar', '#sheet', '#toast']) expect([sel, inert(sel)]).toEqual([sel, false]);
    expect(S.state.active?.workout).toBe('a');
    expect(document.body.dataset.view).toBe('workout');

    // Away for less than 5 minutes: still open.
    setVisible(false);
    later(4);
    setVisible(true);
    expect(locked()).toBe(false);

    // A pop-up open, then away for 5 minutes: locked, and Escape doesn't close the pop-up under it.
    ui.openSheet('<p>Details</p>');
    setVisible(false);
    expect(locked()).toBe(false); // not yet: it might be back in time
    later(5);
    setVisible(true);
    expect(locked()).toBe(true);
    expect(inert('#sheet')).toBe(true);
    key('Escape');
    expect(document.getElementById('sheet')!.hidden).toBe(false);
    type('1234');
    await waitFor(() => expect(locked()).toBe(false));
    // The pop-up is still open, so only what's behind it stays inert.
    expect(inert('#sheet')).toBe(false);
    expect(inert('#app')).toBe(true);
    ui.closeSheet();
    expect(inert('#app')).toBe(false);

    // Right away: it covers the app as soon as it's hidden (before the app switcher's picture).
    L.update({ away: 0 });
    setVisible(false);
    expect(locked()).toBe(true);
    setVisible(true);
    type('1234');
    await waitFor(() => expect(locked()).toBe(false));
    expect(S.state.active?.workout).toBe('a');
  });

  it("isn't there when it's off, and doesn't ask again when the app just restarted itself while open", async () => {
    await boot('today', { sessions: [] });
    expect(lockEl()).toBe(null);
    expect(document.body.classList.contains('locked')).toBe(false);

    sessionStorage.setItem('arise-lock-seen', String(Date.now() - 3000));
    await boot('today', { sessions: [] }, { lock: { away: 1 } });
    expect(locked()).toBe(false);

    sessionStorage.setItem('arise-lock-seen', String(Date.now() - 60_000));
    await boot('today', { sessions: [] }, { lock: { away: 1 } });
    expect(locked()).toBe(true);
    type('1234');
    await waitFor(() => expect(locked()).toBe(false));
  });

  it('waits after 5 wrong passcodes, saying how long', async () => {
    await boot('today', { sessions: [] }, { lock: { away: 1 } });
    for (let i = 0; i < 4; i++) {
      type('0000');
      await waitFor(() => expect(lockEl()!.querySelector('.lock-pad button')!.getAttribute('aria-disabled')).toBe('false'));
      expect(msg()).toBe('Wrong passcode. Try again.');
    }
    type('0000');
    await waitFor(() => expect(msg()).toBe('Too many wrong tries. Try again in 30 seconds.'));
    expect(lockEl()!.querySelector('.lock-pad button')!.getAttribute('aria-disabled')).toBe('true');
    type('1234'); // not even tried
    expect(lockEl()!.querySelectorAll('.lock-dots i.on')).toHaveLength(0);
    later(0.5);
    type('1234');
    await waitFor(() => expect(locked()).toBe(false));
  });
});
