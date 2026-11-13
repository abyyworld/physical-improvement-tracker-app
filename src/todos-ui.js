// To-dos (lib/todos.ts), on Today and in the calendar.
//   Today: what's left to do, with its day and time if it has them, a box to add one (with a day
//   and a time if you like), what got done today, and what's coming up. Ticked like quests; tap
//   one to change or delete it. To-dos an AI app added through the web connector show its name.
//   Calendar: a month, with a dot on each day that has to-dos or calendar events (from the life
//   log: the iPhone's calendar, Google or Outlook), and the picked day's to-dos and events, with a
//   box to add one for that day. All of it on this device.
// Reminders at a to-do's time: the phone apps schedule them (native.js), and the web app shows
// them while it's open (todo-alerts.js).

import * as S from './store';
import * as L from './life/log';
import { hasLifeStore } from './life/store-port';
import * as N from './native.js';
import { esc, icon, openSheet, closeSheet, toast } from './ui.js';

export const VIEW = 'calendar';
const $ = (sel, root = globalThis.document) => root?.querySelector(sel) ?? null;

const parse = (k) => {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const keyOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const dayText = (k, today = S.todayKey()) => {
  if (k === today) return 'Today';
  if (k === S.addDays(today, 1)) return 'Tomorrow';
  if (k === S.addDays(today, -1)) return 'Yesterday';
  return parse(k).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
};
const clock = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

function row(t, today, { showDay = true } = {}) {
  const done = !!t.done;
  const late = !done && t.day && t.day < today;
  const when = t.day && showDay ? `${late ? 'Was due ' : ''}${dayText(t.day, today)}${t.time ? `, ${t.time}` : ''}` : t.time || '';
  const meta = [when, t.from ? `From ${t.from}` : ''].filter(Boolean);
  return `<li class="qrow ${done ? 'done' : ''}" data-todo="${esc(t.id)}">
    <button class="qcheck" data-act="todo-tick" data-id="${esc(t.id)}" aria-pressed="${done}" aria-label="${esc(t.title)}: ${done ? 'done' : 'not done yet'}">${icon('check')}</button>
    <button class="qbody todo-open" data-act="todo-edit" data-id="${esc(t.id)}" aria-label="Change ${esc(t.title)}">
      <span class="qtitle">${esc(t.title)}</span>
      ${meta.length ? `<span class="qmeta${late ? ' late' : ''}">${esc(meta.join(' · '))}</span>` : ''}
    </button>
    <button class="icon-btn small" data-act="todo-del" data-id="${esc(t.id)}" aria-label="Delete ${esc(t.title)}">${icon('close')}</button>
  </li>`;
}

// The box to add one. `day`: fixed to that day (the calendar's).
const addForm = (day = '') => `<form class="todo-add" data-form="todo-add">
      <label class="sr-only" for="todoIn">New to-do</label>
      <input id="todoIn" type="text" maxlength="200" placeholder="${day ? `Add a to-do for ${esc(dayText(day).toLowerCase() === 'today' ? 'today' : dayText(day))}` : 'Add a to-do'}" autocomplete="off" enterkeyhint="done">
      <label class="sr-only" for="todoDay">Day (optional)</label>
      <input id="todoDay" type="date" value="${esc(day)}" aria-label="Day (optional)" ${day ? 'hidden' : ''}>
      <label class="sr-only" for="todoTime">Time (optional)</label>
      <input id="todoTime" type="time" value="" aria-label="Time (optional, with a day)">
      <button class="btn small primary" type="submit">Add</button>
    </form>`;

export function todoCard(k = S.todayKey()) {
  const { open, done, later } = S.todosFor(k);
  const next = later.slice(0, 3);
  return `<section class="panel todos" id="todoCard">
    <div class="panel-title">${icon('check')}<span>To do</span>${open.length + done.length ? `<span class="qcount">${done.length}/${open.length + done.length}</span>` : ''}</div>
    ${open.length || done.length ? `<ul class="qlist">${[...open, ...done].map((t) => row(t, k)).join('')}</ul>` : '<p class="muted small">Nothing to do. Add anything you want to get done, today or another day.</p>'}
    ${addForm()}
    ${next.length ? `<p class="label">Coming up</p><ul class="qlist later">${next.map((t) => row(t, k)).join('')}</ul>${later.length > next.length ? `<p class="muted small">And ${later.length - next.length} more.</p>` : ''}` : ''}
    <div class="row"><button class="link" data-act="nav" data-v="${VIEW}">${icon('days')} Calendar</button></div>
  </section>`;
}

// ---------- the calendar

const cal = { month: '', day: '' }; // 'YYYY-MM', 'YYYY-MM-DD'
let events = { month: '', byDay: new Map() }; // calendar events from the life log, by day
let eventsGen = 0;

const monthOf = (k) => k.slice(0, 7);
function monthDays(month) {
  const [y, m] = month.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const lead = (first.getDay() + 6) % 7; // Monday first
  const n = new Date(y, m, 0).getDate();
  return { first, lead, n, y, m };
}

// To-dos on a day: not done and due that day, or done that day.
function todosOn(k) {
  return Object.values(S.state.todos)
    .filter((t) => !t.gone && (t.done ? keyOf(new Date(t.done)) === k : t.day === k))
    .sort((a, b) => (a.time || '').localeCompare(b.time || '') || a.created - b.created); // (no time first, like all-day)
}

async function loadEvents(month) {
  if (!hasLifeStore()) return;
  const gen = ++eventsGen;
  const { y, m } = monthDays(month);
  const from = new Date(y, m - 1, 1).getTime();
  const to = new Date(y, m, 1).getTime();
  let list = [];
  try {
    list = await L.eventsBetween(from, to, { kinds: ['event'], limit: 2000 });
  } catch {}
  if (gen !== eventsGen) return;
  const byDay = new Map();
  for (const e of list) {
    const k = keyOf(new Date(e.at));
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(e);
  }
  for (const l of byDay.values()) l.sort((a, b) => a.at - b.at);
  events = { month, byDay };
  repaintCalendar();
}

function gridHTML() {
  const today = S.todayKey();
  const { lead, n, y, m } = monthDays(cal.month);
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push('<span class="cal-cell blank" aria-hidden="true"></span>');
  for (let d = 1; d <= n; d++) {
    const k = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const todos = todosOn(k);
    const left = todos.filter((t) => !t.done).length;
    const evs = events.month === cal.month ? events.byDay.get(k)?.length || 0 : 0;
    const said = [left ? `${left} to do` : '', evs ? `${evs} in your calendar` : ''].filter(Boolean).join(', ');
    cells.push(
      `<button class="cal-cell${k === today ? ' today' : ''}${k === cal.day ? ' on' : ''}" data-act="cal-day" data-d="${k}" aria-pressed="${k === cal.day}" aria-label="${esc(parse(k).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }))}${said ? `: ${said}` : ''}"><span>${d}</span><span class="cal-dots">${left ? '<i class="dot todo"></i>' : ''}${evs ? '<i class="dot ev"></i>' : ''}</span></button>`,
    );
  }
  const names = Array.from({ length: 7 }, (_, i) => new Date(2024, 0, 1 + i).toLocaleDateString(undefined, { weekday: 'narrow' }));
  return `<div class="cal-head">
      <button class="icon-btn" data-act="cal-month" data-n="-1" aria-label="Last month">${icon('back')}</button>
      <b>${esc(new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }))}</b>
      <button class="icon-btn flip" data-act="cal-month" data-n="1" aria-label="Next month">${icon('back')}</button>
    </div>
    <div class="cal-grid" role="group" aria-label="Days">${names.map((x) => `<span class="cal-name" aria-hidden="true">${esc(x)}</span>`).join('')}${cells.join('')}</div>
    ${cal.day !== today ? '<button class="link small" data-act="cal-today">Back to today</button>' : ''}`;
}

function dayHTML() {
  const k = cal.day;
  const today = S.todayKey();
  const todos = todosOn(k);
  const overdue = k === today ? S.todosFor(k).open.filter((t) => !t.day || t.day < k) : [];
  const evs = events.month === monthOf(k) ? events.byDay.get(k) || [] : [];
  return `<section class="panel todos" id="calDay">
    <div class="panel-title">${icon('days')}<span>${esc(dayText(k, today))}</span></div>
    ${todos.length ? `<ul class="qlist">${todos.map((t) => row(t, today, { showDay: false })).join('')}</ul>` : '<p class="muted small">No to-dos on this day.</p>'}
    ${overdue.length ? `<p class="label">Still to do from before, or with no day</p><ul class="qlist later">${overdue.map((t) => row(t, today)).join('')}</ul>` : ''}
    ${addForm(k)}
    ${
      evs.length
        ? `<p class="label">In your calendar</p><ul class="cal-events">${evs.map((e) => `<li><span class="muted">${esc(clock(e.at))}</span> ${esc(e.title)}</li>`).join('')}</ul>`
        : hasLifeStore()
          ? '<p class="muted small">Nothing from your calendar. Connect it on Setup and connections.</p>'
          : ''
    }
  </section>`;
}

export function renderCalendar(root) {
  const today = S.todayKey();
  if (!cal.day) cal.day = today;
  if (!cal.month) cal.month = monthOf(cal.day);
  root.innerHTML = `
    <header class="page-head life-back-head"><button class="icon-btn" data-act="nav" data-v="today" aria-label="Back to Today">${icon('back')}</button><div><p class="kicker">Your to-dos and your calendar</p><h1 class="display">Calendar</h1></div></header>
    <div class="cols">
      <div class="col"><section class="panel cal" id="calMonth">${gridHTML()}</section></div>
      <div class="col">${dayHTML()}</div>
    </div>`;
  if (events.month !== cal.month) void loadEvents(cal.month);
}

function repaintCalendar() {
  const grid = $('#calMonth');
  if (grid) grid.innerHTML = gridHTML();
  const day = $('#calDay');
  if (day) day.outerHTML = dayHTML();
}

// ---------- after a change

function repaint() {
  const el = $('#todoCard');
  if (el) el.outerHTML = todoCard();
  repaintCalendar();
}

function add() {
  const input = $('#todoIn');
  const title = (input?.value || '').trim();
  if (!title) {
    toast('Write what to do first.');
    input?.focus();
    return;
  }
  const day = $('#todoDay')?.value || undefined;
  const time = $('#todoTime')?.value || undefined;
  if (time && !day) {
    toast('Pick a day for the time too.');
    $('#todoDay')?.focus();
    return;
  }
  if (!S.addTodo({ title, day, time })) {
    toast("That couldn't be added.");
    return;
  }
  repaint();
  $('#todoIn')?.focus();
}

// ---------- changing one

// What a time does, here.
function remindText() {
  const plain = S.state.settings.notifyDetails ? '' : " On your lock screen it only says there's something on your list.";
  if (N.isNative) return S.state.settings.notify ? `With a time, Arise reminds you then.${plain}` : 'With a time, Arise reminds you then, once reminders are on (Settings).';
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') return `With a time, Arise reminds you then, while it's open on this device.${plain}`;
  return 'With a time, Arise can remind you while it\'s open: turn on reminders in Settings first.';
}

function editSheet(t) {
  openSheet(`<div class="todo-sheet" data-id="${esc(t.id)}">
    <p class="kicker">To do</p><h2 class="display sheet-title">Change it</h2>
    <form data-form="todo-save">
      <label class="field"><span class="k">What</span><input id="todoEditTitle" type="text" maxlength="200" value="${esc(t.title)}" autocomplete="off"></label>
      <label class="field"><span class="k">Day</span><input id="todoEditDay" type="date" value="${esc(t.day || '')}"></label>
      <label class="field"><span class="k">Time</span><input id="todoEditTime" type="time" value="${esc(t.time || '')}"></label>
      <p class="muted small">${esc(remindText())}${t.from ? ` Added by ${esc(t.from)}.` : ''}</p>
      <div class="row">
        <button class="btn primary small" type="submit">Save</button>
        <button class="btn ghost small danger" type="button" data-act="todo-del" data-id="${esc(t.id)}">Delete</button>
      </div>
    </form>
  </div>`);
}

function save() {
  const box = $('.todo-sheet');
  const id = box?.dataset.id;
  if (!id || !S.state.todos[id]) return;
  const title = ($('#todoEditTitle')?.value || '').trim();
  if (!title) {
    toast('Write what to do first.');
    return;
  }
  const day = $('#todoEditDay')?.value || null;
  const time = $('#todoEditTime')?.value || null;
  if (time && !day) {
    toast('Pick a day for the time too.');
    return;
  }
  S.editTodo(id, { title, day, time: day ? time : null });
  closeSheet();
  repaint();
  toast('Saved.');
}

// True when it was one of these.
export function handleAction(act, el) {
  const id = el?.dataset?.id;
  switch (act) {
    case 'todo-tick': {
      const t = S.state.todos[id];
      if (!t) return true;
      S.setTodoDone(id, !t.done);
      repaint();
      return true;
    }
    case 'todo-edit': {
      const t = S.state.todos[id];
      if (t && !t.gone) editSheet(t);
      return true;
    }
    case 'todo-del': {
      const t = S.state.todos[id];
      if (!t) return true;
      S.removeTodo(id);
      if ($('.todo-sheet')) closeSheet();
      repaint();
      toast(`Deleted "${t.title}".`);
      return true;
    }
    case 'cal-day':
      cal.day = el.dataset.d;
      repaintCalendar();
      return true;
    case 'cal-month': {
      const { y, m } = monthDays(cal.month);
      const d = new Date(y, m - 1 + Number(el.dataset.n || 0), 1);
      cal.month = keyOf(d).slice(0, 7);
      cal.day = monthOf(S.todayKey()) === cal.month ? S.todayKey() : keyOf(d);
      repaintCalendar();
      void loadEvents(cal.month);
      return true;
    }
    case 'cal-today':
      cal.day = S.todayKey();
      if (monthOf(cal.day) !== cal.month) {
        cal.month = monthOf(cal.day);
        void loadEvents(cal.month);
      }
      repaintCalendar();
      return true;
    default:
      return false;
  }
}

// Return in a box adds or saves, without the page reloading.
globalThis.document?.addEventListener('submit', (e) => {
  const form = e.target?.dataset?.form;
  if (form !== 'todo-add' && form !== 'todo-save') return;
  e.preventDefault();
  if (form === 'todo-add') add();
  else save();
});

// For tests: the calendar starts again on today.
export function _reset() {
  cal.month = '';
  cal.day = '';
  events = { month: '', byDay: new Map() };
}

