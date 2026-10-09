import { EXERCISES, TEMPLATES, IMG_BASE, QUOTES, BAR_SWAPS } from './program.js';
import * as S from './store';
import { esc, fmt, clock, icon, openSheet, closeSheet, toast, xpPop } from './ui.js';
import { drawChart } from './chart.js';
import * as SYS from './system.js';
import * as R from './reminders.js';
import * as N from './native.js';
import * as SYNC from './sync';
import * as GOALS from './goals-ui.js';
import * as AI from './ai.js';
import { setKey as forgetAIKey, connectAccount, initAI } from './ai.js';
import { initUpdates, VERSION, COMMIT, updatesPanel, checkNow, applyNow } from './update';

const $ = (sel, root = document) => root.querySelector(sel);
const app = $('#app');

let view = 'today';
const ui = { progressEx: null, histLimit: 12 };

// ---------- small helpers

const doneCount = (item) => item.sets.filter((s) => s.done).length;
// Rep counts as text. Always numbers, whatever was stored.
const repsText = (sets) => sets.map((s) => Number(s.r) || 0).join(' · ');
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
// YouTube ids are 11 letters, digits, - or _. Anything else is never put in a link or a player.
const ytId = (id) => (typeof id === 'string' && /^[\w-]{11}$/.test(id) ? id : null);
const exName = (id) => EXERCISES[id]?.name || id;
const restFor = (exId) => (EXERCISES[exId].kind === 'big' ? S.state.settings.restBig : S.state.settings.restSmall);
const DAY_LETTER = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const FREE_DAY = 'Day off (your free day this week)';
const daysLabel = (id) => S.week().map((w, i) => (w === id ? DAY_SHORT[i] : null)).filter(Boolean).join(' · ') || 'Any day';

function relDay(k) {
  const d = S.daysBetween(k, S.todayKey());
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`;
}

function targetText(slot, easy) {
  let r = slot.amrap ? 'max reps' : slot.min === slot.max ? `${slot.min}` : `${slot.min}-${slot.max}`;
  if (slot.unit && slot.unit !== 'reps') r += ` ${slot.unit}`;
  if (slot.perLeg) r += ' / leg';
  return `${S.targetSets(slot, easy)} × ${r}`;
}

const unitOf = (slot) => `${slot.unit && slot.unit !== 'reps' ? slot.unit : 'reps'}${slot.perLeg ? '/leg' : ''}`;

function estMinutes(id, easy) {
  let sec = 0;
  for (const slot of S.workouts()[id].slots) {
    const n = S.targetSets(slot, easy);
    sec += n * ((slot.perLeg ? 70 : 40) + restFor(slot.ex));
  }
  return Math.max(10, Math.round(sec / 300) * 5);
}

const SETUP_HINT = {
  wide_pullup: 'e.g. bodyweight, or backpack 5 kg',
  chinup: 'e.g. bodyweight, or backpack 5 kg',
  band_row: 'e.g. green band',
  band_lateral: 'e.g. yellow band',
  face_pull: 'e.g. red band',
  band_curl: 'e.g. red band',
  bulgarian: 'e.g. backpack 8 kg',
  pistol: 'e.g. sit to bed, holding door frame',
  nordic: 'e.g. push off at the bottom',
  hip_thrust: 'e.g. backpack 10 kg',
  calf_raise: 'e.g. bodyweight',
  pike: 'e.g. feet on bed',
  decline: 'e.g. feet on bed',
  chair_dips: 'e.g. feet on floor',
  pushdown: 'e.g. black band',
  jump_squat: 'e.g. bodyweight',
  sl_rdl: 'e.g. backpack 8 kg',
  hanging_leg_raise: 'e.g. knee raises',
  hollow: 'e.g. arms overhead',
};


// ---------- navigation

const VIEWS = { today: renderToday, goals: () => GOALS.renderGoals(app), plan: renderPlan, coach: () => SYS.renderCoach(app), progress: renderProgress, settings: renderSettings, workout: renderWorkout };

function go(v, { scroll = true } = {}) {
  if (!VIEWS[v]) v = 'today';
  if (v === 'workout' && !S.state.active) v = 'today';
  view = v;
  if (location.hash.slice(1) !== v) history.replaceState(null, '', `#${v}`);
  render();
  if (scroll) window.scrollTo(0, 0);
  if (v === 'workout') keepAwake();
  else releaseWakeLock();
}

function render() {
  flushLog();
  document.body.dataset.view = view;
  const tab = view === 'plan' ? 'goals' : view;
  for (const b of document.querySelectorAll('#tabs [data-v]')) {
    b.classList.toggle('on', b.dataset.v === tab);
    if (b.dataset.v === tab) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  VIEWS[view]();
  updateTimers();
}

// ---------- today

function renderToday() {
  const k = S.todayKey();
  const wk = S.workoutsOn();
  // What to do comes first; the System's message and everything else after.
  const main = [resumeBanner()];
  if (wk) {
    const planned = S.plannedFor(k);
    const sug = S.suggestedFor(k);
    const done = S.sessionsOn(k);
    main.push(easyBanner(k), weighInBanner(k));
    if (done.length) main.push(questDoneCard(done));
    else if (sug === 'rest') main.push(restCard(k));
    else main.push(questCard(sug, sug !== planned));
    main.push(GOALS.questsCard(k), SYS.systemMessageCard(), installBanner(), footballCard(k, planned, sug));
  } else main.push(GOALS.questsCard(k), SYS.systemMessageCard(), installBanner());
  main.push(logCard(k));

  app.innerHTML = `
    <header class="page-head">
      <div>
        <p class="kicker">${esc(fmt(k, { weekday: 'long', day: 'numeric', month: 'long' }))}</p>
        <h1 class="display">Today</h1>
      </div>
      ${S.workoutsOn() && S.trainingStart() ? `<span class="tag-sys">Week ${S.programWeek(k)}</span>` : ''}
    </header>
    <div class="cols">
      <div class="col">${main.join('')}</div>
      <div class="col">${statusWindow()}${weekCard(k)}${quoteCard(k)}</div>
    </div>`;
  SYS.afterToday();
}

function resumeBanner() {
  const a = S.state.active;
  if (!a) return '';
  const all = a.items.reduce((n, it) => n + it.sets.length, 0);
  const d = a.items.reduce((n, it) => n + doneCount(it), 0);
  return `<button class="panel banner resume" data-act="nav" data-v="workout">
    <span class="pulse"></span>
    <span><b>Quest in progress: ${esc(S.workoutName(a.workout, a))}</b><small>${d}/${all} sets done. Tap to continue.</small></span>
    <span class="go">Resume →</span>
  </button>`;
}

function easyBanner(k) {
  if (S.isEasy(k)) {
    const end = S.addDays(S.easyWeekStart(k), 6);
    return `<div class="panel banner easy">
      <span>${icon('moon')}</span>
      <span><b>Easy week</b><small>Same exercises, half the sets. Ends ${esc(fmt(end, { weekday: 'long' }))}.</small></span>
      <button class="link" data-act="easy-end">End now</button>
    </div>`;
  }
  if (!S.easyWeekDue(k)) return '';
  return `<div class="panel banner easy col-banner">
    <p><b>${icon('moon')} Time for an easy week</b></p>
    <p class="muted">You've trained ${S.weeksSinceEasy(k)} weeks straight. Every 6-8 weeks, take an easy week with half the sets so your body can catch up.</p>
    <div class="row"><button class="btn small primary" data-act="easy-start">Start easy week</button><button class="btn small ghost" data-act="easy-snooze">Next week</button></div>
  </div>`;
}

function questCard(id, swapped) {
  const w = S.workouts()[id];
  const easy = S.isEasy();
  const busy = S.state.active && S.state.active.workout !== id;
  const rot = S.planMode() === 'rotation';
  const k = S.todayKey();
  const noLegs = rot && S.isFootball(k);
  const bar = S.state.settings.bar;
  const choose = bar === 'nearby' && S.needsBar(id) && !S.state.active;
  const objs = S.viewSlots(id)
    .map((slot) => {
      const skip = noLegs && EXERCISES[slot.ex]?.stat === 'agi';
      return `<li><button class="obj ${skip ? 'skip' : ''}" data-act="howto" data-ex="${esc(slot.ex)}">
        <span class="obj-box"></span>
        <span class="obj-name">${esc(exName(slot.ex))}</span>
        <span class="obj-target">${skip ? 'skipped · football' : esc(targetText(slot, easy))}</span>
        ${!skip && S.levelUpDue(slot, id) ? `<span class="badge gold">${icon('up')}harder</span>` : ''}
      </button></li>`;
    })
    .join('');
  const wk = S.weekSummary(k);
  const left = S.restsLeft(k);
  const restBtn = rot
    ? `<button class="link center" data-act="rest-day" ${left > 0 ? '' : 'disabled'}>${left > 0 ? `Take a rest day instead (${left} left this week)` : 'No rest days left this week. Lock in.'}</button>`
    : '';
  const startLabel = S.state.active?.workout === id ? 'Resume quest' : 'Start quest';
  // With this week's free day still there, skipping uses it up instead of ending the streak.
  const free = S.state.settings.dayOff && !S.freeDayIn(k);
  const warn = free
    ? rot
      ? "Warning: skip without taking a rest day and you use up this week's free day."
      : "Warning: skip today's quest and you use up this week's free day."
    : rot
      ? 'Warning: skip without taking a rest day and your streak ends.'
      : "Warning: if you skip today's quest, your streak ends.";
  return `<section class="panel quest glow">
    <div class="panel-title">${icon('bolt')}<span>Daily quest</span>${swapped ? '<span class="swap">football swap</span>' : ''}</div>
    <p class="sys-line">[Daily Quest: <b>${esc(w.name)}</b>] has arrived.</p>
    <h2 class="display quest-name">${esc(w.name)}</h2>
    <p class="muted">${esc(w.tag)} · ${w.slots.length} exercises · about ${estMinutes(id, easy)} min${easy ? ' · <b class="gold">easy week</b>' : ''}</p>
    ${rot ? `<p class="muted small">${wk.done}/${wk.target} sessions this week · In order: whatever day it is, you do the next one.</p>` : ''}
    <p class="label">Goals <span class="muted">· tap one to see how it's done</span></p>
    <ul class="objs">${objs}</ul>
    <p class="warn">${warn}</p>
    ${
      choose
        ? `<button class="btn primary xl block" data-act="start" data-w="${esc(id)}" data-bar="1" ${busy ? 'disabled' : ''}>Start at the bar</button>
    <button class="btn ghost block" data-act="start" data-w="${esc(id)}" data-bar="0" ${busy ? 'disabled' : ''}>Start at home (no bar)</button>
    <p class="muted small center">At home, pull-ups, chin-ups and hanging leg raises become band pulldowns and reverse crunches.</p>`
        : `<button class="btn primary xl block" data-act="${S.state.active?.workout === id ? 'nav' : 'start'}" data-v="workout" data-w="${esc(id)}" ${busy ? 'disabled' : ''}>${startLabel}</button>`
    }
    ${restBtn}
    ${otherSessions(id, rot ? 'Do the other session' : 'Do a different session')}
  </section>`;
}

function restCard(k) {
  const rot = S.planMode() === 'rotation';
  return `<section class="panel quest">
    <div class="panel-title">${icon('moon')}<span>Rest day</span></div>
    <h2 class="display quest-name">Recover</h2>
    <p>Muscles grow while you rest. Sleep well, eat well and go for a walk.</p>
    <p class="muted">Rest days count toward your streak.${rot ? ` ${S.restsLeft(k)} rest day${S.restsLeft(k) === 1 ? '' : 's'} left this week.` : ''}</p>
    ${rot ? `<button class="btn ghost" data-act="rest-day">Changed my mind: train today</button>` : otherSessions(null, 'Train anyway')}
  </section>`;
}

function questDoneCard(sessions) {
  const s = sessions[sessions.length - 1];
  const mins = Math.max(1, Math.round((s.finished - s.started) / 60000));
  const sets = s.items.reduce((n, it) => n + it.sets.length, 0);
  return `<section class="panel quest cleared">
    <div class="panel-title">${icon('check')}<span>Quest cleared</span></div>
    <h2 class="display quest-name">${esc(S.workoutName(s.workout, s))}</h2>
    <p>${plural(sets, 'set')} in ${mins} min · <b class="accent">+${S.sessionXP(s)} XP</b></p>
    <p class="muted">Done for today. Come back tomorrow.${S.planMode() === 'rotation' ? ` Next quest: <b>${esc(S.workouts()[S.nextWorkout()].name)}</b>.` : ''}</p>
    <div class="row"><button class="btn ghost" data-act="session" data-id="${esc(s.id)}">See what you did</button></div>
    ${otherSessions(null, 'Do another session')}
  </section>`;
}

function otherSessions(exclude, label) {
  const busy = !!S.state.active;
  return `<details class="other"><summary>${esc(label)}</summary><div class="chips">${S.workoutOrder().filter((id) => id !== exclude)
    .map((id) => `<button class="chip" data-act="start" data-w="${esc(id)}" ${busy ? 'disabled' : ''}>${esc(S.workouts()[id].name)}</button>`)
    .join('')}</div>${busy ? '<p class="muted small">Finish or abandon the quest in progress first.</p>' : ''}</details>`;
}

function footballCard(k, planned, sug) {
  const on = S.isFootball(k);
  const legDay = planned !== 'rest' && S.workouts()[planned].legs;
  let sub;
  if (on && legDay) sub = `Logged (+${S.FOOTBALL_XP} XP). ${S.workouts()[planned].name} moves to another day. Doing ${S.workouts()[sug].name} instead.`;
  else if (on) sub = `Logged. +${S.FOOTBALL_XP} XP, and it counts toward your streak.`;
  else if (legDay) sub = S.planMode() === 'rotation' ? 'Playing today? Tap it and you get an upper-body session instead. Legs stay for another day.' : 'Played today? Tap and leg day gets swapped for the next session.';
  else sub = 'Tap to log it. It counts toward your streak.';
  return `<button class="panel toggle-card ${on ? 'on' : ''}" data-act="football" aria-pressed="${on}">
    <span class="tc-icon">${icon('ball')}</span>
    <span><b>Played football today</b><small>${esc(sub)}</small></span>
    <span class="switch" aria-hidden="true"></span>
  </button>`;
}

function logCard(k) {
  const log = S.state.logs[k] || {};
  return `<section class="panel">
    <div class="panel-title"><span>Daily log</span></div>
    <p class="label">Energy today <span class="muted">· 1 = drained, 5 = unstoppable</span></p>
    <div class="log-energy" role="group" aria-label="Energy today">${[1, 2, 3, 4, 5]
      .map((n) => `<button class="${log.e === n ? 'on' : ''}" data-act="energy" data-n="${n}" aria-pressed="${log.e === n}">${n}</button>`)
      .join('')}</div>
    <textarea class="log-text" id="logText" rows="3" placeholder="How did today go? Sleep, food, mood, what got in the way, what worked…">${esc(log.t || '')}</textarea>
    <p class="muted small log-saved">Saved on this device as you type (+${S.LOG_XP} XP a day). Over months and years, these notes show what helps you stay consistent.</p>
    ${SYS.reflectionBlock(k)}
  </section>`;
}

function statusWindow() {
  const L = S.levelInfo();
  const st = S.stats();
  const streak = S.currentStreak();
  const cons = S.consistency();
  const name = S.state.settings.name.trim() || 'Hunter';
  return `<section class="panel status">
    <div class="panel-title"><span>Status</span></div>
    <div class="status-top">
      <div class="lvl"><span class="lvl-num">${L.level}</span><span class="lvl-lab">Level</span></div>
      <dl class="status-meta">
        <div><dt>Name</dt><dd>${esc(name)}</dd></div>
        <div><dt>Rank</dt><dd><b class="rank rank-${L.rank}">${L.rank}</b></dd></div>
        <div><dt>Title</dt><dd>${esc(L.title)}</dd></div>
      </dl>
    </div>
    ${SYS.goalLine()}
    <div class="xp" role="img" aria-label="${L.into} of ${L.need} XP to level ${L.level + 1}">
      <div class="xp-bar"><i style="width:${L.pct}%"></i></div>
      <p class="xp-txt"><span>XP</span><span>${L.into} / ${L.need}</span></p>
    </div>
    <div class="stat-grid">
      ${S.workoutsOn() ? `<div class="stat"><span class="k">STR</span><span class="v">${st.str}</span></div><div class="stat"><span class="k">AGI</span><span class="v">${st.agi}</span></div>` : ''}
      <div class="stat"><span class="k">VIT</span><span class="v">${st.vit}</span></div>
      <div class="stat"><span class="k">INT</span><span class="v">${st.int}</span></div>
      <div class="stat"><span class="k">SEN</span><span class="v">${st.sen}</span></div>
      <div class="stat"><span class="k">${icon('flame')} Streak</span><span class="v">${streak}</span></div>
    </div>
    <p class="muted small">${S.workoutsOn() ? 'STR comes from push and pull reps, AGI from legs, VIT from core and fitness. ' : 'VIT grows with fitness quests, '}INT with learning, career, money and creative quests, SEN with health, mind, people and habits. ${cons == null ? 'Clear your first quest to start the count.' : `You've done ${cons}% of what was due in the last 4 weeks.`}</p>
  </section>`;
}

function weekCard(k) {
  const wk = S.weekSummary(k);
  const streak = S.streakDays();
  const first = S.firstDay();
  const cells = wk.days
    .map((d, i) => {
      let cls = 'day';
      let mark = '';
      const wk = S.workoutsOn();
      let label = wk ? (d.rest ? 'Rest day' : d.planned && S.workouts()[d.planned] ? S.workouts()[d.planned].name : 'Training day') : 'Quests';
      const ticked = S.questsFor(d.key).filter((x) => x.done).map((x) => x.quest.title);
      const free = d.key < k && streak.day(d.key) === 'free';
      if (!wk && d.key <= k && S.active(d.key)) {
        cls += S.covered(d.key) ? ' done' : ' part';
        mark = icon('check');
        label = ticked.join(', ') || 'Quests done';
        if (free) label += `. ${FREE_DAY}`;
      } else if (d.trained) {
        cls += ' done';
        const short = S.workouts()[d.sessions[0].workout]?.short || '';
        mark = S.planMode() === 'rotation' && short.length <= 2 ? `<b>${esc(short)}</b>` : icon('check');
        label = d.sessions.map((s) => S.workoutName(s.workout, s)).join(' + ');
      } else if (d.football) {
        cls += ' fb';
        mark = icon('ball');
        label = 'Football';
      } else if (d.rest) {
        cls += ' rest';
        mark = '-';
      } else if (free) label = FREE_DAY; // looks like a day off, not a miss
      else if (d.key < k && first && d.key >= first && streak.day(d.key) === 'missed') cls += ' missed';
      if (d.key === k) cls += ' today';
      return `<div class="${cls}" title="${esc(label)}"><span class="dn">${DAY_LETTER[i]}</span><span class="dot">${mark}</span></div>`;
    })
    .join('');
  // The weekly day off, said once there's a streak to keep (or after it's been used).
  const used = streak.freeIn(k);
  const note =
    S.state.settings.dayOff && (used || S.currentStreak() > 0)
      ? `<p class="muted small week-note">${used ? `You've used this week's free day (${esc(fmt(used, { weekday: 'long' }))}).` : "Free day this week: missing one day won't break your streak."}</p>`
      : '';
  return `<section class="panel">
    <div class="panel-head"><h2 class="h3">This week</h2><span class="muted">${S.workoutsOn() ? `${wk.done}/${wk.target} ${S.planMode() === 'rotation' ? `sessions · ${S.restsLeft(k)} rest left` : 'quests'}` : `${wk.days.filter((d) => d.key <= k && S.covered(d.key) && S.active(d.key)).length} days cleared`}</span></div>
    <div class="week">${cells}</div>
    ${note}
  </section>`;
}

function quoteCard(k) {
  const doy = S.daysBetween(`${k.slice(0, 4)}-01-01`, k);
  const q = QUOTES[doy % QUOTES.length];
  return `<figure class="quote">
    ${q.ar ? `<p class="ar" lang="ar" dir="rtl">${esc(q.ar)}</p>` : ''}
    <blockquote>${esc(q.text)}</blockquote>
    ${q.by ? `<figcaption>${esc(q.by)}</figcaption>` : ''}
  </figure>`;
}

// ---------- install

let installPrompt = null;
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const lsGet = (k) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const lsSet = (k, v) => {
  try {
    localStorage.setItem(k, v);
  } catch {}
};

function installBanner() {
  if (N.isNative) return notifyBanner();
  if (isStandalone() || lsGet('pit-install-hidden')) return '';
  if (installPrompt) {
    return `<div class="panel banner install">
      <span>${icon('share')}</span>
      <span><b>Put it on your home screen</b><small>It opens full screen, like an app, and works offline.</small></span>
      <button class="btn small primary" data-act="install">Install</button>
      <button class="icon-btn" data-act="install-hide" aria-label="Hide">${icon('close')}</button>
    </div>`;
  }
  if (isIOS()) {
    return `<div class="panel banner install">
      <span>${icon('share')}</span>
      <span><b>Put it on your home screen</b><small>In Safari, tap Share ${icon('share')} (on newer iOS, tap ⋯ first), then “Add to Home Screen”. Your log is saved in whichever one you use, so pick the home-screen app and stick with it.</small></span>
      <button class="icon-btn" data-act="install-hide" aria-label="Hide">${icon('close')}</button>
    </div>`;
  }
  return '';
}

function notifyBanner() {
  if (S.state.settings.notify || !N.canNotify() || lsGet('pit-notify-hidden')) return '';
  return `<div class="panel banner install">
    <span>${icon('bell')}</span>
    <span><b>Turn on daily reminders</b><small>A different message every morning, and a check in the evening if the day isn't done yet.</small></span>
    <button class="btn small primary" data-act="notify-on">Turn on</button>
    <button class="icon-btn" data-act="notify-hide" aria-label="Hide">${icon('close')}</button>
  </div>`;
}

// ---------- workout (focus mode: one exercise, one big button)

function focusIndex(a) {
  if (a.items[a.focus]) return a.focus;
  const i = a.items.findIndex((it) => it.sets.some((s) => !s.done));
  return i === -1 ? a.items.length - 1 : i;
}

function setTotals(a) {
  const all = a.items.reduce((n, it) => n + it.sets.length, 0);
  const done = a.items.reduce((n, it) => n + doneCount(it), 0);
  return { all, done, pct: all ? Math.round((done / all) * 100) : 0 };
}

function renderWorkout() {
  const a = S.state.active;
  a.focus = focusIndex(a);
  const t = setTotals(a);
  app.innerHTML = `
    <header class="wk-head">
      <button class="icon-btn" data-act="nav" data-v="today" aria-label="Back to today">${icon('back')}</button>
      <div class="wk-title">
        <p class="kicker">Quest in progress${a.easy ? ' · easy week' : ''}${a.skippedLegs ? ' · legs skipped (football)' : ''}</p>
        <h1 class="display">${esc(S.workoutName(a.workout, a))}</h1>
      </div>
      <div class="wk-meta"><span id="elapsed" class="mono">0:00</span><span id="setcount">${t.done}/${t.all} sets</span></div>
    </header>
    <div class="wk-progress" aria-hidden="true"><i id="wkbar" style="width:${t.pct}%"></i></div>
    <div class="cols wk-cols">
      <div class="col" id="focus">${focusCard(a.focus)}</div>
      <div class="col">
        <section class="panel">
          <div class="panel-title"><span>Quest log</span></div>
          <ol class="qlog" id="qlog">${questLog()}</ol>
        </section>
        <div class="stack">
          <button class="btn primary block" data-act="finish">Complete quest</button>
          <button class="btn ghost block danger" data-act="discard">Abandon quest</button>
        </div>
      </div>
    </div>`;
}

function focusCard(i) {
  const a = S.state.active;
  const it = a.items[i];
  const slot = S.sessionSlots(a)[i];
  const ex = EXERCISES[it.ex];
  const last = S.lastEntry(it.ex, a.workout);
  const cur = it.sets.findIndex((s) => !s.done);
  const unit = unitOf(slot);
  const step = slot.unit === 'sec' ? 5 : 1;

  const lastLine = last
    ? `<p class="last"><span class="k">Last time</span> ${repsText(last.item.sets.filter((s) => s.done))} ${unit}${last.item.setup ? ` · ${esc(last.item.setup)}` : ''} <span class="muted">(${relDay(last.session.date)})</span></p>`
    : `<p class="last"><span class="k">First time</span> Pick a setup where every set ends with 1-2 reps left in the tank.</p>`;

  let goal = '';
  if (S.levelUpDue(slot, a.workout)) {
    goal = `<div class="alert gold">${icon('up')}<div><b>Level up this exercise.</b> Last time you hit the top of the range on every set. ${esc(ex.harder)}</div></div>`;
  } else if (slot.amrap && last) {
    goal = `<div class="alert">${icon('bolt')}<div><b>Beat ${S.itemTotal(last.item)} total reps.</b> Do as many clean reps as you can on every set.</div></div>`;
  }

  const rows = it.sets
    .map(
      (s, j) => `<div class="set ${s.done ? 'done' : ''} ${j === cur ? 'current' : ''}">
        <span class="set-n">Set ${j + 1}</span>
        <div class="stepper">
          <button class="step" data-act="inc" data-i="${i}" data-j="${j}" data-d="${-step}" aria-label="Less">−</button>
          <input class="reps" type="number" inputmode="numeric" min="0" max="999" value="${esc(s.r)}" data-i="${i}" data-j="${j}" aria-label="Set ${j + 1} ${unit}">
          <button class="step" data-act="inc" data-i="${i}" data-j="${j}" data-d="${step}" aria-label="More">+</button>
        </div>
        <button class="tick" data-act="toggle-set" data-i="${i}" data-j="${j}" aria-pressed="${s.done}" aria-label="Set ${j + 1} done">${icon('check')}</button>
      </div>`,
    )
    .join('');

  let cta;
  if (cur === -1) {
    const next = a.items.findIndex((x) => x.sets.some((s) => !s.done));
    cta =
      next === -1
        ? `<button class="btn primary xl block" data-act="finish">${icon('check')} Complete quest</button>`
        : `<button class="btn primary xl block" data-act="focus" data-i="${next}">Next: ${esc(EXERCISES[a.items[next].ex].name)} →</button>`;
  } else if (slot.unit === 'sec') {
    cta = `<button class="btn primary xl block" data-act="hold" data-i="${i}" data-j="${cur}">${icon('timer')} Start ${Number(it.sets[cur].r) || 0}s hold</button>
      <button class="link center" data-act="toggle-set" data-i="${i}" data-j="${cur}">Log set ${cur + 1} without the timer</button>`;
  } else {
    cta = `<button class="btn primary xl block" data-act="toggle-set" data-cta="1" data-i="${i}" data-j="${cur}">${icon('check')} Set ${cur + 1} done</button>`;
  }

  return `<section class="panel focus glow">
    <div class="panel-title"><span>Exercise ${i + 1} / ${a.items.length}</span></div>
    <div class="focus-head">
      <div>
        <h2 class="display ex-name">${esc(ex.name)}</h2>
        <p class="target">${esc(targetText(slot, a.easy))} <span class="sep">·</span> rest ${clock(restFor(it.ex))}</p>
        ${slot.note ? `<p class="note">${esc(slot.note)}</p>` : ''}
      </div>
      <button class="btn small howto" data-act="howto" data-ex="${esc(it.ex)}">${icon('play')} How to</button>
    </div>
    ${lastLine}
    ${goal}
    <label class="setup"><span class="k">Setup</span><input class="setup-in" type="text" maxlength="120" value="${esc(it.setup)}" data-i="${i}" placeholder="${esc(SETUP_HINT[it.ex] || 'What you used')}" autocomplete="off" enterkeyhint="done"></label>
    <p class="label">Sets <span class="muted">· ${unit}</span></p>
    <div class="sets">${rows}</div>
    <div class="set-actions">
      <button class="link" data-act="add-set" data-i="${i}">+ Add set</button>
      ${it.sets.length > 1 ? `<button class="link" data-act="del-set" data-i="${i}">− Remove last set</button>` : ''}
    </div>
    <div class="focus-cta">${cta}</div>
    <div class="focus-nav">
      <button class="link" data-act="focus" data-i="${i - 1}" ${i === 0 ? 'disabled' : ''}>← Previous</button>
      <button class="link" data-act="focus" data-i="${i + 1}" ${i === a.items.length - 1 ? 'disabled' : ''}>Skip for now →</button>
    </div>
  </section>`;
}

function questLog() {
  const a = S.state.active;
  return a.items
    .map((it, i) => {
      const d = doneCount(it);
      const n = it.sets.length;
      const cls = [i === a.focus ? 'on' : '', d >= n ? 'done' : ''].join(' ');
      return `<li><button class="ql ${cls}" data-act="focus" data-i="${i}">
        <span class="ql-mark">${d >= n ? icon('check') : i + 1}</span>
        <span class="ql-name">${esc(exName(it.ex))}</span>
        <span class="ql-count">${d}/${n}</span>
      </button></li>`;
    })
    .join('');
}

// Re-render the workout pieces without rebuilding the page.
function refreshWorkout({ scrollToFocus = false } = {}) {
  const a = S.state.active;
  if (view !== 'workout' || !a) return;
  a.focus = focusIndex(a);
  $('#focus').innerHTML = focusCard(a.focus);
  $('#qlog').innerHTML = questLog();
  const t = setTotals(a);
  $('#setcount').textContent = `${t.done}/${t.all} sets`;
  $('#wkbar').style.width = `${t.pct}%`;
  if (scrollToFocus) {
    const el = $('#focus');
    if (el.getBoundingClientRect().top < 0) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function toggleSet(i, j) {
  const a = S.state.active;
  const it = a.items[i];
  const s = it.sets[j];
  s.done = !s.done;
  let moved = false;
  if (s.done) {
    s.r = Math.max(0, Number(s.r) || 0);
    xpPop('+10 XP');
    const allDone = a.items.every((x) => x.sets.every((y) => y.done));
    if (!allDone) startTimer('rest', restFor(it.ex));
    else a.timer = null;
    if (it.sets.every((x) => x.done)) {
      const next = a.items.findIndex((x) => x.sets.some((y) => !y.done));
      if (next !== -1) {
        a.focus = next;
        moved = true;
      }
    }
  }
  S.save();
  refreshWorkout({ scrollToFocus: moved });
}

async function finishQuest() {
  const a = S.state.active;
  if (!a) return; // a second tap after the quest was already completed
  const t = setTotals(a);
  if (t.done === 0) {
    if (confirm('No sets ticked off yet. Abandon this quest?')) {
      S.discardWorkout();
      go('today');
    }
    return;
  }
  if (t.done < t.all && !confirm(`${t.all - t.done} set(s) aren't ticked off. Complete the quest anyway? Unticked sets won't be saved.`)) return;
  const prev = a.items.map((it) => S.lastEntry(it.ex, a.workout));
  const before = S.levelInfo();
  const session = S.finishWorkout();
  const after = S.levelInfo();
  try {
    await navigator.storage?.persist?.();
  } catch {}
  go('today');
  showSummary(session, prev, before, after);
}

function showSummary(session, prev, before, after) {
  const slots = S.sessionSlots(session) || [];
  const mins = Math.max(1, Math.round((session.finished - session.started) / 60000));
  const sets = session.items.reduce((n, it) => n + it.sets.length, 0);
  const rows = session.items
    .map((it, i) => {
      if (!it.sets.length) return '';
      const p = prev[i];
      const tot = S.itemTotal(it);
      let delta = '<span class="tag">first time</span>';
      if (p && p.session.workout === session.workout) {
        const pt = S.itemTotal(p.item);
        if ((p.item.setup || '') !== (it.setup || '')) delta = '<span class="tag gold">new setup</span>';
        else if (tot > pt) delta = `<span class="up">+${tot - pt}</span>`;
        else if (tot < pt) delta = `<span class="down">${tot - pt}</span>`;
        else delta = '<span class="muted">same</span>';
      }
      return `<li><span>${esc(exName(it.ex))}</span><span class="mono">${repsText(it.sets)}</span>${delta}</li>`;
    })
    .join('');
  const ups = session.easy ? [] : session.items.filter((it, i) => slots[i] && S.hitTop(it, slots[i]));
  const levelUp = after.level > before.level;
  openSheet(`
    <div class="summary">
      <p class="sys-line center">[System]</p>
      <h2 class="display big center">${levelUp ? 'Level up!' : 'Quest complete'}</h2>
      ${levelUp ? `<p class="center lvl-change"><span>${before.level}</span> → <b>${after.level}</b>${after.rank !== before.rank ? ` · Rank <b class="rank rank-${after.rank}">${after.rank}</b>` : ''}</p>` : ''}
      <p class="center">${esc(S.workoutName(session.workout, session))} · ${mins} min · ${plural(sets, 'set')}</p>
      <p class="center xp-gain">+${S.sessionXP(session)} XP</p>
      <p class="center muted">${icon('flame')} ${S.currentStreak()}-day streak</p>
      <ul class="sum-list">${rows}</ul>
      ${ups.length ? `<div class="alert gold">${icon('up')}<div><b>Make these harder next time:</b> ${ups.map((it) => esc(EXERCISES[it.ex].name)).join(', ')}. You hit the top of the range on every set.</div></div>` : ''}
      <button class="btn primary block" data-act="sheet-close">Done</button>
    </div>`);
}

// ---------- timers (rest + timed holds)

function startTimer(mode, seconds, extra = {}) {
  const a = S.state.active;
  a.timer = { mode, end: Date.now() + seconds * 1000, total: seconds, ...extra };
  S.save();
  updateTimers();
}

function tick() {
  const a = S.state.active;
  const t = a?.timer;
  if (t && Date.now() >= t.end) {
    const late = Date.now() - t.end > 4000; // app was in the background
    a.timer = null;
    if (t.mode === 'hold') {
      const s = a.items[t.i]?.sets[t.j];
      if (s && !s.done) {
        s.r = t.total;
        if (!late) alarm();
        toggleSet(t.i, t.j); // marks it done, starts rest, moves on
      } else S.save();
    } else {
      S.save();
      if (!late) {
        alarm();
        toast('Rest over. Next set.');
      }
    }
  }
  updateTimers();
}

function updateTimers() {
  const a = S.state.active;
  const el = $('#elapsed');
  if (el && a) el.textContent = clock(Math.floor((Date.now() - a.started) / 1000));
  const bar = $('#restbar');
  const t = a?.timer;
  const show = !!t && view === 'workout';
  if (bar.hidden === show) bar.hidden = !show;
  document.body.classList.toggle('has-timer', show);
  if (!show) return;
  if (bar.dataset.mode !== t.mode) {
    bar.dataset.mode = t.mode;
    bar.innerHTML = `<i class="rb-fill"></i>
      <div class="rb-in">
        <span class="rb-label">${t.mode === 'hold' ? 'Hold' : 'Rest'}</span>
        <span class="rb-time mono"></span>
        <span class="rb-btns">${
          t.mode === 'hold'
            ? '<button class="btn small ghost" data-act="hold-stop">Stop</button>'
            : '<button class="btn small ghost" data-act="rest-add">+15s</button><button class="btn small primary" data-act="rest-skip">Skip</button>'
        }</span>
      </div>`;
  }
  const left = Math.max(0, Math.ceil((t.end - Date.now()) / 1000));
  $('.rb-time', bar).textContent = clock(left);
  $('.rb-fill', bar).style.width = `${Math.min(100, (1 - (t.end - Date.now()) / (t.total * 1000)) * 100)}%`;
}

// ---------- sound, vibration, screen wake

let actx = null;
function unlockAudio() {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
  } catch {}
}
function beep() {
  if (!S.state.settings.sound || !actx) return;
  const t0 = actx.currentTime + 0.02;
  [880, 880, 1320].forEach((f, i) => {
    const o = actx.createOscillator();
    const g = actx.createGain();
    o.type = 'sine';
    o.frequency.value = f;
    const t = t0 + i * 0.22;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    o.connect(g).connect(actx.destination);
    o.start(t);
    o.stop(t + 0.2);
  });
}
function alarm() {
  beep();
  if (S.state.settings.vibrate && navigator.vibrate) navigator.vibrate([220, 100, 220]);
}

let wakeLock = null;
async function keepAwake() {
  try {
    if (!wakeLock && 'wakeLock' in navigator && document.visibilityState === 'visible' && S.state.active) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    }
  } catch {}
}
function releaseWakeLock() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

// ---------- how-to sheet

function showHowTo(exId) {
  const ex = EXERCISES[exId];
  // Where it's in the plan, either as itself or as the home version of a bar exercise.
  const slots = S.workoutOrder().flatMap((id) =>
    S.workouts()[id].slots
      .filter((s) => s.ex === exId || BAR_SWAPS[s.ex]?.ex === exId)
      .map((s) => ({ id, s: s.ex === exId ? s : S.swapForBar(s) })),
  );
  let html = `<p class="kicker">How to</p><h2 class="display sheet-title">${esc(ex.name)}</h2>`;
  html += `<p class="muted">${slots.map(({ id, s }) => `${esc(S.workouts()[id].name)}: ${esc(targetText(s, false))}`).join(' · ')}</p>`;
  if (ex.video) {
    html += `<div class="yt" id="yt">${ytThumb(ex.video)}</div>
      <p class="src" id="ytsrc">${ytSource(ex.video)}</p>`;
  }
  if (ex.photos) {
    const base = `${IMG_BASE}${encodeURIComponent(ex.photos.id)}`;
    html += `<h3 class="sub">Photos</h3>
      <div class="photos">
        <figure><img src="${base}/0.jpg" crossorigin="anonymous" alt="${esc(ex.name)}: start position" loading="lazy"><figcaption>Start</figcaption></figure>
        <figure><img src="${base}/1.jpg" crossorigin="anonymous" alt="${esc(ex.name)}: end position" loading="lazy"><figcaption>Finish</figcaption></figure>
      </div>
      <p class="src">${esc(ex.photos.caption)} Photos from Free Exercise DB (public domain).</p>`;
  }
  if (ex.more?.length) {
    html += `<h3 class="sub">More videos</h3><ul class="more">${ex.more
      .map(
        (m) => `<li>${
          N.isNative
            ? `<a class="more-btn" href="${ytUrl(m.id)}" target="_blank" rel="noopener">${icon('play')}<span>${esc(m.title)}</span></a>`
            : `<button class="more-btn" data-act="play-alt" data-id="${m.id}" data-title="${esc(m.title)}">${icon('play')}<span>${esc(m.title)}</span></button>`
        }
        <a class="icon-btn" href="${ytUrl(m.id)}" target="_blank" rel="noopener" aria-label="Open on YouTube">${icon('ext')}</a></li>`,
      )
      .join('')}</ul>`;
  }
  html += `<h3 class="sub">${icon('up')} How to make it harder</h3><p>${esc(ex.harder)}</p>`;
  openSheet(html);
}

const ytUrl = (id) => `https://www.youtube.com/watch?v=${ytId(id)}`;

// In the iOS app a tap opens the YouTube app, because embedded players refuse to play there.
const ytThumb = (v) => {
  const inner = `<img src="https://i.ytimg.com/vi/${v.id}/hqdefault.jpg" alt="" loading="lazy">
    <span class="yt-play">${icon('play')}</span>`;
  return N.isNative
    ? `<a class="yt-thumb" href="${ytUrl(v.id)}" target="_blank" rel="noopener" aria-label="Play video on YouTube: ${esc(v.title)}">${inner}</a>`
    : `<button class="yt-thumb" data-act="play" data-id="${v.id}" aria-label="Play video: ${esc(v.title)}">${inner}</button>`;
};

const ytSource = (v) =>
  `${icon('play')} ${esc(v.title)} · <a href="${ytUrl(v.id)}" target="_blank" rel="noopener">Open in YouTube ${icon('ext')}</a>`;

function playVideo(id, title) {
  const box = $('#yt');
  id = ytId(id);
  if (!box || !id) return;
  if (!navigator.onLine) {
    toast('Videos need an internet connection.');
    return;
  }
  box.innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${id}?autoplay=1&playsinline=1&rel=0&modestbranding=1"
    title="${esc(title || 'Exercise video')}" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
    referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>`;
  if (title) $('#ytsrc').innerHTML = ytSource({ id, title });
}

// ---------- plan

function renderPlan() {
  const rot = S.planMode() === 'rotation';
  const order = S.workoutOrder();
  const cards = order.map((id, n) => {
    const w = S.workouts()[id];
    const rows = S.viewSlots(id)
      .map(
        (slot, i) => `<li><button class="obj" data-act="howto" data-ex="${esc(slot.ex)}">
          <span class="obj-num">${i + 1}</span>
          <span class="obj-name">${esc(exName(slot.ex))}${slot.note ? `<small>${esc(slot.note)}</small>` : ''}${S.state.settings.bar === 'nearby' && BAR_SWAPS[slot.ex] ? `<small>At home, no bar: ${esc(EXERCISES[BAR_SWAPS[slot.ex].ex].name)}</small>` : ''}</span>
          <span class="obj-target">${esc(targetText(slot, false))}</span>
          <span class="obj-play">${icon('play')}</span>
        </button></li>`,
      )
      .join('');
    const isNext = rot && S.nextWorkout() === id;
    return `<section class="panel ${isNext ? 'glow' : ''}">
      <div class="panel-head">
        <div><p class="kicker">${rot ? `Session ${n + 1} of ${order.length}${isNext ? ' · next up' : ''}` : esc(daysLabel(id))}</p><h2 class="display">${esc(w.name)}</h2><p class="muted">${esc(w.tag)}</p></div>
        <button class="btn small ghost" data-act="start" data-w="${esc(id)}" ${S.state.active ? 'disabled' : ''}>Start</button>
      </div>
      <ol class="objs">${rows}</ol>
    </section>`;
  });
  let schedule;
  if (rot) {
    const per = S.perWeek();
    schedule = `<section class="panel">
      <div class="panel-title"><span>How it works</span></div>
      <p class="rotation">${order.map((id) => `<b>${esc(S.workouts()[id].short || S.workouts()[id].name)}</b>`).join(' → ')} → ${order.length ? `<b>${esc(S.workouts()[order[0]].short || S.workouts()[order[0]].name)}</b> …` : ''}</p>
      <p>Do the next session in order on whatever day you can. There are no fixed weekdays, so a busy week or a trip never breaks the plan.</p>
      <p>A and B build a V-taper upper body, arms and abs. C builds first-step speed and leg muscle for football. At 6 sessions a week every session comes round twice; 4 is the minimum.</p>
      <p class="label">Sessions per week</p>
      <div class="seg" role="group">${[4, 5, 6]
        .map((n) => `<button class="${per === n ? 'on' : ''}" data-act="per-week" data-n="${n}" aria-pressed="${per === n}">${n}×</button>`)
        .join('')}</div>
      <p class="muted small">${per} sessions and ${7 - per} rest day${7 - per === 1 ? '' : 's'} a week. Rest days are taken from the Today screen and count toward your streak.</p>
      ${S.hasCutVersion() ? versionPicker() : ''}
    </section>`;
  } else {
    const week = S.week()
      .map((w, i) => `<div class="wk-day"><span class="k">${DAY_LETTER[i]}</span><span>${w === 'rest' || !S.workouts()[w] ? 'Rest' : esc(S.workouts()[w].short || S.workouts()[w].name)}</span></div>`)
      .join('');
    schedule = `<section class="panel"><div class="panel-title"><span>Weekly schedule</span></div><div class="wk-grid">${week}</div></section>`;
  }
  const templates = S.isCustomPlan()
    ? ''
    : `<section class="panel">
      <div class="panel-title"><span>Plan type</span></div>
      <div class="seg" role="group">${Object.values(TEMPLATES)
        .map((t) => `<button class="${S.state.settings.template === t.id ? 'on' : ''}" data-act="template" data-id="${t.id}" aria-pressed="${S.state.settings.template === t.id}">${esc(t.label)}</button>`)
        .join('')}</div>
      <p class="muted small">${rot ? 'Recommended: three sessions on repeat. Easy to remember, works on any schedule.' : 'Your original plan: four workouts over six fixed weekdays.'} Your history stays either way.</p>
    </section>`;
  app.innerHTML = `
    <header class="page-head"><button class="icon-btn" data-act="nav" data-v="goals" aria-label="Back to goals">${icon('back')}</button><div><p class="kicker">${S.isCustomPlan() ? 'Personalised by the System' : rot ? `${S.workoutOrder().map((id) => S.workouts()[id].short || id).join('/')} rotation · ${S.perWeek()}× a week${S.onCut() && S.hasCutVersion() ? ' · cut version' : ''} · at home` : '6 days a week · at home'}</p><h1 class="display">The plan</h1></div></header>
    ${SYS.planPanel()}
    ${schedule}
    <div class="grid-2">${cards.join('')}</div>
    ${templates}
    <section class="panel rules">
      <div class="panel-title"><span>Rules</span></div>
      <ol>${S.planRules().map((r) => `<li>${esc(r)}</li>`).join('')}</ol>
    </section>`;
}

// Bulk / cut version. It follows the body phase, so switching here also switches it under Progress.
function versionPicker() {
  const ph = S.state.body.phase;
  return `<p class="label">Version</p>
      <div class="seg" role="group">${Object.entries(S.PHASES)
        .map(([id, p]) => `<button class="${ph === id ? 'on' : ''}" data-act="phase" data-v="${id}" aria-pressed="${ph === id}">${p.label}</button>`)
        .join('')}</div>
      <p class="muted small">${
        S.onCut()
          ? 'Cut version: same exercises and effort, about a sixth fewer sets. Pull-ups, lateral raises and sprints stay full.'
          : 'Full version. Pick Cut and the plan drops a set from the legs, dips, pike push-ups and the smaller exercises while you eat less.'
      }</p>`;
}

// ---------- progress

function renderProgress() {
  const L = S.levelInfo();
  const wk = S.weekSummary(S.todayKey());
  const cons = S.consistency();
  const withData = S.exercisesWithData();
  if (!ui.progressEx || !EXERCISES[ui.progressEx]) {
    const lastS = S.state.sessions[S.state.sessions.length - 1];
    ui.progressEx = lastS?.items.find((it) => it.sets.length)?.ex || withData[0] || 'wide_pullup';
  }
  const options = Object.keys(EXERCISES)
    .map((id) => `<option value="${id}" ${id === ui.progressEx ? 'selected' : ''}>${esc(EXERCISES[id].name)}${withData.includes(id) ? '' : ' (no data yet)'}</option>`)
    .join('');
  const wkOn = S.workoutsOn();
  app.innerHTML = `
    <header class="page-head"><div><p class="kicker">Consistency + improvement</p><h1 class="display">Progress</h1></div></header>
    <div class="tiles">
      <div class="tile"><span class="k">Level</span><span class="v">${L.level}</span><span class="s">Rank ${L.rank} · ${L.xp} XP</span></div>
      <div class="tile"><span class="k">${icon('flame')} Streak</span><span class="v">${S.currentStreak()}</span><span class="s">days · best ${S.bestStreak()}</span></div>
      ${wkOn ? `<div class="tile"><span class="k">This week</span><span class="v">${wk.done}<small>/${wk.target}</small></span><span class="s">workouts</span></div>` : `<div class="tile"><span class="k">Goals</span><span class="v">${S.activeGoals().length}</span><span class="s">${S.state.goals.filter((g) => g.status === 'done').length} achieved</span></div>`}
      <div class="tile"><span class="k">Consistency</span><span class="v">${cons == null ? '-' : cons}<small>${cons == null ? '' : '%'}</small></span><span class="s">last 4 weeks</span></div>
    </div>
    <div class="cols">
      <div class="col">
        ${heatmap()}
        ${GOALS.goalsProgress()}
        ${wkOn || S.state.sessions.length ? historyList() : ''}
        ${logList()}
      </div>
      <div class="col">
        ${wkOn ? bodyPanel() : ''}
        ${
          wkOn || S.state.sessions.length
            ? `<section class="panel">
          <div class="panel-title"><span>Exercise progress</span></div>
          <label class="field"><span class="k">Exercise</span><select id="exSel">${options}</select></label>
          <div id="chart"></div>
          <div id="entries"></div>
        </section>`
            : ''
        }
      </div>
    </div>`;
  drawExercise();
  drawBody();
  GOALS.drawGoalCharts();
}

function heatmap() {
  const today = S.todayKey();
  const weeks = 16;
  const start = S.addDays(S.mondayOf(today), -(weeks - 1) * 7);
  const first = S.firstDay();
  const streak = S.streakDays();
  let cells = '';
  for (let wi = 0; wi < weeks; wi++) {
    for (let di = 0; di < 7; di++) {
      const k = S.addDays(start, wi * 7 + di);
      const trained = S.sessionsOn(k);
      const ticked = Object.entries(S.state.checks[k] || {}).filter(([, c]) => c.done).length;
      let cls = 'hc';
      let label = '';
      if (k > today) cls += ' future';
      else if (trained.length || (ticked && S.covered(k))) {
        cls += ' w';
        label = [...trained.map((s) => S.workoutName(s.workout, s)), ticked ? `${ticked} quest${ticked === 1 ? '' : 's'}` : ''].filter(Boolean).join(' + ') + ' ✓';
      } else if (S.isFootball(k)) {
        cls += ' f';
        label = 'Football';
      } else if (!first || k < first) cls += ' before';
      else if (S.trainingAsked(k) && S.isRestDay(k) && S.covered(k)) {
        cls += ' r';
        label = 'Rest day';
      } else if (k === today) label = 'Not done yet';
      else {
        const status = streak.day(k);
        if (status === 'missed') {
          cls += ' m';
          label = S.workoutsOn() && S.planMode() === 'week' && !S.trainingCovered(k) ? `Missed: ${S.workouts()[S.plannedFor(k)].name}` : ticked ? `${ticked} done, some missed` : 'Missed';
        } else {
          cls += ' before';
          if (status === 'free') label = S.mondayOf(k) === S.mondayOf(today) ? FREE_DAY : "Day off (that week's free day)";
          else label = status === 'off' ? 'Day off' : S.state.rests.includes(k) ? 'Rest day' : "Week's targets met";
        }
      }
      if (k === today) cls += ' today';
      const date = fmt(k, { weekday: 'short', day: 'numeric', month: 'short' });
      cells += `<button class="${cls}" style="grid-column:${wi + 2};grid-row:${di + 1}" data-act="heat" data-info="${esc(`${date}: ${label || 'nothing logged'}`)}" aria-label="${esc(`${date}: ${label || 'nothing logged'}`)}"></button>`;
    }
  }
  const labels = DAY_LETTER.map((d, i) => `<span class="hl" style="grid-row:${i + 1}">${i % 2 === 0 ? d : ''}</span>`).join('');
  return `<section class="panel">
    <div class="panel-title"><span>Last 16 weeks</span></div>
    <div class="heat">${labels}${cells}</div>
    <p class="heat-info muted small" id="heatInfo">Tap a day to see what happened.</p>
    <div class="legend">
      <span><i class="hc w"></i>Done</span>${S.workoutsOn() || /hc f\b/.test(cells) ? '<span><i class="hc f"></i>Football</span>' : ''}${S.workoutsOn() || /hc r\b/.test(cells) ? '<span><i class="hc r"></i>Rest day</span>' : ''}<span><i class="hc m"></i>Missed</span>
    </div>
  </section>`;
}

function historyList() {
  const list = [...S.state.sessions].reverse();
  if (!list.length) return `<section class="panel"><div class="panel-title"><span>Quest history</span></div><p class="muted">Nothing yet. Your cleared quests will show up here.</p></section>`;
  const rows = list
    .slice(0, ui.histLimit)
    .map((s) => {
      const sets = s.items.reduce((n, it) => n + it.sets.length, 0);
      const mins = Math.max(1, Math.round((s.finished - s.started) / 60000));
      return `<li><button class="hist" data-act="session" data-id="${esc(s.id)}">
        <span class="hist-date">${esc(fmt(s.date, { weekday: 'short', day: 'numeric', month: 'short' }))}</span>
        <span class="hist-name">${esc(S.workoutName(s.workout, s))}${s.easy ? ' <span class="tag">easy</span>' : ''}</span>
        <span class="hist-meta">${plural(sets, 'set')} · ${mins} min</span>
      </button></li>`;
    })
    .join('');
  return `<section class="panel">
    <div class="panel-title"><span>Quest history</span></div>
    <ul class="hist-list">${rows}</ul>
    ${list.length > ui.histLimit ? '<button class="link center" data-act="more-history">Show more</button>' : ''}
  </section>`;
}

function logList() {
  const logs = S.recentLogs(ui.histLimit);
  if (!logs.length) return '';
  return `<section class="panel">
    <div class="panel-title"><span>Daily log</span></div>
    <ul class="log-list">${logs
      .map(
        ([k, l]) => `<li><span class="hist-date"><span>${esc(fmt(k, { weekday: 'short', day: 'numeric', month: 'short' }))}</span>${l.e ? `<span>Energy ${Number(l.e) || '-'}/5</span>` : ''}</span>${l.t && l.t.trim() ? `<p>${esc(l.t.trim())}</p>` : ''}</li>`,
      )
      .join('')}</ul>
  </section>`;
}

function drawExercise() {
  const exId = ui.progressEx;
  const hist = S.exerciseHistory(exId);
  const timed = !!EXERCISES[exId].timed;
  const chartEl = $('#chart');
  const entriesEl = $('#entries');
  if (!chartEl) return;
  if (!hist.length) {
    chartEl.innerHTML = `<p class="muted empty">No sets logged for ${esc(EXERCISES[exId].name)} yet. Once you have, this chart shows your total ${timed ? 'seconds' : 'reps'} each time you do it.</p>`;
    entriesEl.innerHTML = '';
    return;
  }
  const pts = hist.map((h, idx) => ({
    t: S.parseKey(h.session.date).getTime(),
    y: S.itemTotal(h.item),
    h,
    changed: idx > 0 && (h.item.setup || '') !== (hist[idx - 1].item.setup || ''),
  }));
  drawChart(chartEl, pts, timed ? 'sec' : 'reps', {
    tip: (p) => {
      const { session, item } = p.h;
      return `<b>${esc(fmt(session.date, { weekday: 'short', day: 'numeric', month: 'short' }))}</b><span>${esc(p.y)} ${timed ? 'sec' : 'reps'} total</span><span class="mono">${repsText(item.sets)}</span>${item.setup ? `<span>${esc(item.setup)}</span>` : ''}`;
    },
  });
  const recent = hist.slice(-8).reverse();
  entriesEl.innerHTML = `<table class="entries">
    <thead><tr><th>Date</th><th>Sets</th><th>Total</th><th>Setup</th></tr></thead>
    <tbody>${recent
      .map(
        ({ session, item }) => `<tr><td>${esc(fmt(session.date, { day: 'numeric', month: 'short' }))}</td><td class="mono">${repsText(item.sets)}</td><td class="mono">${S.itemTotal(item)}</td><td>${esc(item.setup || '-')}</td></tr>`,
      )
      .join('')}</tbody></table>`;
}

// ---------- body: phase, weigh-ins, V-taper ratio

const VERDICT = {
  bulk: { slow: 'Gaining slower than planned: add about 150-200 kcal a day.', fast: 'Gaining faster than planned: take away about 150-200 kcal a day to stay lean.' },
  cut: { slow: 'Losing slower than planned: eat about 150-200 kcal less a day, or walk more.', fast: 'Losing faster than planned: eat about 150-200 kcal more a day to protect your muscle.' },
  maintain: { slow: 'Drifting down: eat a little more.', fast: 'Drifting up: eat a little less.' },
};

function bodyForm() {
  const st = S.bodyStats();
  const f = (name, label, ph) =>
    `<label class="field"><span class="k">${label}</span><input name="${name}" type="number" inputmode="decimal" step="0.1" min="0" placeholder="${esc(ph)}"></label>`;
  return `<div class="body-form">
    <div class="bf-grid">
      ${f('weight', 'Weight (kg)', st.weight ?? 'e.g. 72.5')}
      ${f('waist', 'Waist (cm)', st.waist ?? 'e.g. 80')}
      ${f('shoulders', 'Shoulders (cm)', st.shoulders ?? 'e.g. 118')}
    </div>
    <button class="btn primary small" data-act="body-save">${icon('check')} Save weigh-in</button>
  </div>`;
}

function weighInBanner(k) {
  const b = S.state.body;
  if (!b.phase && !b.entries.length) return '';
  if (!S.bodyStats(k).due) return '';
  return `<button class="panel banner weigh" data-act="weigh-in">
    <span>${icon('scale')}</span>
    <span><b>Weigh-in day</b><small>Weekly check: weight and waist. 30 seconds.</small></span>
    <span class="go">Log →</span>
  </button>`;
}

function bodyPanel() {
  const b = S.state.body;
  const st = S.bodyStats();
  const ph = S.PHASES[b.phase];
  const rate = st.ratePerWeek != null ? `${st.ratePerWeek > 0 ? '+' : ''}${st.ratePerWeek} kg/week (${st.ratePct > 0 ? '+' : ''}${st.ratePct}%)` : 'needs 2 weigh-ins a week apart';
  const verdict = st.verdict === 'ok' ? `<p class="ok small">${icon('check')} On track for your ${ph.label.toLowerCase()}.</p>` : st.verdict ? `<p class="gold small">${esc(VERDICT[b.phase][st.verdict])}</p>` : '';
  return `<section class="panel">
    <div class="panel-title">${icon('scale')}<span>Body</span></div>
    <p class="label">Phase</p>
    <div class="seg" role="group">${Object.entries(S.PHASES)
      .map(([id, p]) => `<button class="${b.phase === id ? 'on' : ''}" data-act="phase" data-v="${id}" aria-pressed="${b.phase === id}">${p.label}</button>`)
      .join('')}</div>
    <p class="muted small">${ph ? `Goal for a ${ph.label.toLowerCase()}: ${ph.text}. Keep the effort the same in every phase; food decides the direction.` : 'Pick your phase so the app can tell you if you are on track.'}</p>
    ${
      st.last
        ? `<div class="body-stats">
            <div><span class="k">Weight</span><b>${esc(st.weight ?? '-')}<small> kg</small></b><span class="s">${esc(rate)}</span></div>
            <div><span class="k">Waist</span><b>${esc(st.waist ?? '-')}<small> cm</small></b><span class="s">last ${esc(fmt(st.last.date, { day: 'numeric', month: 'short' }))}</span></div>
            <div><span class="k">V-taper</span><b>${esc(st.ratio ?? '-')}</b><span class="s">shoulders ÷ waist</span></div>
          </div>${verdict}`
        : ''
    }
    <div id="bodyChart"></div>
    <p class="label">${st.last ? 'New weigh-in' : 'First weigh-in'}</p>
    ${bodyForm()}
    <details class="other"><summary>Food basics for bulking and cutting</summary>
      <ul class="changes">
        <li><b>Protein</b>: about 1.6-2.2 g per kg of bodyweight every day, in every phase.</li>
        <li><b>Bulk</b>: eat about 250-500 kcal a day above maintenance. Aim for 0.25-0.5% of bodyweight a week, so most of it is muscle.</li>
        <li><b>Cut</b>: eat about 300-500 kcal a day below maintenance and aim for 0.4-0.75% of bodyweight a week. Slower keeps more muscle and speed. Keep training just as hard, push protein to about 2.2 g per kg, and eat most of your carbs around football and sprint days.</li>
        <li><b>Weigh in</b> the same way each time: morning, after the toilet, before food. Measure your waist at the belly button, relaxed, and your shoulders around the widest point.</li>
        <li><b>Sleep</b> 7-9 hours. Muscle gets built while you recover.</li>
        <li><b>Creatine</b> (monohydrate, 3-5 g a day) is the best-researched supplement for muscle and strength. Optional, and check with a doctor first if you have kidney problems.</li>
        <li><b>Abs</b> show at roughly 10-12% body fat for most men. Training builds them, a cut reveals them.</li>
        <li>The V-taper number goes up when your shoulders and back grow or your waist shrinks.</li>
      </ul>
    </details>
  </section>`;
}

function drawBody() {
  const host = $('#bodyChart');
  if (!host) return;
  const entries = S.state.body.entries.filter((e) => e.weight != null);
  if (entries.length < 2) {
    host.innerHTML = '';
    return;
  }
  const pts = entries.map((e) => ({ t: S.parseKey(e.date).getTime(), y: e.weight, e }));
  drawChart(host, pts, 'kg', {
    fit: true,
    caption: 'Bodyweight (kg)',
    tip: (p) =>
      `<b>${esc(fmt(p.e.date, { weekday: 'short', day: 'numeric', month: 'short' }))}</b><span>${esc(p.y)} kg</span>${p.e.waist != null ? `<span>Waist ${esc(p.e.waist)} cm</span>` : ''}${p.e.shoulders != null ? `<span>Shoulders ${esc(p.e.shoulders)} cm</span>` : ''}`,
  });
}

function showSession(id) {
  const s = S.state.sessions.find((x) => x.id === id);
  if (!s) return;
  const mins = Math.max(1, Math.round((s.finished - s.started) / 60000));
  const rows = s.items
    .map(
      (it) => `<li><span>${esc(exName(it.ex))}${it.setup ? `<small>${esc(it.setup)}</small>` : ''}</span><span class="mono">${it.sets.length ? repsText(it.sets) : 'skipped'}</span></li>`,
    )
    .join('');
  openSheet(`<p class="kicker">${esc(fmt(s.date, { weekday: 'long', day: 'numeric', month: 'long' }))}</p>
    <h2 class="display sheet-title">${esc(S.workoutName(s.workout, s))}</h2>
    <p class="muted">${mins} min · +${S.sessionXP(s)} XP${s.easy ? ' · easy week' : ''}</p>
    <ul class="sum-list">${rows}</ul>
    <button class="btn ghost block danger" data-act="session-del" data-id="${esc(s.id)}">Delete this workout</button>`);
}

// ---------- settings

function renderSettings() {
  const st = S.state.settings;
  const seg = (key, opts) =>
    `<div class="seg" role="group">${opts.map((o) => `<button class="${st[key] === o ? 'on' : ''}" data-act="setting" data-k="${key}" data-v="${o}" aria-pressed="${st[key] === o}">${clock(o)}</button>`).join('')}</div>`;
  const sw = (key, label, sub) =>
    `<button class="toggle-row" data-act="toggle-setting" data-k="${key}" aria-pressed="${!!st[key]}"><span><b>${label}</b>${sub ? `<small>${sub}</small>` : ''}</span><span class="switch ${st[key] ? 'on' : ''}"></span></button>`;
  const easy = S.isEasy();
  const calendarPanel = () => `<section class="panel">
          <div class="panel-title">${icon('bell')}<span>Reminders</span></div>
          <p>Get a phone notification for each day's quest, with a different message every day. This adds events with an alert to your calendar app (Apple Calendar, Google Calendar…) for the next 6 months. ${S.planMode() === 'rotation' ? 'On a rotation plan any day can be a training day, so you get one every day.' : 'Rest days stay free.'}</p>
          <label class="field inline"><span class="k">Remind me at</span><input id="remindIn" type="time" value="${esc(st.remindAt)}"></label>
          ${SYS.reminderAIBlock()}
          <button class="btn primary" data-act="calendar">${icon('bell')} Add reminders to my calendar</button>
          <p class="muted small">To change the time later, delete the old “Arise” events in your calendar and add them again.</p>
        </section>`;
  const notifyPanel = () => `<section class="panel">
          <div class="panel-title">${icon('bell')}<span>Notifications</span></div>
          <p>A reminder every morning with a different message, plus an evening check on days you haven't trained yet. Done days, rest days and football days stay quiet.</p>
          <button class="toggle-row" data-act="notify-toggle" aria-pressed="${!!st.notify}"><span><b>Daily reminders</b></span><span class="switch ${st.notify ? 'on' : ''}"></span></button>
          <p class="error small" id="notifyBlocked" hidden>Notifications are blocked for Arise. Turn them on in the iPhone Settings app, under Notifications, then Arise.</p>
          ${
            st.notify
              ? `<label class="field inline"><span class="k">Morning reminder</span><input id="remindIn" type="time" value="${esc(st.remindAt)}"></label>
          ${sw('evening', 'Evening check', "Only if the day isn't done yet.")}
          ${st.evening ? `<label class="field inline"><span class="k">Evening check at</span><input id="eveningIn" type="time" value="${esc(st.eveningAt)}"></label>` : ''}`
              : ''
          }
          ${SYS.reminderAIBlock()}
        </section>`;
  app.innerHTML = `
    <header class="page-head"><div><p class="kicker">Make it yours</p><h1 class="display">Settings</h1></div></header>
    <div class="cols">
      <div class="col">
        ${SYNC.panel()}
        ${SYS.settingsPanels()}
        <section class="panel">
          <div class="panel-title"><span>Player</span></div>
          <label class="field"><span class="k">Name on your status window</span><input id="nameIn" type="text" maxlength="24" value="${esc(st.name)}" placeholder="Hunter" autocomplete="nickname"></label>
        </section>
        <section class="panel">
          <div class="panel-title">${icon('flame')}<span>Streak</span></div>
          ${sw('dayOff', 'Weekly day off', "The first day you miss each week (Monday to Sunday) counts as a day off, so your streak keeps going. A second missed day ends it.")}
        </section>
        ${S.workoutsOn() ? `<section class="panel">
          <div class="panel-title"><span>Pull-up bar</span></div>
          <div class="seg" role="group">${[
            ['home', 'At home'],
            ['nearby', 'Near home'],
            ['none', 'None'],
          ]
            .map(([v, l]) => `<button class="${st.bar === v ? 'on' : ''}" data-act="bar" data-v="${v}" aria-pressed="${st.bar === v}">${l}</button>`)
            .join('')}</div>
          <p class="muted small">${
            st.bar === 'nearby'
              ? 'Sessions with bar exercises ask where you are. At home, pull-ups, chin-ups and hanging leg raises become band pulldowns and reverse crunches.'
              : st.bar === 'none'
                ? 'Pull-ups, chin-ups and hanging leg raises become band pulldowns and reverse crunches. Anchor the band high on a door (a door anchor, or a knotted towel shut in the door).'
                : 'Pull-ups, chin-ups and hanging leg raises on your own bar.'
          }</p>
        </section>
        <section class="panel">
          <div class="panel-title"><span>Rest timer</span></div>
          <p class="label">Big exercises (pull-ups, squats, push-ups…)</p>${seg('restBig', [90, 105, 120])}
          <p class="label">Bands and core</p>${seg('restSmall', [45, 60, 75, 90])}
          ${sw('sound', 'Sound when rest is over', 'On iPhone the ringer switch must be on to hear it.')}
          ${'vibrate' in navigator ? sw('vibrate', 'Vibrate when rest is over') : ''}
          <button class="btn ghost small" data-act="test-sound">Test sound</button>
        </section>` : ''}
        ${N.isNative ? notifyPanel() : calendarPanel()}
        ${S.workoutsOn() ? `<section class="panel">
          <div class="panel-title">${icon('moon')}<span>Easy week</span></div>
          <p>${easy ? 'You are in an easy week: half the sets on every exercise.' : `Every 6-8 weeks, take a week with half the sets. You've trained ${S.weeksSinceEasy()} week(s) since the last one.`}</p>
          ${easy ? '<button class="btn ghost" data-act="easy-end">End easy week</button>' : '<button class="btn ghost" data-act="easy-start">Start an easy week now</button>'}
        </section>` : ''}
      </div>
      <div class="col">
        <section class="panel">
          <div class="panel-title"><span>Backup</span></div>
          <p>${SYNC.configured ? 'With an account (see Account) your data syncs by itself. Without one, your' : 'Your'} log is saved on this device only. You can also save a backup here and load it on another device to combine them.</p>
          <div class="row"><button class="btn primary" data-act="export">Save backup</button><button class="btn ghost" data-act="import">Load backup</button></div>
        </section>
        ${
          N.isNative
            ? `<section class="panel">
          <div class="panel-title"><span>Automatic copy</span></div>
          <p>The app also keeps a copy of your data in the Files app, under On My iPhone, Arise. If iOS ever clears the app's storage, it loads that copy back. Deleting the app deletes the copy too, so save a backup somewhere else now and then.</p>
        </section>`
            : `<section class="panel">
          <div class="panel-title">${icon('share')}<span>Home screen</span></div>
          ${installPrompt ? '<button class="btn primary" data-act="install">Install app</button>' : ''}
          <p><b>iPhone / iPad:</b> open this page in Safari, tap Share (on newer iOS, tap ⋯ first), then “Add to Home Screen”.</p>
          <p><b>Android:</b> in Chrome, tap ⋮, then “Add to Home screen” or “Install app”.</p>
          <p><b>Laptop:</b> in Chrome or Edge, click the install icon at the right end of the address bar. In Safari on a Mac, choose File, then “Add to Dock”.</p>
          <p class="muted small">${isStandalone() ? 'You are using the installed app.' : 'You are in the browser right now.'}</p>
        </section>`
        }
        ${updatesPanel(esc)}
        <section class="panel">
          <div class="panel-title"><span>Privacy</span></div>
          <p>What you put in Arise is yours. Synced data is end-to-end encrypted and the AI coach is private by default.</p>
          <button class="btn ghost small" data-act="privacy">How your data is kept private</button>
        </section>
        <section class="panel">
          <div class="panel-title"><span>Credits</span></div>
          <p class="small">The exercise videos are YouTube tutorials by their creators; each how-to screen names the video and links to it. The photos come from <a href="https://github.com/yuhonas/free-exercise-db" target="_blank" rel="noopener">Free Exercise DB</a> (public domain). The fonts (Bebas Neue, Rajdhani, Cormorant Garamond) use the SIL Open Font License.</p>
          <p class="muted small">Version ${VERSION} (${COMMIT})</p>
        </section>
        <section class="panel danger-zone">
          <div class="panel-title"><span>Danger zone</span></div>
          <p>Delete every workout, setting and streak on this device${SYNC.configured ? ', and your AI key. If you are signed in, this also signs you out; your encrypted cloud copy stays' : ''}.</p>
          <button class="btn ghost danger" data-act="reset">Erase all data</button>
        </section>
      </div>
    </div>`;
  if (N.isNative) N.permission().then((p) => $('#notifyBlocked')?.toggleAttribute('hidden', p !== 'denied'));
}

// What the app keeps, where, and who can read it. Plain words; kept in step with the README.
function privacyHTML() {
  const own = AI.engine() === 'own' ? AI.provider() : null;
  return `<p class="kicker">Privacy</p>
    <h2 class="display sheet-title">Your data is yours</h2>
    <h3 class="sub">On this device</h3>
    <p>Everything you enter (goals, quests, workouts, your daily log, weigh-ins, AI chats) is saved on this device. Anyone who can unlock this device and open the app can see it.</p>
    <h3 class="sub">With an account</h3>
    <p>A copy is kept in the cloud so your devices stay in step. It's <b>end-to-end encrypted</b>: locked on your device with a key only your devices have, before it's sent. Nobody else can read it: not the people who run Arise, not Google (who host it), and not anyone who asks either of them for it.</p>
    <p>Your password never leaves your device; the sign-in service only gets a value made from it. That's also why nobody can reset it for you: if you forget it, your recovery code is the only way back in. (One exception: an account from before Arise 2.0 still has its old password at the sign-in service, so that password is sent once, the way the old version did, and the account is then switched over. That only happens when you tick the box for it when signing in, or when you unlock a device the old version had signed in.)</p>
    <p>What the server can see: your sign-in email (nothing at all with a no-email account), when you sync, and roughly how much data you have. Not what any of it says.</p>
    <h3 class="sub">The AI coach</h3>
    <p><b>Private AI</b> runs in a sealed, verified enclave. Before anything is sent, the app checks the enclave is running the exact published code on genuine secure hardware, then encrypts what it sends to it. Nobody in between can read it. The service that passes it on only sees which account asked, and when.</p>
    <p><b>On this device</b>, nothing leaves your computer at all.</p>
    <p><b>Your own AI service</b> (Claude, ChatGPT, Gemini…) is not private: that company can read what the coach sends it. The app only uses it if you pick it and say yes.${own ? ` You're using ${esc(own.name)} right now.` : ''}</p>
    <h3 class="sub">Your choices</h3>
    <ul class="changes">
      <li>Save a backup of everything any time (Settings, Backup).</li>
      <li>Erase everything from this device (Settings, Danger zone).</li>
      <li>Delete your account and its cloud copy for good (Settings, Account, More).</li>
    </ul>
    <p class="muted small">Arise has no ads, no trackers and no analytics. How-to videos come from YouTube's privacy-enhanced player, and exercise photos from GitHub, when you open them.</p>
    <button class="btn primary block" data-act="sheet-close">Got it</button>`;
}

// Calendar events with an alert give real phone notifications without a server.
// One event per training day for the next 26 weeks, each with a different message.
const REMIND_WEEKS = 26;

function icsText(str) {
  return String(str).replace(/\\/g, '\\\\').replace(/\r?\n|\r/g, '\\n').replace(/([,;])/g, '\\$1');
}

// iCalendar lines must be at most 75 bytes; longer ones continue on the next line after a space.
function foldLine(line) {
  const enc = new TextEncoder();
  let out = '';
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (bytes + n > (out ? 74 : 75)) {
      out += (out ? '\r\n ' : '') + cur;
      cur = '';
      bytes = 0;
    }
    cur += ch;
    bytes += n;
  }
  return out ? `${out}\r\n ${cur}` : cur;
}

function calendarFile() {
  const [hh, mm] = (S.state.settings.remindAt || '07:00').split(':').map(Number);
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const url = location.href.split('#')[0];
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Arise//Daily quests//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:Arise quests'];
  const event = (k, title, body) => {
    const date = k.replace(/-/g, '');
    lines.push(
      'BEGIN:VEVENT',
      `UID:arise-${date}-${pad(hh)}${pad(mm)}@arise.app`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${date}T${pad(hh)}${pad(mm)}00`,
      'DURATION:PT45M',
      `SUMMARY:${icsText(title)}`,
      `DESCRIPTION:${icsText(`${body}\n\nOpen the app: ${url}`)}`,
      `URL:${url}`,
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:${icsText(title)}`,
      'TRIGGER:PT0M',
      'END:VALARM',
      'END:VEVENT',
    );
  };
  const first = S.addDays(S.todayKey(), 1);
  for (let i = 0; i < REMIND_WEEKS * 7; i++) {
    const k = S.addDays(first, i);
    // Rotation plans: any day can be a training day, so every day gets a reminder.
    const name = R.questName(k, false);
    if (name) event(k, R.morningLine(k, name), R.quoteFor(k));
  }
  const last = S.addDays(first, REMIND_WEEKS * 7 - 1);
  event(last, 'Arise: add your next 6 months of quest reminders', 'Open Settings in the app and tap "Add reminders to my calendar" again.');
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n');
}

async function saveFile(name, type, text) {
  if (N.isNative) {
    try {
      await N.shareFile(name, text);
    } catch (err) {
      toast(err?.message || 'The file could not be saved.');
    }
    return;
  }
  const file = new File([text], name, { type });
  if (navigator.canShare?.({ files: [file] }) && matchMedia('(pointer: coarse)').matches) {
    try {
      await navigator.share({ files: [file], title: name });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}


// ---------- events

let lastCta = 0;

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const d = el.dataset;
  const a = S.state.active;
  unlockAudio();
  switch (d.act) {
    case 'nav':
      closeSheet();
      go(d.v);
      break;
    case 'start': {
      closeSheet();
      if (a) {
        go('workout');
        break;
      }
      S.startWorkout(d.w, d.bar === '1' ? { noBar: false } : d.bar === '0' ? { noBar: true } : undefined);
      go('workout');
      break;
    }
    case 'bar':
      S.state.settings.bar = d.v;
      S.save();
      render();
      break;
    case 'energy': {
      const k = S.todayKey();
      const n = Number(d.n);
      const first = !S.state.logs[k]?.e && !S.state.logs[k]?.t?.trim();
      S.setLog(k, { e: S.state.logs[k]?.e === n ? null : n });
      document.querySelectorAll('.log-energy button').forEach((b) => {
        const on = S.state.logs[k].e === Number(b.dataset.n);
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', on);
      });
      if (first) xpPop(`+${S.LOG_XP} XP`);
      break;
    }
    case 'phase':
      S.setPhase(d.v);
      render();
      break;
    case 'weigh-in':
      openSheet(`<p class="kicker">Weekly check</p><h2 class="display sheet-title">Weigh-in</h2>${bodyForm()}<p class="muted small">Morning, after the toilet, before food. Waist at the belly button, relaxed.</p>`);
      break;
    case 'body-save': {
      const f = el.closest('.body-form');
      const val = (n) => f.querySelector(`[name="${n}"]`).value;
      const result = S.addBodyEntry({ weight: val('weight'), waist: val('waist'), shoulders: val('shoulders') });
      if (result === 'saved') {
        closeSheet();
        xpPop(`+${S.BODY_XP} XP`);
        toast('Weigh-in saved.');
        render();
      } else if (result === 'empty') toast('Enter at least one number.');
      else {
        const [lo, hi] = S.BODY_RANGES[result];
        toast(`Check your ${result}: it should be between ${lo} and ${hi} ${result === 'weight' ? 'kg' : 'cm'}.`);
      }
      break;
    }
    case 'rest-day': {
      const k = S.todayKey();
      if (!S.toggleRest(k)) toast('No rest days left this week. Lock in.');
      else if (S.isRestDay(k)) toast('Rest day logged. Recover well.');
      render();
      break;
    }
    case 'per-week':
      S.state.settings.perWeek = Number(d.n);
      S.save();
      render();
      break;
    case 'template':
      if (S.state.active) {
        toast('Finish or abandon the quest in progress first.');
        break;
      }
      S.setTemplate(d.id);
      render();
      break;
    case 'football':
      S.toggleFootball(S.todayKey());
      if (S.isFootball(S.todayKey())) xpPop(`+${S.FOOTBALL_XP} XP`);
      render();
      break;
    case 'howto':
      showHowTo(d.ex);
      break;
    case 'play':
      playVideo(d.id, EXERCISES[Object.keys(EXERCISES).find((k) => EXERCISES[k].video?.id === d.id)]?.video.title);
      break;
    case 'play-alt':
      playVideo(d.id, d.title);
      $('#yt')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      break;
    case 'focus': {
      const i = Number(d.i);
      if (!a || !a.items[i]) break;
      a.focus = i;
      S.save();
      refreshWorkout({ scrollToFocus: true });
      break;
    }
    case 'inc': {
      const s = a.items[d.i].sets[d.j];
      s.r = Math.max(0, (Number(s.r) || 0) + Number(d.d));
      S.save();
      const input = el.parentElement.querySelector('.reps');
      if (input) input.value = s.r;
      if (!s.done && S.sessionSlots(a)[d.i].unit === 'sec') refreshWorkout();
      break;
    }
    case 'toggle-set': {
      // The big "Set N done" button turns into the next set's button under the finger, so a quick
      // double tap would tick two sets. Only the set it was drawn for counts, once.
      if (d.cta && (!a || a.items[d.i]?.sets[d.j]?.done || Date.now() - lastCta < 600)) break;
      if (d.cta) lastCta = Date.now();
      toggleSet(Number(d.i), Number(d.j));
      break;
    }
    case 'hold': {
      const s = a.items[d.i].sets[d.j];
      startTimer('hold', Math.max(5, Number(s.r) || 30), { i: Number(d.i), j: Number(d.j) });
      break;
    }
    case 'hold-stop': {
      const t = a.timer;
      if (!t) break;
      const held = Math.max(0, Math.round(t.total - (t.end - Date.now()) / 1000));
      a.items[t.i].sets[t.j].r = held;
      a.timer = null;
      toggleSet(t.i, t.j);
      break;
    }
    case 'rest-add':
      if (a?.timer) {
        a.timer.end += 15000;
        a.timer.total += 15;
        S.save();
        updateTimers();
      }
      break;
    case 'rest-skip':
      if (a) {
        a.timer = null;
        S.save();
        updateTimers();
      }
      break;
    case 'add-set': {
      const it = a.items[d.i];
      const lastSet = it.sets[it.sets.length - 1];
      it.sets.push({ r: lastSet ? lastSet.r : 8, done: false });
      S.save();
      refreshWorkout();
      break;
    }
    case 'del-set': {
      const it = a.items[d.i];
      if (it.sets.length > 1) it.sets.pop();
      S.save();
      refreshWorkout();
      break;
    }
    case 'finish':
      closeSheet();
      finishQuest();
      break;
    case 'discard':
      if (confirm('Abandon this quest? Nothing from it will be saved.')) {
        S.discardWorkout();
        go('today');
      }
      break;
    case 'sheet-close':
      closeSheet();
      break;
    case 'session':
      showSession(d.id);
      break;
    case 'session-del':
      if (confirm('Delete this workout from your log?')) {
        S.deleteSession(d.id);
        closeSheet();
        render();
      }
      break;
    case 'more-history':
      ui.histLimit += 20;
      render();
      break;
    case 'heat':
      $('#heatInfo').textContent = d.info;
      document.querySelectorAll('.hc.sel').forEach((c) => c.classList.remove('sel'));
      el.classList.add('sel');
      break;
    case 'easy-start':
      S.startEasyWeek();
      toast('Easy week started: half the sets for 7 days.');
      render();
      break;
    case 'easy-end':
      S.endEasyWeek();
      render();
      break;
    case 'easy-snooze':
      S.snoozeEasyWeek(7);
      render();
      break;
    case 'setting':
      S.state.settings[d.k] = Number(d.v);
      S.save();
      render();
      break;
    case 'toggle-setting':
      S.state.settings[d.k] = !S.state.settings[d.k];
      S.save();
      render();
      break;
    case 'test-sound':
      unlockAudio();
      setTimeout(alarm, 50);
      break;
    case 'calendar':
      await saveFile('arise-daily-quests.ics', 'text/calendar', calendarFile());
      break;
    case 'export':
      await saveFile(`arise-backup-${S.todayKey()}.json`, 'application/json', JSON.stringify(S.exportData(), null, 2));
      break;
    case 'import':
      $('#importFile').click();
      break;
    case 'reset': {
      const signedIn = !!SYNC.status.user;
      const msg = signedIn
        ? 'Erase everything on this device and sign out? Your encrypted cloud copy stays, so you can sign in again to get it back. (To delete the cloud copy too, use Account, More, Delete.)'
        : 'Erase ALL your workouts and settings on this device? This cannot be undone.';
      if (confirm(msg) && (signedIn || confirm('Are you sure? Save a backup first if you might want it.'))) {
        if (!(await SYNC.eraseThisDevice())) break; // kept changes that haven't reached the cloud
        forgetAIKey('');
        AI.forgetConsent(); // the next person is asked again
        go('today');
        toast(signedIn ? 'Erased from this device and signed out.' : 'All data erased.');
        SYS.startOnboarding();
      }
      break;
    }
    case 'update-check':
      checkNow();
      break;
    case 'update-apply':
      applyNow();
      break;
    case 'install':
      if (installPrompt) {
        installPrompt.prompt();
        await installPrompt.userChoice.catch(() => {});
        installPrompt = null;
        render();
      }
      break;
    case 'privacy':
      openSheet(privacyHTML());
      break;
    case 'install-hide':
      lsSet('pit-install-hidden', '1');
      render();
      break;
    case 'notify-hide':
      lsSet('pit-notify-hidden', '1');
      render();
      break;
    case 'notify-on':
    case 'notify-toggle':
      if (d.act === 'notify-toggle' && S.state.settings.notify) {
        await N.disableNotifications();
        toast('Reminders off.');
      } else {
        const p = await N.enableNotifications();
        if (p === 'granted') toast('Reminders on. Every morning, plus an evening check.');
        else toast('Notifications are blocked. Turn them on in the iPhone Settings app, under Notifications, then Arise.');
      }
      render();
      break;
    default:
      if (GOALS.handleAction(d.act, el)) break;
      if (!(await SYNC.handleAction(d.act, el))) await SYS.handleAction(d.act, el);
  }
});

// The daily log saves half a second after typing stops (a save rewrites all the data), and right
// away if the app is closed or another screen opens first.
let logTimer = null;
let pendingLog = null;
function flushLog() {
  if (!logTimer) return;
  clearTimeout(logTimer);
  logTimer = null;
  pendingLog?.();
  pendingLog = null;
}

document.addEventListener('input', (e) => {
  const t = e.target;
  const a = S.state.active;
  if (t.matches('.setup-in') && a) {
    a.items[t.dataset.i].setup = t.value;
    S.save();
  } else if (t.matches('.reps') && a) {
    const v = t.value === '' ? '' : Math.max(0, Math.min(999, Math.round(Number(t.value)) || 0));
    a.items[t.dataset.i].sets[t.dataset.j].r = v;
    S.save();
  } else if (t.id === 'logText') {
    clearTimeout(logTimer);
    const k = S.todayKey();
    const v = t.value;
    logTimer = setTimeout(() => S.setLog(k, { t: v }), 500);
    pendingLog = () => S.setLog(k, { t: v });
  } else if (t.id === 'nameIn') {
    S.state.settings.name = t.value;
    if (S.state.profile) S.state.profile.name = t.value;
    S.save();
  } else if (t.id === 'remindIn') {
    S.state.settings.remindAt = t.value || '07:00';
    S.save();
  } else if (t.id === 'eveningIn') {
    S.state.settings.eveningAt = t.value || '20:30';
    S.save();
  }
});

document.addEventListener('change', async (e) => {
  const t = e.target;
  if (t.id === 'exSel') {
    ui.progressEx = t.value;
    drawExercise();
  } else if (t.id === 'importFile' && t.files[0]) {
    try {
      const added = S.importData(JSON.parse(await t.files[0].text()));
      toast(added ? `Backup loaded: ${plural(added, 'new workout')} added.` : 'Backup loaded. No new workouts in it.');
      render();
    } catch (err) {
      toast(err.message || 'That file could not be read.');
    }
    t.value = '';
  } else if (t.matches('.reps')) {
    const a = S.state.active;
    const set = a?.items[t.dataset.i]?.sets[t.dataset.j];
    if (!set) return;
    if (t.value === '') {
      set.r = 0;
      S.save();
    }
    t.value = set.r; // shows the kept number, e.g. 0 instead of -5
  }
});

// Missing images: hide video thumbnails, label photos that can't load (e.g. offline).
document.addEventListener(
  'error',
  (e) => {
    const img = e.target;
    if (img.tagName !== 'IMG') return;
    if (img.closest('.yt-thumb')) img.remove();
    else if (img.closest('.photos figure')) img.closest('figure').classList.add('broken');
  },
  true,
);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSheet();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') {
    flushLog();
    return;
  }
  tick();
  if (view === 'workout') keepAwake();
  if (view === 'today') render(); // the date may have changed
});

window.addEventListener('hashchange', () => {
  const v = location.hash.slice(1);
  if (v !== view && VIEWS[v]) go(v);
});

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (view !== 'progress') return;
    drawExercise();
    drawBody();
    GOALS.drawGoalCharts();
  }, 150);
});

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  if (view === 'today' || view === 'settings') render();
});

// ---------- start

function buildNav() {
  const tabs = [
    ['today', 'Today'],
    ['goals', 'Goals'],
    ['coach', 'System'],
    ['progress', 'Progress'],
    ['settings', 'Settings'],
  ];
  $('#tabs').innerHTML = `<div class="brand"><span class="brand-mark">Arise</span><span class="brand-sub">Level up in every part of life</span></div>
    ${tabs.map(([v, label]) => `<button data-act="nav" data-v="${v}">${icon(v === 'coach' ? 'system' : v === 'goals' ? 'target' : v)}<span>${label}</span></button>`).join('')}`;
}

buildNav();
SYS.initSystem({ go, render, view: () => view });
GOALS.initGoals({ go, render, view: () => view });
if (S.storageProblem() === 'corrupt') setTimeout(() => toast("Your saved data couldn't be read, so the app started fresh. The old copy is kept on this device."), 800);
// Another tab or window saved: show its data (not while typing here, to keep what's being typed).
S.onOutsideChange(() => {
  const el = document.activeElement;
  if (!el || !['INPUT', 'TEXTAREA'].includes(el.tagName)) render();
});
let warnedFull = false;
S.onSave(() => {
  if (S.storageProblem() === 'full' && !warnedFull) {
    warnedFull = true;
    toast("This device's storage is full, so changes aren't being saved. Save a backup and free some space.");
  }
});
const startView = location.hash.slice(1);
go(VIEWS[startView] ? startView : S.state.active ? 'workout' : 'today', { scroll: false });
if (SYS.needsOnboarding() && !S.state.sessions.length && !SYNC.hasAccount()) SYS.startOnboarding();
setInterval(tick, 250);

N.initNative();
SYNC.initSync({
  render: () => {
    if (view === 'settings') render();
  },
  changed: () => render(),
  checkForUpdate: () => checkNow().catch(() => {}),
});
// The private AI is for signed-in players; the account proves it to the AI proxy.
connectAccount({ signedIn: () => !!SYNC.status.user && !SYNC.status.locked, idToken: SYNC.idToken });
initAI().then(() => render());

// What a restart would interrupt right now (nothing: an empty list).
const busyWith = () =>
  [SYS.aiBusy() && 'ai', GOALS.editing() && 'editing', document.body.classList.contains('onboarding') && 'intro', S.state.active && 'workout'].filter(Boolean);
// Updates for the website, the installed app and the iPhone app alike (see update.ts).
initUpdates({
  busy: busyWith,
  whatsNew: openSheet,
  // Only the App updates panel changes, so nothing else in Settings (like a half-typed form) is touched.
  changed: () => {
    const panel = document.getElementById('updatesPanel');
    if (panel) panel.outerHTML = updatesPanel(esc);
  },
});
