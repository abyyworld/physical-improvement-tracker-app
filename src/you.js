// The You tab's own panels (renderProgress in app.js draws the rest): the person's life as they
// rated it, with their daily check-ins and what the life log says about the last 4 weeks; what
// Arise noticed in their days (life/insight.ts, worked out on this device with no AI); the week
// and month the memory summed up; and the list of their check-ins. The parts that need the life
// log are drawn at once from what's kept and filled in when it's read (fillYou).

import './styles/you.css';
import * as S from './store';
import * as SYS from './system.js';
import * as LC from './lib/life-check';
import { lifeAverages, WINDOW_DAYS } from './lib/patterns';
import * as M from './life/memory';
import * as INS from './life/insight';
import * as L from './life/log';
import { hasLifeStore } from './life/store-port';
import { addDays, mondayOf } from './life/dates';
import { esc, fmt } from './ui.js';
import { w } from './words';

// (Parts fill in after reading the log; by then a test may have gone.)
const $ = (sel, root = globalThis.document) => root?.querySelector(sel) ?? null;
const MAX_AGE = 10 * 60000; // patterns older than this are worked out again when You is drawn
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DOTS = [1, 2, 3, 4, 5];
// "a", "a and b", "a, b and c".
const and = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
// Whether this device keeps a life log to read.
const logHere = () => hasLifeStore() && L.hasLifeDB();

let gen = 0; // goes up when the data goes, so a fill still on its way doesn't land
let shown = []; // the sentences on screen, for "Ask your coach"

// Another account's data took this one's place, or the log was emptied.
export function forgetYou() {
  gen++;
  shown = [];
}
S.onReset(forgetYou);
L.onClearing(forgetYou);

// The patterns, if they were worked out today and lately (else they're filled in).
function kept() {
  const c = INS.peek();
  return c && c.day === S.todayKey() && Date.now() - c.at <= MAX_AGE ? c : null;
}

// =====================================================================
// Your life
// =====================================================================

export function lifePanel() {
  const p = S.state.profile || {};
  const life = LC.cleanLife(p.life);
  const old = LC.cleanLifeBefore(p.lifeBefore);
  const before = life && old && old.at < life.at ? old : null;
  const body = life
    ? `<p class="muted small">Your own rating from ${esc(LC.shortDate(life.at))}.${before ? ` Before that: ${esc(LC.shortDate(before.at))}.` : ''}</p>
      <ul class="life-rows">${LC.AREA_IDS.map((id) => areaRow(id, life, before)).join('')}</ul>
      <p class="small">${esc(checkinLine())}</p>
      ${avgSlot()}
      ${life.hope.trim() ? `<p class="small">A great next year, in your words: “${esc(life.hope.trim())}”</p>` : ''}
      ${life.values.length ? `<p class="small">What matters most to you: ${esc(life.values.join(', '))}.</p>` : ''}
      ${S.daysBetween(life.at, S.todayKey()) >= 30 ? `<p class="muted small">It's been a month since you last checked in. How's life now?</p>` : ''}
      <button class="btn small ghost" data-act="life-checkin">Check in again</button>`
    : `<p>You haven't checked in on your life yet. It takes a minute and helps you and your coach see the whole picture.</p><button class="btn primary" data-act="life-checkin">Check in</button>
      ${avgSlot()}`;
  return `<section class="panel life-panel" id="lifePanel">
    <div class="panel-title"><span>${esc(w('lifeTitle'))}</span></div>
    ${body}
  </section>`;
}

function areaRow(id, life, before) {
  const { label } = LC.AREAS[id];
  const v = life.areas[id];
  const was = before?.areas[id];
  const word = v ? LC.SCALE[v - 1] : 'Not rated';
  const dots = `<span class="dots" role="img" aria-label="${esc(`${label}: ${v ? word : 'not rated'}`)}">${DOTS.map((n) => `<i${v && n <= v ? ' class="on"' : ''}></i>`).join('')}</span>`;
  const growing = life.grow.includes(id) ? '<span class="tag">Growing</span>' : '';
  const moved = v && was && was !== v ? `<span class="muted small">${v > was ? '↑' : '↓'} was ${esc(LC.SCALE[was - 1])}</span>` : '';
  return `<li><span class="k">${esc(label)}</span>${dots}<span${v ? '' : ' class="muted"'}>${esc(word)}</span>${growing}${moved}</li>`;
}

// Sleep, energy and mood from the daily check-ins, on average over the last 4 weeks.
function checkinLine() {
  const a = LC.checkinAverages(S.state.logs, S.todayKey());
  const parts = [a.s != null && `sleep ${a.s.toFixed(1)}`, a.e != null && `energy ${a.e.toFixed(1)}`, a.m != null && `mood ${a.m.toFixed(1)}`].filter(Boolean);
  if (!a.n) return 'Check in on Today to see how your sleep, energy and mood move.';
  return `Last 4 weeks, from ${a.n} daily ${a.n === 1 ? 'check-in' : 'check-ins'}: ${parts.join(', ')} out of 5.`;
}

// What the life log says about the last 4 weeks. On the screen only, never sent to an AI.
const avgSlot = () => {
  const html = avgHTML(kept());
  return `<p id="lifeAvg" class="small"${html ? '' : ' hidden'}>${html}</p>`;
};
function avgHTML(ins) {
  if (!ins || !logHere()) return '';
  const parts = lifeAverages(ins.rows.filter((r) => r.day >= addDays(ins.day, -28) && r.day < ins.day));
  if (!parts.length) return `Connect your phone, calendar or apps and your sleep, steps and time with people show here. <button class="link" data-act="nav" data-v="connect">Connect →</button>`;
  return esc(`From your life log, last 4 weeks: ${and(parts)}.`);
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
    // The days with energy or a mood in the 6 weeks (and today, so a first check-in counts).
    const from = addDays(ins.day, -WINDOW_DAYS);
    const n = ins.rows.filter((r) => r.day >= from && (r.e || r.mood)).length;
    return `${head}<p class="muted">Nothing clear yet. Patterns need about a week of check-ins or data from your phone. ${n} ${n === 1 ? 'day' : 'days'} so far.</p>`;
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
// Check-ins (each day's sleep, energy, mood and words)
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
// Filling in, after You is drawn
// =====================================================================

// Only into the panels that were there when it started, and not after the data went meanwhile:
// You may have been drawn again since, for another account's data.
export async function fillYou() {
  const g = gen;
  const here = (el) => g === gen && !!el?.isConnected && document.body.dataset.view === 'progress';
  const back = $('#lifeBack');
  if (back && !M.isLoaded()) {
    M.load()
      .catch(() => {})
      .then(() => {
        if (here(back)) back.innerHTML = backInner(true);
      });
  }
  const patterns = $('#lifePatterns');
  const avg = $('#lifeAvg');
  let ins = null;
  try {
    ins = await INS.get({ maxAge: MAX_AGE });
  } catch {}
  if (!ins) return;
  if (here(patterns)) patterns.innerHTML = noticedInner(ins);
  if (here(avg)) {
    const html = avgHTML(ins);
    avg.innerHTML = html;
    avg.hidden = !html;
  }
}

export function handleAction(act, el) {
  if (act !== 'you-ask') return false;
  const said = shown[Number(el.dataset.i)];
  if (said) SYS.askCoach(`Arise noticed: ${said} What do you make of it, and is there one small thing I could try?`, { recallAs: 'the last 6 weeks' });
  return true;
}
