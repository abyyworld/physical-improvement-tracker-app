// Screens and panels for the AI coach ("the System"): the intro (the life check-in, then a goal if
// they want one) and the life check-in on its own, the daily System message, check-in reflections,
// the coach chat, plan personalisation and the AI settings.

import { EXERCISES } from './program.js';
import * as S from './store';
import * as AI from './ai.js';
import * as Device from './lib/on-device';
import * as F from './lib/free-ai';
import * as G from './lib/goals';
import * as LC from './lib/life-check';
import * as GOALS from './goals-ui.js';
import * as LOCAL from './local-ai-ui.js'; // "Your computer's AI" in Settings, AI coach
import { esc, icon, md, toast, openSheet, setBackgroundInert } from './ui.js';
import { isNative } from './native.js';
import { configured as syncConfigured } from './sync';
import { w, isSystem } from './words';

let app = { go: () => {}, render: () => {}, view: () => 'today' };
export function initSystem(hooks) {
  app = { ...app, ...hooks };
  LOCAL.initLocalUI(app);
}

const $ = (sel, root = document) => root.querySelector(sel);
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
// Links to get a key from each service with a sign-up page: the free ones, or the paid ones.
const keyLinks = (free) =>
  Object.values(AI.PROVIDERS)
    .filter((x) => x.keyUrl && x.free === free && x.web !== 'no')
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
// Intro: the person first (the life check-in), then a goal if they want one ("Awakening")
// =====================================================================

const DEADLINES = ['3 months', '6 months', '1 year', '2 years', 'No deadline'];
const EQUIPMENT = ['Pull-up bar', 'Resistance bands', 'Door anchor', 'Backpack + weights', 'Step', 'Chair', 'Bed or sofa'];
const TIMES = ['Morning', 'Midday', 'Evening', 'It changes'];
const TRAVEL = ['Rarely', 'Sometimes', 'Often'];
const OBSTACLES = ['Distraction / ADHD', 'Irregular schedule', 'Travel', 'Low energy', 'Motivation dips', 'Uni or work pressure', 'Sport or training', 'Sleep', 'Family or caring'];
const TONES = ['Calm and kind', 'Strict coach', 'Funny', 'Faith-centred (Islam)', 'The System (Solo Leveling)'];
const PISTOL = ['Not yet', 'With support', 'Yes'];
const PER_WEEK = ['4', '5', '6'];
const PHASE_LABELS = { Bulking: 'bulk', Cutting: 'cut', Maintaining: 'maintain' };
// Under the quests to pick, when the part of life rated lowest is one a long list would make worse.
const QUEST_HINT = {
  sleep: 'You said sleep is rough right now, so start with one or two. You can add more once they stick.',
  mind: "You said you're carrying a lot right now, so start with one or two. You can add more once they stick.",
  fun: "You said there's little rest in your days right now, so start with one or two. You can add more once they stick.",
};

let ob = null; // { step, draft, busy, error, fromSettings, checkin, goalId }

// The questions, in order. The life check-in (from Today or You) is only the two life questions.
// Editing the profile from Settings skips the goal (goals are edited on the Goals tab). A goal is
// optional: its questions only come up once one is typed, and the workout questions only for
// people who pick the workout plan.
function obSteps() {
  if (ob.checkin) return ['check', 'grow', 'done'];
  if (ob.fromSettings) return ['name', 'check', 'grow', 'life', 'tone', 'done'];
  const g = ob.draft.goal.trim();
  return ['intro', 'name', 'check', 'grow', 'goal', ...(g ? ['why', 'quests'] : []), ...(g && ob.draft.workouts ? ['start'] : []), 'life', 'tone', 'ai', 'done'];
}

export function needsOnboarding() {
  return !S.state.profile?.onboarded;
}

// `checkin`: only the life check-in (how each part of life is going, where to grow), any time.
export function startOnboarding({ fromSettings = false, checkin = false } = {}) {
  const p = S.state.profile || {};
  const life = p.life || {};
  const quests = G.TEMPLATES.other.quests.map((q) => q.title);
  ob = {
    step: 0,
    fromSettings: fromSettings && !checkin,
    checkin,
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
      tone: p.tone || [isSystem() ? 'The System (Solo Leveling)' : 'Calm and kind'],
      perWeek: String(S.state.settings.perWeek || 5),
      phase: S.state.body.phase ? S.PHASES[S.state.body.phase].label : '',
      weight: '',
      // The life check-in, starting from the last one.
      areas: { ...(life.areas || {}) },
      grow: [...(life.grow || [])],
      values: [...(life.values || [])],
      hope: life.hope || '',
    },
  };
  let el = $('#onboard');
  if (!el) {
    el = document.createElement('div');
    el.id = 'onboard';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    document.body.append(el);
    el.addEventListener('click', onboardClick);
    el.addEventListener('input', onboardInput);
  }
  el.setAttribute('aria-label', ob.checkin ? 'Life check-in' : ob.fromSettings ? 'Edit your profile' : 'Set up Arise');
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

// Editing the profile from Settings, or a life check-in, can be cancelled at any step (Escape or
// the close button). The first intro can't: it has its own "Skip the intro".
const canClose = () => !!ob && (ob.fromSettings || ob.checkin);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && canClose() && !ob.busy) closeOnboarding();
});

const chips = (name, options, selected, multi, labels = {}) =>
  `<div class="chips ob-chips" role="group">${options
    .map((o) => {
      const on = multi ? selected.includes(o) : selected === o;
      return `<button class="chip ${on ? 'on' : ''}" data-ob="${multi ? 'multi' : 'pick'}" data-k="${name}" data-v="${esc(o)}" aria-pressed="${on}">${esc(labels[o] || o)}</button>`;
    })
    .join('')}</div>`;

// The life check-in's chips (where to grow, what matters): `kind` is the tap's action.
const picks = (kind, options, selected, label, labels = {}) =>
  `<div class="chips ob-chips" role="group" aria-label="${esc(label)}">${options
    .map((o) => {
      const on = selected.includes(o);
      return `<button class="chip ${on ? 'on' : ''}" data-ob="${kind}" data-v="${esc(o)}" aria-pressed="${on}">${esc(labels[o] || o)}</button>`;
    })
    .join('')}</div>`;

// One part of life to rate from 1 to 5. Its word ("· Not great") shows once it's rated.
const rateLabel = (id, n) => `${esc(LC.AREAS[id].label)}${n ? ` <span class="muted">· ${LC.SCALE[n - 1]}</span>` : ''}`;
const rateRow = (id, n) => {
  const a = LC.AREAS[id];
  return `<div class="ob-rate">
      <p class="label" data-rated="${id}">${rateLabel(id, n)}</p>
      <small class="muted">${esc(a.hint)}</small>
      <div class="log-energy" role="group" aria-label="${esc(a.label)}">${[1, 2, 3, 4, 5]
        .map((v) => `<button class="${n === v ? 'on' : ''}" data-ob="rate" data-k="${id}" data-v="${v}" aria-pressed="${n === v}" aria-label="${esc(a.label)}: ${LC.SCALE[v - 1]}">${v}</button>`)
        .join('')}</div>
    </div>`;
};

// Taps in the life check-in change the buttons in place, so a long list doesn't jump back to
// the top (and the button keeps the focus).
function syncPressed(kind, isOn) {
  for (const b of document.querySelectorAll(`#onboard [data-ob="${kind}"]`)) {
    const on = isOn(b);
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  }
}

// Anything answered in the life check-in.
const lifeAnswered = (d) => !!(Object.keys(d.areas).length || d.grow.length || d.values.length || d.hope.trim());

// What they see after the life check-in: where they are, in plain words (life-check.ts).
function startingPoint(d, goal = '', label = true) {
  const lines = LC.firstRead({ areas: d.areas, grow: d.grow, values: d.values }, goal, isSystem() ? { coach: 'The System', tab: w('youTab') } : { tab: w('youTab') });
  if (!lines.length) return '';
  return `${label ? '<p class="label">Your starting point</p>' : ''}<ul class="changes ob-read">${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`;
}

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
      body = isSystem()
        ? `<p class="sys-line center">[System]</p>
        <h1 class="display ob-hero">Arise</h1>
        <p class="ob-lead center">You have been chosen to become the strongest version of yourself.</p>
        <p class="center muted">The System reads your whole life, not one goal: rate where you stand, check in each day, and take on quests your life can carry. About 3 minutes. You can change everything later.</p>`
        : `<h1 class="display ob-hero">Arise</h1>
        <p class="ob-lead center">A private coach for your whole life, not just one goal.</p>
        <ul class="ob-points">
          <li>${icon('note')}<span><b>Your days, written for you</b>A 20-second check-in, and Arise fills in the rest from your phone, calendar and apps if you connect them.</span></li>
          <li>${icon('heart')}<span><b>See what helps</b>After a week or so, Arise shows what goes with your good days: sleep, people, work, money and more.</span></li>
          <li>${icon('chat')}<span><b>A coach that sees the whole you</b>Not just one goal. It's honest, it can question a goal, and it never nags. Nobody else can read it.</span></li>
        </ul>
        <p class="center muted small">About 3 minutes. You can change everything later.</p>`;
      body += `
        ${syncConfigured ? '<p class="center"><button class="link" data-ob="sign-in">Already have an account? Sign in</button></p>' : ''}`;
      next = isSystem() ? 'Begin' : 'Get started';
      break;
    case 'name':
      body = `<h2 class="display ob-q">${isSystem() ? 'What should the System call you?' : 'What should we call you?'}</h2>
        <label class="field"><span class="k">Your name</span><input type="text" maxlength="24" data-obk="name" value="${esc(d.name)}" placeholder="${w('namePlaceholder')}" autocomplete="nickname" enterkeyhint="next"></label>`;
      break;
    case 'check':
      body = isSystem()
        ? `<p class="sys-line">[System] Status check</p>
        <h2 class="display ob-q">Where do you stand?</h2>
        <p class="muted">Rate each part of your life from 1 (hard) to 5 (great). The System reads all of it before it gives you a quest.</p>`
        : `<h2 class="display ob-q">How is your life right now?</h2>
        <p class="muted">Rate each part from 1 (hard) to 5 (great). No right answers. Skip any you like.</p>`;
      body += `${LC.AREA_IDS.map((id) => rateRow(id, d.areas[id])).join('')}
        <p class="muted small">This stays in Arise. Only you and the AI coach you pick see it.</p>`;
      break;
    case 'grow': {
      const low = LC.lowest(d.areas);
      body = isSystem()
        ? `<p class="sys-line">[System] Growth path</p>
        <h2 class="display ob-q">Where do you want to grow?</h2>
        <p class="muted">Pick up to two. The System pays extra attention to them, and still watches the rest.</p>`
        : `<h2 class="display ob-q">Where do you want to grow?</h2>
        <p class="muted">Pick up to two parts of your life. Arise and your coach pay extra attention to them, and still look after the rest.</p>`;
      body += `${low.length ? `<p class="small muted">Lowest right now: ${low.map((id) => `${esc(LC.AREAS[id].label)} (${d.areas[id]})`).join(' and ')}.</p>` : ''}
        ${picks('grow', LC.AREA_IDS, d.grow, 'Where you want to grow', Object.fromEntries(LC.AREA_IDS.map((id) => [id, LC.AREAS[id].label])))}
        <p class="label">What would make the next year a great one for you?</p>
        <textarea class="log-text" rows="2" maxlength="300" data-obk="hope" placeholder="e.g. Feel fit, finish my degree and see my family more. (optional)">${esc(d.hope)}</textarea>
        <p class="label">What matters most to you? <span class="muted">Up to three.</span></p>
        ${picks('value', LC.VALUES, d.values, 'What matters most to you')}`;
      break;
    }
    case 'goal':
      body = `<h2 class="display ob-q">Anything you're working toward?</h2>
        <p class="muted">Optional. A goal helps when something matters enough to work on. Leave it empty and Arise still writes your days and helps you grow.</p>
        <p class="label">What kind of goal?</p>${chips('category', CATEGORY_IDS, d.category, false, CATEGORY_LABELS)}
        <textarea class="log-text" rows="3" maxlength="120" data-obk="goal" placeholder="e.g. ${esc(t.examples[0])}">${esc(d.goal)}</textarea>
        <p class="label">Ideas</p>${chips('goalIdea', t.examples, '', false)}
        <p class="label">By when?</p>${chips('deadline', DEADLINES, d.deadline, false)}`;
      break;
    case 'why':
      body = `<h2 class="display ob-q">Why does it matter to you?</h2>
        <p class="muted">On the days you don't feel like it, ${w('coach')} will remind you of this.</p>
        <textarea class="log-text" rows="4" maxlength="600" data-obk="why" placeholder="e.g. I want to feel confident, be disciplined, and prove to myself I can stay consistent.">${esc(d.why)}</textarea>`;
      break;
    case 'quests': {
      const hint = QUEST_HINT[LC.lowest(d.areas)[0]];
      body = `<h2 class="display ob-q">Your daily quests</h2>
        <p class="muted">Small actions you'll tick off. Pick a few; you can change them, add your own or let ${w('coach')} suggest some later.</p>
        ${chips('quests', t.quests.map((q) => q.title), d.quests, true, Object.fromEntries(t.quests.map((q) => [q.title, `${q.title} · ${G.scheduleText(q.schedule)}${q.amount ? `, ${q.amount.target} ${q.amount.unit}` : ''}`])))}
        ${hint ? `<p class="small muted">${esc(hint)}</p>` : ''}
        ${
          d.category === 'fitness'
            ? `<button class="toggle-row" data-ob="workouts" aria-pressed="${!!d.workouts}"><span><b>Use Arise's home workout plan</b><small>Three sessions in turn (A, B, C) with sets, reps, a rest timer and how-to videos. Needs resistance bands and a backpack; a pull-up bar is best.</small></span><span class="switch ${d.workouts ? 'on' : ''}"></span></button>`
            : ''
        }`;
      break;
    }
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
      body = `<h2 class="display ob-q">How your days go</h2>
        <p class="label">Best time of day for you</p>${chips('time', TIMES, d.time, false)}
        <p class="label">How often do you travel?</p>${chips('travel', TRAVEL, d.travel, false)}
        <p class="label">What usually gets in the way?</p>${chips('obstacles', OBSTACLES, d.obstacles, true)}
        <textarea class="log-text" rows="2" maxlength="300" data-obk="obstaclesNote" placeholder="Anything else? (optional)">${esc(d.obstaclesNote)}</textarea>`;
      break;
    case 'tone':
      body = `<h2 class="display ob-q">How should ${w('coach')} talk to you?</h2>
        <p class="muted">Pick one or more.</p>${chips('tone', TONES, d.tone, true)}`;
      if (ob.fromSettings) next = 'Save';
      break;
    case 'ai':
      body = `<h2 class="display ob-q">Your AI coach</h2>
        <p>${isSystem() ? "The System's" : "Your coach's"} daily message, check-in reflections, chat and quest ideas come from an AI. Patterns on the ${w('youTab')} tab are worked out on this device, with no AI. Yours stays private:</p>
        <ul class="changes">
          <li><b>Private AI</b>: encrypted to a sealed, verified enclave, so nobody can read it. Free with an account (Settings, Account).</li>
          <li><b>On this device</b>: on a laptop with Chrome, it can run right here. Nothing leaves your computer.</li>
        </ul>
        <details class="other"><summary>Or link a free AI key (Gemini, Groq…) or your own</summary>
          <p class="small">Less private: that company can read what the coach sends it. Free keys: ${keyLinks(true)}. Paid: ${keyLinks(false)}. You can link more in Settings, and the coach switches to the next one when a key hits its limit. Keys are stored only on this device.</p>
          <label class="field"><span class="k">API key</span><input type="password" data-obk="key" placeholder="${AI.hasKey() && ob.key == null ? '•••••••• saved on this device' : 'Paste your API key'}" autocomplete="off" spellcheck="false" value="${esc(ob.key ?? '')}"></label>
        </details>`;
      next = 'Save and continue';
      break;
    case 'done': {
      const sys = isSystem();
      if (ob.checkin) {
        // The life check-in on its own: where they are now, and what moved since the last one.
        const p = S.state.profile || {};
        const saved = lifeAnswered(d);
        const moved = saved ? LC.changesSince(p.life, p.lifeBefore) : '';
        body = `<h2 class="display ob-hero small">${sys ? '[Status updated]' : 'Saved'}</h2>
        <p class="center ob-lead">${saved ? "Here's where you are." : 'Nothing saved. You can check in any time.'}</p>
        ${saved ? startingPoint(d, '', false) : ''}
        ${moved ? `<p class="small">${esc(moved)}</p>` : ''}`;
        next = 'Done';
      } else if (ob.fromSettings) {
        body = `${sys ? '<p class="sys-line center">[System]</p>' : ''}<h2 class="display ob-hero small">Profile saved</h2>`;
        next = sys ? 'Enter' : 'Start';
      } else if (d.goal.trim()) {
        const g = ob.goalId ? S.goalById(ob.goalId) : null;
        // Without a name, the Arise look says "Your goal: ..." (not "You, your goal: ...").
        const who = d.name.trim() || (sys ? 'Player' : '');
        body = `${sys ? '<p class="sys-line center">[System]</p>' : ''}
        <h2 class="display ob-hero small">${sys ? 'Quest log ready' : "You're all set"}</h2>
        <p class="center ob-lead">${who ? `${esc(who)}, your goal` : 'Your goal'}: <b>${esc(d.goal.trim())}</b>${d.deadline && d.deadline !== 'No deadline' ? ` in ${esc(d.deadline)}` : ''}.</p>
        ${startingPoint(d, d.goal)}
        ${g?.quests.length ? `<ul class="changes">${g.quests.map((q) => `<li><b>${esc(q.title)}</b>: ${esc(G.scheduleText(q.schedule))}${q.amount ? `, ${esc(q.amount.target)} ${esc(q.amount.unit)}` : ''}</li>`).join('')}</ul>` : ''}
        ${
          AI.ready() && g
            ? `<button class="btn ghost block" data-ob="ai-quests">${icon('system')} Let ${w('coach')} suggest quests for this goal</button>`
            : `<p class="center muted">Today starts with your day and a quick check-in, then your quests. Add more goals any time on the Goals tab.</p>`
        }`;
        next = sys ? 'Enter' : 'Start';
      } else {
        // No goal: where they are, and what happens next.
        const who = d.name.trim() || (sys ? 'Player' : '');
        body = `${sys ? '<p class="sys-line center">[System]</p>' : ''}
        <h2 class="display ob-hero small">${sys ? 'Quest log ready' : "You're all set"}</h2>
        <p class="center ob-lead">${who ? `${esc(who)}, here's where you are.` : "Here's where you are."}</p>
        ${startingPoint(d)}
        <p class="label">What happens next</p>
        <ul class="changes">
          <li>Each day, a quick check-in: how you slept, your energy and your mood. About 20 seconds.</li>
          <li>Arise writes your day for you. Connect your phone, calendar or apps (Days, Connect apps and devices), and it fills in by itself.</li>
          <li>After a week or so, the ${w('youTab')} tab starts showing what goes with your good days.</li>
        </ul>
        <p class="center muted">Set a goal any time on the Goals tab.</p>`;
        next = sys ? 'Enter' : 'Start';
      }
      canSkip = false;
      break;
    }
  }
  const last = step === 'done';
  el.innerHTML = `<div class="ob-panel panel glow">
      ${canClose() && !last ? `<button class="icon-btn ob-close" data-ob="cancel" aria-label="Close without saving">${icon('close')}</button>` : ''}
      ${dots}
      <div class="ob-body">${body}</div>
      <div class="ob-actions">
        ${ob.step > 0 && !last ? `<button class="btn ghost" data-ob="back">Back</button>` : '<span></span>'}
        ${ob.busy ? '' : `<button class="btn primary ${last ? '' : 'xl-ish'}" data-ob="${last ? 'finish' : 'next'}">${esc(next)}</button>`}
      </div>
      ${canSkip && !last ? `<button class="link center ob-skip" data-ob="${step === 'intro' ? 'skip-all' : step === 'goal' ? 'no-goal' : 'next'}">${step === 'intro' ? 'Skip the intro' : step === 'goal' ? 'Not now' : 'Skip this question'}</button>` : ''}
    </div>`;
  el.scrollTop = 0;
  // Not on the grow question: the keyboard would cover the choices above its box.
  if (step !== 'grow') el.querySelector('input[type="text"], textarea')?.focus({ preventScroll: true });
}

function onboardInput(e) {
  const k = e.target.dataset.obk;
  if (!k || !ob) return;
  if (k === 'key') ob.key = e.target.value;
  else if (k === 'pullups' || k === 'pushups') ob.draft[k] = Math.max(0, Math.min(999, Number(e.target.value) || 0));
  else {
    ob.draft[k] = e.target.value;
    // No goal, no workout plan (its questions only come with a fitness goal).
    if (k === 'goal' && !e.target.value.trim()) ob.draft.workouts = false;
  }
}

// Arriving at the goal question: the kind of goal starts at the part of life they most want to
// grow, with its first two quests.
function enterStep() {
  const d = ob.draft;
  if (obSteps()[ob.step] === 'goal' && !d.category && d.grow[0]) {
    d.category = LC.GROW_CATEGORY[d.grow[0]];
    d.quests = G.TEMPLATES[d.category].quests.slice(0, 2).map((q) => q.title);
  }
}

// The intro's answers: the profile with the life check-in, and (the first time) the goal with its
// quests if one was typed. The workout answers are only kept with the workout plan.
function saveIntro() {
  const d = ob.draft;
  const { perWeek, phase, weight, quests, workouts, category, goal, deadline, why, pullups, pushups, pistol, equipment, areas, grow, values, hope, ...profile } = d;
  const old = S.state.profile || {};
  const today = S.todayKey();
  const answered = lifeAnswered(d);
  // A new check-in on another day keeps the last one's ratings, to show what changed.
  const life = answered
    ? {
        life: { at: today, areas: { ...areas }, grow: [...grow], values: [...values], hope: hope.trim() },
        ...(old.life && old.life.at !== today && Object.keys(old.life.areas || {}).length ? { lifeBefore: { at: old.life.at, areas: old.life.areas } } : {}),
      }
    : {};
  if (ob.checkin) {
    if (answered) S.saveProfile(life);
    return;
  }
  if (ob.fromSettings) {
    // Never writes pull-ups or equipment. A check-in left as it was keeps its date (and the one before).
    const same = old.life && JSON.stringify([LC.cleanAreas(old.life.areas), old.life.grow, old.life.values, old.life.hope]) === JSON.stringify([LC.cleanAreas(areas), grow, values, hope.trim()]);
    S.saveProfile({ ...profile, ...(same ? {} : life), name: d.name.trim(), obstaclesNote: d.obstaclesNote.trim() });
    return;
  }
  if (workouts) {
    if (perWeek) S.state.settings.perWeek = Number(perWeek);
    if (PHASE_LABELS[phase] && S.state.body.phase !== PHASE_LABELS[phase]) S.setPhase(PHASE_LABELS[phase]);
    if (weight) S.addBodyEntry({ weight });
  }
  const cat = category || 'other';
  const t = G.TEMPLATES[cat];
  const g = goal.trim()
    ? S.saveGoal({
        id: S.uid(),
        title: goal.trim(),
        category: cat,
        why: why.trim(),
        by: deadline && deadline !== 'No deadline' ? deadline : '',
        workouts: !!workouts,
        quests: t.quests.filter((q) => quests.includes(q.title)).map((q) => ({ ...q, id: S.uid(), created: today })),
      })
    : null;
  ob.goalId = g?.id || null;
  if (g) S.markIntroGoal(g);
  S.saveProfile({ ...profile, ...(workouts ? { pullups, pushups, pistol, equipment } : {}), ...life, goal: goal.trim(), why: g ? why.trim() : '', deadline: g ? deadline : '', name: d.name.trim(), obstaclesNote: d.obstaclesNote.trim() });
}

async function onboardClick(e) {
  const b = e.target.closest('[data-ob]');
  if (!b || !ob || b.disabled) return;
  const d = ob.draft;
  const act = b.dataset.ob;
  if (act === 'rate') {
    // A part of life from 1 to 5; the same number again clears it.
    const id = b.dataset.k;
    const v = Number(b.dataset.v);
    if (!LC.isArea(id) || !(v >= 1 && v <= 5)) return;
    if (d.areas[id] === v) delete d.areas[id];
    else d.areas[id] = v;
    syncPressed('rate', (x) => d.areas[x.dataset.k] === Number(x.dataset.v));
    const label = document.querySelector(`#onboard [data-rated="${id}"]`);
    if (label) label.innerHTML = rateLabel(id, d.areas[id]);
    return;
  }
  if (act === 'grow') {
    // Up to two: a third drops the one picked first.
    const v = b.dataset.v;
    if (!LC.isArea(v)) return;
    d.grow = d.grow.includes(v) ? d.grow.filter((x) => x !== v) : [...d.grow, v].slice(-2);
    syncPressed('grow', (x) => d.grow.includes(x.dataset.v));
    return;
  }
  if (act === 'value') {
    const v = b.dataset.v;
    if (d.values.includes(v)) d.values = d.values.filter((x) => x !== v);
    else if (d.values.length >= 3) {
      toast('Pick up to three.');
      return;
    } else d.values = [...d.values, v];
    syncPressed('value', (x) => d.values.includes(x.dataset.v));
    return;
  }
  if (act === 'no-goal') {
    // "Not now" on the goal question: no goal this time, even a half-typed one.
    d.goal = '';
    d.workouts = false;
  }
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
    enterStep();
    renderOnboard();
  } else if (act === 'next' || act === 'no-goal') {
    const step = steps[ob.step];
    if (step === 'ai' && ob.key != null && ob.key.trim()) {
      // The key is only kept if the Player agrees to that company reading what the coach sends.
      const id = AI.detectProvider(ob.key);
      const p = id ? AI.PROVIDERS[id] : null;
      if (!p) toast("That key isn't one the app recognises. You can add it in Settings, AI coach, where you can pick the service.");
      else if (confirm(consentText(id))) {
        AI.addKey({ provider: id, key: ob.key });
        AI.consent(id);
        S.state.settings.aiEngine = 'own';
        S.save();
      } else ob.key = null;
    }
    // The answers are saved just before the last screen.
    if (steps[ob.step + 1] === 'done') saveIntro();
    ob.step = Math.min(steps.length - 1, ob.step + 1);
    enterStep();
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
// When today's check-in was last changed in this session, so a message written before it can be
// written again.
let checkedInAt = 0;

// The message without an AI: the day's state in a line or two, then one line on a part of life
// they rated low or want to grow (a different one each day). A hard day (poor sleep, a low mood or
// no energy) asks for less.
function localMessage() {
  const p = S.state.profile || {};
  const sys = isSystem();
  const name = (p.name || S.state.settings.name || '').trim();
  const prefix = name ? `${name}. ` : sys ? 'Player. ' : '';
  const streak = S.currentStreak();
  const streakText = streak > 1 ? `${streak}-day streak. ` : '';
  const k = S.todayKey();
  const t = S.state.logs[k] || {};
  const hard = (t.s && t.s <= 2) || (t.m && t.m <= 2) || t.e === 1;
  let plan = '';
  if (S.workoutsOn() && !S.sessionsOn(k).length) {
    const planned = S.suggestedFor(k);
    plan = planned === 'rest' ? 'Rest day: recover.' : `${S.workouts()[planned].name} is waiting.`;
  }
  const q = (x) => (sys ? `[${x}]` : x);
  const left = S.questsFor(k).filter((x) => !x.done);
  const quests = left.length === 1 ? `${q(left[0].quest.title)} is waiting.` : left.length ? `${left.length} quests left today, starting with ${q(left[0].quest.title)}.` : '';
  const todo = [plan, quests].filter(Boolean).join(' ');
  const life = p.life;
  let body;
  if (hard) body = `Hard start today. Do the smallest version of one thing that matters, and let the rest wait.${plan && plan !== 'Rest day: recover.' ? ' A rest day is fine if you need one.' : ''}`;
  else if (todo) body = todo;
  else if (S.activeGoals().length) body = "Today's plan is done. The rest of the day is yours.";
  else if (!life) body = 'Start with a quick check-in on your life. It takes a minute and helps Arise see the whole picture.';
  else if (!LC.hasCheckin(t)) body = 'Start with how you are today: sleep, energy and mood, in the check-in.';
  else body = 'Thanks for checking in. Set a goal when something matters enough to work on.';
  let nudge = '';
  if (!hard && life) {
    const low = LC.lowest(life.areas);
    const list = [...new Set([...low, ...(life.grow || [])])];
    if (list.length) {
      const a = list[Math.max(0, S.daysBetween('2024-01-01', k)) % list.length];
      nudge = low.includes(a) ? LC.AREAS[a].said : `You picked ${LC.AREAS[a].label} to grow first. One small step for it today counts.`;
    }
  }
  return `${prefix}${streakText}${body}${nudge ? ` ${nudge}` : ''}`;
}

// Called when today's check-in changes (sleep, energy or mood): the coach's card says so if
// today's message was written before it.
export function noteCheckin() {
  checkedInAt = Date.now();
  refreshSysmsg();
}

export function systemMessageCard() {
  const cached = S.state.ai.daily[S.todayKey()];
  const hasKey = AI.ready();
  let body;
  if (cached) {
    body = `<p class="sysmsg-text">${esc(cached.message)}</p>${cached.focus ? `<p class="sysmsg-focus">${icon('target')} ${esc(cached.focus)}</p>` : ''}`;
    if (hasKey && checkedInAt > (cached.at || 0)) body += `<p class="muted small">You checked in after this was written. <button class="link" data-act="ai-daily" data-force="1">Write it again</button></p>`;
  } else if (hasKey && briefing.loading) {
    body = `<p class="sysmsg-text">${esc(localMessage())}</p><div class="thinking"><span class="dots"><i></i><i></i><i></i></span> Writing today's message…</div>`;
  } else {
    body = `<p class="sysmsg-text">${esc(localMessage())}</p>`;
    if (briefing.error) body += `<p class="error small">${esc(briefing.error)} <button class="link" data-act="ai-daily">Try again</button></p>`;
    else if (!hasKey) body += `<p class="muted small">Personal daily messages come from your AI coach. <button class="link" data-act="nav" data-v="settings">Turn it on →</button></p>`;
    else if (!S.state.settings.aiDaily) body += `<button class="link" data-act="ai-daily">${icon('system')} Get today's message from ${w('coach')}</button>`;
  }
  return `<section class="panel sysmsg" id="sysmsg">
    <div class="sysmsg-head"><span class="sys-line">${isSystem() ? '' : icon('system')}${w('dailyMessage')}</span>${cached && hasKey ? `<button class="icon-btn small" data-act="ai-daily" data-force="1" aria-label="New message">${icon('refresh')}</button>` : ''}</div>
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

// `asked`: the Player tapped for it, as opposed to the automatic one, which simply comes again
// after an update (so only an asked-for one holds an update back).
async function loadBriefing(force = false, asked = false) {
  briefing = { loading: true, error: '', asked };
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
  const hasEntry = LC.hasCheckin(log);
  const hasKey = AI.ready();
  return `<div class="reflect">
    ${log.ai ? `<div class="ai-reply" id="logAi"><p class="sys-line">${w('coachTag')}</p>${md(log.ai)}</div>` : `<div class="ai-reply" id="logAi" hidden></div>`}
    ${
      hasKey
        ? `<button class="btn small ghost" data-act="ai-reflect" ${reflecting ? 'disabled' : ''} ${hasEntry ? '' : 'title="Write something first"'}>${icon('system')} ${log.ai ? 'Reflect again' : `Reflect with ${w('coach')}`}</button>`
        : `<p class="muted small">Your AI coach can reflect on your entry and spot patterns over time. <button class="link" data-act="nav" data-v="settings">Connect it →</button></p>`
    }
  </div>`;
}

async function reflectToday(btn) {
  const k = S.todayKey();
  const log = S.state.logs[k] || {};
  if (!LC.hasCheckin(log)) {
    toast('Tap how you slept, your energy or your mood first, or write a few words.');
    return;
  }
  const out = $('#logAi');
  reflecting = new AbortController();
  btn.disabled = true;
  out.hidden = false;
  out.innerHTML = `<p class="sys-line">${w('coachTag')}</p><div class="thinking"><span class="dots"><i></i><i></i><i></i></span> Reading your day…</div>`;
  try {
    await AI.reflect(k, {
      signal: reflecting.signal,
      onText: (t) => {
        const el = $('#logAi');
        if (el) el.innerHTML = `<p class="sys-line">${w('coachTag')}</p>${md(t)}`;
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

// `recall`: what the coach looks up in the life log for it (sent as recallAs), instead of the
// question's own words.
const QUICK = [
  {
    label: 'Review my week',
    recall: 'the last 7 days',
    text: "Review my last 7 days as a whole: sleep, energy and mood, the people I saw, how I spent my time, and my goals. What went well, what didn't, and one change for next week.",
  },
  {
    label: 'What helps me?',
    recall: 'the last 6 weeks',
    text: 'Look across everything you can see: what goes with my good days and my hard days? Use my check-ins, the patterns Arise found and my life log. Tell me the 3 clearest patterns, how sure you are of each, and one small thing to try for each.',
  },
  {
    label: 'Deep review of everything',
    full: true,
    recall: 'the last 3 months',
    text: "Do a deep review of everything you know about me: my life check-ins, my sleep, energy and mood over time, my goals and quests, and my life log. What helps me and what drains me? Then the 3 changes that would help me most this month, even if they're not about my goals.",
  },
  {
    label: 'What would help me most?',
    recall: 'the last 4 weeks',
    text: "Looking at my whole life, not only my goals: what's the one change that would help me most this month, and why? It doesn't have to be one of my goals.",
  },
  {
    label: 'Is my goal right for me?',
    recall: 'the last 4 weeks',
    text: 'Look at my goals next to the rest of my life. Is any of them costing me too much (sleep, health, money, people), or not really what I care about? Be honest, and ask me before you suggest changing one.',
  },
  { label: 'Hard day', recall: 'the last 2 days', text: 'Today is hard. Help me make it a lighter day: the one smallest thing worth doing, and how to look after myself tonight. No pep talk.' },
  { label: 'Busy week', text: "I'm travelling or my schedule is different this week. Adapt today's and this week's quests to what I can realistically do, and make sure I still rest. Keep it short." },
  { label: 'I missed days', text: "I missed days recently. Help me restart without guilt: first ask what got in the way if you can't see it in my data, then the smallest version of my quests that keeps me moving this week." },
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
    ? `<div class="msg ai"><div class="bubble" id="streamBubble">${chatState.text ? md(chatState.text) : `<div class="thinking"><span class="dots"><i></i><i></i><i></i></span> ${isSystem() ? 'The System is thinking…' : 'Thinking…'}</div>`}</div></div>`
    : '';
  const empty = !log.length && !chatState.busy;
  root.innerHTML = `
    <header class="page-head">
      <div><p class="kicker">${hasKey ? `${esc(AI.isPrivate() ? 'Private' : AI.engine() === 'free' ? 'Free AI' : AI.keys().length > 1 ? 'Your AI keys' : prov?.id && prov.id !== 'custom' ? prov.name : 'Your AI')} · your AI coach` : 'Your AI coach'}</p><h1 class="display">${w('coachTitle')}</h1></div>
      ${log.length && !chatState.busy ? `<button class="btn small ghost" data-act="ai-clear">New chat</button>` : ''}
    </header>
    ${questBar()}
    <div class="cols coach-cols">
      <div class="col">
        <section class="panel chat glow">
          <div class="chat-log" id="chatLog">
            ${
              empty
                ? `<div class="chat-empty"><p class="sys-line">${w('coachTag')}</p><p>Ask me anything: your goals, your days or what's on your mind. I look at the whole picture: your check-ins, how you rate your life, your goals, quests and workouts, and your life log as far as your privacy settings let this AI read it.</p>${hasKey ? '' : connectHint('The coach needs its AI turned on.')}</div>`
                : msgs + live
            }
          </div>
          <form class="chat-input" id="chatForm" autocomplete="off">
            <textarea id="chatText" rows="1" placeholder="${hasKey ? `Message ${w('coach')}…` : 'Turn on the AI coach in Settings to chat'}" ${hasKey ? '' : 'disabled'} enterkeyhint="send"></textarea>
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
            ${S.workoutsOn() ? '<button class="quick-btn" data-act="nav" data-v="plan">Personalise my workout plan →</button>' : ''}
          </div>
        </section>
        <section class="panel small-print">
          <p class="small">Replies come from ${esc(AI.engineLabel())}. ${
            AI.isPrivate()
              ? 'What you send stays private: nobody else can read it.'
              : AI.engine() === 'free'
                ? `Less private: your goals, check-ins, life check-in, workouts and notes go to Cloudflare's servers, which can read them, whenever the coach answers you, here or on Today. Your life log goes too only if you allowed it. The deep review sends your whole history. <button class="link small" data-act="ai-learn">Learn more</button>`
                : `Less private: your goals, check-ins, life check-in, workouts and notes are sent to ${esc(companies(prov))}, who can read them, whenever the coach answers you, here or on Today. Your life log goes too only if you allowed it. The deep review sends your whole history. <button class="link small" data-act="ai-learn" data-v="keys">Learn more</button>`
          }</p>
        </section>
      </div>
    </div>`;
  const logEl = $('#chatLog');
  if (logEl) logEl.scrollTop = logEl.scrollHeight;
}

// Today's quests stay one tap away while chatting, without pushing: talking is welcome too.
function questBar() {
  const k = S.todayKey();
  const a = S.state.active;
  const sys = isSystem();
  if (a) return `<button class="panel banner resume" data-act="nav" data-v="workout"><span class="pulse"></span><span><b>${w('inProgress')}: ${esc(S.workoutName(a.workout, a))}</b><small>Talk later. Finish your sets.</small></span><span class="go">Resume →</span></button>`;
  if (!S.workoutsOn()) {
    // Goals without the workout plan: their own quests for today.
    const open = S.questsFor(k).filter((x) => !x.done);
    if (!S.activeQuests().length) {
      return sys
        ? `<button class="panel banner" data-act="nav" data-v="goals"><span>${icon('target')}</span><span><b>No quests yet.</b><small>Set a goal and pick a few small daily actions.</small></span><span class="go">Goals →</span></button>`
        : `<button class="panel banner" data-act="nav" data-v="goals"><span>${icon('target')}</span><span><b>No goal right now.</b><small>That's fine. Ask me anything, or set one when you're ready.</small></span><span class="go">Goals →</span></button>`;
    }
    if (!open.length) return `<div class="panel banner"><span>${icon('check')}</span><span><b>Today's quests are cleared.</b><small>${sys ? "Good. Use the System to plan what's next." : "Nice work. Ask your coach what's next."}</small></span></div>`;
    return `<button class="panel banner quest-bar" data-act="nav" data-v="today"><span>${icon('bolt')}</span><span><b>${open.length > 1 ? `${open.length} quests left today` : `Today's quest: ${esc(open[0].quest.title)}`}</b><small>${w('questBarSub')}</small></span><span class="go">Today →</span></button>`;
  }
  if (S.sessionsOn(k).length) return `<div class="panel banner"><span>${icon('check')}</span><span><b>Today's quest is cleared.</b><small>${sys ? 'Good. Use the System to plan the next one.' : 'Nice work. Ask your coach about the next one.'}</small></span></div>`;
  const q = S.suggestedFor(k);
  if (q === 'rest') return `<div class="panel banner"><span>${icon('moon')}</span><span><b>Rest day.</b><small>${sys ? 'Recover. Short talk, early sleep.' : 'Recover and sleep well tonight.'}</small></span></div>`;
  return `<div class="panel banner quest-bar"><span>${icon('bolt')}</span><span><b>${sys ? "Today's quest" : "Today's workout"}: ${esc(S.workouts()[q].name)}</b><small>${w('questBarSub')}</small></span><button class="btn small primary" data-act="start" data-w="${q}">Start</button></div>`;
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

// A question from another screen ("Ask the coach" on Your days, "Ask your coach" on Me): opens
// the chat and sends it. The coach looks it up in the life log as it does every question (ai.js,
// chat), or looks up `recallAs` instead ("the last 6 weeks") when the question's words wouldn't
// find the right days.
export function askCoach(text, { recallAs } = {}) {
  if (!AI.ready()) {
    toast('Turn on the AI coach in Settings first.');
    return false;
  }
  if (chatState.busy) {
    toast(`${isSystem() ? 'The System is' : 'Your coach is'} still answering. Try again in a moment.`);
    return false;
  }
  app.go('coach');
  sendChat(text, { recallAs });
  return true;
}

async function sendChat(text, { full = false, recallAs } = {}) {
  text = text.trim();
  if (!text || chatState.busy) return;
  chatState = { busy: true, controller: new AbortController(), text: '' };
  if (app.view() === 'coach') app.render();
  try {
    await AI.chat(text, {
      full,
      ...(recallAs ? { recallAs } : {}),
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

// An AI answer is on its way (an update waits for it, so the question isn't lost).
export const aiBusy = () => chatState.busy || planState.busy || !!reflecting || remindState.busy || (briefing.loading && !!briefing.asked);

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
    <p class="sys-line">${isSystem() ? '[System] Proposed plan' : 'Your coach suggests'}</p>
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
      <p class="muted small">Made by ${w('coach')} on ${esc(new Date(custom.created).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }))}.</p>
      ${custom.summary ? `<p>${esc(custom.summary)}</p>` : ''}
      ${custom.changes?.length ? `<ul class="changes">${custom.changes.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}
      <button class="btn small ghost" data-act="ai-plan-reset">Go back to the original plan</button>
    </section>`;
  }
  let body;
  if (!hasKey) body = connectHint(`${w('Coach')} can redesign this plan around your goal, schedule and progress.`);
  else if (planState.busy) body = `<div class="thinking"><span class="dots"><i></i><i></i><i></i></span> ${w('Coach')} is designing your plan. This can take up to a minute…</div>`;
  else if (planState.proposal) body = planPreviewHTML(planState.proposal, 'plan');
  else
    body = `<p class="muted">Tell ${w('coach')} what you need, or leave it empty to personalise the plan to your profile and progress.</p>
      <textarea class="log-text" id="planReq" rows="2" placeholder="e.g. Only 30 minutes on weekdays · Travelling 2 weeks with only bands · Focus on my first muscle-up">${esc(planState.request)}</textarea>
      ${planState.error ? `<p class="error small">${esc(planState.error)}</p>` : ''}
      <button class="btn primary" data-act="ai-plan">${icon('system')} Design my plan</button>
      <p class="muted small">Nothing changes until you tap Apply. Your workout history stays as it is.</p>`;
  return `${current}<section class="panel glow" id="planAI">
    <div class="panel-title">${icon('system')}<span>Personalise with ${w('coach')}</span></div>
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

let remindState = { busy: false, error: '' };

// "Your AI keys": the form that's open (adding a key, or editing one), and each key's last test.
// { mode: 'add' | 'edit', id, provider, key, model, base, models, loading, error }
let keyForm = null;
let keyTests = {}; // key id -> { busy, ok, text }

const tokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`);

// Keys only travel over HTTPS, apart from AI running on this computer (Ollama, LM Studio).
const okBase = (v) => /^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$))[^\s"'<>`]{0,300}$/.test(v);

// What the Player agrees to before a service first gets anything from the coach.
function consentText(id) {
  const p = AI.PROVIDERS[id];
  const free = F.freeService(id);
  return `Use ${p.name} for the coach? It's less private: ${p.company} can read your goal, plan, history and journal whenever the coach uses them.${free ? ` ${free.privacy}` : ''}`;
}

function renderSettings() {
  if (app.view() === 'settings') app.render();
}

async function loadKeyModels() {
  const f = keyForm;
  if (!f || f.mode !== 'edit') return;
  f.loading = true;
  f.error = '';
  renderSettings();
  try {
    f.models = await AI.listModels({ keyId: f.id });
    if (!f.models.length) f.error = 'No models came back for this key.';
  } catch (err) {
    f.models = [];
    f.error = "Couldn't load the model list. You can still type a model name.";
  }
  f.loading = false;
  if (keyForm === f) renderSettings();
}

async function testOneKey(id) {
  keyTests[id] = { busy: true, ok: false, text: '' };
  renderSettings();
  try {
    const by = await AI.testKeyEntry(id);
    keyTests[id] = { busy: false, ok: true, text: `✓ Answered by ${by}. ${isSystem() ? 'The System is online.' : 'Your coach is ready.'}` };
  } catch (err) {
    keyTests[id] = { busy: false, ok: false, text: err.message };
  }
  renderSettings();
}

const ENGINE_TEXT = {
  private: 'An open AI model in a sealed enclave. The app checks the enclave is genuine, then encrypts what it sends to it, so nobody can read it: not the people who run Arise, not the cloud it runs in. Free, with a daily limit.',
  device: 'Runs on this computer. Nothing leaves it, it works offline, and it costs nothing. Needs Chrome 148 or later on a laptop or desktop (not phones yet).',
  local: LOCAL.CARD_TEXT,
  free: "Free for you. Runs on Cloudflare's servers, which can read what the coach sends while it answers. Cloudflare says it isn't used to train AI.",
  own: 'Link free AIs like Gemini and Groq. When one hits its daily limit, the next one answers by itself. Paid keys (Claude, ChatGPT) work too. Each company can read what the coach sends it.',
};
let deviceState = { progress: null, error: '' };

function engineStatus(id) {
  if (id === 'local') return LOCAL.cardStatus();
  if (id === 'private' || id === 'free') {
    if (!AI.privateConfigured()) return { ok: false, text: 'Not switched on for this app yet.' };
    if (!AI.privateSignedIn()) return { ok: false, text: 'Needs a free account (Account, above). That keeps it for Arise players.' };
    if (id === 'free' && !AI.freeAgreed()) return { ok: false, text: 'Pick it to use it. The app asks you first.' };
    return { ok: true, text: id === 'free' ? 'Ready. Free, with a daily limit.' : 'Ready.' };
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
  if (!AI.hasKey()) return { ok: false, text: 'Add a free key to start.' };
  const rows = AI.keyRows();
  const live = rows.filter((r) => r.state !== 'off');
  if (!live.length) return { ok: false, text: rows.some((r) => r.consent) ? 'Waiting for your OK to send data to that service.' : 'None of your keys can answer right now. See below.' };
  if (live.length === 1) return { ok: true, text: `Using ${AI.modelLabel(live[0].id)}.` };
  const by = AI.answeredBy();
  return { ok: true, text: `Using ${live.length} keys, in your order.${by ? ` Last answer: ${by}.` : ''}` };
}

function engineCard(id) {
  const picked = S.state.settings.aiEngine;
  const on = picked ? picked === id : AI.engine() === id;
  const st = engineStatus(id);
  const tag = id === 'private' ? '<span class="tag gold">Recommended</span>' : id === 'own' || id === 'free' ? '<span class="tag gold">Less private</span>' : '';
  const card = `<button class="engine ${on ? 'on' : ''}" data-act="ai-engine" data-v="${id}" aria-pressed="${on}">
    <span class="engine-head"><b>${esc(AI.ENGINES[id].name)}</b>${tag}</span>
    <small>${esc(ENGINE_TEXT[id])}</small>
    <small class="${st.ok ? 'ok' : 'muted'}">${st.ok ? '✓ ' : ''}${esc(st.text)}</small>
  </button>`;
  // A button can't hold another, so "Learn more" sits right under the card.
  if (id === 'free') return `<div class="engine-group">${card}<button class="learn-more" data-act="ai-learn">Learn more: what each option can see</button></div>`;
  if (id === 'own') return `<div class="engine-group">${card}<button class="learn-more" data-act="ai-learn" data-v="keys">Learn more: what each free AI can see</button><p class="muted small">${esc(SUBSCRIPTIONS)}</p></div>`;
  return card;
}

const SUBSCRIPTIONS = 'Have ChatGPT Plus or Claude Pro? Those subscriptions only work in their own apps. For Arise, link free keys, make a paid API key, or use the private or free AI.';

// The model picker for the private and free AI, filled from the list the AI itself sends.
let engineModelState = { engine: '', list: null, loading: false, error: '' };

async function loadEngineModels(id, refresh = false) {
  engineModelState = { engine: id, list: engineModelState.engine === id ? engineModelState.list : null, loading: true, error: '' };
  if (app.view() === 'settings') app.render();
  let list = [];
  let error = '';
  try {
    list = await AI.engineModels(id, { refresh });
  } catch (err) {
    error = `Couldn't load the model list: ${err.message}`;
  }
  if (engineModelState.engine !== id) return; // switched to another AI meanwhile
  engineModelState = { engine: id, list, loading: false, error };
  if (app.view() === 'settings') app.render();
}

function engineModelPanel(id) {
  if (engineModelState.engine !== id) {
    engineModelState = { engine: id, list: null, loading: true, error: '' };
    setTimeout(() => loadEngineModels(id), 0);
  }
  const ms = engineModelState;
  const picked = S.state.settings[id === 'free' ? 'freeModel' : 'privateModel'];
  const rec = AI.recommendedEngineModel(id);
  const others = (ms.list || []).filter((m) => m !== rec);
  // A pick that isn't on the list stays shown, so nothing changes without the Player knowing.
  const gone = !!picked && picked !== rec && !others.includes(picked);
  if (gone) others.push(picked);
  const name = (m) => (gone && m === picked && ms.list?.length ? `${m} (not offered now, so the recommended one answers)` : AI.engineModelName(id, m));
  return `<div class="stack own-key">
      <label class="field"><span class="k">Model</span>
        <select id="engineModel" data-engine="${id}">
          <option value="" ${picked && picked !== rec ? '' : 'selected'}>${esc(AI.engineModelName(id, rec))}</option>
          ${others.map((m) => `<option value="${esc(m)}" ${picked === m ? 'selected' : ''}>${esc(name(m))}</option>`).join('')}
        </select>
      </label>
      ${id === 'private' ? '<p class="muted small">Bigger models can be slower, and each answer costs Arise more.</p>' : ''}
      ${AI.engine() === id && AI.memoryStrength() === 'weak' ? '<p class="muted small">This model is too small to write your memory, so Arise stops learning while you use it. It still answers you.</p>' : ''}
      ${
        ms.loading
          ? '<p class="muted small">Loading the models on offer…</p>'
          : ms.error
            ? `<p class="muted small">${esc(ms.error)} <button class="link small" data-act="ai-engine-models" data-v="${id}">Try again</button></p>`
            : ''
      }
    </div>`;
}

// "Learn more": the four options side by side, in plain words.
const AI_OPTIONS = [
  {
    name: 'Private AI',
    read: 'Nobody but you. The app checks the sealed enclave is genuine, then locks what it sends so only the AI inside can read it. Not the people who run Arise, not the cloud it runs in.',
    cost: 'Free for you. Arise pays for it.',
    needs: 'A free Arise account. There is a daily limit.',
    where: 'A sealed enclave at Tinfoil, in the cloud.',
  },
  {
    name: 'On this device',
    read: 'Nobody. Nothing leaves your computer.',
    cost: 'Free.',
    needs: 'Chrome 148 or later on a laptop or desktop. Not phones yet.',
    where: 'On your computer.',
  },
  {
    name: "Your computer's AI",
    read: 'Nobody. It runs in Ollama or LM Studio on your own computer, and nothing leaves it.',
    cost: 'Free.',
    needs: 'Ollama or LM Studio (free apps) on a laptop or desktop with 8 GB of memory or more, and Arise open on that computer. A bigger computer runs a bigger, better model.',
    where: 'On your computer.',
  },
  {
    name: 'Free AI (less private)',
    read: "Cloudflare's servers can read what the coach sends (your goal, plan, history and journal) while they answer. Cloudflare says it doesn't use it to train AI. Arise's server passes it on and keeps none of it.",
    cost: 'Free for you.',
    needs: "A free Arise account. You get a daily limit, and there's also one shared by everybody, which can run out by later in the day. Both start again at midnight UTC.",
    where: "Cloudflare's servers (Workers AI), with the same open model as the private AI.",
  },
  {
    name: 'Your AI keys (less private)',
    read: 'The company behind each key (Google, Groq, Anthropic and so on) can read what the coach sends. Some free plans let that company keep it, use it to train AI, or have people read it. The list below says which.',
    cost: 'Free keys are free, within their limits. With paid keys, that company bills you.',
    needs: 'A key from each service you link. They stay on this device.',
    where: "Each company's servers.",
  },
];

// The free AIs side by side: limits and what each one does with what it gets.
function freeAIsHTML() {
  return `<h3 class="sub">The free AIs you can link</h3>
    <p class="small">The coach tries your keys from the top. When one hits its limit, the next one answers, and the first one comes back when its limit starts again. Free limits change often; these were checked in October 2026.</p>
    ${F.FREE.map(
      (s) => `<p class="small"><b>${esc(s.name)}:</b> ${esc(s.limits)} <b>Privacy:</b> ${esc(s.privacy)} <b>Sign-up:</b> ${esc(s.signup)}</p>`,
    ).join('')}`;
}

function aiOptionsHTML(keysFirst = false) {
  if (keysFirst) {
    return `<p class="kicker">AI coach</p>
    <h2 class="display sheet-title">Your AI keys</h2>
    <p>Every option coaches you with the same data: your goal, plan, history and journal. With your own keys, the company behind each key can read it while it answers.</p>
    ${freeAIsHTML()}`;
  }
  return `<p class="kicker">AI coach</p>
    <h2 class="display sheet-title">How private is each option?</h2>
    <p>Every option coaches you with the same data: your goal, plan, history and journal. What changes is who could read it on the way.</p>
    ${AI_OPTIONS.map(
      (o) => `<h3 class="sub">${esc(o.name)}</h3>
    <p class="small"><b>Who can read it:</b> ${esc(o.read)}</p>
    <p class="small"><b>Cost:</b> ${esc(o.cost)}</p>
    <p class="small"><b>Needs:</b> ${esc(o.needs)}</p>
    <p class="small"><b>Where it runs:</b> ${esc(o.where)}</p>`,
    ).join('')}
    <h3 class="sub">Why the free AI is less private</h3>
    <p class="small">With the private AI, the app checks the enclave itself and locks each request so only the AI can open it. The free AI is an ordinary cloud service: the request is protected on the way, but Cloudflare's servers open it to answer. You're trusting Cloudflare's word, and Arise's, not a check the app can make. If that's fine for you, it's a good free option.</p>
    ${freeAIsHTML()}`;
}

// One free AI in the "Add a key" list: its limits, its privacy and where to get a key.
function freeItem(s) {
  const phoneOnly = s.web === 'no' && !isNative;
  return `<div class="free-item">
      <span class="engine-head"><b>${esc(s.name)}</b>${phoneOnly ? '<span class="tag">iPhone app only</span>' : ''}</span>
      <small>${esc(s.limits)} ${esc(s.signup)}</small>
      <small><b>Privacy:</b> ${esc(s.privacy)}</small>
      <span class="free-links"><a href="${esc(s.keyUrl)}" target="_blank" rel="noopener">Get a free key ${icon('ext')}</a><button class="link small" data-act="ai-key-pick" data-v="${s.id}">Add my ${esc(s.name)} key</button></span>
    </div>`;
}

const providerOptions = (picked, detected) => {
  const opt = (id) => `<option value="${id}" ${picked === id ? 'selected' : ''}>${esc(AI.PROVIDERS[id].label)}</option>`;
  const ids = Object.keys(AI.PROVIDERS);
  return `<option value="" ${picked ? '' : 'selected'}>${!picked && detected ? `From my key: ${esc(AI.PROVIDERS[detected].name)}` : 'Work it out from my key'}</option>
    <optgroup label="Free">${ids.filter((id) => AI.PROVIDERS[id].free).map(opt).join('')}</optgroup>
    <optgroup label="Paid, or your own">${ids.filter((id) => !AI.PROVIDERS[id].free).map(opt).join('')}</optgroup>`;
};

// The form for adding a key, or for changing one (then the key itself may stay as it is).
function keyFormHTML() {
  const f = keyForm;
  const edit = f.mode === 'edit';
  const detected = AI.detectProvider(f.key);
  const id = f.provider || detected || '';
  const p = id ? AI.PROVIDERS[id] : null;
  const row = edit ? AI.keyRows().find((r) => r.id === f.id) : null;
  const rec = edit ? AI.recommendedModel(f.id) : p?.model || '';
  return `<div class="key-form">
      <label class="field"><span class="k">AI service</span><select id="keyProvider">${providerOptions(f.provider, detected)}</select></label>
      <label class="field"><span class="k">API key</span><input id="keyIn" type="password" autocomplete="off" spellcheck="false" placeholder="${edit ? `•••• ${esc(row?.tail || '')} saved (leave empty to keep it)` : esc(p?.keyHint || 'Paste your API key')}" value="${esc(f.key)}"></label>
      ${id === 'custom' ? `<label class="field"><span class="k">API address</span><input id="keyBase" type="url" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://api.example.com/v1" value="${esc(f.base)}"></label>` : ''}
      ${
        edit
          ? `<label class="field"><span class="k">Model</span><input id="keyModel" type="text" list="keyModels" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${rec ? `Recommended: ${esc(rec)}` : 'Best one on this key'}" value="${esc(f.model)}"></label>
      <datalist id="keyModels">${(f.models || []).map((m) => `<option value="${esc(m)}"></option>`).join('')}</datalist>
      <p class="muted small">Leave the model empty for the recommended one. ${f.loading ? 'Loading the models this key can use…' : f.error ? esc(f.error) : f.models?.length ? `${f.models.length} models on this key.` : ''}</p>`
          : ''
      }
      ${p?.free ? `<p class="muted small">${esc(F.freeService(id)?.limits || '')}</p>` : ''}
      <div class="row">
        <button class="btn primary small" data-act="ai-key-save">${icon('key')} ${edit ? 'Save changes' : 'Save key'}</button>
        <button class="btn ghost small" data-act="ai-key-cancel">Cancel</button>
      </div>
    </div>`;
}

// Whether a key's model may write the memory (life/strength.ts): only strong ones do, and one Arise
// doesn't know only once the Player trusts it for that key (on this device).
function memoryNote(r) {
  if (r.memory === 'weak') return '<small class="muted key-memory">Too small to write your memory. It still answers you.</small>';
  if (r.memory !== 'unknown' && r.memory !== 'trusted') return '';
  const on = r.memory === 'trusted';
  return `<button class="toggle-row key-trust" data-act="ai-key-trust" data-id="${r.id}" aria-pressed="${on}"><span><b>Trust this model to write my memory</b><small>Arise doesn't know ${esc(r.model)}. Only turn this on for a large model: a small one's mistakes would stay in your memory.</small></span><span class="switch ${on ? 'on' : ''}"></span></button>`;
}

// "Your AI keys": the keys in the order they're tried, each with its state, and adding more.
function keysPanel() {
  const rows = AI.keyRows();
  if (!rows.length && !keyForm) keyForm = { mode: 'add', provider: '', key: '', model: '', base: '' };
  const adding = keyForm?.mode === 'add';
  const now = Date.now();
  const top = F.FREE.slice(0, 4);
  const more = F.FREE.slice(4);
  return `<div class="stack own-key keys">
      <div class="keys-head">
        <span class="engine-head"><b>Your AI keys</b><span class="tag gold">Less private</span></span>
        <p class="muted small">The coach tries them from the top. When one hits its free limit, the next one answers, and the first comes back when its limit starts again. Keys stay on this device and are never in backups.</p>
      </div>
      ${
        rows.length
          ? `<ol class="key-list">${rows
              .map((r, i) => {
                const t = keyTests[r.id];
                const editing = keyForm?.mode === 'edit' && keyForm.id === r.id;
                return `<li class="key-row ${r.state}">
              <div class="key-main">
                <span class="key-name"><b>${r.n}. ${esc(r.name)}</b>${r.model ? ` <small>${esc(r.model)}</small>` : ''}</span>
                <small class="key-status ${r.state}">${r.state === 'ready' ? '✓ ' : ''}${esc(r.text)}${r.last ? ` · Answered last at ${esc(F.when(r.last, now))}` : ''}</small>
                ${t?.text ? `<small class="${t.ok ? 'ok' : 'error'}">${esc(t.text)}</small>` : ''}
                ${memoryNote(r)}
              </div>
              <div class="key-actions">
                <button class="icon-btn small" data-act="ai-key-up" data-id="${r.id}" aria-label="Move ${esc(r.name)} up" ${i === 0 ? 'disabled' : ''}>${icon('up')}</button>
                <button class="icon-btn small key-down" data-act="ai-key-down" data-id="${r.id}" aria-label="Move ${esc(r.name)} down" ${i === rows.length - 1 ? 'disabled' : ''}>${icon('up')}</button>
                ${r.consent ? `<button class="btn primary small" data-act="ai-key-ok" data-id="${r.id}">OK, use it</button>` : ''}
                <button class="btn ghost small" data-act="ai-key-test" data-id="${r.id}" ${t?.busy ? 'disabled' : ''}>${t?.busy ? 'Testing…' : 'Test'}</button>
                <button class="btn ghost small" data-act="ai-key-edit" data-id="${r.id}" aria-expanded="${editing}">Edit</button>
                <button class="btn ghost small danger" data-act="ai-key-remove" data-id="${r.id}">Remove</button>
              </div>
              ${editing ? keyFormHTML() : ''}
            </li>`;
              })
              .join('')}</ol>`
          : ''
      }
      ${
        adding
          ? `<div class="key-add">
        <p class="label">Add a key</p>
        <p class="muted small">Free AIs, best first. Get a free key from one, then paste it below. Two or three keys keep the coach going when one runs out.</p>
        <div class="free-list">${top.map(freeItem).join('')}</div>
        <details class="other"><summary>More free AIs</summary><div class="free-list">${more.map(freeItem).join('')}</div></details>
        ${keyFormHTML()}
      </div>`
          : `<button class="btn ghost small" data-act="ai-key-add">${icon('key')} Add a key</button>`
      }
    </div>`;
}

// Who gets what the coach sends with the Player's own keys: "Google, Groq or OpenRouter".
function companies(prov) {
  const list = AI.ownCompanies();
  if (list.length < 2) return prov?.company || list[0] || 'the AI service';
  return `${list.slice(0, -1).join(', ')} or ${list[list.length - 1]} (whichever answers)`;
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
      <p>Pick where ${w('coach')} does its thinking. ${st.aiEngine ? '' : `Right now it picks for you: ${LOCAL.autoOrder()}.`}</p>
      <div class="engines" role="group" aria-label="Where the AI runs">${['private', 'device', ...(LOCAL.offered() ? ['local'] : []), 'free', 'own'].map((id) => engineCard(id)).join('')}</div>
      ${st.aiEngine ? `<button class="link small" data-act="ai-engine" data-v="">Let the app pick (${LOCAL.autoFirst()} first)</button>` : ''}
      ${LOCAL.showPanel(st.aiEngine) ? LOCAL.panel() : ''}
      ${['private', 'free'].includes(AI.engine()) ? engineModelPanel(AI.engine()) : ''}
      ${st.aiEngine === 'own' ? keysPanel() : ''}
      <button class="toggle-row" data-act="toggle-setting" data-k="aiDaily" aria-pressed="${!!st.aiDaily}"><span><b>${isSystem() ? 'Daily System message' : 'Daily message from your coach'}</b><small>Writes a personal message on the Today screen once a day.</small></span><span class="switch ${st.aiDaily ? 'on' : ''}"></span></button>
      <p class="muted small">${
        AI.engine() === 'own'
          ? `Used so far on this device: ${Number(u.calls) || 0} request${u.calls === 1 ? '' : 's'}.${cost > 0 ? ` Claude: about $${cost < 0.01 ? '0.01' : cost.toFixed(2)}.` : ''}${other ? ` Other services: ${tokens(other)} tokens (their dashboard shows the cost).` : ''} Your profile, life check-in, check-ins, plan, workouts and weigh-ins go to ${esc(companies(prov))} when you use an AI feature, and once a day for the daily message if it's on.`
          : AI.engine() === 'free'
            ? `Used so far on this device: ${Number(u.calls) || 0} request${u.calls === 1 ? '' : 's'}. Your profile, life check-in, check-ins, plan, workouts and weigh-ins go to Cloudflare's servers when you use an AI feature, and once a day for the daily message if it's on. Cloudflare can read them while it answers.`
            : AI.engine()
              ? 'Your profile, life check-in, check-ins, plan, workouts and weigh-ins are used to coach you, privately: nobody else can read them.'
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

// `live`: this device's notifications are on, so they already use the texts.
export function reminderAIBlock(live = isNative) {
  const n = S.state.ai.nudges;
  if (!AI.ready()) return `<p class="muted small">Turn on the AI coach to have the reminder texts written for your goal.</p>`;
  return `<div class="stack">
    <p class="small ${n ? 'ok' : 'muted'}">${n ? `✓ ${n.messages.length} reminder texts written by ${w('coach')} for you. ${live ? 'Your morning reminders use them.' : "They'll be used when you add reminders."}` : 'Reminder texts are generic right now.'}</p>
    ${remindState.error ? `<p class="error small">${esc(remindState.error)}</p>` : ''}
    <button class="btn ghost small" data-act="ai-reminders" ${remindState.busy ? 'disabled' : ''}>${icon('system')} ${remindState.busy ? 'Writing…' : n ? 'Write new texts' : `Write my reminder texts with ${w('coach')}`}</button>
  </div>`;
}

// =====================================================================
// Event handling (called from app.js)
// =====================================================================

export async function handleAction(act, el) {
  if (act.startsWith('local-')) return LOCAL.handleAction(act, el);
  switch (act) {
    case 'ai-engine': {
      const v = el.dataset.v;
      if (v === 'local') LOCAL.turnOn();
      if (v === 'own' && AI.hasKey() && AI.provider() && !AI.consented()) {
        const p = AI.provider();
        if (!confirm(consentText(p.id))) return true;
        AI.consent(p.id);
      }
      if (v === 'free' && !AI.freeAgreed()) {
        if (!confirm("Use the free AI? It's less private: Cloudflare's servers can read your goal, plan, history and journal while the coach answers. Cloudflare says it doesn't use it to train AI.")) return true;
        AI.agreeFree();
      }
      S.state.settings.aiEngine = v;
      S.save();
      if (v === 'device' && Device.lastKnown() === 'downloadable') downloadDeviceModel();
      app.render();
      return true;
    }
    case 'ai-learn':
      openSheet(aiOptionsHTML(el.dataset.v === 'keys'));
      return true;
    case 'onboard':
      startOnboarding({ fromSettings: el.dataset.from === 'settings' || !!S.state.profile?.onboarded });
      return true;
    case 'life-checkin':
      startOnboarding({ checkin: true });
      return true;
    case 'ai-daily':
      loadBriefing(!!el.dataset.force, true);
      return true;
    case 'ai-reflect':
      reflectToday(el);
      return true;
    case 'ai-quick': {
      const q = QUICK[Number(el.dataset.i)];
      if (q) sendChat(q.text, { full: !!q.full, recallAs: q.recall });
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
    case 'ai-key-add':
      keyForm = { mode: 'add', provider: '', key: '', model: '', base: '' };
      app.render();
      $('#keyIn')?.focus();
      return true;
    case 'ai-key-pick':
      // "Add my Groq key" in the list of free AIs.
      keyForm = { ...(keyForm || { mode: 'add', key: '', model: '', base: '' }), provider: el.dataset.v };
      app.render();
      $('#keyIn')?.focus();
      return true;
    case 'ai-key-edit': {
      const id = el.dataset.id;
      if (keyForm?.mode === 'edit' && keyForm.id === id) keyForm = null;
      else {
        const k = AI.keys().find((x) => x.id === id);
        if (!k) return true;
        keyForm = { mode: 'edit', id, provider: k.provider || AI.keyProvider(k) || '', key: '', model: AI.keyModel(k), base: AI.keyBase(k), models: null, loading: false, error: '' };
        // The list comes from the service, so only once the Player has said yes to it.
        if (AI.consented(AI.keyProvider(k))) loadKeyModels();
      }
      app.render();
      return true;
    }
    case 'ai-key-cancel':
      keyForm = null;
      app.render();
      return true;
    case 'ai-key-save':
      saveKeyForm();
      return true;
    case 'ai-key-up':
    case 'ai-key-down':
      AI.moveKey(el.dataset.id, act === 'ai-key-up' ? -1 : 1);
      app.render();
      return true;
    case 'ai-key-ok': {
      const k = AI.keys().find((x) => x.id === el.dataset.id);
      const id = AI.keyProvider(k);
      if (!id || !confirm(consentText(id))) return true;
      AI.consent(id);
      S.state.settings.aiEngine = 'own';
      S.save();
      testOneKey(k.id);
      return true;
    }
    case 'ai-key-test':
      testOneKey(el.dataset.id);
      return true;
    case 'ai-key-trust': {
      const row = AI.keyRows().find((r) => r.id === el.dataset.id);
      if (!row) return true;
      const on = row.memory !== 'trusted';
      if (on && !confirm(`Let ${row.model} write your memory? Only do this if it's a large model. You can turn it off again here.`)) return true;
      AI.trustKey(row.id, on);
      app.render();
      return true;
    }
    case 'ai-key-remove': {
      const row = AI.keyRows().find((r) => r.id === el.dataset.id);
      if (row && confirm(`Remove the ${row.name} key from this device?${AI.keys().length === 1 ? ' AI features will stop until you add one again.' : ''}`)) {
        AI.removeKey(row.id);
        delete keyTests[row.id];
        if (keyForm?.id === row.id) keyForm = null;
        app.render();
      }
      return true;
    }
    case 'ai-engine-models':
      await loadEngineModels(el.dataset.v, true);
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

// Saves the open key form: a new key at the end of the order, or changes to one. Then asks once
// per service before it gets anything, and tests the key straight away.
function saveKeyForm() {
  const f = keyForm;
  if (!f) return;
  const edit = f.mode === 'edit';
  const key = f.key.trim();
  if (!edit && !key) {
    toast('Paste your API key first.');
    return;
  }
  const old = edit ? AI.keys().find((k) => k.id === f.id) : null;
  if (edit && !old) return;
  const id = f.provider || AI.detectProvider(key || old?.key);
  if (!id) {
    toast("The app can't tell which service this key is for. Pick it under AI service.");
    return;
  }
  const base = f.base.trim().replace(/\/+$/, '');
  if (id === 'custom') {
    if (!base) {
      toast('Add the API address of your AI service first.');
      return;
    }
    if (!okBase(base)) {
      toast('Use an https:// address (or http://localhost for AI on this computer).');
      return;
    }
    if (!AI.hostConfirmed(base)) {
      const host = AI.customHost(base);
      if (!confirm(`Send your key to ${host}? Only allow this if you trust that service: it gets your API key and everything the coach sends.`)) return;
      AI.confirmHost(base);
    }
  }
  const saved = edit ? AI.updateKey(f.id, { provider: f.provider, key, model: f.model, base: id === 'custom' ? base : '' }) : AI.addKey({ provider: id, key, base: id === 'custom' ? base : '' });
  if (!saved) {
    toast("That doesn't look like an API key. Copy it again from the service's website.");
    return;
  }
  keyForm = null;
  delete keyTests[saved.id];
  S.state.settings.aiEngine = 'own';
  S.save();
  const p = AI.PROVIDERS[id];
  if (AI.webBlocked(id)) {
    toast(`Key saved. ${p.name} only works in the iPhone app, so it waits there.`);
    app.render();
    return;
  }
  // The key stays saved either way; without a yes it waits ("Waiting for your OK").
  if (!AI.consented(id)) {
    if (!confirm(consentText(id))) {
      app.render();
      return;
    }
    AI.consent(id);
  }
  toast(`Key saved. Testing ${p.name}…`);
  app.render();
  testOneKey(saved.id);
}

// The key form in Settings: what's typed is kept across redraws.
const KEY_FIELDS = { keyIn: 'key', keyModel: 'model', keyBase: 'base' };

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.id === 'keyProvider' && keyForm) {
    keyForm.provider = t.value;
    app.render();
  } else if (t.id === 'engineModel') {
    S.state.settings[t.dataset.engine === 'free' ? 'freeModel' : 'privateModel'] = t.value;
    S.save();
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
  if (KEY_FIELDS[e.target.id] && e.key === 'Enter' && keyForm) {
    e.preventDefault();
    handleAction('ai-key-save');
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
  else if (KEY_FIELDS[e.target.id] && keyForm) keyForm[KEY_FIELDS[e.target.id]] = e.target.value;
});

