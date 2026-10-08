// Screens and panels for the AI coach ("the System"): the goal-setting intro, the daily System
// message, journal reflections, the coach chat, plan personalisation and the AI settings.

import { EXERCISES } from './program.js';
import * as S from './store';
import * as AI from './ai.js';
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
  `<p class="muted small">${esc(what)} <button class="link" data-act="nav" data-v="settings">Connect an AI in Settings →</button></p>`;

// =====================================================================
// Intro: the long-term goal and background ("Awakening")
// =====================================================================

const GOAL_EXAMPLES = ['Build an athletic V-taper physique', 'Do 20 strict pull-ups', 'Get my first muscle-up', 'Lock in every day, no matter where I am'];
const DEADLINES = ['3 months', '6 months', '1 year', '2 years', 'No deadline'];
const EQUIPMENT = ['Pull-up bar', 'Resistance bands', 'Door anchor', 'Backpack + weights', 'Step', 'Chair', 'Bed or sofa'];
const TIMES = ['Morning', 'Midday', 'Evening', 'It changes'];
const TRAVEL = ['Rarely', 'Sometimes', 'Often'];
const OBSTACLES = ['Distraction / ADHD', 'Irregular schedule', 'Travel', 'Low energy', 'Motivation dips', 'Uni or work pressure', 'Football or other sport', 'Sleep'];
const TONES = ['The System (Solo Leveling)', 'Strict coach', 'Calm and kind', 'Faith-centred (Islam)', 'Funny'];
const PISTOL = ['Not yet', 'With support', 'Yes'];
const PER_WEEK = ['4', '5', '6'];
const PHASE_LABELS = { Bulking: 'bulk', Cutting: 'cut', Maintaining: 'maintain' };

let ob = null; // { step, draft, busy, plan, error }

const OB_STEPS = ['intro', 'name', 'goal', 'why', 'start', 'life', 'tone', 'ai', 'done'];

export function needsOnboarding() {
  return !S.state.profile?.onboarded;
}

export function startOnboarding({ fromSettings = false } = {}) {
  const p = S.state.profile || {};
  ob = {
    step: fromSettings ? 1 : 0,
    fromSettings,
    draft: {
      name: p.name ?? S.state.settings.name ?? '',
      goal: p.goal || '',
      deadline: p.deadline || '',
      why: p.why || '',
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
    el.setAttribute('aria-label', 'Set up your goal');
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

// Editing the goal from Settings can be cancelled at any step (Escape or the close button).
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && ob?.fromSettings && !ob.busy) closeOnboarding();
});

const chips = (name, options, selected, multi) =>
  `<div class="chips ob-chips" role="group">${options
    .map((o) => {
      const on = multi ? selected.includes(o) : selected === o;
      return `<button class="chip ${on ? 'on' : ''}" data-ob="${multi ? 'multi' : 'pick'}" data-k="${name}" data-v="${esc(o)}" aria-pressed="${on}">${esc(o)}</button>`;
    })
    .join('')}</div>`;

const stepper = (name, value, max) =>
  `<div class="stepper ob-stepper"><button class="step" data-ob="inc" data-k="${name}" data-d="-1" aria-label="Less">−</button><input class="reps" type="number" inputmode="numeric" min="0" max="${max}" value="${value}" data-obk="${name}" aria-label="${name}"><button class="step" data-ob="inc" data-k="${name}" data-d="1" aria-label="More">+</button></div>`;

function renderOnboard() {
  const el = $('#onboard');
  if (!el || !ob) return;
  const d = ob.draft;
  const step = OB_STEPS[ob.step];
  const total = OB_STEPS.length - 2; // intro and done are not counted
  const dots = ob.step > 0 && ob.step < OB_STEPS.length - 1 ? `<p class="kicker ob-count">Step ${ob.step} of ${total}</p><div class="ob-bar"><i style="width:${(ob.step / total) * 100}%"></i></div>` : '';
  let body = '';
  let next = 'Next';
  let canSkip = true;
  switch (step) {
    case 'intro':
      body = `<p class="sys-line center">[System]</p>
        <h1 class="display ob-hero">Arise</h1>
        <p class="ob-lead center">You have been chosen to become the strongest version of yourself.</p>
        <p class="center muted">Answer a few quick questions (about 2 minutes) so the System can build your path. You can change everything later.</p>
        ${syncConfigured ? '<p class="center"><button class="link" data-ob="sign-in">Already have an account? Sign in</button></p>' : ''}`;
      next = 'Begin';
      break;
    case 'name':
      body = `<h2 class="display ob-q">What should the System call you?</h2>
        <label class="field"><span class="k">Your name</span><input type="text" maxlength="24" data-obk="name" value="${esc(d.name)}" placeholder="Hunter" autocomplete="nickname" enterkeyhint="next"></label>`;
      break;
    case 'goal':
      body = `<h2 class="display ob-q">What's your big goal?</h2>
        <p class="muted">Dream big. This is what every quest leads to.</p>
        <textarea class="log-text" rows="3" maxlength="300" data-obk="goal" placeholder="e.g. Build an athletic V-taper physique and never miss a week">${esc(d.goal)}</textarea>
        <p class="label">Ideas</p>${chips('goalIdea', GOAL_EXAMPLES, '', false)}
        <p class="label">By when?</p>${chips('deadline', DEADLINES, d.deadline, false)}`;
      canSkip = false;
      break;
    case 'why':
      body = `<h2 class="display ob-q">Why does it matter to you?</h2>
        <p class="muted">On the days you don't feel like it, the System will remind you of this.</p>
        <textarea class="log-text" rows="4" maxlength="600" data-obk="why" placeholder="e.g. I want to feel confident, be disciplined, and prove to myself I can stay consistent.">${esc(d.why)}</textarea>`;
      break;
    case 'start':
      body = `<h2 class="display ob-q">Where are you starting?</h2>
        <div class="ob-grid">
          <div><p class="label">Max pull-ups in a row</p>${stepper('pullups', d.pullups, 50)}</div>
          <div><p class="label">Max push-ups in a row</p>${stepper('pushups', d.pushups, 150)}</div>
        </div>
        <p class="label">Can you do a pistol squat?</p>${chips('pistol', PISTOL, d.pistol, false)}
        <p class="label">Right now you are…</p>${chips('phase', [...Object.keys(PHASE_LABELS), 'Not sure'], d.phase, false)}
        <label class="field"><span class="k">Your weight in kg (optional)</span><input type="number" inputmode="decimal" step="0.1" data-obk="weight" value="${esc(d.weight)}" placeholder="e.g. 72.5"></label>
        <p class="label">What do you have?</p>${chips('equipment', EQUIPMENT, d.equipment, true)}`;
      break;
    case 'life':
      body = `<h2 class="display ob-q">Your life right now</h2>
        <p class="label">How many days a week can you train?</p>${chips('perWeek', PER_WEEK, d.perWeek, false)}
        <p class="muted small">You'll do three sessions, A, B and C, in turn on whatever days you can. No fixed weekdays.</p>
        <p class="label">Best time to train</p>${chips('time', TIMES, d.time, false)}
        <p class="label">How often do you travel?</p>${chips('travel', TRAVEL, d.travel, false)}
        <p class="label">What usually gets in the way?</p>${chips('obstacles', OBSTACLES, d.obstacles, true)}
        <textarea class="log-text" rows="2" maxlength="300" data-obk="obstaclesNote" placeholder="Anything else? (optional)">${esc(d.obstaclesNote)}</textarea>`;
      break;
    case 'tone':
      body = `<h2 class="display ob-q">How should the System talk to you?</h2>
        <p class="muted">Pick one or more.</p>${chips('tone', TONES, d.tone, true)}`;
      break;
    case 'ai':
      body = `<h2 class="display ob-q">Connect your AI</h2>
        <p>The System's personal messages, journal reflections, coaching chat and custom plans come from an AI. Paste an API key from <b>Claude</b>, <b>Gemini</b>, <b>OpenAI</b>, <b>OpenRouter</b> or <b>Groq</b> and the app works out which one it is. That company bills your account for what you use, usually a few cents a day.</p>
        <p class="muted small">Get a key: ${keyLinks()}. It is stored only on this device.</p>
        <label class="field"><span class="k">API key</span><input type="password" data-obk="key" placeholder="${AI.hasKey() && ob.key == null ? '•••••••• saved on this device' : 'Paste your API key'}" autocomplete="off" spellcheck="false" value="${esc(ob.key ?? '')}"></label>
        <p class="muted small">Another service that works like OpenAI? Add it in Settings after the intro. Everything else in the app works without a key.</p>`;
      next = 'Save and continue';
      break;
    case 'done': {
      const hasKey = AI.hasKey();
      body = `<p class="sys-line center">[System]</p>
        <h2 class="display ob-hero small">Profile saved</h2>
        <p class="center ob-lead">${esc(d.name || 'Player')}, your goal: <b>${esc(d.goal || 'lock in every day')}</b>${d.deadline && d.deadline !== 'No deadline' ? ` in ${esc(d.deadline)}` : ''}.</p>
        ${
          hasKey
            ? ob.busy
              ? `<div class="thinking center"><span class="dots"><i></i><i></i><i></i></span> The System is designing your personal plan. This can take up to a minute…</div>`
              : ob.plan
                ? planPreviewHTML(ob.plan, 'ob')
                : `<p class="center muted">The System can now adjust your training plan to your goal, level and schedule.</p>
                   ${ob.error ? `<p class="error center">${esc(ob.error)}</p>` : ''}
                   <button class="btn primary block" data-ob="plan">${icon('system')} Personalise my plan</button>`
            : `<p class="center muted">You're using the original plan. Connect an AI any time in Settings for personal coaching.</p>`
        }`;
      next = ob.plan ? 'Keep original plan' : 'Enter';
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

async function onboardClick(e) {
  const b = e.target.closest('[data-ob]');
  if (!b || !ob || b.disabled) return;
  const d = ob.draft;
  const act = b.dataset.ob;
  if (act === 'pick') {
    if (b.dataset.k === 'goalIdea') d.goal = b.dataset.v;
    else d[b.dataset.k] = d[b.dataset.k] === b.dataset.v ? '' : b.dataset.v;
    renderOnboard();
  } else if (act === 'multi') {
    const list = d[b.dataset.k];
    const i = list.indexOf(b.dataset.v);
    if (i >= 0) list.splice(i, 1);
    else list.push(b.dataset.v);
    renderOnboard();
  } else if (act === 'inc') {
    d[b.dataset.k] = Math.max(0, (Number(d[b.dataset.k]) || 0) + Number(b.dataset.d));
    const input = b.parentElement.querySelector('input');
    if (input) input.value = d[b.dataset.k];
  } else if (act === 'back') {
    ob.step = Math.max(ob.fromSettings ? 1 : 0, ob.step - 1);
    renderOnboard();
  } else if (act === 'next') {
    if (OB_STEPS[ob.step] === 'goal' && !d.goal.trim()) {
      toast('Write your goal first, even one line.');
      return;
    }
    if (OB_STEPS[ob.step] === 'ai') {
      if (ob.key != null) saveKey(ob.key);
      const { perWeek, phase, weight, ...profile } = d;
      if (perWeek) S.state.settings.perWeek = Number(perWeek);
      if (PHASE_LABELS[phase] && S.state.body.phase !== PHASE_LABELS[phase]) S.setPhase(PHASE_LABELS[phase]);
      if (weight) S.addBodyEntry({ weight });
      S.saveProfile({ ...profile, name: d.name.trim(), goal: d.goal.trim(), why: d.why.trim(), obstaclesNote: d.obstaclesNote.trim() });
    }
    ob.step = Math.min(OB_STEPS.length - 1, ob.step + 1);
    renderOnboard();
  } else if (act === 'sign-in') {
    // Signing in brings back the profile, so the intro won't be needed.
    closeOnboarding();
    app.go('settings');
  } else if (act === 'skip-all') {
    S.saveProfile({ skipped: true });
    closeOnboarding();
  } else if (act === 'plan') {
    ob.busy = true;
    ob.error = '';
    renderOnboard();
    try {
      ob.plan = await AI.proposePlan('This is my first day. Personalise the plan to my goal, starting level, equipment and schedule from my profile.');
    } catch (err) {
      ob.error = err.message;
    }
    ob.busy = false;
    renderOnboard();
  } else if (act === 'apply-plan') {
    S.applyPlan(ob.plan);
    toast('Personal plan applied. Arise.');
    closeOnboarding();
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
  const planned = S.suggestedFor(k);
  const quest = planned === 'rest' ? 'Rest and recover.' : `${S.workouts()[planned].name} is waiting.`;
  const goal = p?.goal ? ` Everything leads to: “${p.goal}”.` : '';
  return `${name}. ${streak ? `${streak}-day streak.` : 'Day one starts now.'} ${quest}${goal}`;
}

export function systemMessageCard() {
  const cached = S.state.ai.daily[S.todayKey()];
  const hasKey = AI.hasKey();
  let body;
  if (cached) {
    body = `<p class="sysmsg-text">${esc(cached.message)}</p>${cached.focus ? `<p class="sysmsg-focus">${icon('target')} ${esc(cached.focus)}</p>` : ''}`;
  } else if (hasKey && briefing.loading) {
    body = `<p class="sysmsg-text">${esc(localMessage())}</p><div class="thinking"><span class="dots"><i></i><i></i><i></i></span> Writing today's message…</div>`;
  } else {
    body = `<p class="sysmsg-text">${esc(localMessage())}</p>`;
    if (briefing.error) body += `<p class="error small">${esc(briefing.error)} <button class="link" data-act="ai-daily">Try again</button></p>`;
    else if (!hasKey) body += `<p class="muted small">Personal daily messages come from your AI coach. <button class="link" data-act="nav" data-v="settings">Connect it →</button></p>`;
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
  if (AI.hasKey() && S.state.settings.aiDaily && !S.state.ai.daily[S.todayKey()] && !briefing.loading && !briefing.error) loadBriefing();
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

export function goalBanner() {
  const p = S.state.profile;
  if (p?.goal) return '';
  return `<button class="panel banner goal-banner" data-act="onboard">
    <span>${icon('target')}</span>
    <span><b>Set your long-term goal</b><small>2-minute intro. The System uses it for your messages, reflections and plan.</small></span>
    <span class="go">Start →</span>
  </button>`;
}

export const goalLine = () => (S.state.profile?.goal ? `<p class="goal-line">${icon('target')} <span>${esc(S.state.profile.goal)}</span></p>` : '');

// =====================================================================
// Daily log reflection
// =====================================================================

let reflecting = null; // AbortController while streaming

export function reflectionBlock(k) {
  const log = S.state.logs[k] || {};
  const hasEntry = log.e || (log.t && log.t.trim());
  const hasKey = AI.hasKey();
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
    text: 'Do a deep review of all my data since I started: consistency patterns (which days and situations I skip), what goes with high or low energy in my log, strength trends per exercise, and the 3 most important changes for the next month.',
  },
  { label: "I'm travelling", text: "I'm travelling or my schedule is different this week. Adapt today's and this week's training to what I can realistically do. Keep it short." },
  { label: 'I missed days', text: 'I missed training recently. Help me restart today without guilt: the smallest version that keeps me moving, and what to do this week.' },
  { label: 'What should I focus on?', text: "Based on my goal and my data, what's the single most important thing to focus on this month, and why?" },
];

let chatState = { busy: false, controller: null, text: '' };

function bubble(m, i) {
  if (m.role === 'user') return `<div class="msg user"><div class="bubble">${esc(m.text).replace(/\n/g, '<br>')}</div></div>`;
  return `<div class="msg ai ${m.error ? 'err' : ''}"><div class="bubble">${m.error ? `<p>${esc(m.text)}</p>` : md(m.text)}</div></div>`;
}

export function renderCoach(root) {
  const hasKey = AI.hasKey();
  const prov = AI.provider();
  const log = S.state.ai.chat;
  const msgs = log.map(bubble).join('');
  const live = chatState.busy
    ? `<div class="msg ai"><div class="bubble" id="streamBubble">${chatState.text ? md(chatState.text) : '<div class="thinking"><span class="dots"><i></i><i></i><i></i></span> The System is thinking…</div>'}</div></div>`
    : '';
  const empty = !log.length && !chatState.busy;
  root.innerHTML = `
    <header class="page-head">
      <div><p class="kicker">${hasKey && prov && prov.id !== 'custom' ? `${esc(prov.name)} · your AI coach` : 'Your AI coach'}</p><h1 class="display">The System</h1></div>
      ${log.length && !chatState.busy ? `<button class="btn small ghost" data-act="ai-clear">New chat</button>` : ''}
    </header>
    ${questBar()}
    <div class="cols coach-cols">
      <div class="col">
        <section class="panel chat glow">
          <div class="chat-log" id="chatLog">
            ${
              empty
                ? `<div class="chat-empty"><p class="sys-line">[System]</p><p>Ask me anything about your training, your goal or your week. I can see your plan, your workouts, your streaks and your daily log.</p>${hasKey ? '' : connectHint('The coach needs an AI connected.')}</div>`
                : msgs + live
            }
          </div>
          <form class="chat-input" id="chatForm" autocomplete="off">
            <textarea id="chatText" rows="1" placeholder="${hasKey ? 'Message the System…' : 'Connect an AI in Settings to chat'}" ${hasKey ? '' : 'disabled'} enterkeyhint="send"></textarea>
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
          <p class="small">Replies come from ${esc(AI.modelLabel())}. Your plan, workouts and daily log are sent to ${esc(prov?.company || 'your AI service')} only when you ask something here. The deep review sends your whole history.</p>
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
  const hasKey = AI.hasKey();
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

export function settingsPanels() {
  const hasKey = AI.hasKey();
  if (hasKey && AI.provider() && keyState.models === null && !keyState.loadingModels) setTimeout(() => loadModels(), 0);
  const st = S.state.settings;
  const u = S.state.ai.usage;
  const p = S.state.profile;
  const prov = AI.provider();
  const detected = AI.detectProvider(AI.getKey());
  const cost = AI.usageCost();
  const list = keyState.models || [];
  const rec = AI.recommendedModel();
  const recommended = rec ? (rec === AI.MODEL ? 'Claude Opus 5.5' : rec) : '';
  const options = [...new Set([st.aiModel, ...list].filter((m) => m && (m !== rec || st.aiModel === m)))];
  const other = (u.otherIn || 0) + (u.otherOut || 0);
  return `
    <section class="panel glow" id="aiSettings">
      <div class="panel-title">${icon('system')}<span>AI coach</span></div>
      <p>The System's messages, reflections, coaching and custom plans come from an AI you connect with your own API key: Claude, Gemini, OpenAI, OpenRouter, Groq, or any service that works like OpenAI. That company bills your account for what you use.</p>
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
        hasKey && prov
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
      <button class="toggle-row" data-act="toggle-setting" data-k="aiDaily" aria-pressed="${!!st.aiDaily}"><span><b>Daily System message</b><small>Writes a personal message on the Today screen once a day.</small></span><span class="switch ${st.aiDaily ? 'on' : ''}"></span></button>
      <p class="muted small">Used so far on this device: ${u.calls} request${u.calls === 1 ? '' : 's'}.${cost > 0 ? ` Claude: about $${cost < 0.01 ? '0.01' : cost.toFixed(2)}.` : ''}${other ? ` Other services: ${tokens(other)} tokens (their dashboard shows the cost).` : ''} Your profile, plan, workouts, weigh-ins and daily log go to ${esc(prov?.company || 'the AI service')} when you use an AI feature, and once a day for the daily message if it's on.</p>
    </section>
    <section class="panel">
      <div class="panel-title">${icon('target')}<span>Your goal</span></div>
      ${
        p?.goal
          ? `<p class="goal-line">${icon('target')} <span>${esc(p.goal)}${p.deadline && p.deadline !== 'No deadline' ? ` · ${esc(p.deadline)}` : ''}</span></p>${p.why ? `<p class="muted">${esc(p.why)}</p>` : ''}`
          : '<p class="muted">Not set yet.</p>'
      }
      <button class="btn ghost small" data-act="onboard" data-from="settings">${p?.goal ? 'Edit goal and profile' : 'Set my goal'}</button>
    </section>`;
}

export function reminderAIBlock() {
  const n = S.state.ai.nudges;
  if (!AI.hasKey()) return `<p class="muted small">Connect an AI to have the reminder texts written for your goal.</p>`;
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
      if (!AI.provider()) {
        toast('Key saved. Now pick which AI service it is for.');
        app.render();
        return true;
      }
      toast(`Key saved. Connecting to ${AI.provider().name}…`);
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

