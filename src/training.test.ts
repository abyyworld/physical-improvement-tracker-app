// @vitest-environment jsdom
// Training: the fitness goal's own place. The plan's week, the last 16 weeks, every workout, the
// body and each exercise's progress, with today's workout one tap away. It opens from the Goals tab
// (which stays lit) and is only there for people with the plan, or who trained with it before.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./lib/firebase', () => import('./test/fake-firebase'));

const TODAY = '2026-10-09'; // a Friday
const days = (from: string, to: string) => {
  const out: string[] = [];
  for (let d = new Date(`${from}T12:00`); d <= new Date(`${to}T12:00`); d.setDate(d.getDate() + 1)) out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  return out;
};
const EX: Record<string, string[]> = { a: ['wide_pullup', 'band_row'], b: ['pike', 'decline'], c: ['jump_squat', 'hollow'] };
// A workout on `date`: two exercises of three sets, one more rep each time (`n`).
const session = (date: string, workout = 'a', n = 0) => ({
  id: `s${date.replace(/-/g, '')}`,
  workout,
  date,
  started: 1,
  finished: 45 * 60000,
  easy: false,
  items: EX[workout].map((ex) => ({ ex, setup: '', sets: [0, 1, 2].map(() => ({ r: 6 + n, done: true })) })),
});
// Every other day for 5 weeks (the last one yesterday), in turn A, B, C; football once.
const trained = days('2026-09-04', '2026-10-08').filter((_, i) => i % 2 === 0);
const FIT = { id: 'fit', title: 'Get strong and lean', category: 'fitness', workouts: true, quests: [] };
const planUser = { sessions: trained.map((k, i) => session(k, 'abc'[i % 3], i)), football: ['2026-10-03'], goals: [FIT], profile: { onboarded: true, name: 'Sam' } };
const SPANISH = { id: 'g1', title: 'Learn Spanish', category: 'learning', quests: [{ id: 'q1', title: 'Study', schedule: { kind: 'daily' }, created: '2026-09-28' }] };

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
const button = (label: string) => $$('#app button').find((b) => b.textContent!.trim() === label);
// a comes before b on the page.
const before = (a: string, b: string) => !!($(a)!.compareDocumentPosition($(b)!) & Node.DOCUMENT_POSITION_FOLLOWING);
// A day of the heatmap, as "class | label".
const heat = (date: string) => {
  const el = $$('.heat .hc').find((e) => e.getAttribute('aria-label')!.startsWith(date))!;
  return `${el.className} | ${el.getAttribute('aria-label')!.slice(date.length + 2)}`;
};
const lit = () => $$('#tabs [data-v].on').map((b) => b.dataset.v);
// A row of the exercise's last entries: date, sets, total, setup.
// A tile's parts: what it is, the number, the words under it.
const tile = (n: number) => [...$$('.tiles .tile')[n].children].map((c) => c.textContent!.trim());
const entry = (n = 0) => [...($$('#entries tbody tr')[n] as HTMLTableRowElement).cells].map((c) => c.textContent);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 9, 12)); // Friday 9 October 2026, noon
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  window.scrollTo = () => {};
});
afterEach(() => vi.useRealTimers());

describe('Training', () => {
  it("shows the plan's week, the last 16 weeks, every workout, the body and exercise progress", async () => {
    const S = await boot('training', planUser);
    expect(location.hash).toBe('#training');
    expect(text('.page-head h1')).toBe('Training');
    expect(text('.page-head .kicker')).toBe('Your fitness goal');
    // It belongs to Goals.
    expect(lit()).toEqual(['goals']);
    expect($('#tabs [data-v="goals"]')!.getAttribute('aria-current')).toBe('page');

    const wk = S.weekSummary(TODAY);
    expect(texts('.tiles .tile .k')).toEqual(['This week', 'Streak', 'Consistency']);
    expect(tile(0)).toEqual(['This week', `${wk.done}/${wk.target}`, 'workouts']);
    expect(tile(1)).toEqual(['Streak', `${S.currentStreak()}`, `days · best ${S.bestStreak()}`]);
    expect(tile(2)).toEqual(['Consistency', `${S.consistency()}%`, 'last 4 weeks']);

    // Left: the week strip, the last 16 weeks, the workouts. Right: the body and each exercise.
    expect($$('.week .day')).toHaveLength(7);
    expect(before('.week', '.heat')).toBe(true);
    expect(before('.heat', '.hist-list')).toBe(true);
    expect($$('.heat .hc')).toHaveLength(16 * 7);
    expect(heat('Thu, Oct 8')).toBe(`hc w | ${S.workoutName('c')} ✓`);
    expect(heat('Sat, Oct 3')).toMatch(/^hc f \| Football/);
    expect(texts('.legend span')).toEqual(['Done', 'Football', 'Rest day', 'Missed']);
    $('.heat .hc[aria-label^="Thu, Oct 8"]')!.click();
    expect(text('#heatInfo')).toBe(`Thu, Oct 8: ${S.workoutName('c')} ✓`);

    const cols = $$('.cols > .col');
    expect([...cols[1].querySelectorAll('.panel-title')].map((e) => e.textContent!.trim())).toEqual(['Body', 'Exercise progress']);
    expect($('#exSel')).not.toBeNull();
    expect($('#chart svg')).not.toBeNull();
  });

  it('lists every workout, newest first, with more on request', async () => {
    await boot('training', planUser);
    expect(text('.hist-list .hist-date')).toBe('Thu, Oct 8');
    expect($$('.hist-list li')).toHaveLength(12);
    button('Show more')!.click();
    expect($$('.hist-list li')).toHaveLength(trained.length);
    expect(button('Show more')).toBeUndefined();
    // A workout opens with its sets.
    $('.hist-list .hist')!.click();
    expect(text('#sheet .sheet-title')).toMatch(/Speed & legs|Back & biceps|Shoulders/);
  });

  it("shows how each exercise went, and another one when it's picked", async () => {
    await boot('training', planUser);
    // The last workout's first exercise to start with (C: jump squats on Oct 8).
    expect(($('#exSel') as HTMLSelectElement).value).toBe('jump_squat');
    expect(entry()).toEqual(['Oct 8', '23 · 23 · 23', '69', '-']);

    const sel = $('#exSel') as HTMLSelectElement;
    sel.value = 'pike';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    expect(entry()).toEqual(['Oct 6', '22 · 22 · 22', '66', '-']);
    expect($('#chart svg')).not.toBeNull();

    sel.value = 'nordic';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    expect(text('#chart')).toBe('No sets logged for Nordic curls yet. Once you have, this chart shows your total reps each time you do it.');
    expect($('#entries')!.innerHTML).toBe('');
  });

  it("starts today's workout, the same as Today does", async () => {
    const S = await boot('training', planUser);
    const start = $('.page-head [data-act="start"]')!;
    expect(start.textContent).toBe('Start workout');
    expect(start.dataset.w).toBe(S.suggestedFor(TODAY));
    expect(texts('.page-head .head-acts button')).toEqual(['Start workout', 'Your plan']);
    start.click();
    expect(S.state.active?.workout).toBe(S.suggestedFor(TODAY));
    expect(location.hash).toBe('#workout');

    // Back on Training while it's going: carry on with it.
    location.hash = '#training';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(location.hash).toBe('#training');
    expect($('.page-head [data-act="start"]')).toBeNull();
    const resume = $('.page-head [data-v="workout"]')!;
    expect(resume.textContent).toBe('Resume workout');

    // "Your plan" opens the plan.
    button('Your plan')!.click();
    expect(location.hash).toBe('#plan');
    expect(lit()).toEqual(['goals']);
  });

  it('has no Start button once today is done, or on a rest day', async () => {
    await boot('training', { ...planUser, sessions: [...planUser.sessions, session(TODAY, 'b', 20)] });
    expect($('.page-head [data-act="start"]')).toBeNull();
    expect(texts('.page-head .head-acts button')).toEqual(['Your plan']);

    await boot('training', { ...planUser, rests: [TODAY] });
    expect($('.page-head [data-act="start"]')).toBeNull();
  });

  it('goes back to Goals', async () => {
    await boot('training', planUser);
    const back = button('← Goals')!;
    expect(back.dataset).toMatchObject({ act: 'nav', v: 'goals' });
    back.click();
    expect(location.hash).toBe('#goals');
    expect(text('.page-head h1')).toBe('Goals');
  });

  it('is only for people with the plan, or who trained with it before', async () => {
    // No plan and no workouts: Goals instead.
    await boot('training', { goals: [SPANISH], profile: { onboarded: true } });
    expect(location.hash).toBe('#goals');
    expect(text('.page-head h1')).toBe('Goals');
    location.hash = '#training';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(location.hash).toBe('#goals');

    // The plan turned off, the workouts kept: their history, without the week, the body or a start.
    const S = await boot('training', planUser, (S) => S.saveGoal({ ...S.goalById('fit')!, workouts: false }));
    expect(S.workoutsOn()).toBe(false);
    expect(location.hash).toBe('#training');
    expect($('.week')).toBeNull();
    expect(texts('.panel-title')).toEqual(['Last 16 weeks', 'Workouts', 'Exercise progress']);
    expect(tile(0)).toEqual(['This week', `${S.weekSummary(TODAY).done}`, 'workouts']);
    expect($('.page-head [data-act="start"]')).toBeNull();

    // The plan and the workouts gone while Training is open (another tab): Goals instead.
    await boot('training', planUser);
    expect(location.hash).toBe('#training');
    window.dispatchEvent(new StorageEvent('storage', { key: 'pit-data-v1', newValue: JSON.stringify({ goals: [SPANISH], profile: { onboarded: true } }) }));
    expect(location.hash).toBe('#goals');
    expect(text('.page-head h1')).toBe('Goals');
  });

  it('keeps the free day as a day off, not a miss', async () => {
    // Trained every day, but missed Study (another goal) on Tuesday: the same heatmap as before.
    const every = { sessions: days('2026-09-28', '2026-10-08').map((k) => session(k)) };
    await boot('training', every, (S) => {
      S.saveGoal(SPANISH);
      for (const k of days('2026-09-28', '2026-10-08')) if (k !== '2026-10-06') S.tick('q1', { done: true }, k);
    });
    expect(heat('Tue, Oct 6')).toBe('hc before | A · Back & biceps done. Day off (your free day this week)');
    expect(heat('Mon, Oct 5')).toBe('hc w | A · Back & biceps + 1 quest ✓');
  });

  it('keeps its own words in the System look', async () => {
    await boot('training', { ...planUser, settings: { look: 'system' } });
    expect(text('.page-head .kicker')).toBe('Training log');
    expect(text('.page-head h1')).toBe('Training');
    expect(text('.page-head [data-act="start"]')).toBe('Start quest');
    expect(texts('.tiles .tile .k')).toEqual(['This week', 'Streak', 'Consistency']);
    expect(lit()).toEqual(['goals']);
  });
});
