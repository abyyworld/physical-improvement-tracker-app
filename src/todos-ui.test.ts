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

async function boot(todos: object = {}) {
  for (const [target, type, fn, opts] of added.splice(0)) target.removeEventListener(type, fn, opts as EventListenerOptions);
  vi.resetModules();
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
  localStorage.setItem('arise-look-hint', 'seen');
  localStorage.setItem('pit-data-v1', JSON.stringify({ sessions: [], profile: { onboarded: true, skipped: true }, todos }));
  document.body.innerHTML = '<nav id="tabs"></nav><main id="app"></main><div id="restbar" hidden></div><div id="sheet" hidden><div class="sheet-panel"><button class="sheet-close"></button><div class="sheet-body"></div></div></div><div id="toast"></div><input type="file" id="importFile" hidden>';
  history.replaceState(null, '', '#today');
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

function addTodo(title: string, day = '') {
  ($('#todoIn') as HTMLInputElement).value = title;
  ($('#todoDay') as HTMLInputElement).value = day;
  $('#todoCard form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
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
