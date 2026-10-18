// @vitest-environment jsdom
// The life log on screen: the Days tab, a day's timeline and summary, search, adding a note,
// What Arise knows, yesterday on Today, and the panel in Settings.

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LifeEvent } from './types';

vi.mock('../lib/firebase', () => import('../test/fake-firebase'));

const T = (k: string, h = 12, m = 0) => {
  const [y, mo, d] = k.split('-').map(Number);
  return new Date(y, mo - 1, d, h, m).getTime();
};
const EVENTS: LifeEvent[] = [
  { id: 'spotify:a1', source: 'spotify', kind: 'listen', at: T('2026-10-16', 9, 5), title: 'Listened to Daft Punk: One More Time', tier: 2 },
  { id: 'spotify:a2', source: 'spotify', kind: 'listen', at: T('2026-10-16', 9, 40), title: 'Listened to Justice: D.A.N.C.E.', tier: 2 },
  { id: 'google:s1', source: 'google', kind: 'search', at: T('2026-10-16', 14), title: 'Searched "protein bars"', tier: 3 },
  { id: 'netflix:n1', source: 'netflix', kind: 'watch', at: T('2026-10-12', 21), title: 'Watched Dark: S1E1', tier: 2 },
];

// Each boot starts the whole app again: the listeners the last one added go first.
const added: [EventTarget, string, EventListenerOrEventListenerObject, unknown][] = [];
for (const target of [document, window]) {
  const add = target.addEventListener.bind(target);
  target.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: unknown) => {
    added.push([target, type, fn, opts]);
    add(type, fn, opts as AddEventListenerOptions);
  }) as typeof target.addEventListener;
}

async function boot(view: string, { events = EVENTS, facts = [] as string[], summaries = [] as object[], data = {} } = {}) {
  for (const [target, type, fn, opts] of added.splice(0)) target.removeEventListener(type, fn, opts as EventListenerOptions);
  vi.resetModules();
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
  localStorage.setItem('pit-data-v1', JSON.stringify({ sessions: [], profile: { onboarded: true, skipped: true }, ...data }));
  document.body.innerHTML = '<nav id="tabs"></nav><main id="app"></main><div id="restbar" hidden></div><div id="sheet" hidden><div class="sheet-panel"><button class="sheet-close"></button><div class="sheet-body"></div></div></div><div id="toast"></div><input type="file" id="importFile" hidden>';
  history.replaceState(null, '', `#${view}`);
  const L = await import('./log');
  const M = await import('./memory');
  await L.addEvents(events);
  for (const f of facts) await M.addFact(f);
  if (summaries.length) {
    const db = await (await import('./db')).open();
    const tx = db.transaction('summaries', 'readwrite');
    for (const x of summaries) tx.objectStore('summaries').put(x);
    await new Promise((r) => (tx.oncomplete = r));
  }
  await import('../app.js');
  return { L, M };
}
const app = () => document.getElementById('app')!;
const click = (sel: string) => (document.querySelector(sel) as HTMLElement).click();
const text = (sel: string) => document.querySelector(sel)?.textContent?.replace(/\s+/g, ' ').trim() || '';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 17, 10)); // Saturday 17 October 2026
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  window.scrollTo = () => {};
});
afterEach(() => vi.useRealTimers());

describe('Your days', () => {
  it('is a tab, and shows a day grouped by hour with where each thing came from', async () => {
    await boot('days');
    expect([...document.querySelectorAll('#tabs [data-v]')].map((b) => b.getAttribute('data-v'))).toEqual(['today', 'days', 'progress', 'goals', 'coach', 'settings']);
    expect(document.querySelector('#tabs [data-v="days"]')?.classList.contains('on')).toBe(true);
    expect(text('h1')).toBe('Your days');
    // Signed out: it says where the log is, and how to sync it.
    expect(app().textContent).toContain('On this device only. Sign in to sync it.');
    await vi.waitFor(() => expect(text('#lifeDay')).toContain('Nothing in your log for this day yet.'));

    click('[data-act="life-day"][data-d="-1"]');
    await vi.waitFor(() => expect(document.querySelectorAll('#lifeDay .tl-ev')).toHaveLength(3));
    expect(text('.life-nav-day b')).toBe('Yesterday');
    const clock = (h: number, m = 0) => new Date(2026, 9, 16, h, m).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    expect([...document.querySelectorAll('.tl-hour')].map((h) => [h.querySelector('.tl-h')!.textContent, h.querySelectorAll('.tl-ev').length])).toEqual([
      [clock(9), 2],
      [clock(14), 1],
    ]);
    expect(text('.tl-ev .tl-title')).toBe('Listened to Daft Punk: One More Time');
    expect(text('.tl-ev small')).toBe(`Spotify · ${clock(9, 5)}`);
    expect(document.querySelector('.tl-ev .tl-icon svg')).not.toBeNull();
  });

  it('shows the summary of a day once there is one, and opens one event with who may read it', async () => {
    await boot('days', { summaries: [{ id: 'd:2026-10-16', kind: 'day', key: '2026-10-16', text: 'You listened to music and looked up protein bars.', tier: 3, cap: 3, sig: 'x', n: 3, at: 1 }] });
    click('[data-act="life-day"][data-d="-1"]');
    await vi.waitFor(() => expect(text('#lifeDay .life-summary p:last-child')).toBe('You listened to music and looked up protein bars.'));
    click('#lifeDay .tl-ev[data-id="google:s1"]');
    await vi.waitFor(() => expect(text('.sheet-body h2')).toBe('Searched "protein bars"'));
    expect(text('.sheet-body')).toContain('Only the private AI and the AI on your device read this.');
    expect(document.querySelector('.sheet-body [data-act="life-ev-del"]')).not.toBeNull();
  });

  it('lets you delete a question you asked the coach, though other things from Arise change where you made them', async () => {
    const ask = { id: `arise:chat:${T('2026-10-16', 8)}`, source: 'arise' as const, kind: 'message' as const, at: T('2026-10-16', 8), title: 'Asked the coach: Is this rash serious?', tier: 1 as const };
    const quest = { id: 'arise:football:2026-10-16', source: 'arise' as const, kind: 'play' as const, at: T('2026-10-16', 17), title: 'Played football', tier: 1 as const };
    const { L } = await boot('days', { events: [ask, quest], data: { football: ['2026-10-16'] } });
    click('[data-act="life-day"][data-d="-1"]');
    await vi.waitFor(() => expect(document.querySelector(`#lifeDay .tl-ev[data-id="${quest.id}"]`)).not.toBeNull());
    click(`#lifeDay .tl-ev[data-id="${ask.id}"]`);
    await vi.waitFor(() => expect(text('.sheet-body h2')).toBe('Asked the coach: Is this rash serious?'));
    expect(text('.sheet-body')).toContain('Deleting it here takes it out of your log for good.');
    window.confirm = () => true;
    click('.sheet-body [data-act="life-ev-del"]');
    await vi.waitFor(async () => expect(await L.getEvent(ask.id)).toBeNull());
    // (The day is drawn again after the delete.)
    await vi.waitFor(() => expect(document.querySelector(`#lifeDay .tl-ev[data-id="${quest.id}"]`)).not.toBeNull());
    click(`#lifeDay .tl-ev[data-id="${quest.id}"]`);
    await vi.waitFor(() => expect(text('.sheet-body h2')).toBe('Played football'));
    expect(document.querySelector('.sheet-body [data-act="life-ev-del"]')).toBeNull();
    expect(text('.sheet-body')).toContain('This comes from Arise itself.');
  });

  it('searches the log and offers to ask the coach', async () => {
    await boot('days');
    (document.getElementById('lifeQ') as HTMLInputElement).value = 'What did I search for protein?';
    document.getElementById('lifeSearch')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(document.querySelectorAll('#lifeResults .tl-ev')).toHaveLength(1));
    expect(text('#lifeResults')).toContain('Searched "protein bars"');
    expect(text('#lifeResults')).toContain('1 thing found');
    expect(document.querySelector('[data-act="life-ask"]')).not.toBeNull();

    // A date alone lists that day; a word that isn't there says so.
    (document.getElementById('lifeQ') as HTMLInputElement).value = 'What did I do last Monday?';
    document.getElementById('lifeSearch')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(text('#lifeResults')).toContain('Watched Dark: S1E1'));
    (document.getElementById('lifeQ') as HTMLInputElement).value = 'pizza';
    document.getElementById('lifeSearch')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(text('#lifeResults')).toContain('Nothing in your log matches “pizza”'));

    // A result opens its day.
    (document.getElementById('lifeQ') as HTMLInputElement).value = 'protein';
    document.getElementById('lifeSearch')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(document.querySelectorAll('#lifeResults .tl-ev')).toHaveLength(1));
    click('#lifeResults .tl-ev');
    await vi.waitFor(() => expect(text('.life-nav-day b')).toBe('Yesterday'));
  });

  it('forgets the last search when the log is emptied, so the next person never sees it', async () => {
    const { L } = await boot('days');
    (document.getElementById('lifeQ') as HTMLInputElement).value = 'protein';
    document.getElementById('lifeSearch')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(text('#lifeResults')).toContain('Searched "protein bars"'));
    await L.eraseAll(); // Erase all data, Delete everything, or another account's data taking over
    click('#tabs [data-v="today"]');
    click('#tabs [data-v="days"]');
    expect(text('#lifeResults')).toBe('');
    expect((document.getElementById('lifeQ') as HTMLInputElement).value).toBe('');
    expect(app().textContent).not.toContain('protein');
  });

  it("lists a date's events when the other words aren't in the log, whatever the punctuation in the date", async () => {
    await boot('days');
    (document.getElementById('lifeQ') as HTMLInputElement).value = 'How did I feel on Oct. 12?';
    document.getElementById('lifeSearch')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(text('#lifeResults')).toContain('Watched Dark: S1E1'));
    expect(text('#lifeResults')).toContain('Nothing had those words, so here is everything from then: 1 thing found, that day (Mon 12 Oct).');
  });

  it('adds a note with a mood to the day', async () => {
    const { L } = await boot('days');
    click('[data-act="life-add"]');
    expect(text('.sheet-body .kicker')).toBe('Add to your day');
    (document.getElementById('lifeNote') as HTMLTextAreaElement).value = 'Lunch with Sam in the park.\nNice.';
    click('[data-act="life-mood"][data-v="4"]');
    expect(document.querySelector('[data-act="life-mood"][data-v="4"]')?.getAttribute('aria-pressed')).toBe('true');
    (document.getElementById('lifeTime') as HTMLInputElement).value = '09:30';
    click('[data-act="life-add-save"]');
    await vi.waitFor(async () => expect(await L.countBySource()).toMatchObject({ manual: 1 }));
    const [note] = await L.eventsBetween(0, Infinity, { sources: ['manual'] });
    expect(note).toMatchObject({ source: 'manual', kind: 'note', tier: 2, title: 'Lunch with Sam in the park.', at: T('2026-10-17', 9, 30), value: 4 });
    expect(note.detail).toContain('Mood: Good.');
    await vi.waitFor(() => expect(text('#lifeDay')).toContain('Lunch with Sam in the park.'));
  });
});

describe('the calendar in Your days', () => {
  const many = (k: string, n: number, h = 10): LifeEvent[] => Array.from({ length: n }, (_, i) => ({ id: `browser:${k}-${i}`, source: 'browser', kind: 'visit', at: T(k, h, i % 60), title: `Visited page ${i}`, tier: 3 }));
  const cell = (k: string) => document.querySelector(`#lifeCal .cal-day[data-day="${k}"]`) as HTMLButtonElement;
  const lvl = (k: string) => cell(k)?.dataset.lvl;
  const at = (k: string) => T(k, 20);
  const checkins = { '2026-10-13': { m: 4, e: 1, at: at('2026-10-13') }, '2026-10-14': { m: 2, at: at('2026-10-14') }, '2026-10-15': { e: 5, at: at('2026-10-15') }, '2026-10-09': { s: 3, at: at('2026-10-09') } };

  it('shows the month, Monday first, each day shaded by how much is in its log, with a dot for how you felt', async () => {
    await boot('days', { events: [...EVENTS, ...many('2026-10-05', 12), ...many('2026-10-03', 45)], data: { logs: checkins } });
    const cal = document.getElementById('lifeCal')!;
    // At the top, under the heading and above the day.
    expect(cal.compareDocumentPosition(document.querySelector('.life-nav')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(cal.compareDocumentPosition(document.querySelector('.page-head')!) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    expect(text('#lifeCal .cal-title')).toBe(new Date(2026, 9, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }));
    expect([...cal.querySelectorAll('.cal-wd')].map((d) => d.textContent)).toEqual([12, 13, 14, 15, 16, 17, 18].map((d) => new Date(2026, 9, d).toLocaleDateString(undefined, { weekday: 'short' })));
    // 1 October 2026 is a Thursday: three empty places first.
    const grid = [...cal.querySelector('.cal-grid')!.children];
    expect(grid.indexOf(cell('2026-10-01'))).toBe(7 + 3);
    expect(cal.querySelectorAll('.cal-day')).toHaveLength(31);
    expect(cell('2026-10-01').textContent).toBe('1');

    // Today is marked and open; the days to come can't be opened yet.
    expect(cell('2026-10-17').classList.contains('today')).toBe(true);
    expect(cell('2026-10-17').getAttribute('aria-current')).toBe('date');
    expect(cell('2026-10-17').classList.contains('on')).toBe(true);
    expect(cell('2026-10-17').getAttribute('aria-pressed')).toBe('true');
    expect(cell('2026-10-16').getAttribute('aria-pressed')).toBe('false');
    expect(cell('2026-10-18').disabled).toBe(true);
    expect(cell('2026-10-31').disabled).toBe(true);
    expect(cell('2026-10-16').disabled).toBe(false);

    // This month: no way forward, and no Today button.
    expect((cal.querySelector('[aria-label="Next month"]') as HTMLButtonElement).disabled).toBe(true);
    expect((cal.querySelector('[aria-label="Previous month"]') as HTMLButtonElement).disabled).toBe(false);
    expect(cal.querySelector('[data-act="life-cal-today"]')).toBeNull();

    // Shaded once the counts are read: nothing, a little, a lot, very full.
    await vi.waitFor(() => expect(lvl('2026-10-03')).toBe('3'));
    expect(lvl('2026-10-05')).toBe('2');
    expect(lvl('2026-10-16')).toBe('1');
    expect(lvl('2026-10-12')).toBe('1');
    expect(lvl('2026-10-02')).toBe('0');
    expect(cell('2026-10-03').getAttribute('aria-label')).toContain('Your log is very full');
    expect(cell('2026-10-02').getAttribute('aria-label')).toContain('Nothing in your log');

    // The dot: the check-in's mood, else its energy (sleep alone gives none).
    expect(cell('2026-10-13').querySelector('.cal-dot')?.className).toBe('cal-dot high');
    expect(cell('2026-10-13').getAttribute('aria-label')).toContain('Mood: good');
    expect(cell('2026-10-14').querySelector('.cal-dot')?.className).toBe('cal-dot low');
    expect(cell('2026-10-15').querySelector('.cal-dot')?.className).toBe('cal-dot high');
    expect(cell('2026-10-15').getAttribute('aria-label')).toContain('Energy: unstoppable');
    expect(cell('2026-10-09').querySelector('.cal-dot')).toBeNull();
    expect(cell('2026-10-16').querySelector('.cal-dot')).toBeNull();
    expect(text('#lifeCal .cal-legend')).toBe('Darker days have more in them. The dot is how you felt.');
  });

  it('buckets how full a day is', async () => {
    const { activityLevel } = await import('./screens.js');
    expect([0, 1, 9, 10, 39, 40, 5000].map(activityLevel)).toEqual([0, 1, 1, 2, 2, 3, 3]);
  });

  it('goes back a month and forward again, and Today comes back to this month', async () => {
    await boot('days', { events: [...EVENTS, ...many('2026-09-10', 50)] });
    await vi.waitFor(() => expect(lvl('2026-10-16')).toBe('1'));
    click('#lifeCal [aria-label="Previous month"]');
    expect(text('#lifeCal .cal-title')).toBe(new Date(2026, 8, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }));
    expect(document.querySelectorAll('#lifeCal .cal-day')).toHaveLength(30);
    expect((document.querySelector('#lifeCal [aria-label="Next month"]') as HTMLButtonElement).disabled).toBe(false);
    expect(document.querySelector('#lifeCal [data-act="life-cal-today"]')).not.toBeNull();
    // The arrow keeps the focus, and the day below stays as it was.
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Previous month');
    expect(text('.life-nav-day b')).toBe('Today');
    await vi.waitFor(() => expect(lvl('2026-09-10')).toBe('3'));
    expect(lvl('2026-09-11')).toBe('0');

    click('#lifeCal [aria-label="Previous month"]');
    expect(document.querySelector('#lifeCal .cal-day[data-day="2026-08-31"]')).not.toBeNull();
    click('#lifeCal [aria-label="Next month"]');
    click('#lifeCal [aria-label="Next month"]');
    expect(document.getElementById('lifeCal')!.dataset.month).toBe('2026-10');
    expect((document.querySelector('#lifeCal [aria-label="Next month"]') as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelector('#lifeCal [data-act="life-cal-today"]')).toBeNull();
    // From this month's counts, kept from before: shaded at once.
    expect(lvl('2026-10-16')).toBe('1');

    click('#lifeCal [aria-label="Previous month"]');
    click('#lifeCal [data-act="life-cal-today"]');
    expect(document.getElementById('lifeCal')!.dataset.month).toBe('2026-10');
    expect(text('.life-nav-day b')).toBe('Today');
  });

  it('opens a tapped day like picking it, on its journal', async () => {
    await boot('days');
    click('[data-act="life-pane"][data-v="events"]');
    click('#lifeCal .cal-day[data-day="2026-10-16"]');
    expect(text('.life-nav-day b')).toBe('Yesterday');
    expect((document.getElementById('lifeDate') as HTMLInputElement).value).toBe('2026-10-16');
    expect(document.querySelector('[data-act="life-pane"][data-v="journal"]')?.getAttribute('aria-pressed')).toBe('true');
    await vi.waitFor(() => expect(document.querySelector('#lifeDay [data-pane="journal"]')).not.toBeNull());
    expect(document.querySelector('#lifeDay [data-pane="journal"]')!.hasAttribute('hidden')).toBe(false);
    expect(cell('2026-10-16').classList.contains('on')).toBe(true);
    expect(cell('2026-10-17').classList.contains('on')).toBe(false);
    expect(cell('2026-10-17').classList.contains('today')).toBe(true);

    // A day in an earlier month: the calendar stays on its month.
    click('#lifeCal [aria-label="Previous month"]');
    click('#lifeCal .cal-day[data-day="2026-09-30"]');
    expect((document.getElementById('lifeDate') as HTMLInputElement).value).toBe('2026-09-30');
    expect(document.getElementById('lifeCal')!.dataset.month).toBe('2026-09');
    expect(cell('2026-09-30').classList.contains('on')).toBe(true);
    // Moving the day another way takes the calendar along.
    click('[data-act="life-day"][data-d="1"]');
    expect(document.getElementById('lifeCal')!.dataset.month).toBe('2026-10');
    expect(cell('2026-10-01').classList.contains('on')).toBe(true);

    // A day still to come can't be opened.
    cell('2026-10-20').click();
    expect((document.getElementById('lifeDate') as HTMLInputElement).value).toBe('2026-10-01');
  });

  it('shades again when the log changes while it is open', async () => {
    const { L } = await boot('days');
    await vi.waitFor(() => expect(lvl('2026-10-16')).toBe('1'));
    expect(lvl('2026-10-02')).toBe('0');
    await L.addEvents(many('2026-10-02', 45));
    await vi.waitFor(() => expect(lvl('2026-10-02')).toBe('3'));
    await L.removeIds(many('2026-10-02', 45).map((e) => e.id));
    await vi.waitFor(() => expect(lvl('2026-10-02')).toBe('0'));
  });

  it("doesn't shade a calendar with counts read for another month, or from before the log was emptied", async () => {
    const { L } = await boot('days');
    await vi.waitFor(() => expect(lvl('2026-10-16')).toBe('1'));
    type Counts = Record<string, number>;
    const answers: ((c: Counts) => void)[] = [];
    const spy = vi.spyOn(L, 'countByDay').mockImplementation(() => new Promise<Counts>((r) => answers.push(r)));
    // September is read, but October is back on screen before the answer comes.
    const tick = () => new Promise((r) => setTimeout(r, 0));
    click('#lifeCal [aria-label="Previous month"]');
    await tick();
    expect(answers).toHaveLength(1);
    click('#lifeCal [aria-label="Next month"]');
    await tick();
    answers[0]({ '2026-09-10': 99 });
    await tick();
    expect(lvl('2026-10-16')).toBe('1');

    // Read for September again, and the log is emptied meanwhile: nothing from before is kept.
    click('#lifeCal [aria-label="Previous month"]');
    await tick();
    expect(answers).toHaveLength(2);
    await L.eraseAll();
    answers[1]({ '2026-09-10': 99 });
    await tick();
    expect(lvl('2026-09-10')).toBe('0');
    spy.mockRestore();
    click('#tabs [data-v="today"]');
    click('#tabs [data-v="days"]');
    click('#lifeCal [aria-label="Previous month"]');
    await new Promise((r) => setTimeout(r, 50));
    expect(lvl('2026-09-10')).toBe('0');
  });

  it('shows only the check-in dots on a device without a life log', async () => {
    await boot('today', { data: { logs: checkins } });
    (await import('./store-port')).setLifeStore(null);
    click('#tabs [data-v="days"]');
    await new Promise((r) => setTimeout(r, 50));
    expect(document.querySelectorAll('#lifeCal .cal-day')).toHaveLength(31);
    expect(document.querySelectorAll('#lifeCal .cal-day:not([data-lvl="0"])')).toHaveLength(0);
    expect(cell('2026-10-14').querySelector('.cal-dot.low')).not.toBeNull();
    expect(cell('2026-10-16').getAttribute('aria-label')).not.toContain('in your log');
    expect(text('#lifeCal .cal-legend')).toBe('The dot is how you felt.');
  });
});

describe('What Arise knows', () => {
  it('shows the profile, the facts, the switches and what is in the log', async () => {
    await boot('knows', { facts: ['I live in Leeds.'] });
    expect(text('h1')).toBe('What Arise knows');
    expect(document.querySelector('#tabs [data-v="days"]')?.classList.contains('on')).toBe(true);
    await vi.waitFor(() => expect(text('#lifeSources')).toContain('Spotify'));
    expect(text('#lifeProfile')).toContain('I live in Leeds.');
    expect(text('#lifeFacts')).toContain('Added by you');
    expect([...document.querySelectorAll('#lifeSources .src-name')].map((el) => [el.querySelector('b')!.textContent, el.querySelector('small')!.textContent])).toEqual([
      ['Spotify', '2 things'],
      ['Google', '1 thing'],
      ['Netflix', '1 thing'],
    ]);
    expect(document.querySelectorAll('#lifeSources [data-act="life-src-del"]')).toHaveLength(3);
    expect(text('[data-act="life-pause"]')).toContain('Stop learning');
    expect(document.querySelector('[data-act="life-less-private"]')?.getAttribute('aria-pressed')).toBe('false');
    expect(text('[data-act="life-less-private"]')).toContain("Gemini's free tier also says not to send it personal information.");
    expect(text('#lifeLearn')).toContain('Turn on the AI coach in Settings');
  });

  it('pauses learning, and deletes a source after asking', async () => {
    const { L } = await boot('knows');
    click('[data-act="life-pause"]');
    expect(JSON.parse(localStorage.getItem('arise-life-prefs')!)).toMatchObject({ paused: true });
    expect(text('#lifeLearn')).toContain('Paused');
    await vi.waitFor(() => expect(document.querySelector('[data-act="life-src-del"][data-src="spotify"]')).not.toBeNull());
    window.confirm = () => true;
    click('[data-act="life-src-del"][data-src="spotify"]');
    await vi.waitFor(async () => expect(await L.countBySource()).toEqual({ google: 1, netflix: 1 }));
  });
});

describe('elsewhere in the app', () => {
  it('shows yesterday on Today, and hides it until tomorrow when asked', async () => {
    await boot('today');
    await vi.waitFor(() => expect(text('#lifeRecap')).toContain('In your log: 2 songs and shows played and 1 search.'));
    click('[data-act="life-recap-hide"]');
    expect(text('#lifeRecap')).toBe('');
  });

  it("doesn't put a recap that was on its way into a Today drawn again since", async () => {
    const SC = await import('./screens.js');
    document.body.innerHTML = '<main id="app"><div id="lifeRecap"></div></main>';
    const M = await import('./memory');
    type Recap = Awaited<ReturnType<typeof M.recap>>;
    let answer: (r: Recap) => void = () => {};
    const spy = vi.spyOn(M, 'recap').mockReturnValue(new Promise<Recap>((r) => (answer = r)));
    const filling = SC.fillRecap();
    // Meanwhile the data was wiped and Today drawn again, for the next person.
    SC.forgetScreens();
    document.body.innerHTML = '<main id="app"><div id="lifeRecap"></div></main>';
    answer({ day: '2026-10-16', text: 'The last person ran 8 km.', from: 'summary' });
    await filling;
    expect(text('#lifeRecap')).toBe('');
    spy.mockRestore();
  });

  it('shows nothing for yesterday when the log has nothing', async () => {
    await boot('today', { events: [] });
    await new Promise((r) => setTimeout(r, 50));
    expect(text('#lifeRecap')).toBe('');
  });

  it('has a life log panel in Settings', async () => {
    await boot('settings');
    expect(app().textContent).toContain('Your life log');
    expect(document.querySelector('#app [data-act="nav"][data-v="knows"]')).not.toBeNull();
  });
});
