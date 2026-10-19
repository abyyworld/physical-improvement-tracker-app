// The Me tab's own panels (renderProgress in app.js draws the rest): about you (your name, the
// strongest things Arise knows about you, what matters to you); your week next to your usual; each
// part of your life, worked out from your days with nothing to rate (life/areas.ts), with your own
// rating beside it only when you gave one; what Arise noticed in your days; the week and month the
// memory summed up; and your check-ins, when there are any. What comes from your days is worked out
// on this device with no AI and no network (life/insight.ts). The parts that need the life log are
// drawn at once from what's kept and filled in when it's read (fillYou).

import './styles/you.css';
import * as S from './store';
import * as SYS from './system.js';
import * as LC from './lib/life-check';
import { weekNumbers, WINDOW_DAYS } from './lib/patterns';
import * as M from './life/memory';
import * as INS from './life/insight';
import * as L from './life/log';
import { weekCompare } from './life/signals';
import { rowsFrom } from './life/rows';
import { hasLifeStore } from './life/store-port';
import { addDays, mondayOf } from './life/dates';
import { duration } from './life/diary';
import { VIEW as CONNECT } from './life/connect-hub.js';
import { PRIVATE } from './today-side.js';
import { esc, fmt } from './ui.js';
import { w } from './words';

// (Parts fill in after reading the log; by then a test may have gone.)
const $ = (sel, root = globalThis.document) => root?.querySelector(sel) ?? null;
const MAX_AGE = 10 * 60000; // what Arise saw, worked out again when Me is drawn after this long
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DOTS = [1, 2, 3, 4, 5];
// Whether this device keeps a life log to read.
const logHere = () => hasLifeStore() && L.hasLifeDB();
const connectLink = (cls = 'link') => `<button class="${cls}" data-act="nav" data-v="${CONNECT}">Connect →</button>`;

let gen = 0; // goes up when the data goes, so a fill still on its way doesn't land
let shown = []; // the sentences on screen, for "Ask your coach"

// Another account's data took this one's place, or the log was emptied.
export function forgetYou() {
  gen++;
  shown = [];
}
S.onReset(forgetYou);
L.onClearing(forgetYou);

// What was worked out, if it was today and lately (else it's filled in).
function kept() {
  const c = INS.peek();
  return c && c.day === S.todayKey() && Date.now() - c.at <= MAX_AGE ? c : null;
}

// =====================================================================
// About you: who you are, as Arise knows you
// =====================================================================

const ABOUT_FACTS = 6;

export function aboutPanel() {
  const p = S.state.profile || {};
  const name = (S.state.settings.name || p.name || '').trim() || 'You';
  const life = LC.cleanLife(p.life);
  const values = life?.values.length ? `<p class="small">What matters most to you: ${esc(life.values.join(', '))}.</p>` : '';
  const hope = life?.hope.trim() ? `<p class="small">A great next year: “${esc(life.hope.trim())}”</p>` : '';
  return `<section class="panel about-you" id="aboutYou">
    <div class="panel-title"><span>About you</span></div>
    <h2 class="about-name">${esc(name)}</h2>
    <div id="aboutFacts">${factsInner(M.isLoaded())}</div>
    ${values}${hope}
    <button class="link" data-act="nav" data-v="knows">Everything Arise knows →</button>
  </section>`;
}

// The strongest things Arise knows (pinned, your own, then the best confirmed: memory.ts).
function factsInner(loaded) {
  if (!loaded) return '<p class="muted small">Reading…</p>';
  const facts = M.rankFacts(M.activeFacts()).slice(0, ABOUT_FACTS);
  if (!facts.length) return '<p class="muted">Arise learns about you as your days come in: your routines, the people you see, what gives you energy. It shows here.</p>';
  return `<ul class="about-facts">${facts.map((f) => `<li>${esc(f.text)}</li>`).join('')}</ul>`;
}

// =====================================================================
// Your week: the last 7 days next to your usual (on the screen only, never sent to an AI)
// =====================================================================

export function weekPanel() {
  return `<section class="panel you-week" id="youWeek">${weekInner(kept())}</section>`;
}

// From what Arise saw in your days, and how you felt when you said; until those are worked out,
// from your check-ins alone.
function weekInner(ins, reading = !ins && logHere()) {
  const head = '<div class="panel-title"><span>Your week</span></div>';
  const today = S.todayKey();
  const c = ins ? weekCompare(ins.signals, ins.day) : {};
  const seen = seenTiles(c);
  const tiles = [...seen, ...feltTiles(weekNumbers(weekRows(ins, today), today), !!c.sleepMin)];
  if (tiles.length) return `${head}<div class="body-stats week-stats">${tiles.join('')}</div><p class="muted small">Last 7 days${seen.length ? ', next to your usual' : ''}.</p>`;
  if (reading) return `${head}<p class="muted small">Reading…</p>`;
  return `${head}<p class="muted">Connect your phone or Mac, and your week shows here by itself.</p>
    ${connectLink()}`;
}

// The check-ins as saved now: the rows worked out may be a few seconds older than one just made.
function weekRows(ins, today) {
  const own = rowsFrom([], addDays(today, -7), today, S.state);
  if (!ins) return own;
  const now = new Map(own.map((r) => [r.day, r]));
  return ins.rows.map((r) => {
    const o = now.get(r.day);
    return o ? { ...r, e: o.e, s: o.s, mood: o.mood ?? r.mood } : r;
  });
}

const days = (n, one = 'day') => `${n} ${n === 1 ? one : `${one}s`}`;
const round = (n, step) => Math.round(n / step) * step;
// 430 → "7 h 10 min", with the units small, to the nearest 10 minutes (5 under an hour).
const hm = (min) => {
  const r = min < 60 ? round(min, 5) : round(min, 10);
  const h = Math.floor(r / 60);
  const m = r % 60;
  return `${h ? `${h}<small> h</small>` : ''}${m || !h ? `${h ? ' ' : ''}${m}<small> min</small>` : ''}`;
};
const dur = (min) => duration(min < 60 ? Math.max(5, round(min, 5)) : round(min, 10));
const num = (n) => n.toLocaleString('en-GB');
const one = (n) => (Math.abs(n - Math.round(n)) < 0.05 ? String(Math.round(n)) : n.toFixed(1));
const outOf5 = (v) => `${v.toFixed(1)}<small>/5</small>`;
const tile = (k, v, sub) => `<div><span class="k">${esc(k)}</span><b>${v}</b><span class="s">${esc(sub)}</span></div>`;
// ", 20 min less than usual", ", like usual", or how many days it rests on when there's no usual yet.
function vs(x, small, say, unit, more = 'more', less = 'less') {
  if (x.usual == null) return ` (${days(x.n, unit)})`;
  const d = x.avg - x.usual;
  return Math.abs(d) < small ? ', like usual' : `, ${say(Math.abs(d))} ${d > 0 ? more : less} than usual`;
}

// What Arise saw (life/areas.ts weekCompare): sleep, steps, focus, people, fun, social feeds,
// screens and late nights, each only when it's known.
function seenTiles(c) {
  const out = [];
  if (c.sleepMin) out.push(tile('Sleep', `${c.sleepMin.about ? '<small>about </small>' : ''}${hm(c.sleepMin.avg)}`, `a night${vs(c.sleepMin, 10, dur, 'night')}`));
  if (c.steps) out.push(tile('Steps', num(round(c.steps.avg, 100)), `a day${vs(c.steps, 300, (d) => num(round(d, 100)), 'day', 'more', 'fewer')}`));
  // (Focus, fun and social feeds only when there's some: a person who never games has no Fun tile.)
  const some = (x) => x && (x.avg >= 5 || (x.usual || 0) >= 5);
  if (some(c.focusMin)) out.push(tile('Focused', hm(c.focusMin.avg), `a day${vs(c.focusMin, 15, dur, 'day')}`));
  if (c.people) out.push(tile('In touch', one(c.people.avg), `${c.people.avg >= 0.95 && c.people.avg < 1.05 ? 'person' : 'people'} a day${vs(c.people, 0.5, one, 'day', 'more', 'fewer')}`));
  if (some(c.funMin)) out.push(tile('Fun', hm(c.funMin.avg), `a day${vs(c.funMin, 10, dur, 'day')}`));
  if (some(c.socialMin)) out.push(tile('Social feeds', hm(c.socialMin.avg), `a day${vs(c.socialMin, 10, dur, 'day')}`));
  if (c.screenMin) out.push(tile('Screens', hm(c.screenMin.avg), `a day${vs(c.screenMin, 15, dur, 'day')}`));
  if (c.lateNights) {
    const x = c.lateNights;
    out.push(tile('Late nights', `${Math.round(x.avg)}<small> of ${x.n}</small>`, `up past midnight${x.usual != null ? `, usually ${Math.round(x.usual)}` : ''}`));
  }
  return out;
}

// How they felt, from their check-ins when they gave any (optional extras): energy and mood, and
// how they slept when Arise didn't see their sleep.
function feltTiles(n, sleepSeen) {
  const out = [];
  if (!sleepSeen && n.sleepFelt) out.push(tile('Sleep', outOf5(n.sleepFelt.avg), `how you slept (${days(n.sleepFelt.n)})`));
  if (n.energy) out.push(tile('Energy', outOf5(n.energy.avg), `from ${days(n.energy.n, 'check-in')}`));
  if (n.mood) out.push(tile('Mood', outOf5(n.mood.avg), days(n.mood.n)));
  return out;
}

// =====================================================================
// Your life: each part, worked out from your days
// =====================================================================

export function lifePanel() {
  return `<section class="panel life-panel" id="lifePanel">
    <div class="panel-title"><span>${esc(w('lifeTitle'))}</span></div>
    <div id="lifeAreas">${areasInner(kept())}</div>
    <button class="link small" data-act="life-checkin">Rate them yourself (optional)</button>
  </section>`;
}

const TREND = { up: ['↑', 'Better than usual'], down: ['↓', 'Worse than usual'], same: ['', 'Like usual'] };

function areasInner(ins) {
  if (!ins) return '<p class="muted">Looking at your days…</p>';
  const life = LC.cleanLife(S.state.profile?.life);
  const known = ins.areas.some((a) => a.score != null);
  const rated = !!life && Object.keys(life.areas).length > 0;
  const none = `<p>Connect your phone or Mac, and Arise works out how each part of your life is going. Nothing to fill in.</p>${connectLink()}`;
  if (!known && !rated) return none;
  return `${known ? '' : none}
    <ul class="life-rows life-areas">${ins.areas.map((a) => areaRow(a, life)).join('')}</ul>
    <p class="muted small">Your last 7 days, compared with your usual. ${esc(PRIVATE)}</p>`;
}

// Its dots (3 is like usual for you), better or worse than usual, why (with the numbers and where
// they came from), and "You said" when you rated it yourself. Not enough to go on: what would help.
function areaRow(a, life) {
  const v = a.score || 0;
  const label = v ? `${a.label}: ${v} of 5` : `${a.label}: not enough to go on yet`;
  const dots = `<span class="dots" role="img" aria-label="${esc(label)}">${DOTS.map((n) => `<i${n <= v ? ' class="on"' : ''}></i>`).join('')}</span>`;
  const t = TREND[a.trend || 'same'];
  const trend = v ? `<span class="area-trend ${a.trend || 'same'}">${t[0] ? `<span aria-hidden="true">${t[0]}</span> ` : ''}${t[1]}</span>` : '';
  const growing = life?.grow.includes(a.id) ? '<span class="tag">Growing</span>' : '';
  const why = v ? `<p class="area-why">${esc(a.reason)}</p>` : `<p class="area-why muted">${esc(a.reason)}${a.help ? ` ${esc(a.help)}` : ''}</p>`;
  const said = life?.areas[a.id];
  const saidLine = said ? `<p class="area-said">You said: ${esc(LC.SCALE[said - 1])} <span class="muted">(${esc(LC.shortDate(life.at))})</span></p>` : '';
  return `<li class="area${v ? '' : ' unknown'}"><div class="area-head"><span class="k">${esc(a.label)}</span>${dots}${trend}${growing}</div>${why}${saidLine}</li>`;
}

// =====================================================================
// What Arise noticed
// =====================================================================

export function noticedPanel() {
  const ins = kept();
  return `<section class="panel noticed" id="lifePatterns">${noticedInner(ins)}</section>`;
}

function noticedInner(ins) {
  const head = `<div class="panel-title"><span>${esc(w('noticed'))}</span></div>`;
  if (!ins) return `${head}<p class="muted">Looking at your days…</p>`;
  shown = ins.patterns.map((p) => p.text);
  if (!shown.length) {
    // The days in the 6 weeks (and today, so it counts at once) with something from a device or an
    // import, quests due, or how they felt.
    const from = addDays(ins.day, -WINDOW_DAYS);
    const known = (s) => Object.values(s.from).some((ws) => ws?.some((x) => x !== 'Arise')) || s.due || s.e || s.mood;
    const n = ins.signals.filter((s) => s.day >= from && known(s)).length;
    return `${head}<p class="muted">Nothing clear yet. Patterns need a couple of weeks of days from your phone or computer. ${n} ${n === 1 ? 'day' : 'days'} so far.</p>`;
  }
  return `${head}<ul class="noticed-list">${shown.map((t, i) => `<li><p>${esc(t)}</p><button class="link small" data-act="you-ask" data-i="${i}">Ask ${esc(w('coach'))}</button></li>`).join('')}</ul>
    <p class="muted small">These compare your own days. They show what goes together, not what causes what.</p>`;
}

// =====================================================================
// Looking back: last week and last month, as the memory summed them up
// =====================================================================

export function lookingBackPanel() {
  return `<section class="panel looking-back" id="lifeBack">${backInner(M.isLoaded())}</section>`;
}

function backInner(loaded) {
  const head = '<div class="panel-title"><span>Looking back</span></div>';
  if (!loaded) return head;
  const today = S.todayKey();
  const week = mondayOf(addDays(today, -7));
  const month = addDays(`${today.slice(0, 7)}-01`, -1).slice(0, 7);
  const monthName = `${MONTHS[Number(month.slice(5)) - 1]}${month.slice(0, 4) === today.slice(0, 4) ? '' : ` ${month.slice(0, 4)}`}`;
  const items = [
    [M.summaryFor('week', week), `Last week (from Mon ${LC.shortDate(week)})`],
    [M.summaryFor('month', month), monthName],
  ].filter(([s]) => s?.text?.trim());
  if (!items.length) return `${head}<p class="muted">Nothing yet. Arise writes these as it learns from your days.</p>`;
  return `${head}${items.map(([s, kicker]) => `<div class="back-item"><p class="kicker">${esc(kicker)}</p><p class="back-text">${esc(s.text.trim())}</p></div>`).join('')}`;
}

// =====================================================================
// Check-ins (each day's sleep, energy, mood and words), only when there are any
// =====================================================================

export function checkinsPanel(limit = 12) {
  const logs = S.recentLogs(limit);
  if (!logs.length) return '';
  const rows = logs.map(([k, l]) => {
    const nums = [l.s && `Sleep ${Number(l.s)}`, l.e && `Energy ${Number(l.e)}`, l.m && `Mood ${Number(l.m)}`].filter(Boolean).join(' · ');
    const note = (l.t || '').trim();
    return `<li><span class="hist-date"><span>${esc(fmt(k, { weekday: 'short', day: 'numeric', month: 'short' }))}</span>${nums ? `<span>${nums}</span>` : ''}</span>${note ? `<p>${esc(note)}</p>` : ''}</li>`;
  });
  return `<section class="panel checkins">
    <div class="panel-title"><span>Check-ins</span></div>
    <ul class="log-list">${rows.join('')}</ul>
  </section>`;
}

// =====================================================================
// Filling in, after Me is drawn
// =====================================================================

// Only into the panels that were there when it started, and not after the data went meanwhile:
// Me may have been drawn again since, for another account's data.
export async function fillYou() {
  const g = gen;
  const here = (el) => g === gen && !!el?.isConnected && globalThis.document?.body?.dataset.view === 'progress';
  const back = $('#lifeBack');
  const facts = $('#aboutFacts');
  if ((back || facts) && !M.isLoaded()) {
    M.load()
      .catch(() => {})
      .then(() => {
        if (here(back)) back.innerHTML = backInner(true);
        if (here(facts)) facts.innerHTML = factsInner(true);
      });
  }
  const patterns = $('#lifePatterns');
  const areas = $('#lifeAreas');
  const week = $('#youWeek');
  let ins = null;
  try {
    ins = await INS.get({ maxAge: MAX_AGE });
  } catch {}
  if (!ins) {
    if (here(week)) week.innerHTML = weekInner(null, false);
    return;
  }
  if (here(patterns)) patterns.innerHTML = noticedInner(ins);
  if (here(areas)) areas.innerHTML = areasInner(ins);
  if (here(week)) week.innerHTML = weekInner(ins);
}

export function handleAction(act, el) {
  if (act !== 'you-ask') return false;
  const said = shown[Number(el.dataset.i)];
  if (said) SYS.askCoach(`Arise noticed: ${said} What do you make of it, and is there one small thing I could try?`, { recallAs: 'the last 6 weeks' });
  return true;
}
