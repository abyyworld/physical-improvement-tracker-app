// @vitest-environment jsdom
// What the screens show for the weekly day off: the whole app started on some history.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./lib/firebase', () => import('./test/fake-firebase'));

const days = (from: string, to: string) => {
  const out: string[] = [];
  for (let d = new Date(`${from}T12:00`); d <= new Date(`${to}T12:00`); d.setDate(d.getDate() + 1)) out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  return out;
};
const session = (date: string, workout = 'a') => ({ id: `s${date.replace(/-/g, '')}`, workout, date, started: 1, finished: 2, easy: false, items: [{ ex: 'band_row', setup: '', sets: [{ r: 10, done: true }] }] });

// Starts the app on `view` with this saved data, after `setup` (goals, ticks) on the store.
async function boot(view: string, data: object, setup: (S: typeof import('./store')) => void = () => {}) {
  vi.resetModules();
  localStorage.clear();
  localStorage.setItem('pit-data-v1', JSON.stringify(data));
  document.body.innerHTML = '<nav id="tabs"></nav><main id="app"></main><div id="restbar" hidden></div><div id="sheet" hidden><div class="sheet-panel"><button class="sheet-close"></button><div class="sheet-body"></div></div></div><div id="toast"></div><input type="file" id="importFile" hidden>';
  history.replaceState(null, '', `#${view}`);
  const S = await import('./store');
  setup(S);
  await import('./app.js');
  return S;
}
// The Today strip's days, as "class | tooltip".
const strip = () => [...document.querySelectorAll('.week .day')].map((e) => `${e.className} | ${e.getAttribute('title')}`);
// A day of the Progress heatmap, as "class | label".
const heat = (date: string) => {
  const el = [...document.querySelectorAll('.heat .hc')].find((e) => e.getAttribute('aria-label')!.startsWith(date))!;
  return `${el.className} | ${el.getAttribute('aria-label')!.slice(date.length + 2)}`;
};

const studying = (missed: string[], extra: { id: string; title: string }[] = []) => (S: typeof import('./store')) => {
  S.saveGoal({ id: 'g1', title: 'Learn Spanish', category: 'learning', quests: [{ id: 'q1', title: 'Study', schedule: { kind: 'daily' }, created: '2026-09-28' }, ...extra.map((q) => ({ ...q, schedule: { kind: 'daily' }, created: '2026-09-28' }))] });
  for (const k of days('2026-09-28', '2026-10-08')) if (!missed.includes(k)) S.tick('q1', { done: true }, k);
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 9, 12)); // Friday 9 October 2026
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
});

describe('the free day on screen', () => {
  it("doesn't show the free day as done when the workout was done but a quest was missed", async () => {
    // Trained every day, but missed Study (another goal) on Tuesday.
    const S = await boot('today', { sessions: days('2026-09-28', '2026-10-08').map((k) => session(k)) }, studying(['2026-10-06']));
    expect(S.streakDay('2026-10-06')).toBe('free');
    expect(strip()[1]).toBe('day part | A · Back & biceps. Day off (your free day this week)');
    expect(strip()[0]).toBe('day done | A · Back & biceps');
    expect(document.querySelector('.week-note')!.textContent).toBe("You've used this week's free day (Tuesday).");

    await boot('progress', { sessions: days('2026-09-28', '2026-10-08').map((k) => session(k)) }, studying(['2026-10-06']));
    expect(heat('Tue, Oct 6')).toBe('hc before | A · Back & biceps done. Day off (your free day this week)');
    expect(heat('Mon, Oct 5')).toBe('hc w | A · Back & biceps + 1 quest ✓');
  });

  it("names a planned rest day as the free day when a quest was missed on it", async () => {
    // The weekly split, every planned day trained (Thursday is its rest day); Study missed on Thursday.
    const trained = days('2026-09-28', '2026-10-08').filter((k) => new Date(`${k}T12:00`).getDay() !== 4);
    await boot('today', { settings: { template: 'weekly' }, sessions: trained.map((k) => session(k)) }, studying(['2026-10-08']));
    expect(strip()[3]).toBe('day rest | Rest day. Day off (your free day this week)');
    expect(document.querySelector('.week-note')!.textContent).toBe("You've used this week's free day (Thursday).");
  });

  it('keeps the quests that were done on a free day', async () => {
    // Two daily quests; on Tuesday only Study was ticked.
    const both = (S: typeof import('./store')) => {
      studying([], [{ id: 'q2', title: 'Read 10 pages' }])(S);
      for (const k of days('2026-09-28', '2026-10-08')) if (k !== '2026-10-06') S.tick('q2', { done: true }, k);
    };
    await boot('progress', { sessions: [] }, both);
    expect(heat('Tue, Oct 6')).toBe('hc before | 1 quest done. Day off (your free day this week)');

    // With the workout plan: a free day with no training, but a quest ticked.
    const S = await boot('today', { sessions: days('2026-09-28', '2026-10-08').filter((k) => k !== '2026-10-06').map((k) => session(k)) }, studying([]));
    expect(S.streakDay('2026-10-06')).toBe('free');
    expect(strip()[1]).toBe('day part | Study. Day off (your free day this week)');
  });
});
