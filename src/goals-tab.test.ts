// @vitest-environment jsdom
// The Goals tab: the fitness goal's way to Training, and for people without the workout plan, the
// last 16 weeks of their quests at the top (with the plan, those are on Training).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./lib/firebase', () => import('./test/fake-firebase'));

const TODAY = '2026-10-09'; // a Friday
const days = (from: string, to: string) => {
  const out: string[] = [];
  for (let d = new Date(`${from}T12:00`); d <= new Date(`${to}T12:00`); d.setDate(d.getDate() + 1)) out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  return out;
};
const session = (date: string, workout = 'a') => ({ id: `s${date.replace(/-/g, '')}`, workout, date, started: 1, finished: 2, easy: false, items: [{ ex: 'band_row', setup: '', sets: [{ r: 10, done: true }] }] });
const FIT = { id: 'fit', title: 'Get strong and lean', category: 'fitness', workouts: true, quests: [] };
const SPANISH = { id: 'g1', title: 'Learn Spanish', category: 'learning', quests: [{ id: 'q1', title: 'Study', schedule: { kind: 'daily' }, created: '2026-09-28' }] };
const READING = { id: 'q2', title: 'Read 10 pages', schedule: { kind: 'daily' }, created: '2026-09-28' };
const profile = { onboarded: true, name: 'Sam' };
const planUser = { sessions: days('2026-10-05', '2026-10-08').map((k, i) => session(k, 'abc'[i % 3])), goals: [FIT], profile };

// Each boot starts the whole app again: the listeners the last one added go first.
const added: [EventTarget, string, EventListenerOrEventListenerObject, unknown][] = [];
for (const target of [document, window]) {
  const add = target.addEventListener.bind(target);
  target.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: unknown) => {
    added.push([target, type, fn, opts]);
    add(type, fn, opts as AddEventListenerOptions);
  }) as typeof target.addEventListener;
}

// Starts the app on `view` with this saved data, after `setup` (goals, ticks) on the store.
async function boot(view: string, data: object, setup: (S: typeof import('./store')) => void = () => {}) {
  for (const [target, type, fn, opts] of added.splice(0)) target.removeEventListener(type, fn, opts as EventListenerOptions);
  vi.resetModules();
  localStorage.clear();
  localStorage.setItem('arise-look-hint', 'seen');
  localStorage.setItem('pit-data-v1', JSON.stringify(data));
  document.body.innerHTML = '<nav id="tabs"></nav><main id="app"></main><div id="restbar" hidden></div><div id="sheet" hidden><div class="sheet-panel"><button class="sheet-close"></button><div class="sheet-body"></div></div></div><div id="toast"></div><input type="file" id="importFile" hidden>';
  history.replaceState(null, '', `#${view}`);
  const S = await import('./store');
  setup(S);
  await import('./app.js');
  return S;
}
const $ = (sel: string) => document.querySelector<HTMLElement>(sel);
const $$ = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
const text = (sel: string) => $(sel)?.textContent?.replace(/\s+/g, ' ').trim() || '';
const texts = (sel: string) => $$(sel).map((e) => e.textContent!.replace(/\s+/g, ' ').trim());
// Each goal card's title, and its way to Training (if it has one).
const cards = () => $$('.goal').map((g) => [g.querySelector('.goal-title')!.textContent, g.querySelector('.goal-training button')?.textContent || '']);
// A day of the heatmap, as "class | label".
const heat = (date: string) => {
  const el = $$('.heat .hc').find((e) => e.getAttribute('aria-label')!.startsWith(date))!;
  return `${el.className} | ${el.getAttribute('aria-label')!.slice(date.length + 2)}`;
};
// Study ticked every day from 28 September to yesterday, except `missed`.
const studying = (missed: string[] = [], extra: object[] = []) => (S: typeof import('./store')) => {
  S.saveGoal({ ...SPANISH, quests: [...SPANISH.quests, ...extra] });
  for (const k of days('2026-09-28', '2026-10-08')) if (!missed.includes(k)) S.tick('q1', { done: true }, k);
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 9, 12)); // Friday 9 October 2026, noon
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  window.scrollTo = () => {};
});
afterEach(() => vi.useRealTimers());

describe('the fitness goal on the Goals tab', () => {
  it('opens Training, with this week so far', async () => {
    const S = await boot('goals', planUser, studying());
    const wk = S.weekSummary(TODAY);
    expect(cards()).toEqual([
      ['Get strong and lean', 'Training →'],
      ['Learn Spanish', ''],
    ]);
    expect(text('.goal-training .muted')).toBe(`${wk.done} of ${wk.target} this week · ${S.currentStreak()}-day streak`);
    // The plan's own card stays, before it.
    const fit = $$('.goal')[0];
    expect(fit.querySelector('[data-v="plan"]')!.compareDocumentPosition(fit.querySelector('.goal-training')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    $('.goal-training button')!.click();
    expect(location.hash).toBe('#training');
    expect(text('.page-head h1')).toBe('Training');
    expect($$('#tabs [data-v].on').map((b) => b.dataset.v)).toEqual(['goals']);
  });

  it('only shows the way to Training when there is something there', async () => {
    // The plan paused, workouts done before: their history is still there.
    const S = await boot('goals', { ...planUser, goals: [{ ...FIT, status: 'paused' }] });
    expect(cards()).toEqual([['Get strong and lean', 'Training →']]);
    expect($('details .goal .goal-training')).not.toBeNull(); // with the paused goals
    expect(text('.goal-training .muted')).toBe(`${S.currentStreak()}-day streak`); // no plan, so no week to count

    // Paused before any workout: nothing to see yet.
    await boot('goals', { goals: [{ ...FIT, status: 'paused' }], profile });
    expect($('.goal-training')).toBeNull();
  });

  it('keeps the way to Training in the System look', async () => {
    await boot('goals', { ...planUser, settings: { look: 'system' } });
    expect(cards()).toEqual([['Get strong and lean', 'Training →']]);
  });
});

describe('the last 16 weeks on the Goals tab', () => {
  it('comes first for people without the plan who have quests', async () => {
    await boot('goals', { sessions: [], profile }, studying(['2026-10-07']));
    const first = $('.goal-list > :first-child')!;
    expect(first.querySelector('.panel-title')!.textContent).toBe('Your last 16 weeks');
    expect(first.querySelectorAll('.heat .hc')).toHaveLength(16 * 7);
    expect(heat('Mon, Oct 5')).toBe('hc w | 1 quest ✓');
    expect(heat('Wed, Oct 7')).toBe('hc before | Day off (your free day this week)');
    expect(heat('Fri, Oct 9')).toBe('hc today | Not done yet');
    // Only what applies: no football or rest days without the plan.
    expect(texts('.legend span')).toEqual(['Done', 'Missed']);
    $('.heat .hc[aria-label^="Mon, Oct 5"]')!.click();
    expect(text('#heatInfo')).toBe('Mon, Oct 5: 1 quest ✓');
    expect(cards()).toEqual([['Learn Spanish', '']]);
  });

  it('keeps the quests that were done on a free day', async () => {
    // Two daily quests; on Tuesday only Study was ticked.
    await boot('goals', { sessions: [], profile }, (S) => {
      studying([], [READING])(S);
      for (const k of days('2026-09-28', '2026-10-08')) if (k !== '2026-10-06') S.tick('q2', { done: true }, k);
    });
    expect(heat('Tue, Oct 6')).toBe('hc before | 1 quest done. Day off (your free day this week)');
    expect(heat('Mon, Oct 5')).toBe('hc w | 2 quests ✓');
  });

  it('marks a second missed day in a week', async () => {
    await boot('goals', { sessions: [], profile }, studying(['2026-10-06', '2026-10-07']));
    expect(heat('Tue, Oct 6')).toBe('hc before | Day off (your free day this week)');
    expect(heat('Wed, Oct 7')).toBe('hc m | Missed');
  });

  it('is on Training instead for people with the plan, and not there without quests', async () => {
    await boot('goals', planUser, studying());
    expect($('.heat')).toBeNull();

    await boot('goals', { goals: [{ ...SPANISH, quests: [] }], profile });
    expect($('.heat')).toBeNull();

    await boot('goals', { profile });
    expect($('.heat')).toBeNull();
    expect(text('#app .panel')).toMatch(/^No goals yet\./);

    // A paused goal's quests aren't asked for, so nothing to show.
    await boot('goals', { goals: [{ ...SPANISH, status: 'paused' }], profile });
    expect($('.heat')).toBeNull();
  });

  it('is there in the System look too', async () => {
    await boot('goals', { sessions: [], profile, settings: { look: 'system' } }, studying());
    expect(text('.goal-list > :first-child .panel-title')).toBe('Your last 16 weeks');
  });
});
