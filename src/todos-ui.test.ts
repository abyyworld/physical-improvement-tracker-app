// @vitest-environment jsdom
// To-dos on Today: adding one (with a day or not), ticking it, deleting it, what's coming up, and
// the coach seeing the list.

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./lib/firebase', () => import('./test/fake-firebase'));

const added: [EventTarget, string, EventListenerOrEventListenerObject, unknown][] = [];
for (const target of [document, window]) {
  const add = target.addEventListener.bind(target);
  target.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: unknown) => {
    added.push([target, type, fn, opts]);
    add(type, fn, opts as AddEventListenerOptions);
  }) as typeof target.addEventListener;
}

async function boot(todos: object = {}, { view = 'today', events = [] as object[] } = {}) {
  for (const [target, type, fn, opts] of added.splice(0)) target.removeEventListener(type, fn, opts as EventListenerOptions);
  vi.resetModules();
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
  localStorage.setItem('arise-look-hint', 'seen');
  localStorage.setItem('pit-data-v1', JSON.stringify({ sessions: [], profile: { onboarded: true, skipped: true }, todos }));
  document.body.innerHTML = '<nav id="tabs"></nav><main id="app"></main><div id="restbar" hidden></div><div id="sheet" hidden><div class="sheet-panel"><button class="sheet-close"></button><div class="sheet-body"></div></div></div><div id="toast"></div><input type="file" id="importFile" hidden>';
  history.replaceState(null, '', `#${view}`);
  if (events.length) await (await import('./life/log')).addEvents(events as never);
  const S = await import('./store');
  await import('./app.js');
  return { S, AI: await import('./ai.js') };
}
const $ = (sel: string) => document.querySelector<HTMLElement>(sel);
const text = (sel: string) => $(sel)?.textContent?.replace(/\s+/g, ' ').trim() || '';
const titles = (sel = '#todoCard > .qlist:not(.later) .qtitle') => [...document.querySelectorAll(sel)].map((x) => x.textContent);
const NOW = new Date(2026, 10, 13, 10); // Friday 13 November 2026
const at = NOW.getTime();
const shown = (y: number, m: number, d: number) => new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  window.scrollTo = () => {};
});
afterEach(() => vi.useRealTimers());

function addTodo(title: string, day = '', time = '') {
  ($('#todoIn') as HTMLInputElement).value = title;
  if (!($('#todoDay') as HTMLInputElement).hidden) ($('#todoDay') as HTMLInputElement).value = day;
  ($('#todoTime') as HTMLInputElement).value = time;
  $('form[data-form="todo-add"]')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

describe('to-dos on Today', () => {
  it('starts empty, and adds one with Return, or with a day for later', async () => {
    const { S } = await boot();
    expect(text('#todoCard')).toContain('Nothing to do.');
    addTodo('Buy a bike light');
    expect(titles()).toEqual(['Buy a bike light']);
    expect(text('#todoCard .qcount')).toBe('0/1');
    addTodo('Call mum', '2026-11-20');
    expect(titles()).toEqual(['Buy a bike light']);
    expect(titles('#todoCard .later .qtitle')).toEqual(['Call mum']);
    expect(text('#todoCard .later')).toContain(shown(2026, 11, 20));
    addTodo('   ');
    expect(Object.keys(S.state.todos)).toHaveLength(2);
    // Saved, for the next time the app opens.
    expect(Object.keys(JSON.parse(localStorage.getItem('pit-data-v1')!).todos)).toHaveLength(2);
  });

  it('ticks one off, and deletes one', async () => {
    const { S } = await boot({ a: { id: 'a', title: 'Pay rent', day: '2026-11-11', created: at - 1, at: at - 1 }, b: { id: 'b', title: 'Book the dentist', created: at, at } });
    expect(titles()).toEqual(['Pay rent', 'Book the dentist']);
    expect(text('[data-todo="a"] .qmeta')).toBe(`Was due ${shown(2026, 11, 11)}`);
    $('[data-act="todo-tick"][data-id="a"]')!.click();
    await vi.waitFor(() => expect($('[data-todo="a"]')!.classList.contains('done')).toBe(true));
    expect(titles()).toEqual(['Book the dentist', 'Pay rent']);
    expect(text('#todoCard .qcount')).toBe('1/2');
    $('[data-act="todo-del"][data-id="b"]')!.click();
    await vi.waitFor(() => expect(titles()).toEqual(['Pay rent']));
    expect(S.state.todos.b).toMatchObject({ gone: true, title: '' });
  });

  it('counts a deleted to-do as data, so sync never takes this device for an empty one and brings it back', async () => {
    const { S } = await boot({ g: { id: 'g', title: '', created: at, at, gone: true } });
    expect(S.isEmpty()).toBe(false);
    expect(text('#todoCard')).toContain('Nothing to do.');
  });

  it('shows which app added one', async () => {
    await boot({ c: { id: 'c', title: 'Renew the passport', from: 'Claude', created: at, at } });
    expect(text('[data-todo="c"] .qmeta')).toBe('From Claude');
  });

  it('is in what the coach knows', async () => {
    const { AI } = await boot({ a: { id: 'a', title: 'Pay rent', day: '2026-11-11', created: at, at }, b: { id: 'b', title: 'Call mum', day: '2026-11-20', created: at, at } });
    const ctx = AI.buildContext();
    expect(ctx).toContain('## To-dos\n- [not yet] Pay rent (was due 2026-11-11)\n- [later] Call mum (due 2026-11-20)');
  });
});

describe('times, changes and the calendar', () => {
  it('takes a time with a day, and asks for a day for a time', async () => {
    const { S } = await boot();
    addTodo('Dentist', '', '15:30');
    expect(Object.keys(S.state.todos)).toEqual([]);
    expect(text('#toast')).toBe('Pick a day for the time too.');
    addTodo('Dentist', '2026-11-13', '15:30');
    expect(Object.values(S.state.todos)).toMatchObject([{ title: 'Dentist', day: '2026-11-13', time: '15:30' }]);
    expect(text('#todoCard .qmeta')).toBe('Today, 15:30');
  });

  it('changes one in its sheet: the words, the day and the time', async () => {
    const { S } = await boot({ a: { id: 'a', title: 'Pay rent', created: at, at } });
    $('[data-act="todo-edit"][data-id="a"]')!.click();
    await vi.waitFor(() => expect($('.todo-sheet')).not.toBeNull());
    expect(text('.todo-sheet')).toContain('turn on reminders in Settings first');
    ($('#todoEditTitle') as HTMLInputElement).value = 'Pay the rent';
    ($('#todoEditDay') as HTMLInputElement).value = '2026-11-14';
    ($('#todoEditTime') as HTMLInputElement).value = '09:00';
    $('.todo-sheet form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(S.state.todos.a).toMatchObject({ title: 'Pay the rent', day: '2026-11-14', time: '09:00' });
    expect(document.getElementById('sheet')!.hidden).toBe(true);
    expect(titles('#todoCard .later .qtitle')).toEqual(['Pay the rent']);
  });

  it('shows a month with what is on each day, the picked day, and adds one for that day', async () => {
    const event = { id: 'calendar:e1', source: 'calendar', kind: 'event', at: new Date(2026, 10, 20, 14).getTime(), title: 'Team lunch', tier: 2 };
    const allDay = { id: 'calendar:e2', source: 'calendar', kind: 'event', at: new Date(2026, 10, 20).getTime(), title: 'Mum’s birthday', tier: 2, meta: { allDay: true } };
    const own = { id: 'arise:goal:1', source: 'arise', kind: 'event', at: new Date(2026, 10, 20, 9).getTime(), title: 'New goal: Run a 10k', tier: 1 };
    const { S } = await boot({ a: { id: 'a', title: 'Call mum', day: '2026-11-20', created: at, at }, b: { id: 'b', title: 'Pay rent', created: at, at } }, { view: 'today', events: [event, allDay, own] });
    $('#todoCard [data-act="nav"][data-v="calendar"]')!.click();
    await vi.waitFor(() => expect(text('h1')).toBe('Calendar'));
    expect(location.hash).toBe('#calendar');
    expect(document.querySelectorAll('.cal-grid .cal-cell:not(.blank)')).toHaveLength(30);
    expect($('[data-d="2026-11-13"]')!.classList.contains('today')).toBe(true);
    expect($('[data-d="2026-11-20"] .dot.todo')).not.toBeNull();
    await vi.waitFor(() => expect($('[data-d="2026-11-20"] .dot.ev')).not.toBeNull());
    expect($('[data-d="2026-11-20"]')!.getAttribute('aria-label')).toContain('1 to do, 2 in your calendar');
    // Today: nothing on the day itself, but what's still to do with no day.
    expect(text('#calDay')).toContain('No to-dos on this day.');
    expect(titles('#calDay .later .qtitle')).toEqual(['Pay rent']);
    $('[data-d="2026-11-20"]')!.click();
    expect(titles('#calDay > .qlist:not(.later) .qtitle')).toEqual(['Call mum']);
    expect(text('#calDay .cal-events')).toContain('Team lunch');
    expect(text('#calDay .cal-events')).toContain('All day Mum’s birthday');
    expect(text('#calDay .cal-events')).not.toContain('New goal'); // Arise's own aren't calendar events
    // A later day with nothing: what the calendar can and can't show yet.
    $('[data-d="2026-11-25"]')!.click();
    expect(text('#calDay')).toContain('Nothing coming up from your calendar.');
    $('[data-d="2026-11-20"]')!.click();
    addTodo('Buy flowers', '', '18:00');
    expect(Object.values(S.state.todos).find((t) => t.title === 'Buy flowers')).toMatchObject({ day: '2026-11-20', time: '18:00' });
    expect(titles('#calDay > .qlist:not(.later) .qtitle')).toEqual(['Call mum', 'Buy flowers']);
    // The next month, and back.
    $('[data-act="cal-month"][data-n="1"]')!.click();
    expect(document.querySelectorAll('.cal-grid .cal-cell:not(.blank)')).toHaveLength(31);
    $('[data-act="cal-today"]')!.click();
    expect($('[data-d="2026-11-13"]')!.classList.contains('on')).toBe(true);
  });
});

describe('the top of Today', () => {
  it('says hello in big letters, with the day at a glance, and keeps the page title for screen readers', async () => {
    await boot({ a: { id: 'a', title: 'Pay rent', created: at, at }, b: { id: 'b', title: 'Call mum', created: at, at } });
    expect(text('.hero-date')).toBe(new Date(2026, 10, 13).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }));
    expect(text('.hero-hi')).toBe('Good morning.');
    expect(text('.hero-sub')).toBe('A fresh page. Start with one small thing.');
    expect(text('.hero-glance')).toContain('2 to-dos');
    expect(text('.hero-glance')).toContain('0 quests left');
    await vi.waitFor(() => expect(text('#heroCal')).toBe('0'));
    expect(text('h1')).toBe('Today'); // still there, only hidden from view
    $('.hero-glance [data-v="calendar"]')!.click();
    await vi.waitFor(() => expect(text('h1')).toBe('Calendar'));
  });

  it('picks an atmosphere from a small menu, which closes with a tap elsewhere', async () => {
    await boot();
    expect($('#atmoMenu')).toBeNull();
    $('.atmo-btn')!.click();
    await vi.waitFor(() => expect($('#atmoMenu')).not.toBeNull());
    expect($('.atmo-btn')!.getAttribute('aria-expanded')).toBe('true');
    expect([...document.querySelectorAll('#atmoMenu [data-act="bg"]')].map((b) => b.textContent!.trim())).toEqual(['Plain', 'Sunrise', 'Night sky', 'Aurora', 'Dawn', 'Sea', 'Forest', 'Dusk']);
    $('#atmoMenu [data-v="stars"]')!.click();
    await vi.waitFor(() => expect(document.documentElement.dataset.bg).toBe('stars'));
    expect(localStorage.getItem('arise-bg')).toBe('stars');
    expect($('#atmoMenu')).not.toBeNull(); // stays open to try another
    $('#todoCard')!.click();
    await vi.waitFor(() => expect($('#atmoMenu')).toBeNull());
    document.documentElement.removeAttribute('data-bg');
  });
});
