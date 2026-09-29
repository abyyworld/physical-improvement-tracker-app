import { EXERCISES, RULES, IMG_BASE, QUOTES } from './program.js';
import * as S from './store.js';
import { esc, fmt, clock, icon, openSheet, closeSheet, toast, xpPop } from './ui.js';
import * as SYS from './system.js';

const VERSION = '1.0.0';

const $ = (sel, root = document) => root.querySelector(sel);
const app = $('#app');

let view = 'today';
const ui = { progressEx: null, histLimit: 12 };

// ---------- small helpers

const doneCount = (item) => item.sets.filter((s) => s.done).length;
const restFor = (exId) => (EXERCISES[exId].kind === 'big' ? S.state.settings.restBig : S.state.settings.restSmall);
const DAY_LETTER = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const daysLabel = (id) => S.week().map((w, i) => (w === id ? DAY_SHORT[i] : null)).filter(Boolean).join(' · ') || 'Any day';

function relDay(k) {
  const d = S.daysBetween(k, S.todayKey());
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`;
}

function targetText(slot, easy) {
  let r = slot.amrap ? 'max reps' : slot.min === slot.max ? `${slot.min}` : `${slot.min}–${slot.max}`;
  if (slot.unit === 'sec') r += ' sec';
  if (slot.perLeg) r += ' / leg';
  return `${S.targetSets(slot, easy)} × ${r}`;
}

const unitOf = (slot) => (slot.unit === 'sec' ? 'sec' : slot.perLeg ? 'reps/leg' : 'reps');

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

const VIEWS = { today: renderToday, plan: renderPlan, coach: () => SYS.renderCoach(app), progress: renderProgress, settings: renderSettings, workout: renderWorkout };

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
  document.body.dataset.view = view;
  for (const b of document.querySelectorAll('#tabs [data-v]')) b.classList.toggle('on', b.dataset.v === view);
  VIEWS[view]();
  updateTimers();
}

// ---------- today

function renderToday() {
  const k = S.todayKey();
  const planned = S.plannedFor(k);
  const sug = S.suggestedFor(k);
  const done = S.sessionsOn(k);
  const main = [installBanner(), resumeBanner(), SYS.goalBanner(), SYS.systemMessageCard(), easyBanner(k)];
  if (done.length) main.push(questDoneCard(done));
  else if (sug === 'rest') main.push(restCard());
  else main.push(questCard(sug, sug !== planned));
  main.push(footballCard(k, planned, sug));
  main.push(logCard(k));

  app.innerHTML = `
    <header class="page-head">
      <div>
        <p class="kicker">${esc(fmt(k, { weekday: 'long', day: 'numeric', month: 'long' }))}</p>
        <h1 class="display">Today</h1>
      </div>
      ${S.firstDay() ? `<span class="tag-sys">Week ${S.programWeek(k)}</span>` : ''}
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
    <p class="muted">You've trained ${S.weeksSinceEasy(k)} weeks straight. Every 6–8 weeks, take an easy week with half the sets so your body can catch up.</p>
    <div class="row"><button class="btn small primary" data-act="easy-start">Start easy week</button><button class="btn small ghost" data-act="easy-snooze">Next week</button></div>
  </div>`;
}

function questCard(id, swapped) {
  const w = S.workouts()[id];
  const easy = S.isEasy();
  const busy = S.state.active && S.state.active.workout !== id;
  const objs = w.slots
    .map(
      (slot) => `<li><button class="obj" data-act="howto" data-ex="${slot.ex}">
        <span class="obj-box"></span>
        <span class="obj-name">${esc(EXERCISES[slot.ex].name)}</span>
        <span class="obj-target">${esc(targetText(slot, easy))}</span>
        ${S.levelUpDue(slot, id) ? `<span class="badge gold">${icon('up')}harder</span>` : ''}
      </button></li>`,
    )
    .join('');
  const startLabel = S.state.active?.workout === id ? 'Resume quest' : 'Start quest';
  return `<section class="panel quest glow">
    <div class="panel-title">${icon('bolt')}<span>Daily quest</span>${swapped ? '<span class="swap">football swap</span>' : ''}</div>
    <p class="sys-line">[Daily Quest: <b>${esc(w.name)}</b>] has arrived.</p>
    <h2 class="display quest-name">${esc(w.name)}</h2>
    <p class="muted">${esc(w.tag)} · ${w.slots.length} exercises · about ${estMinutes(id, easy)} min${easy ? ' · <b class="gold">easy week</b>' : ''}</p>
    <p class="label">Goals <span class="muted">· tap one to see how it's done</span></p>
    <ul class="objs">${objs}</ul>
    <p class="warn">Warning: if you skip today's quest, your streak ends.</p>
    <button class="btn primary xl block" data-act="${S.state.active?.workout === id ? 'nav' : 'start'}" data-v="workout" data-w="${id}" ${busy ? 'disabled' : ''}>${startLabel}</button>
    ${otherSessions(id, 'Do a different session')}
  </section>`;
}

function restCard() {
  return `<section class="panel quest">
    <div class="panel-title">${icon('moon')}<span>Rest day</span></div>
    <h2 class="display quest-name">Recover</h2>
    <p>Thursday is your rest day. Muscles grow while you rest, so sleep well, eat well and go for a walk.</p>
    <p class="muted">Rest days count toward your streak.</p>
    ${otherSessions(null, 'Train anyway')}
  </section>`;
}

function questDoneCard(sessions) {
  const s = sessions[sessions.length - 1];
  const mins = Math.max(1, Math.round((s.finished - s.started) / 60000));
  const sets = s.items.reduce((n, it) => n + it.sets.length, 0);
  return `<section class="panel quest cleared">
    <div class="panel-title">${icon('check')}<span>Quest cleared</span></div>
    <h2 class="display quest-name">${esc(S.workoutName(s.workout, s))}</h2>
    <p>${sets} sets in ${mins} min · <b class="accent">+${S.sessionXP(s)} XP</b></p>
    <p class="muted">Done for today. Come back tomorrow.</p>
    <div class="row"><button class="btn ghost" data-act="session" data-id="${s.id}">See what you did</button></div>
    ${otherSessions(null, 'Do another session')}
  </section>`;
}

function otherSessions(exclude, label) {
  const busy = !!S.state.active;
  return `<details class="other"><summary>${esc(label)}</summary><div class="chips">${S.workoutOrder().filter((id) => id !== exclude)
    .map((id) => `<button class="chip" data-act="start" data-w="${id}" ${busy ? 'disabled' : ''}>${esc(S.workouts()[id].name)}</button>`)
    .join('')}</div>${busy ? '<p class="muted small">Finish or abandon the quest in progress first.</p>' : ''}</details>`;
}

function footballCard(k, planned, sug) {
  const on = S.isFootball(k);
  const legDay = planned !== 'rest' && S.workouts()[planned].legs;
  let sub;
  if (on && legDay) sub = `Leg day skipped. Doing ${S.workouts()[sug].name} instead.`;
  else if (on) sub = `Logged. +${S.FOOTBALL_XP} XP, and it counts toward your streak.`;
  else if (legDay) sub = "Played today? Tap and leg day gets swapped for the next session.";
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
      <div class="stat"><span class="k">STR</span><span class="v">${st.str}</span></div>
      <div class="stat"><span class="k">AGI</span><span class="v">${st.agi}</span></div>
      <div class="stat"><span class="k">VIT</span><span class="v">${st.vit}</span></div>
      <div class="stat"><span class="k">${icon('flame')} Streak</span><span class="v">${streak}</span></div>
    </div>
    <p class="muted small">STR comes from push and pull reps, AGI from legs, VIT from core. ${cons == null ? 'Clear your first quest to start the count.' : `You've done ${cons}% of your training days in the last 4 weeks.`}</p>
  </section>`;
}

function weekCard(k) {
  const wk = S.weekSummary(k);
  const cells = wk.days
    .map((d, i) => {
      let cls = 'day';
      let mark = '';
      let label = d.planned === 'rest' ? 'Rest day' : S.workouts()[d.planned].name;
      if (d.trained) {
        cls += ' done';
        mark = icon('check');
      } else if (d.football) {
        cls += ' fb';
        mark = icon('ball');
        label = 'Football';
      } else if (d.planned === 'rest') {
        cls += ' rest';
        mark = '–';
      } else if (d.key < k && S.firstDay() && d.key >= S.firstDay()) cls += ' missed';
      if (d.key === k) cls += ' today';
      return `<div class="${cls}" title="${esc(label)}"><span class="dn">${DAY_LETTER[i]}</span><span class="dot">${mark}</span></div>`;
    })
    .join('');
  return `<section class="panel">
    <div class="panel-head"><h3>This week</h3><span class="muted">${wk.done}/${wk.target} quests</span></div>
    <div class="week">${cells}</div>
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
      <span><b>Put it on your home screen</b><small>In Safari, tap Share ${icon('share')} then “Add to Home Screen”. Your log is saved in whichever one you use, so pick the home-screen app and stick with it.</small></span>
      <button class="icon-btn" data-act="install-hide" aria-label="Hide">${icon('close')}</button>
    </div>`;
  }
  return '';
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
        <p class="kicker">Quest in progress${a.easy ? ' · easy week' : ''}</p>
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
    ? `<p class="last"><span class="k">Last time</span> ${last.item.sets.filter((s) => s.done).map((s) => s.r).join(' · ')} ${unit}${last.item.setup ? ` · ${esc(last.item.setup)}` : ''} <span class="muted">(${relDay(last.session.date)})</span></p>`
    : `<p class="last"><span class="k">First time</span> Pick a setup where every set ends with 1–2 reps left in the tank.</p>`;

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
    cta = `<button class="btn primary xl block" data-act="toggle-set" data-i="${i}" data-j="${cur}">${icon('check')} Set ${cur + 1} done</button>`;
  }

  return `<section class="panel focus glow">
    <div class="panel-title"><span>Exercise ${i + 1} / ${a.items.length}</span></div>
    <div class="focus-head">
      <div>
        <h2 class="display ex-name">${esc(ex.name)}</h2>
        <p class="target">${esc(targetText(slot, a.easy))} <span class="sep">·</span> rest ${clock(restFor(it.ex))}</p>
        ${slot.note ? `<p class="note">${esc(slot.note)}</p>` : ''}
      </div>
      <button class="btn small howto" data-act="howto" data-ex="${it.ex}">${icon('play')} How to</button>
    </div>
    ${lastLine}
    ${goal}
    <label class="setup"><span class="k">Setup</span><input class="setup-in" type="text" value="${esc(it.setup)}" data-i="${i}" placeholder="${esc(SETUP_HINT[it.ex] || 'What you used')}" autocomplete="off" enterkeyhint="done"></label>
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
        <span class="ql-name">${esc(EXERCISES[it.ex].name)}</span>
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
      return `<li><span>${esc(EXERCISES[it.ex].name)}</span><span class="mono">${it.sets.map((s) => s.r).join(' · ')}</span>${delta}</li>`;
    })
    .join('');
  const ups = session.easy ? [] : session.items.filter((it, i) => slots[i] && S.hitTop(it, slots[i]));
  const levelUp = after.level > before.level;
  openSheet(`
    <div class="summary">
      <p class="sys-line center">[System]</p>
      <h2 class="display big center">${levelUp ? 'Level up!' : 'Quest complete'}</h2>
      ${levelUp ? `<p class="center lvl-change"><span>${before.level}</span> → <b>${after.level}</b>${after.rank !== before.rank ? ` · Rank <b class="rank rank-${after.rank}">${after.rank}</b>` : ''}</p>` : ''}
      <p class="center">${esc(S.workoutName(session.workout, session))} · ${mins} min · ${sets} sets</p>
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
  const slots = S.workoutOrder().flatMap((id) => S.workouts()[id].slots.filter((s) => s.ex === exId).map((s) => ({ id, s })));
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
        <figure><img src="${base}/0.jpg" alt="${esc(ex.name)}: start position" loading="lazy"><figcaption>Start</figcaption></figure>
        <figure><img src="${base}/1.jpg" alt="${esc(ex.name)}: end position" loading="lazy"><figcaption>Finish</figcaption></figure>
      </div>
      <p class="src">${esc(ex.photos.caption)} Photos from Free Exercise DB (public domain).</p>`;
  }
  if (ex.more?.length) {
    html += `<h3 class="sub">More videos</h3><ul class="more">${ex.more
      .map(
        (m) => `<li><button class="more-btn" data-act="play-alt" data-id="${m.id}" data-title="${esc(m.title)}">${icon('play')}<span>${esc(m.title)}</span></button>
        <a class="icon-btn" href="https://www.youtube.com/watch?v=${m.id}" target="_blank" rel="noopener" aria-label="Open on YouTube">${icon('ext')}</a></li>`,
      )
      .join('')}</ul>`;
  }
  html += `<h3 class="sub">${icon('up')} How to make it harder</h3><p>${esc(ex.harder)}</p>`;
  openSheet(html);
}

const ytThumb = (v) =>
  `<button class="yt-thumb" data-act="play" data-id="${v.id}" aria-label="Play video: ${esc(v.title)}">
    <img src="https://i.ytimg.com/vi/${v.id}/hqdefault.jpg" alt="" loading="lazy">
    <span class="yt-play">${icon('play')}</span>
  </button>`;

const ytSource = (v) =>
  `${icon('play')} ${esc(v.title)} · <a href="https://www.youtube.com/watch?v=${v.id}" target="_blank" rel="noopener">Open in YouTube ${icon('ext')}</a>`;

function playVideo(id, title) {
  const box = $('#yt');
  if (!box) return;
  if (!navigator.onLine) {
    toast('Videos need an internet connection.');
    return;
  }
  box.innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${id}?autoplay=1&playsinline=1&rel=0&modestbranding=1"
    title="${esc(title || 'Exercise video')}" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
    referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>`;
  if (title) $('#ytsrc').innerHTML = ytSource({ id, title });
}

// ---------- plan

function renderPlan() {
  const cards = S.workoutOrder().map((id) => {
    const w = S.workouts()[id];
    const rows = w.slots
      .map(
        (slot, i) => `<li><button class="obj" data-act="howto" data-ex="${slot.ex}">
          <span class="obj-num">${i + 1}</span>
          <span class="obj-name">${esc(EXERCISES[slot.ex].name)}${slot.note ? `<small>${esc(slot.note)}</small>` : ''}</span>
          <span class="obj-target">${esc(targetText(slot, false))}</span>
          <span class="obj-play">${icon('play')}</span>
        </button></li>`,
      )
      .join('');
    return `<section class="panel">
      <div class="panel-head">
        <div><p class="kicker">${esc(daysLabel(id))}</p><h2 class="display">${esc(w.name)}</h2><p class="muted">${esc(w.tag)}</p></div>
        <button class="btn small ghost" data-act="start" data-w="${id}" ${S.state.active ? 'disabled' : ''}>Start</button>
      </div>
      <ol class="objs">${rows}</ol>
    </section>`;
  });
  const week = S.week().map((w, i) => `<div class="wk-day"><span class="k">${DAY_LETTER[i]}</span><span>${w === 'rest' || !S.workouts()[w] ? 'Rest' : esc(S.workouts()[w].short || S.workouts()[w].name)}</span></div>`).join('');
  app.innerHTML = `
    <header class="page-head"><div><p class="kicker">${S.isCustomPlan() ? 'Personalised by the System' : '6 days a week · at home'}</p><h1 class="display">The plan</h1></div></header>
    ${SYS.planPanel()}
    <section class="panel"><div class="panel-title"><span>Weekly schedule</span></div><div class="wk-grid">${week}</div></section>
    <div class="grid-2">${cards.join('')}</div>
    <section class="panel rules">
      <div class="panel-title"><span>Rules</span></div>
      <ol>${RULES.map((r) => `<li>${esc(r)}</li>`).join('')}</ol>
    </section>`;
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
  app.innerHTML = `
    <header class="page-head"><div><p class="kicker">Consistency + improvement</p><h1 class="display">Progress</h1></div></header>
    <div class="tiles">
      <div class="tile"><span class="k">Level</span><span class="v">${L.level}</span><span class="s">Rank ${L.rank} · ${L.xp} XP</span></div>
      <div class="tile"><span class="k">${icon('flame')} Streak</span><span class="v">${S.currentStreak()}</span><span class="s">days · best ${S.bestStreak()}</span></div>
      <div class="tile"><span class="k">This week</span><span class="v">${wk.done}<small>/${wk.target}</small></span><span class="s">quests cleared</span></div>
      <div class="tile"><span class="k">Consistency</span><span class="v">${cons == null ? '–' : cons}<small>${cons == null ? '' : '%'}</small></span><span class="s">last 4 weeks</span></div>
    </div>
    <div class="cols">
      <div class="col">
        ${heatmap()}
        ${historyList()}
        ${logList()}
      </div>
      <div class="col">
        <section class="panel">
          <div class="panel-title"><span>Exercise progress</span></div>
          <label class="field"><span class="k">Exercise</span><select id="exSel">${options}</select></label>
          <div id="chart"></div>
          <div id="entries"></div>
        </section>
      </div>
    </div>`;
  drawExercise();
}

function heatmap() {
  const today = S.todayKey();
  const weeks = 16;
  const start = S.addDays(S.mondayOf(today), -(weeks - 1) * 7);
  const first = S.firstDay();
  let cells = '';
  for (let wi = 0; wi < weeks; wi++) {
    for (let di = 0; di < 7; di++) {
      const k = S.addDays(start, wi * 7 + di);
      const trained = S.sessionsOn(k);
      const planned = S.plannedFor(k);
      let cls = 'hc';
      let label = '';
      if (k > today) cls += ' future';
      else if (trained.length) {
        cls += ' w';
        label = trained.map((s) => S.workoutName(s.workout, s)).join(' + ') + ' ✓';
      } else if (S.isFootball(k)) {
        cls += ' f';
        label = 'Football';
      } else if (!first || k < first) cls += ' before';
      else if (planned === 'rest') {
        cls += ' r';
        label = 'Rest day';
      } else if (k === today) label = 'Not done yet';
      else {
        cls += ' m';
        label = `Missed: ${S.workouts()[planned].name}`;
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
      <span><i class="hc w"></i>Workout</span><span><i class="hc f"></i>Football</span><span><i class="hc r"></i>Rest day</span><span><i class="hc m"></i>Missed</span>
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
      return `<li><button class="hist" data-act="session" data-id="${s.id}">
        <span class="hist-date">${esc(fmt(s.date, { weekday: 'short', day: 'numeric', month: 'short' }))}</span>
        <span class="hist-name">${esc(S.workoutName(s.workout, s))}${s.easy ? ' <span class="tag">easy</span>' : ''}</span>
        <span class="hist-meta">${sets} sets · ${mins} min</span>
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
        ([k, l]) => `<li><span class="hist-date"><span>${esc(fmt(k, { weekday: 'short', day: 'numeric', month: 'short' }))}</span>${l.e ? `<span>Energy ${l.e}/5</span>` : ''}</span>${l.t && l.t.trim() ? `<p>${esc(l.t.trim())}</p>` : ''}</li>`,
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
  drawChart(chartEl, pts, timed ? 'sec' : 'reps');
  const recent = hist.slice(-8).reverse();
  entriesEl.innerHTML = `<table class="entries">
    <thead><tr><th>Date</th><th>Sets</th><th>Total</th><th>Setup</th></tr></thead>
    <tbody>${recent
      .map(
        ({ session, item }) => `<tr><td>${esc(fmt(session.date, { day: 'numeric', month: 'short' }))}</td><td class="mono">${item.sets.map((s) => s.r).join(' · ')}</td><td class="mono">${S.itemTotal(item)}</td><td>${esc(item.setup || '–')}</td></tr>`,
      )
      .join('')}</tbody></table>`;
}

function niceStep(v) {
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function drawChart(host, pts, unit) {
  const W = Math.max(260, host.clientWidth || 320);
  const H = 210;
  const m = { l: 36, r: 16, t: 16, b: 28 };
  const maxY = Math.max(...pts.map((p) => p.y), 1);
  const step = niceStep(maxY / 4);
  const top = Math.ceil((maxY * 1.05) / step) * step;
  const t0 = pts[0].t;
  const t1 = pts[pts.length - 1].t;
  const x = (t) => (t1 === t0 ? m.l + (W - m.l - m.r) / 2 : m.l + ((t - t0) / (t1 - t0)) * (W - m.l - m.r));
  const y = (v) => m.t + (1 - v / top) * (H - m.t - m.b);
  let grid = '';
  for (let v = 0; v <= top; v += step) {
    grid += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}" class="gl"/><text x="${m.l - 8}" y="${y(v) + 4}" class="yl">${v}</text>`;
  }
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.y).toFixed(1)}`).join('');
  const dots = pts.map((p) => `<circle cx="${x(p.t)}" cy="${y(p.y)}" r="${p.changed ? 5 : 4}" class="${p.changed ? 'pt changed' : 'pt'}"/>`).join('');
  const lab = (t, anchor) => `<text x="${x(t)}" y="${H - 8}" class="xl" text-anchor="${anchor}">${esc(new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }))}</text>`;
  const xl = t1 === t0 ? lab(t0, 'middle') : lab(t0, 'start') + lab(t1, 'end');
  const anyChanged = pts.some((p) => p.changed);
  host.innerHTML = `<p class="chart-cap">Total ${unit} each time</p>
    <div class="chart">
      <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Line chart of total ${unit} per workout">
        ${grid}${xl}
        <line class="xh" y1="${m.t}" y2="${H - m.b}" x1="0" x2="0" visibility="hidden"/>
        <path d="${d}" class="ln"/>
        ${dots}
        <circle class="hl-pt" r="6" visibility="hidden"/>
        <rect x="0" y="0" width="${W}" height="${H}" fill="transparent" class="hit"/>
      </svg>
      <div class="tip" hidden></div>
    </div>
    ${anyChanged ? '<p class="muted small legend-note"><i class="ring"></i> Hollow dot: you changed the setup (e.g. heavier backpack or thicker band)</p>' : ''}`;
  const svg = $('svg', host);
  const tip = $('.tip', host);
  const xh = $('.xh', svg);
  const hp = $('.hl-pt', svg);
  const show = (ev) => {
    const r = svg.getBoundingClientRect();
    const px = ev.clientX - r.left;
    let best = pts[0];
    for (const p of pts) if (Math.abs(x(p.t) - px) < Math.abs(x(best.t) - px)) best = p;
    const cx = x(best.t);
    xh.setAttribute('x1', cx);
    xh.setAttribute('x2', cx);
    xh.setAttribute('visibility', 'visible');
    hp.setAttribute('cx', cx);
    hp.setAttribute('cy', y(best.y));
    hp.setAttribute('visibility', 'visible');
    const { session, item } = best.h;
    tip.innerHTML = `<b>${esc(fmt(session.date, { weekday: 'short', day: 'numeric', month: 'short' }))}</b><span>${best.y} ${unit} total</span><span class="mono">${item.sets.map((s) => s.r).join(' · ')}</span>${item.setup ? `<span>${esc(item.setup)}</span>` : ''}`;
    tip.hidden = false;
    const tw = tip.offsetWidth;
    tip.style.left = `${Math.min(Math.max(0, cx - tw / 2), W - tw)}px`;
  };
  svg.addEventListener('pointermove', show);
  svg.addEventListener('pointerdown', show);
  svg.addEventListener('pointerleave', (e) => {
    if (e.pointerType !== 'mouse') return;
    tip.hidden = true;
    xh.setAttribute('visibility', 'hidden');
    hp.setAttribute('visibility', 'hidden');
  });
}

function showSession(id) {
  const s = S.state.sessions.find((x) => x.id === id);
  if (!s) return;
  const mins = Math.max(1, Math.round((s.finished - s.started) / 60000));
  const rows = s.items
    .map(
      (it) => `<li><span>${esc(EXERCISES[it.ex].name)}${it.setup ? `<small>${esc(it.setup)}</small>` : ''}</span><span class="mono">${it.sets.length ? it.sets.map((x) => x.r).join(' · ') : 'skipped'}</span></li>`,
    )
    .join('');
  openSheet(`<p class="kicker">${esc(fmt(s.date, { weekday: 'long', day: 'numeric', month: 'long' }))}</p>
    <h2 class="display sheet-title">${esc(S.workoutName(s.workout, s))}</h2>
    <p class="muted">${mins} min · +${S.sessionXP(s)} XP${s.easy ? ' · easy week' : ''}</p>
    <ul class="sum-list">${rows}</ul>
    <button class="btn ghost block danger" data-act="session-del" data-id="${s.id}">Delete this workout</button>`);
}

// ---------- settings

function renderSettings() {
  const st = S.state.settings;
  const seg = (key, opts) =>
    `<div class="seg" role="group">${opts.map((o) => `<button class="${st[key] === o ? 'on' : ''}" data-act="setting" data-k="${key}" data-v="${o}">${clock(o)}</button>`).join('')}</div>`;
  const sw = (key, label, sub) =>
    `<button class="toggle-row" data-act="toggle-setting" data-k="${key}" aria-pressed="${!!st[key]}"><span><b>${label}</b>${sub ? `<small>${sub}</small>` : ''}</span><span class="switch ${st[key] ? 'on' : ''}"></span></button>`;
  const easy = S.isEasy();
  app.innerHTML = `
    <header class="page-head"><div><p class="kicker">Make it yours</p><h1 class="display">Settings</h1></div></header>
    <div class="cols">
      <div class="col">
        ${SYS.settingsPanels()}
        <section class="panel">
          <div class="panel-title"><span>Player</span></div>
          <label class="field"><span class="k">Name on your status window</span><input id="nameIn" type="text" maxlength="24" value="${esc(st.name)}" placeholder="Hunter" autocomplete="nickname"></label>
        </section>
        <section class="panel">
          <div class="panel-title"><span>Rest timer</span></div>
          <p class="label">Big exercises (pull-ups, squats, push-ups…)</p>${seg('restBig', [90, 105, 120])}
          <p class="label">Bands and core</p>${seg('restSmall', [45, 60, 75, 90])}
          ${sw('sound', 'Sound when rest is over', 'On iPhone the ringer switch must be on to hear it.')}
          ${'vibrate' in navigator ? sw('vibrate', 'Vibrate when rest is over') : ''}
          <button class="btn ghost small" data-act="test-sound">Test sound</button>
        </section>
        <section class="panel">
          <div class="panel-title">${icon('bell')}<span>Reminders</span></div>
          <p>Get a phone notification for each day's quest, with a different message every day. This adds events with an alert to your calendar app (Apple Calendar, Google Calendar…) for the next 6 months. Thursday stays free.</p>
          <label class="field inline"><span class="k">Remind me at</span><input id="remindIn" type="time" value="${esc(st.remindAt)}"></label>
          ${SYS.reminderAIBlock()}
          <button class="btn primary" data-act="calendar">${icon('bell')} Add reminders to my calendar</button>
          <p class="muted small">To change the time later, delete the old “Arise” events in your calendar and add them again.</p>
        </section>
        <section class="panel">
          <div class="panel-title">${icon('moon')}<span>Easy week</span></div>
          <p>${easy ? 'You are in an easy week: half the sets on every exercise.' : `Every 6–8 weeks, take a week with half the sets. You've trained ${S.weeksSinceEasy()} week(s) since the last one.`}</p>
          ${easy ? '<button class="btn ghost" data-act="easy-end">End easy week</button>' : '<button class="btn ghost" data-act="easy-start">Start an easy week now</button>'}
        </section>
      </div>
      <div class="col">
        <section class="panel">
          <div class="panel-title"><span>Backup</span></div>
          <p>Your log is saved on this device only. Phone and tablet keep separate logs. Save a backup on one and load it on the other to combine them.</p>
          <div class="row"><button class="btn primary" data-act="export">Save backup</button><button class="btn ghost" data-act="import">Load backup</button></div>
        </section>
        <section class="panel">
          <div class="panel-title">${icon('share')}<span>Home screen</span></div>
          ${installPrompt ? '<button class="btn primary" data-act="install">Install app</button>' : ''}
          <p><b>iPhone / iPad:</b> open this page in Safari, tap Share, then “Add to Home Screen”.</p>
          <p><b>Android:</b> in Chrome, tap ⋮, then “Add to Home screen” or “Install app”.</p>
          <p class="muted small">${isStandalone() ? 'You are using the installed app.' : 'You are in the browser right now.'}</p>
        </section>
        <section class="panel">
          <div class="panel-title"><span>Credits</span></div>
          <p class="small">The exercise videos are YouTube tutorials by their creators; each how-to screen names the video and links to it. The photos come from <a href="https://github.com/yuhonas/free-exercise-db" target="_blank" rel="noopener">Free Exercise DB</a> (public domain). The fonts (Bebas Neue, Rajdhani, Cormorant Garamond) use the SIL Open Font License.</p>
          <p class="muted small">Version ${VERSION}</p>
        </section>
        <section class="panel danger-zone">
          <div class="panel-title"><span>Danger zone</span></div>
          <p>Delete every workout, setting and streak on this device.</p>
          <button class="btn ghost danger" data-act="reset">Erase all data</button>
        </section>
      </div>
    </div>`;
}

// Calendar events with an alert give real phone notifications without a server.
// One event per training day for the next 26 weeks, each with a different message.
const NUDGES = [
  (w) => `[Daily Quest: ${w}] has arrived.`,
  (w) => `Arise. ${w} is waiting.`,
  (w) => `${w} today. Lock in.`,
  (w) => `The System has assigned: ${w}.`,
  (w) => `No excuses today: ${w}.`,
  (w) => `${w}. Your future self is watching.`,
  (w) => `Daily Quest: ${w}. Keep the streak alive.`,
  (w) => `Level up today: ${w}.`,
  (w) => `${w}. Small reps, every day, add up.`,
  (w) => `Wherever you are today, ${w} still happens.`,
];
const REMIND_WEEKS = 26;

function icsText(str) {
  return String(str).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');
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
  let n = 0;
  for (let i = 0; i < REMIND_WEEKS * 7; i++) {
    const k = S.addDays(first, i);
    const w = S.plannedFor(k);
    if (w === 'rest') continue;
    const name = S.workouts()[w].name;
    const q = QUOTES[n % QUOTES.length];
    const ai = S.state.ai.nudges?.messages;
    const title = ai?.length
      ? ai[n % ai.length].replace(/\{quest\}/g, name)
      : n % 3 === 2
        ? `${name}: \u201c${q.text}\u201d`
        : NUDGES[n % NUDGES.length](name);
    event(k, title, `${q.text}${q.by ? ` (${q.by})` : ''}`);
    n++;
  }
  const last = S.addDays(first, REMIND_WEEKS * 7 - 1);
  event(last, 'Arise: add your next 6 months of quest reminders', 'Open Settings in the app and tap "Add reminders to my calendar" again.');
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n');
}

async function saveFile(name, type, text) {
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
      S.startWorkout(d.w);
      go('workout');
      break;
    }
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
    case 'toggle-set':
      toggleSet(Number(d.i), Number(d.j));
      break;
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
    case 'reset':
      if (confirm('Erase ALL your workouts and settings on this device? This cannot be undone.') && confirm('Are you sure? Save a backup first if you might want it.')) {
        S.resetAll();
        go('today');
        toast('All data erased.');
        SYS.startOnboarding();
      }
      break;
    case 'install':
      if (installPrompt) {
        installPrompt.prompt();
        await installPrompt.userChoice.catch(() => {});
        installPrompt = null;
        render();
      }
      break;
    case 'install-hide':
      lsSet('pit-install-hidden', '1');
      render();
      break;
    default:
      await SYS.handleAction(d.act, el);
  }
});

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
    S.setLog(S.todayKey(), { t: t.value });
  } else if (t.id === 'nameIn') {
    S.state.settings.name = t.value;
    if (S.state.profile) S.state.profile.name = t.value;
    S.save();
  } else if (t.id === 'remindIn') {
    S.state.settings.remindAt = t.value || '07:00';
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
      toast(`Backup loaded: ${added} new workout(s) added.`);
      render();
    } catch (err) {
      toast(err.message || 'That file could not be read.');
    }
    t.value = '';
  } else if (t.matches('.reps')) {
    const a = S.state.active;
    if (a && t.value === '') {
      a.items[t.dataset.i].sets[t.dataset.j].r = 0;
      t.value = 0;
      S.save();
    }
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
  if (document.visibilityState !== 'visible') return;
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
  resizeTimer = setTimeout(() => view === 'progress' && drawExercise(), 150);
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
    ['plan', 'Plan'],
    ['coach', 'System'],
    ['progress', 'Progress'],
    ['settings', 'Settings'],
  ];
  $('#tabs').innerHTML = `<div class="brand"><span class="brand-mark">Arise</span><span class="brand-sub">Physical improvement tracker</span></div>
    ${tabs.map(([v, label]) => `<button data-act="nav" data-v="${v}">${icon(v === 'coach' ? 'system' : v)}<span>${label}</span></button>`).join('')}`;
}

buildNav();
SYS.initSystem({ go, render, view: () => view });
const startView = location.hash.slice(1);
go(VIEWS[startView] ? startView : S.state.active ? 'workout' : 'today', { scroll: false });
if (SYS.needsOnboarding() && !S.state.sessions.length) SYS.startOnboarding();
setInterval(tick, 250);

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return;
    if (S.state.active) toast('App updated. The new version loads after this quest.');
    else location.reload();
  });
}
