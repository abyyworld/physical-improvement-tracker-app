// @vitest-environment jsdom
// The You tab (Progress in the System look): the person's life as they rated it, what the life
// log says about the last 4 weeks, what Arise noticed in their days, looking back, and their
// check-ins. The whole app started on some data.

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

async function boot({ data = {} as Record<string, unknown>, events = [] as LifeEvent[], summaries = [] as object[] } = {}) {
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
  if (summaries.length) {
    const db = await (await import('./life/db')).open();
    const tx = db.transaction('summaries', 'readwrite');
    for (const x of summaries) tx.objectStore('summaries').put(x);
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

describe('the You tab', () => {
  it("is called You in the Arise look, and Progress in the System look, with the rank only there", async () => {
    await boot({ data: { logs: { '2026-10-16': { e: 3, at: 1 } } } });
    expect(text('#tabs [data-v="progress"]')).toBe('You');
    expect(text('.page-head .kicker')).toBe('Your life and your goals');
    expect(text('h1')).toBe('You');
    expect(levelLine()).toBe('5 XP');
    expect($('#app')!.textContent).not.toContain('Rank');

    await boot({ data: { logs: { '2026-10-16': { e: 3, at: 1 } }, settings: { look: 'system' } } });
    expect(text('#tabs [data-v="progress"]')).toBe('Progress');
    expect(text('.page-head .kicker')).toBe('Consistency + improvement');
    expect(text('h1')).toBe('Progress');
    expect(levelLine()).toBe('Rank E · 5 XP');
    expect(text('#lifePatterns .panel-title')).toBe('[System analysis]');
    expect(text('#lifePanel .panel-title')).toBe('Life status');
  });

  it('starts with your life, what Arise noticed and looking back, and ends with your check-ins', async () => {
    await boot({ data: { logs: { '2026-10-16': { s: 2, e: 3, m: 4, t: 'Long day, early night.', at: 1 } } } });
    const left = [...document.querySelectorAll('.cols > .col:first-child > section')];
    expect(left.slice(0, 3).map((s) => s.id)).toEqual(['lifePanel', 'lifePatterns', 'lifeBack']);
    expect(left.at(-1)!.querySelector('.panel-title')!.textContent).toBe('Check-ins');
    expect(texts('.checkins .log-list li .hist-date span')).toEqual(['Fri, Oct 16', 'Sleep 2 · Energy 3 · Mood 4']);
    expect(text('.checkins .log-list li p')).toBe('Long day, early night.');
    expect($('#app')!.textContent).not.toContain('Daily log');
  });
});

describe('Your life', () => {
  it("asks for a life check-in when there's none yet", async () => {
    const { SYS } = await boot();
    expect(text('#lifePanel .panel-title')).toBe('Your life');
    expect(text('#lifePanel p')).toBe("You haven't checked in on your life yet. It takes a minute and helps you and your coach see the whole picture.");
    const button = $('#lifePanel [data-act="life-checkin"]')!;
    expect(button.textContent).toBe('Check in');
    expect($('#lifePanel #lifeAvg')).not.toBeNull();
    button.click(); // opens the life check-in (system.js)
    await vi.waitFor(() => expect(SYS.handleAction).toHaveBeenCalledWith('life-checkin', button));
  });

  it('shows each part of life as rated, what changed, where you want to grow and what matters', async () => {
    await boot({
      data: {
        profile: { onboarded: true, skipped: true, life: LIFE, lifeBefore: { at: '2026-09-15', areas: { sleep: 1, money: 3 } } },
        logs: { '2026-10-15': { s: 2, e: 3, at: 1 }, '2026-10-16': { s: 3, e: 4, m: 4, at: 1 } },
      },
    });
    expect(text('#lifePanel .muted.small')).toBe('Your own rating from 1 Oct. Before that: 15 Sep.');
    const rows = texts('#lifePanel .life-rows li');
    expect(rows).toHaveLength(8);
    expect(rows[0]).toBe('SleepNot greatGrowing↑ was Hard');
    expect(rows[3]).toBe('People you loveGreat');
    expect($('#lifePanel .life-rows .dots')!.getAttribute('aria-label')).toBe('Sleep: Not great');
    expect(document.querySelectorAll('#lifePanel .life-rows li:first-child .dots i.on')).toHaveLength(2);
    expect(texts('#lifePanel .life-rows .tag')).toEqual(['Growing']);
    const panel = text('#lifePanel');
    expect(panel).toContain('Last 4 weeks, from 2 daily check-ins: sleep 2.5, energy 3.5, mood 4.0 out of 5.');
    expect(panel).toContain('A great next year, in your words: “See my family more.”');
    expect(panel).toContain('What matters most to you: Family, Health.');
    expect(panel).not.toContain("It's been a month");
    expect(text('#lifePanel [data-act="life-checkin"]')).toBe('Check in again');
  });

  it('asks again after a month', async () => {
    await boot({ data: { profile: { onboarded: true, skipped: true, life: { ...LIFE, at: '2026-09-10' } } } });
    expect(text('#lifePanel')).toContain("It's been a month since you last checked in. How's life now?");
    expect(text('#lifePanel')).toContain('Check in on Today to see how your sleep, energy and mood move.');
  });

  it('adds what the life log says about the last 4 weeks, or how to connect it', async () => {
    const nights = days('2026-10-10', 3).map((k): LifeEvent => ({ id: `health:sleep:${k}`, source: 'health', kind: 'sleep', at: T(k, 0, 30), end: T(k, 7, 40), title: 'Slept 7 h 10 min', value: 430, unit: 'min', tier: 3 }));
    await boot({ events: nights });
    await vi.waitFor(() => expect(text('#lifeAvg')).toBe('From your life log, last 4 weeks: you slept 7 h 10 min a night on average (3 nights).'));
    expect($('#lifeAvg')!.hidden).toBe(false);

    await boot();
    await vi.waitFor(() => expect(text('#lifeAvg')).toBe('Connect your phone, calendar or apps (Settings, Your life) and your sleep, steps and time with people show here. Settings →'));
    expect($('#lifeAvg [data-act="nav"][data-v="settings"]')).not.toBeNull();
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
    await vi.waitFor(() => expect(text('#lifePatterns p')).toBe('Nothing clear yet. Patterns need about a week of check-ins or data from your phone. 1 day so far.'));
    expect($('#lifePatterns [data-act="you-ask"]')).toBeNull();
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
