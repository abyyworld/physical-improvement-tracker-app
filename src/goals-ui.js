// Goals and quests on screen: the day's quest list on Today, the Goals tab, the goal editor,
// logging a measure, sharing a goal's progress, and each goal's part of the Progress tab.

import * as S from './store';
import * as G from './lib/goals';
import * as AI from './ai.js';
import * as SYNC from './sync';
import * as SHARE from './share';
import * as N from './native.js';
import { shareLink } from './lib/share';
import { SITE_URL } from './lib/pages';
import { esc, icon, openSheet, closeSheet, toast, xpPop, fmt } from './ui.js';
import { drawChart } from './chart.js';

const $ = (sel, root = document) => root.querySelector(sel);
let app = { go: () => {}, render: () => {}, view: () => 'today' };
export function initGoals(hooks) {
  app = { ...app, ...hooks };
}

const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const amountText = (q) => (q.amount ? `${q.amount.target} ${q.amount.unit}`.trim() : '');
const fmtNum = (v) => (v == null ? '-' : Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 }));

// =====================================================================
// Today: the day's quests across every goal
// =====================================================================

export function questsCard(k = S.todayKey()) {
  if (!S.state.goals.length) return firstGoalCard();
  const list = S.questsFor(k);
  if (!list.length) {
    if (S.workoutsOn() && !S.activeQuests().length) return '';
    return `<section class="panel">
      <div class="panel-title">${icon('target')}<span>Today's quests</span></div>
      <p class="muted">${S.activeQuests().length ? 'Nothing else due today. Weekly quests are done for this week.' : 'Your goals have no quests yet. Quests are the small actions that get a goal done.'}</p>
      <button class="btn ghost small" data-act="nav" data-v="goals">${S.activeQuests().length ? 'See your goals' : 'Add quests'}</button>
    </section>`;
  }
  const done = list.filter((x) => x.done).length;
  return `<section class="panel quests ${done === list.length ? 'cleared' : 'glow'}">
    <div class="panel-title">${icon('target')}<span>Today's quests</span><span class="qcount">${done}/${list.length}</span></div>
    ${done === list.length ? '<p class="sys-line">[All quests cleared] Come back tomorrow.</p>' : ''}
    <ul class="qlist">${list.map((x) => questRow(x, k)).join('')}</ul>
  </section>`;
}

function questRow({ goal, quest: q, check, done, week }, k) {
  const streak = S.questStreak(q, k);
  const meta = [
    S.state.goals.length > 1 ? esc(goal.title) : '',
    q.schedule.kind === 'weekly' ? `${week}/${q.schedule.times} this week` : streak > 1 ? `${icon('flame')} ${streak}` : '',
  ].filter(Boolean);
  return `<li class="qrow ${done ? 'done' : ''}">
    <button class="qcheck" data-act="q-tick" data-q="${esc(q.id)}" aria-pressed="${done}" aria-label="${esc(q.title)}: ${done ? 'done' : 'not done yet'}">${icon('check')}</button>
    <div class="qbody">
      <span class="qtitle">${esc(q.title)}${q.amount ? ` <span class="muted">· ${esc(amountText(q))}</span>` : ''}</span>
      ${meta.length ? `<span class="qmeta">${meta.join(' · ')}</span>` : ''}
      ${q.how ? `<span class="qhow">${esc(q.how)}</span>` : ''}
    </div>
    ${
      q.amount
        ? `<label class="qamount"><span class="sr-only">${esc(q.title)}, ${esc(q.amount.unit || 'amount')}</span><input type="number" inputmode="decimal" min="0" step="any" value="${check?.amount != null ? esc(check.amount) : ''}" placeholder="${esc(q.amount.target)}" data-qa="${esc(q.id)}"><span>${esc(q.amount.unit)}</span></label>`
        : ''
    }
  </li>`;
}

function firstGoalCard() {
  return `<section class="panel quest glow">
    <div class="panel-title">${icon('target')}<span>Your first goal</span></div>
    <h2 class="display quest-name">What are you working toward?</h2>
    <p>Fitness, a language, money, your career, your mind, a habit to break… Set a goal and it turns into small daily quests.</p>
    <button class="btn primary xl block" data-act="g-new">Set a goal</button>
  </section>`;
}

function findQuest(qid) {
  for (const g of S.state.goals) for (const q of g.quests) if (q.id === qid) return q;
  return null;
}

function tickQuest(qid) {
  const q = findQuest(qid);
  if (!q) return;
  const k = S.todayKey();
  const c = S.state.checks[k]?.[qid];
  const done = !c?.done;
  const amount = q.amount ? (done ? Math.max(c?.amount ?? 0, q.amount.target) : c?.amount) : undefined;
  S.tick(qid, { done, amount });
  if (done) xpPop(`+${S.CHECK_XP + (q.amount ? 5 : 0)} XP`);
  app.render();
}

function setAmount(qid, raw) {
  const q = findQuest(qid);
  if (!q?.amount) return;
  const v = raw === '' ? 0 : Number(String(raw).replace(',', '.'));
  if (!Number.isFinite(v) || v < 0) return;
  const was = !!S.state.checks[S.todayKey()]?.[qid]?.done;
  const done = v >= q.amount.target;
  S.tick(qid, { done, amount: v });
  if (done && !was) xpPop(`+${S.CHECK_XP + 5} XP`);
  app.render();
}

// =====================================================================
// The Goals tab
// =====================================================================

export function renderGoals(root) {
  const goals = S.state.goals;
  const active = goals.filter((g) => g.status === 'active');
  const rest = goals.filter((g) => g.status !== 'active');
  root.innerHTML = `
    <header class="page-head">
      <div><p class="kicker">What you're working toward</p><h1 class="display">Goals</h1></div>
      <button class="btn small primary" data-act="g-new">+ New goal</button>
    </header>
    ${goals.length ? '' : `<section class="panel"><p>No goals yet. A goal can be anything: get fit, learn a language, save money, land a job, sleep better, quit a habit.</p><button class="btn primary" data-act="g-new">Set your first goal</button></section>`}
    <div class="goal-list">${active.map(goalCard).join('')}</div>
    ${
      rest.length
        ? `<details class="other"><summary>Paused and achieved (${rest.length})</summary><div class="goal-list">${rest.map(goalCard).join('')}</div></details>`
        : ''
    }`;
}

function goalCard(g) {
  const k = S.todayKey();
  const quests = g.quests.filter((q) => !q.archived);
  const status = g.status === 'done' ? '<span class="tag gold">Achieved</span>' : g.status === 'paused' ? '<span class="tag">Paused</span>' : '';
  return `<section class="panel goal ${g.status === 'active' ? '' : 'dim'}">
    <div class="panel-head">
      <div>
        <p class="kicker">${esc(G.CATEGORIES[g.category].label)}${g.by ? ` · by ${esc(g.by)}` : ''} ${status}</p>
        <h2 class="display goal-title">${esc(g.title)}</h2>
        ${g.why ? `<p class="muted small">${esc(g.why)}</p>` : ''}
      </div>
      <button class="btn small ghost" data-act="g-edit" data-g="${esc(g.id)}">Edit</button>
    </div>
    ${
      g.workouts
        ? `<button class="panel banner" data-act="nav" data-v="plan"><span>${icon('bolt')}</span><span><b>Home workout plan</b><small>${esc(S.workoutOrder().map((id) => S.workouts()[id].short || id).join(' / '))} · ${S.perWeek()} a week. Sets, reps, rest timer and how-to videos.</small></span><span class="go">Open →</span></button>`
        : ''
    }
    ${
      quests.length
        ? `<p class="label">Quests</p><ul class="gquests">${quests
            .map((q) => {
              const streak = S.questStreak(q, k);
              return `<li><b>${esc(q.title)}</b><span class="muted small">${esc(G.scheduleText(q.schedule))}${q.amount ? ` · ${esc(amountText(q))}` : ''}${streak > 1 ? ` · ${icon('flame')} ${streak}` : ''}</span></li>`;
            })
            .join('')}</ul>`
        : g.workouts
          ? ''
          : `<p class="muted small">No quests yet. <button class="link small" data-act="g-edit" data-g="${esc(g.id)}">Add some</button></p>`
    }
    ${g.measures.length ? `<p class="label">Measures</p><div class="measures">${g.measures.map((m) => measureTile(g, m)).join('')}</div>` : ''}
    ${
      g.milestones.length
        ? `<p class="label">Milestones</p><ul class="milestones">${g.milestones
            .map(
              (m) => `<li><button class="mstone ${m.done ? 'done' : ''}" data-act="g-mile" data-g="${esc(g.id)}" data-m="${esc(m.id)}" aria-pressed="${!!m.done}">
                <span class="obj-box">${m.done ? icon('check') : ''}</span><span>${esc(m.title)}</span>
                <span class="muted small">${m.done ? `done ${esc(fmt(m.done, { day: 'numeric', month: 'short' }))}` : m.due ? `by ${esc(fmt(m.due, { day: 'numeric', month: 'short', year: 'numeric' }))}` : ''}</span>
              </button></li>`,
            )
            .join('')}</ul>`
        : ''
    }
    <button class="link small share-link" data-act="g-share" data-g="${esc(g.id)}">${icon('share')} ${g.share ? 'Shared with a link' : 'Share progress'}</button>
  </section>`;
}

function measureTile(g, m) {
  const series = S.measureSeries(m.id);
  const last = series[series.length - 1];
  let pct = null;
  if (last && m.target != null) {
    const start = m.start ?? series[0].v;
    const span = m.target - start;
    pct = span ? Math.max(0, Math.min(100, Math.round(((last.v - start) / span) * 100))) : last.v === m.target ? 100 : 0;
  }
  return `<button class="measure" data-act="g-log" data-g="${esc(g.id)}" data-m="${esc(m.id)}">
    <span class="k">${esc(m.name)}</span>
    <b>${fmtNum(last?.v)}<small> ${esc(m.unit)}</small></b>
    ${m.target != null ? `<span class="s">target ${fmtNum(m.target)} ${esc(m.unit)}</span>` : `<span class="s">${last ? esc(fmt(last.date, { day: 'numeric', month: 'short' })) : 'tap to log'}</span>`}
    ${pct != null ? `<span class="mbar" role="img" aria-label="${pct}% of the way"><i style="width:${pct}%"></i></span>` : ''}
  </button>`;
}

// =====================================================================
// The goal editor (a pop-up sheet)
// =====================================================================

let draft = null; // { g, isNew, ai: { busy, error, idea } }

// The goal editor is open (an update waits, so the edits and any quest ideas being written aren't lost).
export const editing = () => !!draft && !document.getElementById('sheet')?.hidden;

export function openGoalEditor(id) {
  const existing = id ? S.goalById(id) : null;
  const g = existing
    ? structuredClone(existing)
    : { id: S.uid(), title: '', category: 'other', why: '', by: '', status: 'active', quests: [], measures: [], milestones: [] };
  draft = { g, isNew: !existing, ai: { busy: false, error: '', idea: null } };
  openSheet(editorHTML());
}

function refreshEditor() {
  const panel = $('#sheet .sheet-panel');
  const top = panel?.scrollTop || 0;
  const body = $('#sheet .sheet-body');
  if (!body || !draft) return;
  body.innerHTML = editorHTML();
  if (panel) panel.scrollTop = top;
}

const SCHEDULES = [
  ['daily', 'Every day'],
  ['weekdays', 'Weekdays'],
  ['weekends', 'Weekends'],
  ['days', 'Some days'],
  ['weekly', 'A few times a week'],
];
const scheduleKey = (s) => (s.kind === 'weekly' ? 'weekly' : s.kind === 'daily' ? 'daily' : s.days.join() === '0,1,2,3,4' ? 'weekdays' : s.days.join() === '5,6' ? 'weekends' : 'days');

function questEditor(q, i) {
  const key = scheduleKey(q.schedule);
  return `<div class="qedit">
    <div class="qedit-row">
      <label class="field grow"><span class="k">Quest</span><input type="text" maxlength="80" value="${esc(q.title)}" data-gq="${i}" data-f="title" placeholder="e.g. Study Spanish"></label>
      <button class="icon-btn" data-act="g-q-del" data-i="${i}" aria-label="Remove ${esc(q.title || 'this quest')}">${icon('close')}</button>
    </div>
    <div class="qedit-row">
      <label class="field grow"><span class="k">When</span><select data-gq="${i}" data-f="schedule">${SCHEDULES.map(([v, l]) => `<option value="${v}" ${key === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      ${
        q.schedule.kind === 'weekly'
          ? `<label class="field"><span class="k">Times a week</span><input type="number" inputmode="numeric" min="1" max="7" value="${q.schedule.times}" data-gq="${i}" data-f="times"></label>`
          : ''
      }
    </div>
    ${
      key === 'days'
        ? `<div class="chips days" role="group" aria-label="Days">${DAY_SHORT.map((d, n) => `<button class="chip ${q.schedule.days.includes(n) ? 'on' : ''}" data-act="g-q-day" data-i="${i}" data-d="${n}" aria-pressed="${q.schedule.days.includes(n)}">${d}</button>`).join('')}</div>`
        : ''
    }
    <div class="qedit-row">
      <label class="field"><span class="k">Amount (optional)</span><input type="number" inputmode="decimal" min="0" step="any" value="${q.amount ? esc(q.amount.target) : ''}" data-gq="${i}" data-f="target" placeholder="e.g. 30"></label>
      <label class="field grow"><span class="k">Unit</span><input type="text" maxlength="16" value="${q.amount ? esc(q.amount.unit) : ''}" data-gq="${i}" data-f="unit" placeholder="min, pages, km…"></label>
    </div>
    <label class="field"><span class="k">How or when (optional)</span><input type="text" maxlength="300" value="${esc(q.how || '')}" data-gq="${i}" data-f="how" placeholder="e.g. Right after breakfast, in the app"></label>
  </div>`;
}

function measureEditor(m, i) {
  return `<div class="qedit">
    <div class="qedit-row">
      <label class="field grow"><span class="k">Measure</span><input type="text" maxlength="40" value="${esc(m.name)}" data-gm="${i}" data-f="name" placeholder="e.g. Savings"></label>
      <label class="field"><span class="k">Unit</span><input type="text" maxlength="12" value="${esc(m.unit)}" data-gm="${i}" data-f="unit" placeholder="$, kg, %"></label>
      <button class="icon-btn" data-act="g-m-del" data-i="${i}" aria-label="Remove ${esc(m.name || 'this measure')}">${icon('close')}</button>
    </div>
    <div class="qedit-row">
      <label class="field"><span class="k">Start</span><input type="number" inputmode="decimal" step="any" value="${m.start ?? ''}" data-gm="${i}" data-f="start"></label>
      <label class="field"><span class="k">Target</span><input type="number" inputmode="decimal" step="any" value="${m.target ?? ''}" data-gm="${i}" data-f="target"></label>
      <label class="field"><span class="k">Better</span><select data-gm="${i}" data-f="better"><option value="up" ${m.better !== 'down' ? 'selected' : ''}>Higher</option><option value="down" ${m.better === 'down' ? 'selected' : ''}>Lower</option></select></label>
    </div>
  </div>`;
}

function milestoneEditor(m, i) {
  return `<div class="qedit-row">
    <label class="field grow"><span class="k">Milestone</span><input type="text" maxlength="120" value="${esc(m.title)}" data-gs="${i}" data-f="title" placeholder="e.g. Pass the A2 exam"></label>
    <label class="field"><span class="k">By</span><input type="date" value="${esc(m.due || '')}" data-gs="${i}" data-f="due"></label>
    <button class="icon-btn" data-act="g-s-del" data-i="${i}" aria-label="Remove ${esc(m.title || 'this milestone')}">${icon('close')}</button>
  </div>`;
}

function editorHTML() {
  const { g, isNew, ai } = draft;
  const t = G.TEMPLATES[g.category];
  const titles = new Set(g.quests.map((q) => q.title.toLowerCase()));
  const ideas = t.quests.filter((q) => !titles.has(q.title.toLowerCase()));
  const measureIdeas = (t.measures || []).filter((m) => !g.measures.some((x) => x.name.toLowerCase() === m.name.toLowerCase()));
  const aiIdea = ai.idea;
  return `<p class="kicker">${isNew ? 'New goal' : 'Edit goal'}</p>
    <h2 class="display sheet-title">${isNew ? 'Set a goal' : esc(g.title)}</h2>
    <label class="field"><span class="k">Goal</span><textarea class="log-text" rows="2" maxlength="120" data-gf="title" placeholder="e.g. ${esc(t.examples[0])}">${esc(g.title)}</textarea></label>
    <p class="label">Area</p>
    <div class="chips" role="group" aria-label="Area">${Object.entries(G.CATEGORIES)
      .map(([id, c]) => `<button class="chip ${g.category === id ? 'on' : ''}" data-act="g-cat" data-v="${id}" aria-pressed="${g.category === id}">${esc(c.label)}</button>`)
      .join('')}</div>
    ${isNew && !g.title ? `<p class="muted small">Ideas: ${t.examples.map((x) => `<button class="link small" data-act="g-example" data-v="${esc(x)}">${esc(x)}</button>`).join(' · ')}</p>` : ''}
    <label class="field"><span class="k">Why it matters (optional)</span><textarea class="log-text" rows="2" maxlength="600" data-gf="why" placeholder="On the hard days, the System reminds you of this.">${esc(g.why)}</textarea></label>
    <label class="field"><span class="k">By when (optional)</span><input type="text" maxlength="40" value="${esc(g.by)}" data-gf="by" placeholder="e.g. June 2027, 6 months"></label>
    ${
      g.category === 'fitness'
        ? `<button class="toggle-row" data-act="g-workouts" aria-pressed="${!!g.workouts}"><span><b>Use Arise's home workout plan</b><small>Three sessions in turn (A, B, C) with sets, reps, a rest timer and how-to videos. Bands, a backpack and ideally a pull-up bar.</small></span><span class="switch ${g.workouts ? 'on' : ''}"></span></button>`
        : ''
    }

    <h3 class="sub">Quests</h3>
    <p class="muted small">The small actions you'll tick off. Pick ones you can do even on a bad day.</p>
    ${g.quests.map((q, i) => (q.archived ? '' : questEditor(q, i))).join('')}
    <div class="row">
      <button class="btn ghost small" data-act="g-q-add">+ Add a quest</button>
      ${AI.ready() ? `<button class="btn ghost small" data-act="g-ai" ${ai.busy || !g.title.trim() ? 'disabled' : ''}>${icon('system')} ${ai.busy ? 'Thinking…' : 'Suggest quests'}</button>` : ''}
    </div>
    ${ai.error ? `<p class="error small">${esc(ai.error)}</p>` : ''}
    ${
      aiIdea
        ? `<div class="alert"><div><b>The System suggests</b>${aiIdea.summary ? ` <span class="small">${esc(aiIdea.summary)}</span>` : ''}<div class="chips">${aiIdea.quests
            .map((q, n) => `<button class="chip" data-act="g-ai-add" data-k="quests" data-n="${n}">+ ${esc(q.title)} <small>${esc(G.scheduleText(q.schedule))}${q.amount ? `, ${esc(amountText(q))}` : ''}</small></button>`)
            .join('')}${aiIdea.measures.map((m, n) => `<button class="chip" data-act="g-ai-add" data-k="measures" data-n="${n}">+ Measure: ${esc(m.name)}</button>`).join('')}${aiIdea.milestones
            .map((m, n) => `<button class="chip" data-act="g-ai-add" data-k="milestones" data-n="${n}">+ Milestone: ${esc(m.title)}</button>`)
            .join('')}</div></div></div>`
        : ideas.length
          ? `<p class="label">Ideas</p><div class="chips">${ideas.map((q) => `<button class="chip" data-act="g-q-idea" data-v="${esc(q.title)}">+ ${esc(q.title)} <small>${esc(G.scheduleText(q.schedule))}${q.amount ? `, ${esc(amountText(q))}` : ''}</small></button>`).join('')}</div>`
          : ''
    }

    <h3 class="sub">Measures <span class="muted small">(optional)</span></h3>
    <p class="muted small">Numbers that show you're getting there, like savings or a test score.</p>
    ${g.measures.map(measureEditor).join('')}
    <div class="row">
      <button class="btn ghost small" data-act="g-m-add">+ Add a measure</button>
      ${measureIdeas.map((m) => `<button class="chip" data-act="g-m-idea" data-v="${esc(m.name)}">+ ${esc(m.name)}</button>`).join('')}
    </div>

    <h3 class="sub">Milestones <span class="muted small">(optional)</span></h3>
    ${g.milestones.map(milestoneEditor).join('')}
    <button class="btn ghost small" data-act="g-s-add">+ Add a milestone</button>

    <div class="stack sheet-actions">
      <button class="btn primary block" data-act="g-save">${isNew ? 'Save goal' : 'Save changes'}</button>
      ${
        isNew
          ? ''
          : `<div class="row">
        ${g.status === 'active' ? '<button class="btn ghost small" data-act="g-status" data-v="paused">Pause</button>' : '<button class="btn ghost small" data-act="g-status" data-v="active">Make active again</button>'}
        ${g.status !== 'done' ? '<button class="btn ghost small" data-act="g-status" data-v="done">I achieved it</button>' : ''}
        <button class="btn ghost small danger" data-act="g-delete">Delete goal</button>
      </div>`
      }
    </div>`;
}

const blankQuest = (title = '') => ({ id: S.uid(), title, schedule: { kind: 'daily' }, created: S.todayKey() });

function fromTemplate(title) {
  const t = G.TEMPLATES[draft.g.category].quests.find((q) => q.title === title);
  return t ? { ...structuredClone(t), id: S.uid(), created: S.todayKey() } : blankQuest(title);
}

function onDraftInput(t) {
  if (!draft) return false;
  const g = draft.g;
  if (t.dataset.gf) {
    g[t.dataset.gf] = t.value;
    // "Suggest quests" needs a goal to work from.
    const ask = t.dataset.gf === 'title' && $('[data-act="g-ai"]');
    if (ask) ask.disabled = !!draft.ai?.busy || !t.value.trim();
    return true;
  }
  const f = t.dataset.f;
  if (t.dataset.gq != null) {
    const q = g.quests[Number(t.dataset.gq)];
    if (!q) return true;
    if (f === 'title' || f === 'how') q[f] = t.value;
    else if (f === 'times') q.schedule = { kind: 'weekly', times: Math.min(7, Math.max(1, Math.round(Number(t.value)) || 1)) };
    else if (f === 'target' || f === 'unit') {
      // The unit stays while the number is being retyped (an empty box for a moment).
      const target = f === 'target' ? Number(t.value) : q.amount?.target;
      const unit = f === 'unit' ? t.value : q.amount?.unit || '';
      q.amount = target > 0 || unit ? { target: target > 0 ? target : 0, unit } : undefined;
    } else if (f === 'schedule') {
      q.schedule =
        t.value === 'weekdays'
          ? { kind: 'days', days: [0, 1, 2, 3, 4] }
          : t.value === 'weekends'
            ? { kind: 'days', days: [5, 6] }
            : t.value === 'days'
              ? { kind: 'days', days: q.schedule.kind === 'days' ? q.schedule.days : [0, 2, 4] }
              : t.value === 'weekly'
                ? { kind: 'weekly', times: 3 }
                : { kind: 'daily' };
      refreshEditor();
    }
    return true;
  }
  if (t.dataset.gm != null) {
    const m = g.measures[Number(t.dataset.gm)];
    if (!m) return true;
    if (f === 'start' || f === 'target') m[f] = t.value === '' ? undefined : Number(t.value);
    else m[f] = t.value;
    return true;
  }
  if (t.dataset.gs != null) {
    const m = g.milestones[Number(t.dataset.gs)];
    if (m) m[f] = f === 'title' ? t.value : t.value || undefined;
    return true;
  }
  return false;
}

async function suggest() {
  const g = draft.g;
  if (!g.title.trim()) {
    toast('Write the goal first.');
    return;
  }
  draft.ai = { busy: true, error: '', idea: null };
  refreshEditor();
  const mine = draft;
  try {
    const idea = await AI.proposeQuests(g);
    if (draft === mine) draft.ai = { busy: false, error: '', idea };
  } catch (err) {
    if (draft === mine) draft.ai = { busy: false, error: err.message, idea: null };
  }
  if (draft === mine) refreshEditor();
}

function saveDraft() {
  const g = draft.g;
  if (!g.title.trim()) {
    toast('Write the goal first, even one line.');
    $('[data-gf="title"]')?.focus();
    return;
  }
  // Empty rows are dropped; amounts of 0 mean "just done".
  g.quests = g.quests.filter((q) => q.title.trim()).map((q) => (q.amount && !(q.amount.target > 0) ? { ...q, amount: undefined } : q));
  g.measures = g.measures.filter((m) => m.name.trim());
  g.milestones = g.milestones.filter((m) => (m.title || '').trim());
  // The link is the goal's as it is now: made or turned off while the editor was open, maybe on
  // another device. The editor never changes it.
  g.share = S.goalById(g.id)?.share;
  const isNew = draft.isNew;
  const saved = S.saveGoal(g);
  draft = null;
  closeSheet();
  if (!saved) return toast("That goal couldn't be saved.");
  if (!S.state.profile?.onboarded) S.saveProfile({ goal: saved.title, why: saved.why });
  toast(isNew ? `Goal set. ${saved.quests.length ? 'Your quests are on Today.' : 'Add quests any time.'}` : 'Saved.');
  app.render();
}

// =====================================================================
// Logging a measure
// =====================================================================

function openLog(goalId, mid) {
  const g = S.goalById(goalId);
  const m = g?.measures.find((x) => x.id === mid);
  if (!m) return;
  const series = S.measureSeries(mid);
  const today = S.state.values[mid]?.[S.todayKey()];
  openSheet(`<p class="kicker">${esc(g.title)}</p>
    <h2 class="display sheet-title">${esc(m.name)}</h2>
    ${m.target != null ? `<p class="muted">Target: ${fmtNum(m.target)} ${esc(m.unit)}${m.start != null ? ` · started at ${fmtNum(m.start)}` : ''}</p>` : ''}
    <label class="field"><span class="k">Today${m.unit ? ` (${esc(m.unit)})` : ''}</span><input id="mvIn" type="number" inputmode="decimal" step="any" value="${today ? esc(today.v) : ''}"></label>
    <button class="btn primary block" data-act="g-log-save" data-g="${esc(goalId)}" data-m="${esc(mid)}">Save</button>
    <div id="mvChart"></div>
    ${series.length ? `<ul class="sum-list">${series.slice(-8).reverse().map((x) => `<li><span>${esc(fmt(x.date, { weekday: 'short', day: 'numeric', month: 'short' }))}</span><span class="mono">${fmtNum(x.v)} ${esc(m.unit)}</span></li>`).join('')}</ul>` : ''}`);
  drawMeasure($('#mvChart'), m, series);
  $('#mvIn')?.focus({ preventScroll: true });
}

function drawMeasure(host, m, series) {
  if (!host || series.length < 2) return;
  drawChart(
    host,
    series.map((x) => ({ t: S.parseKey(x.date).getTime(), y: x.v })),
    m.unit,
    { fit: true, caption: `${m.name}${m.unit ? ` (${m.unit})` : ''}` },
  );
}

// =====================================================================
// Sharing a goal's progress with a friend (share.ts does the work)
// =====================================================================

let sharing = null; // { id: the goal, name: "Show my name" before there's a link, busy, error }

// Where a friend opens the link: this page's own address on the web. In the iPhone app, whose
// pages are only on the phone, the website it was built from (or Arise's).
const linkTo = (ref) => shareLink(N.isNative ? __APP_UPDATE_SITE__ || SITE_URL : `${location.origin}${location.pathname}`, ref);
const canSend = () => N.canShareLink() || typeof navigator.share === 'function';

const WHAT_THEY_SEE = [
  "This goal's name and area",
  'Your streak, and the streak of each of its quests',
  'Its last 28 days: done, missed or a day off',
  'The latest number of each measure, with its target',
  'The milestones you reached',
  'When it was last updated',
];
const WHO_CAN =
  "It's end-to-end encrypted. The key is in the link itself, so anyone who has the link can see the page, and nobody else can: not the people who run Arise, not Google, who host it. With the link, they can also see a random ID for your account (not your email or account code) and when the page was updated. So anyone with two of your links can tell they're both yours.";

function openShare(goalId) {
  sharing = { id: goalId, name: false, busy: false, error: '' };
  openSheet(shareHTML());
}

// Only while the share sheet is the one showing.
function refreshShare() {
  const body = $('#sheet .sheet-body');
  if (!sharing || !body?.querySelector('.share-sheet')) return;
  body.innerHTML = shareHTML();
}

function shareHTML() {
  const g = S.goalById(sharing.id);
  if (!g) return '<div class="share-sheet"><p>This goal was deleted.</p></div>';
  const name = SHARE.firstName();
  const nameRow = (on) =>
    `<button class="toggle-row" data-act="share-name" aria-pressed="${on}" ${name && !sharing.busy ? '' : 'disabled'}><span><b>Show my name</b><small>${name ? `Your first name, ${esc(name)}, at the top of the page.` : 'Add your name in Settings, Player, first.'}</small></span><span class="switch ${on ? 'on' : ''}"></span></button>`;
  const user = SYNC.status.user;
  const error = sharing.error ? `<p class="error small">${esc(sharing.error)}</p>` : '';
  const head = `<div class="share-sheet"><p class="kicker">${esc(g.title)}</p><h2 class="display sheet-title">Share progress</h2>`;
  if (!SYNC.configured) return `${head}<p>Sharing needs the cloud, and this copy of Arise has none set up.</p></div>`;
  if (!g.share) {
    return `${head}
      <p>Make a link to a page that shows how this goal is going, and send it to a friend. The page keeps itself up to date as you tick things off.</p>
      <p class="label">What they see</p>
      <ul class="changes">${WHAT_THEY_SEE.map((x) => `<li>${x}</li>`).join('')}</ul>
      <p>Never your journal, your chats with the coach, your other goals, your weigh-ins, your email or your account code.</p>
      ${nameRow(sharing.name)}
      <p class="muted small">${WHO_CAN} You can turn it off any time.</p>
      ${
        user
          ? `<button class="btn primary block" data-act="share-make" ${sharing.busy ? 'disabled' : ''}>${sharing.busy ? 'Making the link…' : 'Make a link'}</button>`
          : SYNC.status.loading
            ? '<p>Your account is still loading. Try again in a moment.</p>'
            : `<p><b>Sharing needs an account</b>, since the page is kept in the cloud. Make one, or sign in, under Settings, Account.</p>
      <button class="btn primary block" data-act="nav" data-v="settings">Go to Account</button>`
      }
      ${error}</div>`;
  }
  const note = SHARE.note(g.share.id);
  const when = note.at ? new Date(note.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';
  // What went wrong last, once: what the Player just did, or else the page's last update.
  const status = error || (note.error ? `<p class="error small">The page couldn't be updated: ${esc(note.error)}</p>` : when ? `<p class="muted small">Page updated at ${esc(when)}.</p>` : '');
  const retry = user && note.error ? `<button class="btn ghost small" data-act="share-retry" ${sharing.busy ? 'disabled' : ''}>Try again</button>` : '';
  return `${head}
    <p>Anyone with this link can see how this goal is going. The page updates itself after your changes${user ? '' : ', whenever you are signed in'}.</p>
    <label class="field"><span class="k">Link</span><input id="shareLinkIn" type="text" readonly value="${esc(linkTo(g.share))}"></label>
    <div class="row">
      <button class="btn primary small" data-act="share-copy">Copy link</button>
      ${canSend() ? '<button class="btn ghost small" data-act="share-send">Share…</button>' : ''}
    </div>
    ${user ? nameRow(!!g.share.name) : ''}
    ${status}${retry}
    <p class="muted small">${WHO_CAN}</p>
    <p class="label">Turn it off</p>
    ${
      user
        ? `<p class="small"><b>New link</b> gives you a new link to the same page, and the old one stops working for good. <b>Stop sharing</b> deletes the page, so the link stops working for good.</p>
    <div class="row">
      <button class="btn ghost small" data-act="share-new" ${sharing.busy ? 'disabled' : ''}>New link</button>
      <button class="btn ghost small danger" data-act="share-stop" ${sharing.busy ? 'disabled' : ''}>Stop sharing</button>
    </div>`
        : '<p class="small">Sign in, under Settings, Account, to stop sharing or make a new link.</p>'
    }
    </div>`;
}

// `failed`: said before what went wrong, if it did.
async function shareDo(fn, done, failed = '') {
  if (!sharing || sharing.busy) return;
  const mine = sharing;
  mine.busy = true;
  mine.error = '';
  refreshShare();
  try {
    await fn();
    if (done) toast(done);
  } catch (err) {
    mine.error = `${failed ? `${failed} ` : ''}${SHARE.problem(err)}`;
  }
  mine.busy = false;
  if (sharing === mine) refreshShare();
  app.render();
}

async function copyLink() {
  const input = $('#shareLinkIn');
  if (!input) return;
  try {
    await navigator.clipboard.writeText(input.value);
    toast('Link copied.');
  } catch {
    input.focus();
    input.select();
    toast('Copy the link from the box.');
  }
}

async function sendLink(g) {
  const url = linkTo(g.share);
  const text = `My progress on ${g.title}`;
  try {
    if (N.canShareLink()) await N.shareLink({ title: 'Arise', text, url });
    else await navigator.share({ title: 'Arise', text, url });
  } catch (err) {
    if (err?.name !== 'AbortError') copyLink();
  }
}

// A shared goal's link is turned off first, so its page doesn't outlive it.
async function deleteGoal(id) {
  const g = S.goalById(id);
  if (g?.share) {
    if (SYNC.status.user) {
      try {
        await SHARE.stop(id);
      } catch (err) {
        toast(`${SHARE.problem(err)} The goal is still here, since its link couldn't be turned off.`);
        return;
      }
    } else if (!confirm("This goal's progress is shared with a link. Turning that off needs you signed in. Delete the goal anyway? The link would keep showing the goal as it is now.")) return;
  }
  S.deleteGoal(id);
  draft = null;
  closeSheet();
  toast('Goal deleted.');
  app.render();
}

// =====================================================================
// Progress: each goal's quests and measures
// =====================================================================

export function goalsProgress() {
  const goals = S.state.goals.filter((g) => g.status !== 'paused' && (g.quests.length || g.measures.length));
  if (!goals.length) return '';
  const k = S.todayKey();
  const from = S.addDays(k, -27);
  return goals
    .map((g) => {
      const rows = g.quests
        .filter((q) => !q.archived)
        .map((q) => {
          let text;
          if (q.schedule.kind === 'weekly') {
            const weeks = [3, 2, 1, 0].map((i) => S.weekCount(q.id, S.addDays(k, -7 * i)));
            text = `${weeks.join(' · ')} a week <span class="muted">(target ${q.schedule.times})</span>`;
          } else {
            let due = 0;
            let done = 0;
            for (let d = from < q.created ? q.created : from; d <= k; d = S.addDays(d, 1)) {
              if (!G.dueOn(q, d)) continue;
              const ok = G.isDone(S.state.checks, d, q.id);
              if (d === k && !ok) continue;
              due++;
              if (ok) done++;
            }
            text = due ? `${Math.round((done / due) * 100)}% <span class="muted">(${done} of ${due}, last 4 weeks)</span>` : '<span class="muted">new</span>';
          }
          const streak = S.questStreak(q, k);
          return `<li><span>${esc(q.title)}</span><span class="mono">${text}${streak > 1 ? ` · ${icon('flame')} ${streak}` : ''}</span></li>`;
        })
        .join('');
      return `<section class="panel">
        <div class="panel-title">${icon('target')}<span>${esc(g.title)}</span></div>
        ${rows ? `<ul class="sum-list">${rows}</ul>` : ''}
        ${g.measures.map((m) => `<div class="gchart" data-g="${esc(g.id)}" data-m="${esc(m.id)}"></div>`).join('')}
      </section>`;
    })
    .join('');
}

export function drawGoalCharts() {
  for (const host of document.querySelectorAll('.gchart')) {
    const g = S.goalById(host.dataset.g);
    const m = g?.measures.find((x) => x.id === host.dataset.m);
    if (!m) continue;
    const series = S.measureSeries(m.id);
    if (series.length < 2) {
      host.innerHTML = `<p class="muted small">${esc(m.name)}: ${series.length ? `${fmtNum(series[0].v)} ${esc(m.unit)} so far. ` : ''}Log it a couple of times to see a chart. <button class="link small" data-act="g-log" data-g="${esc(g.id)}" data-m="${esc(m.id)}">Log now</button></p>`;
    } else drawMeasure(host, m, series);
  }
}

// =====================================================================
// Events
// =====================================================================

export function handleAction(act, el) {
  const d = el.dataset;
  switch (act) {
    case 'q-tick':
      tickQuest(d.q);
      return true;
    case 'g-new':
      openGoalEditor(null);
      return true;
    case 'g-edit':
      openGoalEditor(d.g);
      return true;
    case 'g-mile': {
      const m = S.goalById(d.g)?.milestones.find((x) => x.id === d.m);
      S.toggleMilestone(d.g, d.m);
      if (m && !m.done) xpPop(`+${S.MILESTONE_XP} XP`);
      app.render();
      return true;
    }
    case 'g-log':
      openLog(d.g, d.m);
      return true;
    case 'g-log-save': {
      const v = Number(String($('#mvIn')?.value ?? '').replace(',', '.'));
      if ($('#mvIn')?.value === '' || !Number.isFinite(v)) {
        toast('Type a number first.');
        return true;
      }
      const first = !S.state.values[d.m]?.[S.todayKey()];
      S.logValue(d.m, v);
      if (first) xpPop(`+${S.VALUE_XP} XP`);
      closeSheet();
      toast('Saved.');
      app.render();
      return true;
    }
    case 'g-share':
      draft = null;
      openShare(d.g);
      return true;
  }
  if (sharing && act.startsWith('share-')) {
    const g = S.goalById(sharing.id);
    if (!g) return true;
    switch (act) {
      case 'share-name': {
        if (!g.share) {
          sharing.name = !sharing.name;
          refreshShare();
          return true;
        }
        // Said done only once the page is: until then, the page still shows what it did.
        const on = !g.share.name;
        shareDo(
          async () => {
            if (await SHARE.showName(g.id, on)) toast(on ? 'Your first name shows on the page now.' : 'Your name is off the page now.');
          },
          '',
          on ? "Your name isn't on the page yet." : 'The page still shows your name.',
        );
        return true;
      }
      case 'share-retry':
        shareDo(async () => {
          if (await SHARE.updatePage(g.id)) toast('Page updated.');
        });
        return true;
      case 'share-make':
        shareDo(() => SHARE.start(g.id, { name: sharing.name }), 'Link made. Send it to a friend.');
        return true;
      case 'share-copy':
        copyLink();
        return true;
      case 'share-send':
        if (g.share) sendLink(g);
        return true;
      case 'share-new':
        if (confirm('Make a new link? The old one stops working, so anyone who has it no longer sees your progress.')) shareDo(() => SHARE.newLink(g.id), 'New link made. The old one no longer works.');
        return true;
      case 'share-stop':
        if (confirm('Stop sharing this goal? Its page is deleted, so the link stops working for good.')) shareDo(() => SHARE.stop(g.id), 'Sharing stopped. The link no longer works.');
        return true;
    }
  }
  if (!draft || !act.startsWith('g-')) return false;
  const g = draft.g;
  switch (act) {
    case 'g-cat':
      g.category = d.v;
      if (g.category !== 'fitness') delete g.workouts;
      break;
    case 'g-example':
      g.title = d.v;
      break;
    case 'g-workouts':
      if (g.workouts) delete g.workouts;
      else g.workouts = true;
      break;
    case 'g-q-add':
      g.quests.push(blankQuest());
      refreshEditor();
      $(`[data-gq="${g.quests.length - 1}"][data-f="title"]`)?.focus();
      return true;
    case 'g-q-idea':
      g.quests.push(fromTemplate(d.v));
      break;
    case 'g-q-del':
      g.quests.splice(Number(d.i), 1);
      break;
    case 'g-q-day': {
      const q = g.quests[Number(d.i)];
      if (q?.schedule.kind !== 'days') break;
      const n = Number(d.d);
      const days = q.schedule.days.includes(n) ? q.schedule.days.filter((x) => x !== n) : [...q.schedule.days, n].sort();
      if (days.length) q.schedule = { kind: 'days', days };
      break;
    }
    case 'g-m-add':
      g.measures.push({ id: S.uid(), name: '', unit: '', better: 'up' });
      break;
    case 'g-m-idea': {
      const t = (G.TEMPLATES[g.category].measures || []).find((m) => m.name === d.v);
      if (t) g.measures.push({ ...t, id: S.uid() });
      break;
    }
    case 'g-m-del':
      g.measures.splice(Number(d.i), 1);
      break;
    case 'g-s-add':
      g.milestones.push({ id: S.uid(), title: '' });
      break;
    case 'g-s-del':
      g.milestones.splice(Number(d.i), 1);
      break;
    case 'g-ai':
      suggest();
      return true;
    case 'g-ai-add': {
      const item = draft.ai.idea?.[d.k]?.[Number(d.n)];
      if (!item) break;
      g[d.k].push({ ...item, id: S.uid(), ...(d.k === 'quests' ? { created: S.todayKey() } : {}) });
      draft.ai.idea[d.k].splice(Number(d.n), 1);
      break;
    }
    case 'g-save':
      saveDraft();
      return true;
    case 'g-status': {
      const id = g.id;
      draft = null;
      S.setGoalStatus(id, d.v);
      closeSheet();
      if (d.v === 'done') {
        xpPop(`+${S.GOAL_XP} XP`);
        toast('Goal achieved. Level up.');
      } else toast(d.v === 'paused' ? 'Paused. Its quests are off your list until you make it active again.' : 'Active again.');
      app.render();
      return true;
    }
    case 'g-delete':
      if (!confirm(`Delete "${g.title}"? Its quests and measures go too. Ticks you already earned XP for stay in your history.`)) return true;
      deleteGoal(g.id);
      return true;
    default:
      return false;
  }
  refreshEditor();
  return true;
}

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.closest?.('#sheet') && onDraftInput(t)) return;
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset?.qa) setAmount(t.dataset.qa, t.value);
  else if (t.closest?.('#sheet') && t.tagName === 'SELECT') onDraftInput(t);
});

// Closing the sheet another way (Escape, the X, the backdrop) drops an unsaved draft, and the
// share sheet's state.
document.addEventListener('click', (e) => {
  if (e.target.closest?.('[data-act="sheet-close"]')) draft = sharing = null;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') draft = sharing = null;
});
