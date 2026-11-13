// To-dos on Today (lib/todos.ts): what's left to do, with its day if it has one, a box to add one
// (and pick a day), what got done today, and what's coming up. Ticked like quests. To-dos an AI app
// added through the web connector show its name.

import * as S from './store';
import { esc, icon, toast } from './ui.js';

const $ = (sel, root = globalThis.document) => root?.querySelector(sel) ?? null;

const dayText = (k, today) => {
  if (k === today) return 'Today';
  if (k === S.addDays(today, 1)) return 'Tomorrow';
  if (k === S.addDays(today, -1)) return 'Yesterday';
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
};

function row(t, today) {
  const done = !!t.done;
  const late = !done && t.day && t.day < today;
  const meta = [t.day ? `${late ? 'Was due ' : ''}${dayText(t.day, today)}${t.time ? `, ${t.time}` : ''}` : '', t.from ? `From ${t.from}` : ''].filter(Boolean);
  return `<li class="qrow ${done ? 'done' : ''}" data-todo="${esc(t.id)}">
    <button class="qcheck" data-act="todo-tick" data-id="${esc(t.id)}" aria-pressed="${done}" aria-label="${esc(t.title)}: ${done ? 'done' : 'not done yet'}">${icon('check')}</button>
    <div class="qbody">
      <span class="qtitle">${esc(t.title)}</span>
      ${meta.length ? `<span class="qmeta${late ? ' late' : ''}">${esc(meta.join(' · '))}</span>` : ''}
    </div>
    <button class="icon-btn small" data-act="todo-del" data-id="${esc(t.id)}" aria-label="Delete ${esc(t.title)}">${icon('close')}</button>
  </li>`;
}

export function todoCard(k = S.todayKey()) {
  const { open, done, later } = S.todosFor(k);
  const next = later.slice(0, 3);
  return `<section class="panel todos" id="todoCard">
    <div class="panel-title">${icon('check')}<span>To do</span>${open.length + done.length ? `<span class="qcount">${done.length}/${open.length + done.length}</span>` : ''}</div>
    ${open.length || done.length ? `<ul class="qlist">${[...open, ...done].map((t) => row(t, k)).join('')}</ul>` : '<p class="muted small">Nothing to do. Add anything you want to get done, today or another day.</p>'}
    <form class="todo-add" data-form="todo-add">
      <label class="sr-only" for="todoIn">New to-do</label>
      <input id="todoIn" type="text" maxlength="200" placeholder="Add a to-do" autocomplete="off" enterkeyhint="done">
      <label class="sr-only" for="todoDay">Day (optional)</label>
      <input id="todoDay" type="date" value="" aria-label="Day (optional)">
      <button class="btn small primary" type="submit">Add</button>
    </form>
    ${next.length ? `<p class="label">Coming up</p><ul class="qlist later">${next.map((t) => row(t, k)).join('')}</ul>${later.length > next.length ? `<p class="muted small">And ${later.length - next.length} more.</p>` : ''}` : ''}
  </section>`;
}

function repaint() {
  const el = $('#todoCard');
  if (el) el.outerHTML = todoCard();
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
  if (!S.addTodo({ title, day })) {
    toast("That couldn't be added.");
    return;
  }
  repaint();
  $('#todoIn')?.focus();
}

// True when it was one of these.
export function handleAction(act, el) {
  const id = el?.dataset?.id;
  switch (act) {
    case 'todo-add':
      add();
      return true;
    case 'todo-tick': {
      const t = S.state.todos[id];
      if (!t) return true;
      S.setTodoDone(id, !t.done);
      repaint();
      return true;
    }
    case 'todo-del': {
      const t = S.state.todos[id];
      if (!t) return true;
      S.removeTodo(id);
      repaint();
      toast(`Deleted "${t.title}".`);
      return true;
    }
    default:
      return false;
  }
}

// Return in the box adds it, without the page reloading.
globalThis.document?.addEventListener('submit', (e) => {
  if (e.target?.dataset?.form !== 'todo-add') return;
  e.preventDefault();
  add();
});
