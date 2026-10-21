// @vitest-environment jsdom
// The Me tab (Progress in the System look): about you, each part of the person's life worked out
// from their days (with their own rating beside it only when they gave one), what Arise noticed in
// their days, looking back, their check-ins when there are any, their week next to their usual,
// their goals and the way into Training. The whole app started on some data.

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LifeEvent } from './life/types';

vi.mock('./lib/firebase', () => import('./test/fake-firebase'));
// The coach and the life check-in are the Coach tab's (system.js): watched here, not opened.
vi.mock('./system.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./system.js')>();
  return { ...real, askCoach: vi.fn(() => true), handleAction: vi.fn(real.handleAction) };
});

const T = (k: string, h = 12, m = 0) => {
  const [y, mo, d] = k.split('-').map(Number);
  return new Date(y, mo - 1, d, h, m).getTime();
};
const days = (from: string, n: number) =>
  Array.from({ length: n }, (_, i) => {
    const d = new Date(T(from));
    d.setDate(d.getDate() + i);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
// A night that ended on the morning of `k`, from Apple Health; the day's steps.
const night = (k: string, min: number): LifeEvent => ({ id: `health:sleep:${k}`, source: 'health', kind: 'sleep', at: T(k, 7) - min * 60000, end: T(k, 7), title: 'Slept', value: min, unit: 'min', tier: 3 });
const stepsOn = (k: string, n: number): LifeEvent => ({ id: `health:day:${k}`, source: 'health', kind: 'steps', at: T(k, 0), end: T(k, 23, 59), title: `${n} steps`, value: n, unit: 'steps', tier: 2 });
const session = (date: string) => ({ id: `s${date.replace(/-/g, '')}`, workout: 'a', date, started: 1, finished: 2, easy: false, items: [{ ex: 'band_row', setup: '', sets: [{ r: 10, done: true }] }] });

// Each boot starts the whole app again: the listeners the last one added go first.
const added: [EventTarget, string, EventListenerOrEventListenerObject, unknown][] = [];
for (const target of [document, window]) {
  const add = target.addEventListener.bind(target);
  target.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: unknown) => {
    added.push([target, type, fn, opts]);
    add(type, fn, opts as AddEventListenerOptions);
  }) as typeof target.addEventListener;
}

async function boot({ data = {} as Record<string, unknown>, events = [] as LifeEvent[], summaries = [] as object[], facts = [] as object[] } = {}) {
  for (const [target, type, fn, opts] of added.splice(0)) target.removeEventListener(type, fn, opts as EventListenerOptions);
  vi.resetModules();
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
  localStorage.setItem('pit-data-v1', JSON.stringify({ sessions: [], profile: { onboarded: true, skipped: true }, ...data }));
  localStorage.setItem('arise-look-hint', 'seen');
  document.documentElement.removeAttribute('data-theme');
  document.body.innerHTML = '<nav id="tabs"></nav><main id="app"></main><div id="restbar" hidden></div><div id="sheet" hidden><div class="sheet-panel"><button class="sheet-close"></button><div class="sheet-body"></div></div></div><div id="toast"></div><input type="file" id="importFile" hidden>';
  history.replaceState(null, '', '#progress');
  const L = await import('./life/log');
  if (events.length) await L.addEvents(events);
  for (const [store, list] of [['summaries', summaries], ['facts', facts]] as const) {
    if (!list.length) continue;
    const db = await (await import('./life/db')).open();
    const tx = db.transaction(store, 'readwrite');
    for (const x of list) tx.objectStore(store).put(x);
    await new Promise((r) => (tx.oncomplete = r));
  }
  await import('./app.js');
  return { SYS: await import('./system.js') };
}
const $ = (sel: string) => document.querySelector<HTMLElement>(sel);
const text = (sel: string) => $(sel)?.textContent?.replace(/\s+/g, ' ').trim() || '';
const texts = (sel: string) => [...document.querySelectorAll(sel)].map((el) => el.textContent!.replace(/\s+/g, ' ').trim());
const levelLine = () => [...document.querySelectorAll('.tile')].find((t) => t.querySelector('.k')?.textContent === 'Level')!.querySelector('.s')!.textContent;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 17, 10)); // Saturday 17 October 2026
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  window.scrollTo = () => {};
});
afterEach(() => vi.useRealTimers());

const LIFE = {
  at: '2026-10-01',
  areas: { sleep: 2, body: 3, mind: 3, people: 5, work: 2, money: 3, fun: 2, meaning: 3 },
  grow: ['sleep'],
  values: ['Family', 'Health'],
  hope: 'See my family more.',
};

describe('the Me tab', () => {
  it('is called Me in the Arise look, and Progress in the System look, with the rank only there', async () => {
    await boot({ data: { logs: { '2026-10-16': { e: 3, at: 1 } } } });
    expect(text('#tabs [data-v="progress"]')).toBe('Me');
    // Right after the days, with a person for its icon.
    expect([...document.querySelectorAll('#tabs [data-v]')].map((b) => b.getAttribute('data-v'))).toEqual(['today', 'days', 'progress', 'goals', 'coach', 'settings']);
    expect($('#tabs [data-v="progress"] svg')!.innerHTML).toBe('<circle cx="12" cy="8" r="4"></circle><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"></path>');
    expect($('#tabs [data-v="progress"]')!.classList.contains('on')).toBe(true);
    expect(text('.page-head .kicker')).toBe('Everything about you');
    expect(text('h1')).toBe('Me');
    // The level is one quiet line at the end, not a row of tiles.
    expect($('.tiles')).toBeNull();
    expect(text('.me-game')).toBe('Level 1 · 5 XP');
    expect($('.cols > .col:last-child > :last-child')).toBe($('.me-game'));
    expect($('#app')!.textContent).not.toContain('Rank');

    await boot({ data: { logs: { '2026-10-16': { e: 3, at: 1 } }, settings: { look: 'system' } } });
    expect(text('#tabs [data-v="progress"]')).toBe('Progress');
    expect(text('.page-head .kicker')).toBe('Consistency + improvement');
    expect(text('h1')).toBe('Progress');
    // The Player keeps their status window on top.
    expect(texts('.tiles .tile .k')).toEqual(['Level', 'Streak', 'Goals', 'Consistency']);
    expect(levelLine()).toBe('Rank E · 5 XP');
    expect($('.me-game')).toBeNull();
    expect(text('#lifePatterns .panel-title')).toBe('[System analysis]');
    expect(text('#lifePanel .panel-title')).toBe('Life status');
  });

  it('starts with about you, your life, what Arise noticed and looking back, ends with your check-ins, and has your week on the right', async () => {
    await boot({ data: { logs: { '2026-10-16': { s: 2, e: 3, m: 4, t: 'Long day, early night.', at: 1 } } } });
    const left = [...document.querySelectorAll('.cols > .col:first-child > section')];
    expect(left.slice(0, 4).map((s) => s.id)).toEqual(['aboutYou', 'lifePanel', 'lifePatterns', 'lifeBack']);
    expect(left.at(-1)!.querySelector('.panel-title')!.textContent).toBe('Check-ins');
    expect(texts('.checkins .log-list li .hist-date span')).toEqual(['Fri, Oct 16', 'Sleep 2 · Energy 3 · Mood 4']);
    expect(text('.checkins .log-list li p')).toBe('Long day, early night.');
    expect($('#app')!.textContent).not.toContain('Daily log');
    expect($('.cols > .col:last-child > section')!.id).toBe('youWeek');
  });

  it('counts the level and the streak in one line', async () => {
    // Studied every day from 21 September to 4 October, then missed 5 and 6 October (the first is
    // the week's free day, the second breaks the streak), then every day up to yesterday.
    const done = [...days('2026-09-21', 14), ...days('2026-10-07', 10)];
    const goal = { id: 'g1', title: 'Learn Spanish', category: 'learning', created: '2026-09-21', quests: [{ id: 'q1', title: 'Study', schedule: { kind: 'daily' }, created: '2026-09-21' }] };
    await boot({ data: { goals: [goal], checks: Object.fromEntries(done.map((k) => [k, { q1: { done: true, at: 1 } }])) } });
    expect(text('.me-game')).toBe('Level 2 · 240 XP · 10-day streak (best 14)');
  });

  it("has no workout panels: the plan's goal leads to Training instead", async () => {
    const plan = { id: 'fit', title: 'Get strong and lean', category: 'fitness', created: '2026-09-28', workouts: true, quests: [] };
    await boot({ data: { goals: [plan], sessions: days('2026-10-12', 6).filter((_, i) => i % 2 === 0).map(session), football: ['2026-10-15'] } });
    for (const gone of ['.heat', '#exSel', '#chart', '.hist-list', '#bodyChart', '.week']) expect($(gone), gone).toBeNull();
    const titles = texts('.panel-title');
    for (const gone of ['Last 16 weeks', 'Workouts', 'Body', 'Exercise progress']) expect(titles).not.toContain(gone);
    expect(text('.me-training .panel-title')).toBe('Training');
    expect(text('.me-training .muted')).toBe('Get strong and lean');
    expect(text('.me-training p:not(.muted)')).toMatch(/^3 of \d+ workouts this week$/);
    const go = $('.me-training [data-act="nav"]')!;
    expect(go.dataset.v).toBe('training');
    expect(go.textContent).toBe('Your training →');
    // The System look's tiles still count the week's workouts.
    await boot({ data: { goals: [plan], sessions: days('2026-10-12', 6).filter((_, i) => i % 2 === 0).map(session), settings: { look: 'system' } } });
    expect(texts('.tiles .tile .k')).toEqual(['Level', 'Streak', 'This week', 'Consistency']);
    expect($('.me-training [data-v="training"]')).not.toBeNull();
    expect($('.heat')).toBeNull();
  });

  it('lists the goals, with no Training without the plan', async () => {
    const goal = { id: 'g1', title: 'Learn Spanish', category: 'learning', created: '2026-10-10', quests: [{ id: 'q1', title: 'Study', schedule: { kind: 'daily' }, created: '2026-10-10' }] };
    await boot({ data: { goals: [goal] } });
    expect($('.me-training')).toBeNull();
    expect(texts('.cols > .col:last-child .panel-title')).toContain('Learn Spanish');
    expect($('.heat')).toBeNull();
  });
});

describe('About you', () => {
  const fact = (id: string, text: string, more: object = {}) => ({ id, text, since: '2026-10-01', from: 'ai', tier: 2, sources: ['2026-10-01'], at: 1, ...more });

  it('shows your name and the strongest things Arise knows about you, with the way to everything', async () => {
    await boot({
      data: { settings: { name: 'Sam' } },
      facts: [
        fact('fa', 'You walk to work.'),
        fact('fb', 'You call your sister on Sundays.', { sources: ['2026-10-01', '2026-10-08', '2026-10-15'] }),
        fact('fc', 'You used to run at night.', { until: '2026-10-10' }),
        fact('fd', 'You play football on Saturdays.', { pinned: true }),
        fact('fe', 'You love cooking.', { from: 'you' }),
        fact('ff', 'You read before bed.', { sources: ['2026-10-01', '2026-10-02'] }),
        fact('fg', 'You work from home on Fridays.', { since: '2026-10-05' }),
        fact('fh', 'You drink coffee at 10.'),
      ],
    });
    expect(text('#aboutYou .panel-title')).toBe('About you');
    expect(text('#aboutYou .about-name')).toBe('Sam');
    // Pinned, your own words, then the best confirmed and newest; six at most, none no longer true.
    await vi.waitFor(() =>
      expect(texts('#aboutFacts li')).toEqual(['You play football on Saturdays.', 'You love cooking.', 'You call your sister on Sundays.', 'You read before bed.', 'You work from home on Fridays.', 'You walk to work.']),
    );
    const all = $('#aboutYou [data-act="nav"]')!;
    expect(all.dataset.v).toBe('knows');
    expect(all.textContent).toBe('Everything Arise knows →');
  });

  it("says what it will show when it knows nothing yet, and what matters to you once you've said", async () => {
    await boot();
    expect(text('#aboutYou .about-name')).toBe('You');
    await vi.waitFor(() => expect(text('#aboutFacts')).toBe('Arise learns about you as your days come in: your routines, the people you see, what gives you energy. It shows here.'));
    expect(text('#aboutYou')).not.toContain('What matters most');

    await boot({ data: { profile: { onboarded: true, skipped: true, name: 'Robin', life: LIFE } } });
    expect(text('#aboutYou .about-name')).toBe('Robin');
    expect(texts('#aboutYou > p.small')).toEqual(['What matters most to you: Family, Health.', 'A great next year: “See my family more.”']);
  });
});

describe('Your week', () => {
  const tiles = () => [...document.querySelectorAll('#youWeek .week-stats > div')].map((d) => [d.querySelector('.k')!.textContent, d.querySelector('b')!.textContent, d.querySelector('.s')!.textContent]);

  it('sums up the last 7 days from your check-ins', async () => {
    // Today and the 6 days before count; 10 October is a day too early.
    await boot({ data: { logs: { '2026-10-17': { s: 4, e: 4, m: 5, at: 1 }, '2026-10-12': { s: 2, e: 3, m: 3, at: 1 }, '2026-10-10': { s: 1, e: 1, m: 1, at: 1 } } } });
    await vi.waitFor(() =>
      expect(tiles()).toEqual([
        ['Sleep', '3.0/5', 'how you slept (2 days)'],
        ['Energy', '3.5/5', 'from 2 check-ins'],
        ['Mood', '4.0/5', '2 days'],
      ]),
    );
    expect(text('#youWeek .panel-title')).toBe('Your week');
    expect(text('#youWeek > p')).toBe('Last 7 days.');
  });

  it('adds what Arise saw in the life log, leaving out today where it is still adding up', async () => {
    const sleep = (k: string, min: number): LifeEvent => ({ id: `health:sleep:${k}`, source: 'health', kind: 'sleep', at: T(k, 0, 0), end: T(k, 0, min), title: 'Slept', value: min, unit: 'min', tier: 3 });
    const steps = (k: string, n: number): LifeEvent => ({ id: `health:steps:${k}`, source: 'health', kind: 'steps', at: T(k, 20), title: `${n} steps`, value: n, unit: 'steps', tier: 2 });
    const msg = (k: string): LifeEvent => ({ id: `whatsapp:${k}`, source: 'whatsapp', kind: 'message', at: T(k, 19), title: 'Message from Sam', tier: 3 });
    const app = (k: string, min: number): LifeEvent => ({ id: `other:app:${k}`, source: 'other', kind: 'app', at: T(k, 14), title: `Used Instagram for ${min} min`, value: min, unit: 'min', tier: 2 });
    await boot({
      data: { logs: { '2026-10-16': { e: 4, at: 1 } } },
      events: [sleep('2026-10-15', 430), sleep('2026-10-16', 450), sleep('2026-10-17', 410), steps('2026-10-15', 8000), steps('2026-10-16', 6000), steps('2026-10-17', 500), msg('2026-10-14'), msg('2026-10-16'), app('2026-10-16', 90), app('2026-10-17', 30)],
    });
    await vi.waitFor(() =>
      expect(tiles()).toEqual([
        ['Sleep', '7 h 10 min', 'a night (3 nights)'],
        ['Steps', '7,000', 'a day (2 days)'],
        ['In touch', '0.7', 'people a day (3 days)'],
        ['Social feeds', '1 h 30 min', 'a day (1 day)'],
        ['Screens', '1 h 30 min', 'a day (1 day)'],
        ['Energy', '4.0/5', 'from 1 check-in'],
      ]),
    );
    // No usual yet, so nothing to compare with; nothing focused or fun, so no tile for them.
    expect(text('#youWeek > p')).toBe('Last 7 days, next to your usual.');
    expect(texts('#youWeek .k')).not.toContain('Focused');
  });

  it('puts each number next to the usual once there are enough days', async () => {
    const weeks = days('2026-09-20', 27); // 20 September to 16 October
    await boot({ events: [...weeks.map((k, i) => night(k, i >= 20 ? 400 : 460)), night('2026-10-17', 400), ...weeks.map((k, i) => stepsOn(k, i >= 20 ? 9000 : 7000))] });
    await vi.waitFor(() =>
      expect(tiles()).toEqual([
        ['Sleep', '6 h 40 min', 'a night, 45 min less than usual'],
        ['Steps', '9,000', 'a day, 1,500 more than usual'],
      ]),
    );
  });

  it('shows a check-in made since the life log was read straight away', async () => {
    const night: LifeEvent = { id: 'health:sleep:2026-10-17', source: 'health', kind: 'sleep', at: T('2026-10-17', 0), end: T('2026-10-17', 7), title: 'Slept 7 h', value: 420, unit: 'min', tier: 3 };
    await boot({ events: [night] });
    await vi.waitFor(() => expect(tiles()).toEqual([['Sleep', '7 h', 'a night (1 night)']]));
    const S = await import('./store');
    S.state.logs['2026-10-17'] = { e: 5, m: 4, at: 1 };
    ($('#tabs [data-v="progress"]') as HTMLElement).click(); // drawn again from the rows kept
    expect(tiles()).toEqual([
      ['Sleep', '7 h', 'a night (1 night)'],
      ['Energy', '5.0/5', 'from 1 check-in'],
      ['Mood', '4.0/5', '1 day'],
    ]);
  });

  it('says how to fill it when there is nothing yet', async () => {
    await boot();
    await vi.waitFor(() => expect(text('#youWeek > p')).toBe('Connect your phone or Mac, and your week shows here by itself.'));
    expect($('#youWeek [data-act="nav"][data-v="connect"]')).not.toBeNull();
    expect($('#youWeek .week-stats')).toBeNull();
  });
});

describe('Your life', () => {
  it("says how to connect when Arise knows nothing yet, with rating it yourself as an option", async () => {
    const { SYS } = await boot();
    expect(text('#lifePanel .panel-title')).toBe('Your life');
    await vi.waitFor(() => expect(text('#lifeAreas p')).toBe('Connect your phone or Mac, and Arise works out how each part of your life is going. Nothing to fill in.'));
    expect($('#lifeAreas [data-act="nav"][data-v="connect"]')).not.toBeNull();
    expect($('#lifeAreas .life-rows')).toBeNull();
    expect(text('#lifePanel')).not.toMatch(/You haven't checked in|Check in/);
    const button = $('#lifePanel [data-act="life-checkin"]')!;
    expect(button.textContent).toBe('Rate them yourself (optional)');
    button.click(); // opens the life check-in (system.js)
    await vi.waitFor(() => expect(SYS.handleAction).toHaveBeenCalledWith('life-checkin', button));
  });

  it('shows each part of life worked out from your days, why, and what you said only where you rated it', async () => {
    // Four weeks of nights from the phone, a little shorter this last week.
    const nights = days('2026-09-20', 28).map((k, i) => night(k, i >= 21 ? 420 : 450));
    await boot({
      data: {
        profile: { onboarded: true, skipped: true, life: { ...LIFE, areas: { sleep: 2, money: 3 } }, lifeBefore: { at: '2026-09-15', areas: { sleep: 1, money: 3 } } },
        logs: { '2026-10-15': { s: 2, e: 3, at: 1 }, '2026-10-16': { s: 3, e: 4, m: 4, at: 1 } },
      },
      events: nights,
    });
    await vi.waitFor(() => expect(texts('#lifePanel .life-areas > li')).toHaveLength(8));
    const rows = [...document.querySelectorAll('#lifePanel .life-areas > li')] as HTMLElement[];
    expect(rows.map((r) => r.querySelector('.k')!.textContent)).toEqual(['Sleep', 'Body and health', 'Mood and mind', 'People you love', 'Work or study', 'Money', 'Fun and rest', 'Purpose']);
    // Sleep: worked out, why, where it came from, and their own word beside it.
    const sleep = rows[0];
    expect(sleep.querySelector('.dots')!.getAttribute('aria-label')).toMatch(/^Sleep: [1-5] of 5$/);
    expect(text('#lifePanel .life-areas > li:first-child .area-trend')).toBe('↓ Worse than usual');
    expect(text('#lifePanel .life-areas > li:first-child .area-why')).toBe('7 h a night, 25 min less than usual (phone).');
    expect(text('#lifePanel .life-areas > li:first-child .area-said')).toBe('You said: Not great (1 Oct)');
    expect(texts('#lifePanel .life-areas .tag')).toEqual(['Growing']);
    // Money: not enough to go on, what would help, and what they said.
    const money = rows[5];
    expect(money.classList.contains('unknown')).toBe(true);
    expect(money.querySelector('.dots')!.getAttribute('aria-label')).toBe('Money: not enough to go on yet');
    expect(money.querySelector('.area-why')!.textContent).toBe('Not enough to go on yet. Connect your bank statements in Connect.');
    expect(money.querySelector('.area-said')!.textContent).toBe('You said: Okay (1 Oct)');
    // Not rated: no "You said".
    expect(rows[1].querySelector('.area-said')).toBeNull();
    expect(text('#lifePanel')).toContain('Your last 7 days, compared with your usual. Worked out on this device. Nobody else can see it, not even Arise.');
    // What matters and the next year are about you (just above), so they're said once.
    expect(text('#aboutYou')).toContain('A great next year: “See my family more.”');
    expect(text('#aboutYou')).toContain('What matters most to you: Family, Health.');
    const panel = text('#lifePanel');
    expect(panel).not.toContain('A great next year');
    expect(panel).not.toContain('What matters most');
    expect(text('#lifePanel [data-act="life-checkin"]')).toBe('Rate them yourself (optional)');
  });

  it('never nags for a rating, even a month after the last one', async () => {
    await boot({ data: { profile: { onboarded: true, skipped: true, life: { ...LIFE, at: '2026-09-10' } } } });
    await vi.waitFor(() => expect($('#lifePanel .life-areas')).not.toBeNull());
    expect(text('#lifePanel')).not.toMatch(/It's been a month|Check in/);
    // Their own ratings still show, beside parts Arise can't see yet.
    expect(text('#lifePanel .life-areas > li:first-child .area-said')).toBe('You said: Not great (10 Sep)');
  });
});

describe('What Arise noticed', () => {
  it('shows what goes with your good days, and asks your coach about one', async () => {
    // 7 days with a workout (energy 4.1 on average) and 10 without (3.2).
    const trained = days('2026-09-30', 7);
    const rest = days('2026-10-07', 10);
    const logs = Object.fromEntries([...trained.map((k, i) => [k, { e: i === 6 ? 5 : 4, at: 1 }]), ...rest.map((k, i) => [k, { e: i >= 8 ? 4 : 3, at: 1 }])]);
    const { SYS } = await boot({ data: { sessions: trained.map(session), logs } });
    expect(text('#lifePatterns .panel-title')).toBe('What Arise noticed');
    await vi.waitFor(() => expect(texts('#lifePatterns .noticed-list li p')).toEqual(['Your energy is higher on days you work out: 4.1 vs 3.2 (17 days).']));
    expect(text('#lifePatterns > p.muted')).toBe('These compare your own days. They show what goes together, not what causes what.');

    const ask = $('#lifePatterns [data-act="you-ask"][data-i="0"]')!;
    expect(ask.textContent).toBe('Ask your coach');
    ask.click();
    expect(SYS.askCoach).toHaveBeenCalledWith('Arise noticed: Your energy is higher on days you work out: 4.1 vs 3.2 (17 days). What do you make of it, and is there one small thing I could try?', { recallAs: 'the last 6 weeks' });
  });

  it('says how far along it is when nothing is clear yet', async () => {
    await boot({ data: { logs: { '2026-10-17': { e: 3, at: 1 } } } });
    await vi.waitFor(() => expect(text('#lifePatterns p')).toBe('Nothing clear yet. Patterns need a couple of weeks of days from your phone or computer. 1 day so far.'));
    expect($('#lifePatterns [data-act="you-ask"]')).toBeNull();
  });

  it("doesn't count days with only quests due, which make no patterns", async () => {
    const goals = [{ id: 'g1', title: 'Read more', category: 'learning', quests: [{ id: 'q1', title: 'Read 10 pages', schedule: { kind: 'daily' }, created: '2026-08-01' }] }];
    await boot({ data: { goals } });
    await vi.waitFor(() => expect(text('#lifePatterns p')).toBe('Nothing clear yet. Patterns need a couple of weeks of days from your phone or computer. 0 days so far.'));
    // Two weeks and more from a device, with nothing clear: no promise of days to come.
    await boot({ events: days('2026-10-01', 17).map((k) => stepsOn(k, 6000)) });
    await vi.waitFor(() => expect(text('#lifePatterns p')).toBe('Nothing clear yet in your last 17 days. A pattern shows here once two things in your days go together often enough.'));
  });

  it("asks about a pattern made from what Arise saw with that pattern's tier", async () => {
    // 7 days with a workout; the night after each is 8 h, the other nights 6 h 30 min (Apple Health).
    const all = days('2026-09-30', 18);
    const trained = all.slice(0, 7);
    const events = all.slice(1).map((k, i) => night(k, trained.includes(all[i]) ? 480 : 390));
    const { SYS } = await boot({ data: { sessions: trained.map(session) }, events });
    await vi.waitFor(() => expect(texts('#lifePatterns .noticed-list li p')).toContain('You sleep 1 h 30 min more after days you work out (17 days).'));
    const i = texts('#lifePatterns .noticed-list li p').indexOf('You sleep 1 h 30 min more after days you work out (17 days).');
    $(`#lifePatterns [data-act="you-ask"][data-i="${i}"]`)!.click();
    expect(SYS.askCoach).toHaveBeenLastCalledWith('Arise noticed: You sleep 1 h 30 min more after days you work out (17 days). What do you make of it, and is there one small thing I could try?', { recallAs: 'the last 6 weeks', about: 3 });
  });
});

describe('Looking back', () => {
  it('shows the week and the month Arise summed up', async () => {
    await boot({
      summaries: [
        { id: 'w:2026-10-05', kind: 'week', key: '2026-10-05', text: 'A steady week: three workouts and early nights.', tier: 2, cap: 3, sig: 'a', n: 7, at: 1 },
        { id: 'm:2026-09', kind: 'month', key: '2026-09', text: 'A busy month at work, with less sleep.', tier: 2, cap: 3, sig: 'b', n: 30, at: 1 },
      ],
    });
    await vi.waitFor(() => expect(texts('#lifeBack .kicker')).toEqual(['Last week (from Mon 5 Oct)', 'September']));
    expect(texts('#lifeBack .back-text')).toEqual(['A steady week: three workouts and early nights.', 'A busy month at work, with less sleep.']);
  });

  it("says when there's nothing yet", async () => {
    await boot();
    await vi.waitFor(() => expect(text('#lifeBack p')).toBe('Nothing yet. Arise writes these as it learns from your days.'));
  });
});
