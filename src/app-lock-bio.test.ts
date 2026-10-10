// @vitest-environment jsdom
// Face ID's own prompt can hide the app for a moment. Time away while it's up still counts once
// it's done, so leaving the app then doesn't get past the lock.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./lib/firebase', () => import('./test/fake-firebase'));

let vis: DocumentVisibilityState = 'visible';
const setVisible = (on: boolean) => {
  vis = on ? 'visible' : 'hidden';
  document.dispatchEvent(new Event('visibilitychange'));
};
const later = (minutes: number) => vi.advanceTimersByTime(minutes * 60_000);
const lockEl = () => document.getElementById('lock');
const locked = () => !!lockEl() && !lockEl()!.hidden && document.body.classList.contains('locked');
const type = (keys: string) => [...keys].forEach((k) => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })));
const unlock = async () => {
  type('1234');
  await vi.waitFor(() => expect(locked()).toBe(false), { timeout: 5000, interval: 20 });
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'performance'] });
  vi.setSystemTime(new Date(2026, 9, 9, 12));
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => vis });
});
afterEach(() => vi.useRealTimers());

describe("the app lock and Face ID's prompt", () => {
  it('counts time away while the prompt was up', async () => {
    localStorage.setItem('pit-data-v1', JSON.stringify({ sessions: [] }));
    document.body.innerHTML = '<nav id="tabs"></nav><main id="app"></main><div id="restbar" hidden></div><div id="sheet" hidden><div class="sheet-backdrop"></div><div class="sheet-panel"><button class="sheet-close"></button><div class="sheet-body"></div></div></div><div id="toast"></div><input type="file" id="importFile" hidden>';
    history.replaceState(null, '', '#settings');
    const L = await import('./lib/lock');
    await L.turnOn('1234', { away: 1 });
    await import('./app.js');
    const LOCK = await import('./app-lock.js');
    await unlock();

    let answer: (v: null) => void = () => {};
    Object.defineProperty(navigator, 'credentials', { configurable: true, value: { create: () => new Promise((r) => (answer = r)) } });
    const faceId = () => LOCK.handleAction('lock-bio', document.body);

    // Away while it's up, and it ends meanwhile: back hours later, it's locked.
    let asked = faceId();
    setVisible(false);
    answer(null);
    await asked;
    later(180);
    setVisible(true);
    expect(locked()).toBe(true);
    await unlock();

    // Back hours later while it's still up: locked once it ends.
    asked = faceId();
    setVisible(false);
    later(180);
    setVisible(true);
    expect(locked()).toBe(false);
    answer(null);
    await asked;
    expect(locked()).toBe(true);
    await unlock();

    // Right away: the prompt's own moment away doesn't count, a longer time does.
    L.update({ away: 0 });
    asked = faceId();
    setVisible(false);
    expect(locked()).toBe(false);
    later(2 / 60);
    setVisible(true);
    answer(null);
    await asked;
    expect(locked()).toBe(false);
    asked = faceId();
    setVisible(false);
    later(1);
    setVisible(true);
    answer(null);
    await asked;
    expect(locked()).toBe(true);
  });
});
