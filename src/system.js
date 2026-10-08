// Screens and panels for the AI coach ("the System"): the goal-setting intro, the daily System
// message, journal reflections, the coach chat, plan personalisation and the AI settings.

import { EXERCISES } from './program.js';
import * as S from './store';
import * as AI from './ai.js';
import * as Device from './lib/on-device';
import * as G from './lib/goals';
import * as GOALS from './goals-ui.js';
import { esc, icon, md, toast, setBackgroundInert } from './ui.js';
import { isNative } from './native.js';
import { configured as syncConfigured } from './sync';

let app = { go: () => {}, render: () => {}, view: () => 'today' };
export function initSystem(hooks) {
  app = { ...app, ...hooks };
}

const $ = (sel, root = document) => root.querySelector(sel);
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
// Links to get a key from each service with a sign-up page.
const keyLinks = () =>
  Object.values(AI.PROVIDERS)
    .filter((x) => x.keyUrl)
    .map((x) => `<a href="${x.keyUrl}" target="_blank" rel="noopener">${esc(x.name)}</a>`)
    .join(' · ');

function targetLabel(slot) {
  let r = slot.amrap ? 'max reps' : slot.min === slot.max ? `${slot.min}` : `${slot.min}-${slot.max}`;
  if (slot.unit && slot.unit !== 'reps') r += ` ${slot.unit}`;
  if (slot.perLeg) r += ' / leg';
  return `${slot.sets} × ${r}`;
}

const connectHint = (what) =>
  `<p class="muted small">${esc(what)} <button class="link" data-act="nav" data-v="settings">Turn on the AI coach in Settings →</button></p>`;

// =====================================================================
// Intro: the long-term goal and background ("Awakening")
// =====================================================================

const DEADLINES = ['3 months', '6 months', '1 year', '2 years', 'No deadline'];
const EQUIPMENT = ['Pull-up bar', 'Resistance bands', 'Door anchor', 'Backpack + weights', 'Step', 'Chair', 'Bed or sofa'];
const TIMES = ['Morning', 'Midday', 'Evening', 'It changes'];
const TRAVEL = ['Rarely', 'Sometimes', 'Often'];
const OBSTACLES = ['Distraction / ADHD', 'Irregular schedule', 'Travel', 'Low energy', 'Motivation dips', 'Uni or work pressure', 'Sport or training', 'Sleep', 'Family or caring'];
const TONES = ['The System (Solo Leveling)', 'Strict coach', 'Calm and kind', 'Faith-centred (Islam)', 'Funny'];
const PISTOL = ['Not yet', 'With support', 'Yes'];
const PER_WEEK = ['4', '5', '6'];
const PHASE_LABELS = { Bulking: 'bulk', Cutting: 'cut', Maintaining: 'maintain' };

let ob = null; // { step, draft, busy, error, fromSettings, goalId }

// The questions, in order. Editing the profile from Settings skips the goal (goals are edited on
// the Goals tab); the workout questions only come up for people who pick the workout plan.
function obSteps() {
  if (ob.fromSettings) return ['name', 'life', 'tone', 'done'];
  return ['intro', 'name', 'goal', 'why', 'quests', ...(ob.draft.workouts ? ['start'] : []), 'life', 'tone', 'ai', 'done'];
}

export function needsOnboarding() {
  return !S.state.profile?.onboarded;
}

export function startOnboarding({ fromSettings = false } = {}) {
  const p = S.state.profile || {};
  const quests = G.TEMPLATES.other.quests.map((q) => q.title);
  ob = {
    step: 0,
    fromSettings,
    draft: {
      name: p.name ?? S.state.settings.name ?? '',
      category: '',
      goal: '',
      deadline: '',
      why: '',
      quests,
      workouts: false,
      pullups: p.pullups ?? 5,
      pushups: p.pushups ?? 20,
      pistol: p.pistol || '',
      equipment: p.equipment || ['Pull-up bar', 'Resistance bands', 'Door anchor', 'Backpack + weights', 'Step', 'Chair', 'Bed or sofa'],
      time: p.time || '',
      travel: p.travel || '',
      obstacles: p.obstacles || [],
      obstaclesNote: p.obstaclesNote || '',
      tone: p.tone || ['The System (Solo Leveling)'],
      perWeek: String(S.state.settings.perWeek || 5),
      phase: S.state.body.phase ? S.PHASES[S.state.body.phase].label : '',
      weight: '',
    },
  };
  let el = $('#onboard');
  if (!el) {
    el = document.createElement('div');
    el.id = 'onboard';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', fromSettings ? 'Edit your profile' : 'Set up your goal');
    document.body.append(el);
    el.addEventListener('click', onboardClick);
    el.addEventListener('input', onboardInput);
  }
  document.body.classList.add('onboarding');
  setBackgroundInert(true);
  renderOnboard();
}

function closeOnboarding() {
  $('#onboard')?.remove();
  document.body.classList.remove('onboarding');
  setBackgroundInert(false);
  ob = null;
  app.render();
}

// Editing the profile from Settings can be cancelled at any step (Escape or the close button).
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && ob?.fromSettings && !ob.busy) closeOnboarding();
});

const chips = (name, options, selected, multi, labels = {}) =>
  `<div class="chips ob-chips" role="group">${options
    .map((o) => {
      const on = multi ? selected.includes(o) : selected === o;
      return `<button class="chip ${on ? 'on' : ''}" data-ob="${multi ? 'multi' : 'pick'}" data-k="${name}" data-v="${esc(o)}" aria-pressed="${on}">${esc(labels[o] || o)}</button>`;
    })
    .join('')}</div>`;

const stepper = (name, value, max) =>
  `<div class="stepper ob-stepper"><button class="step" data-ob="inc" data-k="${name}" data-d="-1" aria-label="Less">−</button><input class="reps" type="number" inputmode="numeric" min="0" max="${max}" value="${value}" data-obk="${name}" aria-label="${name}"><button class="step" data-ob="inc" data-k="${name}" data-d="1" aria-label="More">+</button></div>`;

const CATEGORY_IDS = Object.keys(G.CATEGORIES);
const CATEGORY_LABELS = Object.fromEntries(Object.entries(G.CATEGORIES).map(([id, c]) => [id, c.label]));

function renderOnboard() {
  const el = $('#onboard');
  if (!el || !ob) return;
  const d = ob.draft;
  const steps = obSteps();
  const step = steps[ob.step];
  const counted = steps.filter((x) => x !== 'intro' && x !== 'done');
  const n = counted.indexOf(step) + 1;
  const dots = n > 0 ? `<p class="kicker ob-count">Step ${n} of ${counted.length}</p><div class="ob-bar"><i style="width:${(n / counted.length) * 100}%"></i></div>` : '';
  const t = G.TEMPLATES[d.category || 'other'];
  let body = '';
  let next = 'Next';
  let canSkip = true;
  switch (step) {
    case 'intro':
      body = `<p class="sys-line center">[System]</p>
        <h1 class="display ob-hero">Arise</h1>
        <p class="ob-lead center">You have been chosen to become the strongest version of yourself.</p>
        <p class="center muted">Pick a goal, any goal, and the System turns it into small daily quests you can actually keep. About 2 minutes. You can change everything later.</p>
        ${syncConfigured ? '<p class="center"><button class="link" data-ob="sign-in">Already have an account? Sign in</button></p>' : ''}`;
      next = 'Begin';
      break;
    case 'name':
      body = `<h2 class="display ob-q">What should the System call you?</h2>
        <label class="field"><span class="k">Your name</span><input type="text" maxlength="24" data-obk="name" value="${esc(d.name)}" placeholder="Hunter" autocomplete="nickname" enterkeyhint="next"></label>`;
      break;
    case 'goal':
      body = `<h2 class="display ob-q">What's your big goal?</h2>
        <p class="muted">Anything you want to get to. You can add more goals later.</p>
        <p class="label">Area</p>${chips('category', CATEGORY_IDS, d.category, false, CATEGORY_LABELS)}
        <textarea class="log-text" rows="3" maxlength="120" data-obk="goal" placeholder="e.g. ${esc(t.examples[0])}">${esc(d.goal)}</textarea>
        <p class="label">Ideas</p>${chips('goalIdea', t.examples, '', false)}
        <p class="label">By when?</p>${chips('deadline', DEADLINES, d.deadline, false)}`;
      canSkip = false;
      break;
    case 'why':
      body = `<h2 class="display ob-q">Why does it matter to you?</h2>
        <p class="muted">On the days you don't feel like it, the System will remind you of this.</p>
        <textarea class="log-text" rows="4" maxlength="600" data-obk="why" placeholder="e.g. I want to feel confident, be disciplined, and prove to myself I can stay consistent.">${esc(d.why)}</textarea>`;
      break;
    case 'quests':
      body = `<h2 class="display ob-q">Your daily quests</h2>
        <p class="muted">Small actions you'll tick off. Pick a few; you can change them, add your own or let the System suggest some later.</p>
        ${chips('quests', t.quests.map((q) => q.title), d.quests, true, Object.fromEntries(t.quests.map((q) => [q.title, `${q.title} · ${G.scheduleText(q.schedule)}${q.amount ? `, ${q.amount.target} ${q.amount.unit}` : ''}`])))}
        ${
          d.category === 'fitness'
            ? `<button class="toggle-row" data-ob="workouts" aria-pressed="${!!d.workouts}"><span><b>Use Arise's home workout plan</b><small>Three sessions in turn (A, B, C) with sets, reps, a rest timer and how-to videos. Needs resistance bands and a backpack; a pull-up bar is best.</small></span><span class="switch ${d.workouts ? 'on' : ''}"></span></button>`
            : ''
        }`;
      break;
    case 'start':
      body = `<h2 class="display ob-q">Where are you starting?</h2>
        <div class="ob-grid">
          <div><p class="label">Max pull-ups in a row</p>${stepper('pullups', d.pullups, 50)}</div>
          <div><p class="label">Max push-ups in a row</p>${stepper('pushups', d.pushups, 150)}</div>
        </div>
        <p class="label">Can you do a pistol squat?</p>${chips('pistol', PISTOL, d.pistol, false)}
        <p class="label">How many days a week can you train?</p>${chips('perWeek', PER_WEEK, d.perWeek, false)}
        <p class="label">Right now you are…</p>${chips('phase', [...Object.keys(PHASE_LABELS), 'Not sure'], d.phase, false)}
        <label class="field"><span class="k">Your weight in kg (optional)</span><input type="number" inputmode="decimal" step="0.1" data-obk="weight" value="${esc(d.weight)}" placeholder="e.g. 72.5"></label>
        <p class="label">What do you have?</p>${chips('equipment', EQUIPMENT, d.equipment, true)}`;
      break;
    case 'life':
      body = `<h2 class="display ob-q">Your life right now</h2>
        <p class="label">Best time of day for your quests</p>${chips('time', TIMES, d.time, false)}
        <p class="label">How often do you travel?</p>${chips('travel', TRAVEL, d.travel, false)}
        <p class="label">What usually gets in the way?</p>${chips('obstacles', OBSTACLES, d.obstacles, true)}
        <textarea class="log-text" rows="2" maxlength="300" data-obk="obstaclesNote" placeholder="Anything else? (optional)">${esc(d.obstaclesNote)}</textarea>`;
      break;
    case 'tone':
      body = `<h2 class="display ob-q">How should the System talk to you?</h2>
        <p class="muted">Pick one or more.</p>${chips('tone', TONES, d.tone, true)}`;
      if (ob.fromSettings) next = 'Save';
      break;
    case 'ai':
      body = `<h2 class="display ob-q">Your AI coach</h2>
        <p>The System's personal messages, journal reflections, coaching chat and quest ideas come from an AI. Yours stays private:</p>
        <ul class="changes">
          <li><b>Private AI</b>: encrypted to a sealed, verified enclave, so nobody can read it. Free with an account (Settings, Account).</li>
          <li><b>On this device</b>: on a laptop with Chrome, it can run right here. Nothing leaves your computer.</li>
        </ul>
        <details class="other"><summary>Or use your own AI key (Claude, ChatGPT, Gemini…)</summary>
          <p class="small">Not private: that company can read what the coach sends it, and bills you for it. Get a key: ${keyLinks()}. It's stored only on this device.</p>
          <label class="field"><span class="k">API key</span><input type="password" data-obk="key" placeholder="${AI.hasKey() && ob.key == null ? '•••••••• saved on this device' : 'Paste your API key'}" autocomplete="off" spellcheck="false" value="${esc(ob.key ?? '')}"></label>
        </details>`;
      next = 'Save and continue';
      break;
    case 'done': {
      if (ob.fromSettings) {
        body = `<p class="sys-line center">[System]</p><h2 class="display ob-hero small">Profile saved</h2>`;
      } else {
        const g = ob.goalId ? S.goalById(ob.goalId) : null;
        body = `<p class="sys-line center">[System]</p>
        <h2 class="display ob-hero small">Quest log ready</h2>
        <p class="center ob-lead">${esc(d.name || 'Player')}, your goal: <b>${esc(d.goal || 'lock in every day')}</b>${d.deadline && d.deadline !== 'No deadline' ? ` in ${esc(d.deadline)}` : ''}.</p>
        ${g?.quests.length ? `<ul class="changes">${g.quests.map((q) => `<li><b>${esc(q.title)}</b>: ${esc(G.scheduleText(q.schedule))}${q.amount ? `, ${esc(q.amount.target)} ${esc(q.amount.unit)}` : ''}</li>`).join('')}</ul>` : ''}
        ${
          AI.ready() && g
            ? `<button class="btn ghost block" data-ob="ai-quests">${icon('system')} Let the System suggest quests for this goal</button>`
            : `<p class="center muted">Today's quests are on the Today screen. Add more goals any time on the Goals tab.</p>`
        }`;
      }
      next = 'Enter';
      canSkip = false;
      break;
    }
  }
  const last = step === 'done';
  el.innerHTML = `<div class="ob-panel panel glow">
      ${ob.fromSettings && !last ? `<button class="icon-btn ob-close" data-ob="cancel" aria-label="Close without saving">${icon('close')}</button>` : ''}
      ${dots}
      <div class="ob-body">${body}</div>
      <div class="ob-actions">
        ${ob.step > 0 && !last ? `<button class="btn ghost" data-ob="back">Back</button>` : '<span></span>'}
        ${ob.busy ? '' : `<button class="btn primary ${last ? '' : 'xl-ish'}" data-ob="${last ? 'finish' : 'next'}">${esc(next)}</button>`}
      </div>
      ${canSkip && !last ? `<button class="link center ob-skip" data-ob="${step === 'intro' ? 'skip-all' : 'next'}">${step === 'intro' ? 'Skip the intro' : 'Skip this question'}</button>` : ''}
    </div>`;
  el.scrollTop = 0;
  el.querySelector('input[type="text"], textarea')?.focus({ preventScroll: true });
}

function onboardInput(e) {
  const k = e.target.dataset.obk;
  if (!k || !ob) return;
  if (k === 'key') ob.key = e.target.value;
  else if (k === 'pullups' || k === 'pushups') ob.draft[k] = Math.max(0, Math.min(999, Number(e.target.value) || 0));
  else ob.draft[k] = e.target.value;
}

// The intro's answers: the profile, and (the first time) the goal with its quests.
function saveIntro() {
  const d = ob.draft;
  const { perWeek, phase, weight, quests, workouts, category, goal, deadline, why, ...profile } = d;
  if (ob.fromSettings) {
    S.saveProfile({ ...profile, name: d.name.trim(), obstaclesNote: d.obstaclesNote.trim() });
    return;
  }
  if (workouts) {
    if (perWeek) S.state.settings.perWeek = Number(perWeek);
    if (PHASE_LABELS[phase] && S.state.body.phase !== PHASE_LABELS[phase]) S.setPhase(PHASE_LABELS[phase]);
    if (weight) S.addBodyEntry({ weight });
  }
  const cat = category || 'other';
  const t = G.TEMPLATES[cat];
  const g = S.saveGoal({
    id: workouts ? 'fitness' : S.uid(),
    title: goal.trim(),
    category: cat,
    why: why.trim(),
    by: deadline && deadline !== 'No deadline' ? deadline : '',
    workouts: !!workouts,
    quests: t.quests.filter((q) => quests.includes(q.title)).map((q) => ({ ...q, id: S.uid(), created: S.todayKey() })),
  });
  ob.goalId = g?.id || null;
  S.saveProfile({ ...profile, goal: goal.trim(), why: why.trim(), deadline, name: d.name.trim(), obstaclesNote: d.obstaclesNote.trim() });
}

async function onboardClick(e) {
  const b = e.target.closest('[data-ob]');
  if (!b || !ob || b.disabled) return;
  const d = ob.draft;
  const act = b.dataset.ob;
  const steps = obSteps();
  if (act === 'pick') {
    if (b.dataset.k === 'goalIdea') d.goal = b.dataset.v;
    else if (b.dataset.k === 'category') {
      const before = d.category;
      d.category = d.category === b.dataset.v ? '' : b.dataset.v;
      // New area, new starting quests (the first two of its ideas).
      if (d.category !== before) d.quests = G.TEMPLATES[d.category || 'other'].quests.slice(0, 2).map((q) => q.title);
      if (d.category !== 'fitness') d.workouts = false;
    } else d[b.dataset.k] = d[b.dataset.k] === b.dataset.v ? '' : b.dataset.v;
    renderOnboard();
  } else if (act === 'multi') {
    const list = d[b.dataset.k];
    const i = list.indexOf(b.dataset.v);
    if (i >= 0) list.splice(i, 1);
    else list.push(b.dataset.v);
    renderOnboard();
  } else if (act === 'workouts') {
    d.workouts = !d.workouts;
    // The workout plan is the training, so a separate "Train" quest would only double it.
    if (d.workouts) d.quests = d.quests.filter((q) => q !== 'Train');
    renderOnboard();
  } else if (act === 'inc') {
    d[b.dataset.k] = Math.max(0, (Number(d[b.dataset.k]) || 0) + Number(b.dataset.d));
    const input = b.parentElement.querySelector('input');
    if (input) input.value = d[b.dataset.k];
  } else if (act === 'back') {
    ob.step = Math.max(0, ob.step - 1);
    renderOnboard();
  } else if (act === 'next') {
    const step = steps[ob.step];
    if (step === 'goal' && !d.goal.trim()) {
      toast('Write your goal first, even one line.');
      return;
    }
    if (step === 'ai' && ob.key != null && ob.key.trim()) {
      saveKey(ob.key);
      const p = AI.provider();
      if (p && confirm(`Use ${p.name} for the coach? It isn't private: ${p.company} can read your goals, history and journal when the coach uses them.`)) {
        AI.consent(p.id);
        S.state.settings.aiEngine = 'own';
        S.save();
      }
    }
    // The answers are saved just before the last screen.
    if (steps[ob.step + 1] === 'done') saveIntro();
    ob.step = Math.min(steps.length - 1, ob.step + 1);
    renderOnboard();
  } else if (act === 'sign-in') {
    // Signing in brings back the profile and goals, so the intro won't be needed.
    closeOnboarding();
    app.go('settings');
  } else if (act === 'skip-all') {
    S.saveProfile({ skipped: true });
    closeOnboarding();
  } else if (act === 'ai-quests') {
    const id = ob.goalId;
    closeOnboarding();
    app.go('goals');
    if (id) {
      GOALS.openGoalEditor(id);
      document.querySelector('[data-act="g-ai"]')?.click();
    }
  } else if (act === 'finish' || act === 'cancel') {
    closeOnboarding();
  }
}

// =====================================================================
// Today: the System message
// =====================================================================

let briefing = { loading: false, error: '' };

function localMessage() {
  const p = S.state.profile;
  const name = (p?.name || S.state.settings.name || '').trim() || 'Player';
  const streak = S.currentStreak();
  const k = S.todayKey();
  const left = S.questsFor(k).filter((x) => !x.done);
  let quest = '';
  if (S.workoutsOn() && !S.sessionsOn(k).length) {
    const planned = S.suggestedFor(k);
    quest = planned === 'rest' ? 'Rest and recover.' : `${S.workouts()[planned].name} is waiting.`;
  }
  if (left.length) quest += `${quest ? ' ' : ''}${left.length === 1 ? `[${left[0].quest.title}] is waiting.` : `${left.length} quests left today, starting with [${left[0].quest.title}].`}`;
  if (!quest) quest = S.activeGoals().length ? "Today's quests are cleared. Rest well." : 'Set a goal and the System will give you daily quests.';
  const top = S.activeGoals()[0];
  const goal = top ? ` Everything leads to: “${top.title}”.` : p?.goal ? ` Everything leads to: “${p.goal}”.` : '';
  return `${name}. ${streak ? `${streak}-day streak.` : 'Day one starts now.'} ${quest}${goal}`;
}

export function systemMessageCard() {
  const cached = S.state.ai.daily[S.todayKey()];
  const hasKey = AI.ready();
  let body;
  if (cached) {
    body = `<p class="sysmsg-text">${esc(cached.message)}</p>${cached.focus ? `<p class="sysmsg-focus">${icon('target')} ${esc(cached.focus)}</p>` : ''}`;
  } else if (hasKey && briefing.loading) {
    body = `<p class="sysmsg-text">${esc(localMessage())}</p><div class="thinking"><span class="dots"><i></i><i></i><i></i></span> Writing today's message…</div>`;
  } else {
    body = `<p class="sysmsg-text">${esc(localMessage())}</p>`;
    if (briefing.error) body += `<p class="error small">${esc(briefing.error)} <button class="link" data-act="ai-daily">Try again</button></p>`;
    else if (!hasKey) body += `<p class="muted small">Personal daily messages come from your AI coach. <button class="link" data-act="nav" data-v="settings">Turn it on →</button></p>`;
    else if (!S.state.settings.aiDaily) body += `<button class="link" data-act="ai-daily">${icon('system')} Get today's message from the System</button>`;
  }
  return `<section class="panel sysmsg" id="sysmsg">
    <div class="sysmsg-head"><span class="sys-line">[System message]</span>${cached && hasKey ? `<button class="icon-btn small" data-act="ai-daily" data-force="1" aria-label="New message">${icon('refresh')}</button>` : ''}</div>
    ${body}
  </section>`;
}

function refreshSysmsg() {
  const el = $('#sysmsg');
  if (el) el.outerHTML = systemMessageCard();
}

// Called after the Today screen renders.
export function afterToday() {
  if (AI.ready() && S.state.settings.aiDaily && !S.state.ai.daily[S.todayKey()] && !briefing.loading && !briefing.error) loadBriefing();
}

async function loadBriefing(force = false) {
  briefing = { loading: true, error: '' };
  refreshSysmsg();
  try {
    await AI.dailyBriefing({ force });
    briefing = { loading: false, error: '' };
  } catch (err) {
    briefing = { loading: false, error: err.message };
  }
  refreshSysmsg();
}

export const goalLine = () => {
  const goals = S.activeGoals();
  if (!goals.length) return '';
  return `<p class="goal-line">${icon('target')} <span>${esc(goals[0].title)}${goals.length > 1 ? ` <span class="muted">+${goals.length - 1} more</span>` : ''}</span></p>`;
};

// =====================================================================
// Daily log reflection
// =====================================================================

let reflecting = null; // AbortController while streaming

export function reflectionBlock(k) {
  const log = S.state.logs[k] || {};
  const hasEntry = log.e || (log.t && log.t.trim());
  const hasKey = AI.ready();
  return `<div class="reflect">
    ${log.ai ? `<div class="ai-reply" id="logAi"><p class="sys-line">[System]</p>${md(log.ai)}</div>` : `<div class="ai-reply" id="logAi" hidden></div>`}
    ${
      hasKey
        ? `<button class="btn small ghost" data-act="ai-reflect" ${reflecting ? 'disabled' : ''} ${hasEntry ? '' : 'title="Write something first"'}>${icon('system')} ${log.ai ? 'Reflect again' : 'Reflect with the System'}</button>`
        : `<p class="muted small">Your AI coach can reflect on your entry and spot patterns over time. <button class="link" data-act="nav" data-v="settings">Connect it →</button></p>`
    }
  </div>`;
}

async function reflectToday(btn) {
  const k = S.todayKey();
  const log = S.state.logs[k] || {};
  if (!log.e && !(log.t && log.t.trim())) {
    toast('Write a few words or pick your energy first.');
    return;
  }
  const out = $('#logAi');
  reflecting = new AbortController();
  btn.disabled = true;
  out.hidden = false;
  out.innerHTML = `<p class="sys-line">[System]</p><div class="thinking"><span class="dots"><i></i><i></i><i></i></span> Reading your day…</div>`;
  try {
    await AI.reflect(k, {
      signal: reflecting.signal,
      onText: (t) => {
        const el = $('#logAi');
        if (el) el.innerHTML = `<p class="sys-line">[System]</p>${md(t)}`;
      },
    });
  } catch (err) {
    const el = $('#logAi');
    if (el) el.innerHTML = `<p class="error small">${esc(err.message)}</p>`;
  }
  reflecting = null;
  if (app.view() === 'today') app.render();
}

// =====================================================================
// Coach tab
// =====================================================================

const QUICK = [
  { label: 'Review my week', text: "Review my last 7 days: what went well, what didn't, and one thing to change next week." },
  {
    label: 'Deep review of all my data',
    full: true,
    text: 'Do a deep review of all my data since I started: consistency patterns (which days, quests and situations I skip), what goes with high or low energy in my log, how each goal and measure is moving, and the 3 most important changes for the next month.',
  },
  { label: 'Busy week', text: "I'm travelling or my schedule is different this week. Adapt today's and this week's quests to what I can realistically do. Keep it short." },
  { label: 'I missed days', text: 'I missed days recently. Help me restart today without guilt: the smallest version of my quests that keeps me moving, and what to do this week.' },
  { label: 'What should I focus on?', text: "Based on my goals and my data, what's the single most important thing to focus on this month, and why?" },
];

let chatState = { busy: false, controller: null, text: '' };

function bubble(m, i) {
  if (m.role === 'user') return `<div class="msg user"><div class="bubble">${esc(m.text).replace(/\n/g, '<br>')}</div></div>`;
  return `<div class="msg ai ${m.error ? 'err' : ''}"><div class="bubble">${m.error ? `<p>${esc(m.text)}</p>` : md(m.text)}</div></div>`;
}

export function renderCoach(root) {
  const hasKey = AI.ready();
  const prov = AI.provider();
  const log = S.state.ai.chat;
  const msgs = log.map(bubble).join('');
  const live = chatState.busy
    ? `<div class="msg ai"><div class="bubble" id="streamBubble">${chatState.text ? md(chatState.text) : '<div class="thinking"><span class="dots"><i></i><i></i><i></i></span> The System is thinking…</div>'}</div></div>`
    : '';
  const empty = !log.length && !chatState.busy;
  root.innerHTML = `
    <header class="page-head">
      <div><p class="kicker">${hasKey ? `${esc(AI.isPrivate() ? 'Private' : prov?.id && prov.id !== 'custom' ? prov.name : 'Your AI')} · your AI coach` : 'Your AI coach'}</p><h1 class="display">The System</h1></div>
      ${log.length && !chatState.busy ? `<button class="btn small ghost" data-act="ai-clear">New chat</button>` : ''}
    </header>
    ${questBar()}
    <div class="cols coach-cols">
      <div class="col">
        <section class="panel chat glow">
          <div class="chat-log" id="chatLog">
            ${
              empty
                ? `<div class="chat-empty"><p class="sys-line">[System]</p><p>Ask me anything about your training, your goal or your week. I can see your plan, your workouts, your streaks and your daily log.</p>${hasKey ? '' : connectHint('The coach needs its AI turned on.')}</div>`
                : msgs + live
            }
          </div>
          <form class="chat-input" id="chatForm" autocomplete="off">
            <textarea id="chatText" rows="1" placeholder="${hasKey ? 'Message the System…' : 'Turn on the AI coach in Settings to chat'}" ${hasKey ? '' : 'disabled'} enterkeyhint="send"></textarea>
            ${
              chatState.busy
                ? `<button type="button" class="icon-btn stop" data-act="ai-stop" aria-label="Stop">${icon('stop')}</button>`
                : `<button type="submit" class="icon-btn send" aria-label="Send" ${hasKey ? '' : 'disabled'}>${icon('send')}</button>`
            }
          </form>
        </section>
      </div>
      <div class="col">
        <section class="panel">
          <div class="panel-title"><span>Quick actions</span></div>
          <div class="quick">${QUICK.map((q, i) => `<button class="quick-btn" data-act="ai-quick" data-i="${i}" ${hasKey && !chatState.busy ? '' : 'disabled'}>${esc(q.label)}${q.full ? ' <span class="tag">all data</span>' : ''}</button>`).join('')}
            <button class="quick-btn" data-act="nav" data-v="plan">Personalise my plan →</button>
          </div>
        </section>
        <section class="panel small-print">
          <p class="small">Replies come from ${esc(AI.engineLabel())}. ${
            AI.isPrivate()
              ? 'What you send stays private: nobody else can read it.'
              : `Your plan, workouts and daily log are sent to ${esc(prov?.company || 'your AI service')}, who can read them, only when you ask something here. The deep review sends your whole history.`
          }</p>
        </section>
      </div>
    </div>`;
  const logEl = $('#chatLog');
  if (logEl) logEl.scrollTop = logEl.scrollHeight;
}

// Action over talk: today's quest stays one tap away while chatting.
function questBar() {
  const k = S.todayKey();
  const a = S.state.active;
  if (a) return `<button class="panel banner resume" data-act="nav" data-v="workout"><span class="pulse"></span><span><b>Quest in progress: ${esc(S.workoutName(a.workout, a))}</b><small>Talk later. Finish your sets.</small></span><span class="go">Resume →</span></button>`;
  if (S.sessionsOn(k).length) return `<div class="panel banner"><span>${icon('check')}</span><span><b>Today's quest is cleared.</b><small>Good. Use the System to plan the next one.</small></span></div>`;
  const q = S.suggestedFor(k);
  if (q === 'rest') return `<div class="panel banner"><span>${icon('moon')}</span><span><b>Rest day.</b><small>Recover. Short talk, early sleep.</small></span></div>`;
  return `<div class="panel banner quest-bar"><span>${icon('bolt')}</span><span><b>Today's quest: ${esc(S.workouts()[q].name)}</b><small>Not done yet. Doing beats talking.</small></span><button class="btn small primary" data-act="start" data-w="${q}">Start</button></div>`;
}

let rafPending = false;
function paintStream() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    const el = $('#streamBubble');
    if (el && chatState.text) {
      el.innerHTML = md(chatState.text);
      const logEl = $('#chatLog');
      if (logEl) logEl.scrollTop = logEl.scrollHeight;
    }
  });
}

async function sendChat(text, { full = false } = {}) {
  text = text.trim();
  if (!text || chatState.busy) return;
  chatState = { busy: true, controller: new AbortController(), text: '' };
  if (app.view() === 'coach') app.render();
  try {
    await AI.chat(text, {
      full,
      signal: chatState.controller.signal,
      onText: (t) => {
        chatState.text = t;
        paintStream();
      },
    });
  } catch (err) {
    if (err.code !== 'aborted') toast(err.message);
  }
  chatState = { busy: false, controller: null, text: '' };
  if (app.view() === 'coach') app.render();
}

// =====================================================================
// Plan personalisation
// =====================================================================

let planState = { busy: false, proposal: null, error: '', request: '' };

function scheduleHTML(plan) {
  if (plan.mode === 'rotation') {
    return `<p class="rotation">${plan.order.map((id) => `<b>${esc(plan.workouts[id].short || plan.workouts[id].name)}</b>`).join(' → ')} …</p>
      <p class="muted small">In this order on any day, ${plan.perWeek}× a week.</p>`;
  }
  return `<div class="wk-grid">${plan.week
    .map((id, i) => `<div class="wk-day"><span class="k">${DAYS[i]}</span><span>${id === 'rest' ? 'Rest' : esc(plan.workouts[id].short || plan.workouts[id].name)}</span></div>`)
    .join('')}</div>`;
}

function planPreviewHTML(plan, scope) {
  const workouts = Object.entries(plan.workouts)
    .map(
      ([, w]) => `<div class="pv-workout"><p><b>${esc(w.name)}</b> <span class="muted">${esc(w.tag)}</span></p>
      <ul>${w.slots.map((s) => `<li>${esc(EXERCISES[s.ex].name)} <span class="muted">${esc(targetLabel(s))}${s.note ? ` · ${esc(s.note)}` : ''}</span></li>`).join('')}</ul></div>`,
    )
    .join('');
  return `<div class="plan-preview">
    <p class="sys-line">[System] Proposed plan</p>
    ${plan.summary ? `<p>${esc(plan.summary)}</p>` : ''}
    ${plan.changes.length ? `<p class="label">What changes</p><ul class="changes">${plan.changes.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}
    <p class="label">${plan.mode === 'rotation' ? 'Rotation' : 'Week'}</p>${scheduleHTML(plan)}
    <p class="label">Sessions</p>${workouts}
    <div class="row">
      <button class="btn primary" ${scope === 'ob' ? 'data-ob="apply-plan"' : 'data-act="ai-plan-apply"'}>${icon('check')} Apply this plan</button>
      ${scope === 'ob' ? '' : '<button class="btn ghost" data-act="ai-plan-discard">Discard</button>'}
    </div>
  </div>`;
}

export function planPanel() {
  const hasKey = AI.ready();
  const custom = S.state.customPlan;
  let current = '';
  if (custom) {
    current = `<section class="panel custom-plan">
      <div class="panel-title">${icon('system')}<span>Personalised plan</span></div>
      <p class="muted small">Made by the System on ${esc(new Date(custom.created).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }))}.</p>
      ${custom.summary ? `<p>${esc(custom.summary)}</p>` : ''}
      ${custom.changes?.length ? `<ul class="changes">${custom.changes.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}
      <button class="btn small ghost" data-act="ai-plan-reset">Go back to the original plan</button>
    </section>`;
  }
  let body;
  if (!hasKey) body = connectHint('The System can redesign this plan around your goal, schedule and progress.');
  else if (planState.busy) body = `<div class="thinking"><span class="dots"><i></i><i></i><i></i></span> The System is designing your plan. This can take up to a minute…</div>`;
  else if (planState.proposal) body = planPreviewHTML(planState.proposal, 'plan');
  else
    body = `<p class="muted">Tell the System what you need, or leave it empty to personalise the plan to your profile and progress.</p>
      <textarea class="log-text" id="planReq" rows="2" placeholder="e.g. Only 30 minutes on weekdays · Travelling 2 weeks with only bands · Focus on my first muscle-up">${esc(planState.request)}</textarea>
      ${planState.error ? `<p class="error small">${esc(planState.error)}</p>` : ''}
      <button class="btn primary" data-act="ai-plan">${icon('system')} Design my plan</button>
      <p class="muted small">Nothing changes until you tap Apply. Your workout history stays as it is.</p>`;
  return `${current}<section class="panel glow" id="planAI">
    <div class="panel-title">${icon('system')}<span>Personalise with the System</span></div>
    ${body}
  </section>`;
}

async function designPlan() {
  planState.request = $('#planReq')?.value || planState.request;
  planState = { ...planState, busy: true, error: '', proposal: null };
  app.render();
  try {
    planState.proposal = await AI.proposePlan(planState.request);
  } catch (err) {
    planState.error = err.message;
  }
  planState.busy = false;
  if (app.view() === 'plan') app.render();
  else if (planState.proposal) toast('Your new plan is ready on the Plan tab.');
}

// =====================================================================
// Settings panels
// =====================================================================

const freshKeyState = () => ({ testing: false, status: '', models: null, loadingModels: false, modelsError: '', typing: false });
let keyState = freshKeyState();
let remindState = { busy: false, error: '' };

// Saving a key for a different service resets the model, since model names differ per service.
function saveKey(v) {
  const before = AI.provider()?.id;
  AI.setKey(v);
  if (AI.provider()?.id !== before) S.state.settings.aiModel = '';
  S.save();
  keyState = freshKeyState();
}

const tokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`);

async function loadModels(refresh = false) {
  keyState.loadingModels = true;
  keyState.modelsError = '';
  if (app.view() === 'settings') app.render();
  try {
    const list = await AI.listModels({ refresh });
    keyState.models = list;
    if (!list.length) keyState.modelsError = 'No models came back for this key.';
  } catch (err) {
    keyState.models = [];
    keyState.modelsError = `Couldn't load the model list: ${err.message}`;
  }
  keyState.loadingModels = false;
  if (app.view() === 'settings') app.render();
}

function useModel(name) {
  S.state.settings.aiModel = String(name || '').trim();
  S.save();
  keyState.typing = false;
  testKey();
}

const ENGINE_TEXT = {
  private: 'An open AI model in a sealed enclave. The app checks the enclave is genuine, then encrypts what it sends to it, so nobody can read it: not the people who run Arise, not the cloud it runs in. Free, with a daily limit.',
  device: 'Runs on this computer. Nothing leaves it, it works offline, and it costs nothing. Needs Chrome 148 or later on a laptop or desktop (not phones yet).',
  own: 'Claude, ChatGPT, Gemini, OpenRouter, Groq or any service that works like OpenAI, with your own API key. Not private: that company can read what the coach sends it, and bills you.',
};
let deviceState = { progress: null, error: '' };

function engineStatus(id) {
  if (id === 'private') {
    if (!AI.privateConfigured()) return { ok: false, text: 'Not switched on for this app yet.' };
    if (!AI.privateSignedIn()) return { ok: false, text: 'Needs a free account (Account, above). That keeps it for Arise players.' };
    return { ok: true, text: 'Ready.' };
  }
  if (id === 'device') {
    if (deviceState.progress != null) return { ok: false, text: `Downloading the model… ${Math.round(deviceState.progress * 100)}%` };
    if (deviceState.error) return { ok: false, text: deviceState.error };
    const a = Device.lastKnown();
    if (a === 'available') return { ok: true, text: 'Ready.' };
    if (a === 'downloadable') return { ok: false, text: 'Available. Pick it to download the model (a few GB, once).' };
    if (a === 'downloading') return { ok: false, text: 'Chrome is downloading the model…' };
    return { ok: false, text: 'Not available in this browser.' };
  }
  if (!AI.hasKey()) return { ok: false, text: 'Add your key below.' };
  if (!AI.consented()) return { ok: false, text: 'Waiting for your OK to send data to that service.' };
  return { ok: true, text: `Using ${AI.modelLabel()}.` };
}

function engineCard(id) {
  const picked = S.state.settings.aiEngine;
  const on = picked ? picked === id : AI.engine() === id;
  const st = engineStatus(id);
  const tag = id === 'private' ? '<span class="tag gold">Recommended</span>' : id === 'own' ? '<span class="tag">Not private</span>' : '';
  return `<button class="engine ${on ? 'on' : ''}" data-act="ai-engine" data-v="${id}" aria-pressed="${on}">
    <span class="engine-head"><b>${esc(AI.ENGINES[id].name)}</b>${tag}</span>
    <small>${esc(ENGINE_TEXT[id])}</small>
    <small class="${st.ok ? 'ok' : 'muted'}">${st.ok ? '✓ ' : ''}${esc(st.text)}</small>
  </button>`;
}

function ownKeyPanel() {
  const hasKey = AI.hasKey();
  const st = S.state.settings;
  const prov = AI.provider();
  const detected = AI.detectProvider(AI.getKey());
  const list = keyState.models || [];
  const rec = AI.recommendedModel();
  const recommended = rec ? (rec === AI.MODEL ? 'Claude Opus 5.5' : rec) : '';
  const options = [...new Set([st.aiModel, ...list].filter((m) => m && (m !== rec || st.aiModel === m)))];
  if (hasKey && prov && AI.consented() && keyState.models === null && !keyState.loadingModels) setTimeout(() => loadModels(), 0);
  return `<div class="stack own-key">
      <label class="field"><span class="k">AI service</span>
        <select id="aiProvider">
          <option value="" ${st.aiProvider ? '' : 'selected'}>${!st.aiProvider && detected ? `From my key: ${esc(AI.PROVIDERS[detected].name)}` : 'Work it out from my key'}</option>
          ${Object.entries(AI.PROVIDERS)
            .map(([id, x]) => `<option value="${id}" ${st.aiProvider === id ? 'selected' : ''}>${esc(x.label)}</option>`)
            .join('')}
        </select>
      </label>
      <label class="field"><span class="k">API key</span>
        <input id="keyIn" type="password" autocomplete="off" spellcheck="false" placeholder="${hasKey ? '•••••••• saved on this device' : esc(prov?.keyHint || 'Paste your API key')}">
      </label>
      ${
        prov?.id === 'custom'
          ? `<label class="field"><span class="k">API address</span><input id="aiBase" type="url" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://api.example.com/v1" value="${esc(st.aiBase)}"></label>
      ${
        st.aiBase && !AI.hostConfirmed()
          ? `<div class="alert gold"><div><b>Send your key to ${esc(AI.customHost())}?</b> Only allow this if you trust that service: it receives your API key and everything the coach sends.</div></div>
      <button class="btn ghost small" data-act="ai-host-ok">Allow ${esc(AI.customHost())}</button>`
          : ''
      }`
          : ''
      }
      ${
        hasKey && prov && !AI.consented()
          ? `<div class="alert gold"><div><b>${esc(prov.company)} will be able to read what the coach sends.</b> That's your goal, plan, history and journal, whenever you use an AI feature.</div></div>
      <button class="btn primary small" data-act="ai-consent">OK, use ${esc(prov.name)}</button>`
          : ''
      }
      ${
        hasKey && prov && AI.consented()
          ? `<label class="field"><span class="k">Model</span>
        <select id="aiModel">
          <option value="" ${st.aiModel || keyState.typing ? '' : 'selected'}>${recommended ? `Recommended: ${esc(recommended)}` : 'Best available, picked for you'}</option>
          ${options.map((m) => `<option value="${esc(m)}" ${st.aiModel === m && !keyState.typing ? 'selected' : ''}>${esc(m)}</option>`).join('')}
          <option value="__type" ${keyState.typing ? 'selected' : ''}>Type a model name…</option>
        </select>
      </label>
      ${
        keyState.typing
          ? `<label class="field"><span class="k">Model name</span><input id="aiModelName" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="done" placeholder="${esc(list[0] || 'model-name')}" value="${esc(st.aiModel)}"></label>
      <button class="btn ghost small" data-act="ai-model-use">Use this model</button>`
          : ''
      }
      <p class="muted small">${
        keyState.loadingModels
          ? 'Loading the models this key can use…'
          : list.length
            ? `${list.length} models on this key. Pick one to switch; it gets tested straight away. <button class="link small" data-act="ai-models">Reload list</button>`
            : keyState.modelsError
              ? `${esc(keyState.modelsError)} <button class="link small" data-act="ai-models">Try again</button>`
              : ''
      }</p>`
          : ''
      }
      <div class="row">
        <button class="btn primary small" data-act="ai-key-save">${icon('key')} Save key</button>
        ${hasKey ? `<button class="btn ghost small" data-act="ai-key-test" ${keyState.testing ? 'disabled' : ''}>${keyState.testing ? 'Testing…' : 'Test connection'}</button><button class="btn ghost small danger" data-act="ai-key-remove">Remove key</button>` : ''}
      </div>
      ${keyState.status ? `<p class="small ${keyState.status.startsWith('✓') ? 'ok' : 'error'}">${esc(keyState.status)}</p>` : ''}
      ${hasKey && !prov ? `<p class="small error">The app couldn't tell which service this key is for. Pick it under AI service.</p>` : ''}
      <p class="muted small">${prov?.keyUrl && hasKey ? `Manage your key at <a href="${prov.keyUrl}" target="_blank" rel="noopener">${esc(prov.company)}</a>.` : `No key yet? Get one: ${keyLinks()}.`} The key stays on this device and is never included in backups.</p>
    </div>`;
}

export function settingsPanels() {
  const st = S.state.settings;
  const u = S.state.ai.usage;
  const prov = AI.provider();
  const cost = AI.usageCost();
  const other = (u.otherIn || 0) + (u.otherOut || 0);
  return `
    <section class="panel glow" id="aiSettings">
      <div class="panel-title">${icon('system')}<span>AI coach</span></div>
      <p>Pick where the System does its thinking. ${st.aiEngine ? '' : 'Right now it picks for you: the private AI, then this device.'}</p>
      <div class="engines" role="group" aria-label="Where the AI runs">${['private', 'device', 'own'].map((id) => engineCard(id)).join('')}</div>
      ${st.aiEngine ? '<button class="link small" data-act="ai-engine" data-v="">Let the app pick (private first)</button>' : ''}
      ${st.aiEngine === 'own' ? ownKeyPanel() : ''}
      <button class="toggle-row" data-act="toggle-setting" data-k="aiDaily" aria-pressed="${!!st.aiDaily}"><span><b>Daily System message</b><small>Writes a personal message on the Today screen once a day.</small></span><span class="switch ${st.aiDaily ? 'on' : ''}"></span></button>
      <p class="muted small">${
        AI.engine() === 'own'
          ? `Used so far on this device: ${Number(u.calls) || 0} request${u.calls === 1 ? '' : 's'}.${cost > 0 ? ` Claude: about $${cost < 0.01 ? '0.01' : cost.toFixed(2)}.` : ''}${other ? ` Other services: ${tokens(other)} tokens (their dashboard shows the cost).` : ''} Your profile, plan, workouts, weigh-ins and daily log go to ${esc(prov?.company || 'the AI service')} when you use an AI feature, and once a day for the daily message if it's on.`
          : AI.engine()
            ? 'Your profile, plan, workouts, weigh-ins and daily log are used to coach you, privately: nobody else can read them.'
            : 'Until the AI is on, the app works fully without it.'
      }</p>
    </section>
    <section class="panel">
      <div class="panel-title">${icon('target')}<span>Your goals</span></div>
      ${
        S.activeGoals().length
          ? `<ul class="changes">${S.activeGoals().map((g) => `<li><b>${esc(g.title)}</b>${g.by ? ` · ${esc(g.by)}` : ''}</li>`).join('')}</ul>`
          : '<p class="muted">None yet.</p>'
      }
      <div class="row">
        <button class="btn ghost small" data-act="nav" data-v="goals">Manage goals</button>
        <button class="btn ghost small" data-act="onboard" data-from="settings">Edit profile</button>
      </div>
    </section>`;
}

export function reminderAIBlock() {
  const n = S.state.ai.nudges;
  if (!AI.ready()) return `<p class="muted small">Turn on the AI coach to have the reminder texts written for your goal.</p>`;
  return `<div class="stack">
    <p class="small ${n ? 'ok' : 'muted'}">${n ? `✓ ${n.messages.length} reminder texts written by the System for you. ${isNative ? 'Your morning reminders use them.' : "They'll be used when you add reminders."}` : 'Reminder texts are generic right now.'}</p>
    ${remindState.error ? `<p class="error small">${esc(remindState.error)}</p>` : ''}
    <button class="btn ghost small" data-act="ai-reminders" ${remindState.busy ? 'disabled' : ''}>${icon('system')} ${remindState.busy ? 'Writing…' : n ? 'Write new texts' : 'Write my reminder texts with the System'}</button>
  </div>`;
}

// =====================================================================
// Event handling (called from app.js)
// =====================================================================

export async function handleAction(act, el) {
  switch (act) {
    case 'ai-engine': {
      const v = el.dataset.v;
      if (v === 'own' && AI.hasKey() && AI.provider() && !AI.consented()) {
        const p = AI.provider();
        if (!confirm(`Use ${p.name} for the coach? It isn't private: ${p.company} can read your goal, plan, history and journal whenever the coach uses them.`)) return true;
        AI.consent(p.id);
      }
      S.state.settings.aiEngine = v;
      S.save();
      if (v === 'device' && Device.lastKnown() === 'downloadable') downloadDeviceModel();
      app.render();
      return true;
    }
    case 'ai-consent':
      AI.consent();
      keyState.models = null;
      app.render();
      testKey();
      return true;
    case 'ai-host-ok':
      AI.confirmHost();
      keyState.models = null;
      app.render();
      return true;
    case 'onboard':
      startOnboarding({ fromSettings: el.dataset.from === 'settings' || !!S.state.profile?.onboarded });
      return true;
    case 'ai-daily':
      loadBriefing(!!el.dataset.force);
      return true;
    case 'ai-reflect':
      reflectToday(el);
      return true;
    case 'ai-quick': {
      const q = QUICK[Number(el.dataset.i)];
      if (q) sendChat(q.text, { full: !!q.full });
      return true;
    }
    case 'ai-stop':
      chatState.controller?.abort();
      return true;
    case 'ai-clear':
      if (confirm('Start a new chat? The current conversation will be deleted.')) {
        AI.clearChat();
        app.render();
      }
      return true;
    case 'ai-plan':
      designPlan();
      return true;
    case 'ai-plan-apply':
      if (planState.proposal) {
        if (S.state.active) toast('The quest in progress keeps its old exercises.');
        S.applyPlan(planState.proposal);
        planState = { busy: false, proposal: null, error: '', request: '' };
        toast('Personal plan applied.');
        app.render();
      }
      return true;
    case 'ai-plan-discard':
      planState.proposal = null;
      app.render();
      return true;
    case 'ai-plan-reset':
      if (confirm('Go back to the original plan? Your history stays.')) {
        S.resetPlan();
        app.render();
      }
      return true;
    case 'ai-key-save': {
      const v = $('#keyIn')?.value.trim();
      if (!v) {
        toast('Paste your API key first.');
        return true;
      }
      saveKey(v);
      S.state.settings.aiEngine = 'own';
      S.save();
      const p = AI.provider();
      if (!p) {
        toast('Key saved. Now pick which AI service it is for.');
        app.render();
        return true;
      }
      if (!AI.consented(p.id)) {
        if (!confirm(`Use ${p.name} for the coach? It isn't private: ${p.company} can read your goal, plan, history and journal whenever the coach uses them.`)) {
          app.render();
          return true;
        }
        AI.consent(p.id);
      }
      toast(`Key saved. Connecting to ${p.name}…`);
      app.render();
      testKey();
      return true;
    }
    case 'ai-models':
      await loadModels(true);
      return true;
    case 'ai-model-use': {
      const v = $('#aiModelName')?.value.trim();
      if (!v) {
        toast('Type a model name first.');
        return true;
      }
      useModel(v);
      return true;
    }
    case 'ai-key-test':
      testKey();
      return true;
    case 'ai-key-remove':
      if (confirm('Remove the API key from this device? AI features will stop until you add one again.')) {
        saveKey('');
        S.state.settings.aiModel = '';
        S.save();
        app.render();
      }
      return true;
    case 'ai-reminders':
      remindState = { busy: true, error: '' };
      app.render();
      try {
        await AI.writeReminders();
        remindState = { busy: false, error: '' };
        toast(isNative ? 'Reminder texts ready. Your morning reminders use them from now on.' : 'Reminder texts ready. Add reminders to your calendar to use them.');
      } catch (err) {
        remindState = { busy: false, error: err.message };
      }
      if (app.view() === 'settings') app.render();
      return true;
  }
  return false;
}

// Chrome only allows the download right after a tap, so this runs from the click itself.
async function downloadDeviceModel() {
  deviceState = { progress: 0, error: '' };
  app.render();
  try {
    await Device.download((f) => {
      deviceState.progress = f;
      if (app.view() === 'settings') app.render();
    });
    deviceState = { progress: null, error: '' };
    toast('The AI on this device is ready.');
  } catch (err) {
    deviceState = { progress: null, error: `The download didn't finish: ${err?.message || 'unknown error'}` };
  }
  if (app.view() === 'settings') app.render();
}

async function testKey() {
  // Update keyState in place: the model list may be loading at the same time.
  Object.assign(keyState, { testing: true, status: '' });
  if (app.view() === 'settings') app.render();
  try {
    await AI.testKey();
    const standIn = AI.standInModel();
    Object.assign(keyState, {
      testing: false,
      status: `✓ Connected to ${AI.modelLabel()}. The System is online.${standIn ? ' The recommended model was busy, so this one is standing in for now.' : ''}`,
    });
  } catch (err) {
    Object.assign(keyState, { testing: false, status: err.message });
  }
  if (app.view() === 'settings') app.render();
}

// AI service, model and address pickers in Settings.
document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.id === 'aiProvider') {
    S.state.settings.aiProvider = t.value;
    S.state.settings.aiModel = '';
    S.save();
    keyState = freshKeyState();
    app.render();
  } else if (t.id === 'aiModel') {
    if (t.value === '__type') {
      keyState.typing = true;
      app.render();
      $('#aiModelName')?.focus();
    } else {
      useModel(t.value);
    }
  } else if (t.id === 'aiBase') {
    const v = t.value.trim().replace(/\/+$/, '');
    // Keys only travel over HTTPS, apart from AI running on this computer (Ollama, LM Studio).
    if (v && !/^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$))[^\s"'<>`]{0,300}$/.test(v)) {
      toast('Use an https:// address (or http://localhost for AI on this computer).');
      return;
    }
    S.state.settings.aiBase = v;
    S.save();
    keyState.models = null;
    app.render();
  }
});

// Chat form: Enter sends on a keyboard, Shift+Enter makes a new line.
document.addEventListener('submit', (e) => {
  if (e.target.id !== 'chatForm') return;
  e.preventDefault();
  const t = $('#chatText');
  if (t && t.value.trim()) {
    const v = t.value;
    t.value = '';
    sendChat(v);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.target.id === 'aiModelName' && e.key === 'Enter') {
    e.preventDefault();
    handleAction('ai-model-use');
    return;
  }
  if (e.target.id === 'chatText' && e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(pointer: fine)').matches) {
    e.preventDefault();
    e.target.form.requestSubmit();
  }
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'chatText') {
    e.target.style.height = 'auto';
    e.target.style.height = `${Math.min(160, e.target.scrollHeight)}px`;
  } else if (e.target.id === 'planReq') planState.request = e.target.value;
});

