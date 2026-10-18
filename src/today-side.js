// Today's right column in the Arise look (on a phone, after the rest of Today): You lately, with
// each part of their life as they rated it, what they want to grow, and the clearest thing Arise
// noticed in their days; then one small line of level, XP and streak. The System look keeps its
// status window instead (statusWindow in app.js). The week of training is on Training.

import './styles/today.css';
import * as S from './store';
import * as LC from './lib/life-check';
import * as INS from './life/insight';
import * as L from './life/log';
import { esc, icon } from './ui.js';
import { w } from './words';

// (The note fills in after the patterns are worked out; by then a test may have gone.)
const $ = (sel, root = globalThis.document) => root?.querySelector(sel) ?? null;
const DOTS = [1, 2, 3, 4, 5];

let gen = 0; // goes up when the data goes, so a note still on its way doesn't land
const forget = () => gen++;
S.onReset(forget);
L.onClearing(forget);

// What they want to grow first, from the life check-in.
export function growLine() {
  const grow = (S.state.profile?.life?.grow || []).filter(LC.isArea);
  return grow.length ? `<p class="goal-line">${icon('heart')} <span>Growing first: ${esc(grow.map((a) => LC.AREAS[a].label).join(' and '))}</span></p>` : '';
}

// Days in a row with a daily check-in.
function checkinCell() {
  const n = S.checkinStreak();
  return `<div class="life-cell life-count"><span class="k">Check-ins</span><b>${n}</b><small>${n === 1 ? 'day' : 'days'} in a row</small></div>`;
}

// Each part of their life as five dots, in their own rating, with what moved since the check-in
// before; and the daily check-ins.
function lifeGrid(life) {
  const before = S.state.profile?.lifeBefore?.areas || {};
  const cells = LC.AREA_IDS.map((a) => {
    const { label } = LC.AREAS[a];
    const v = life.areas?.[a] || 0;
    const was = before[a];
    const up = v > was;
    const move = v && was && was !== v ? `<span class="life-move ${up ? 'up' : 'down'}"><span aria-hidden="true">${up ? '↑' : '↓'}</span><span class="sr-only">, ${up ? 'up' : 'down'} from ${LC.SCALE[was - 1]}</span></span>` : '';
    const dots = DOTS.map((n) => `<i${n <= v ? ' class="on"' : ''}></i>`).join('');
    return `<div class="life-cell"><span class="k">${esc(label)}</span><span class="dots" role="img" aria-label="${esc(`${label}: ${v ? LC.SCALE[v - 1] : 'not rated'}`)}">${dots}</span>${move}</div>`;
  }).join('');
  return `<div class="life-grid">${cells}${checkinCell()}</div>`;
}

// The clearest pattern Arise found in their days (life/insight.ts, worked out on this device with
// no AI), if it was worked out today. On the screen only.
function noteHTML(ins) {
  const top = ins && ins.day === S.todayKey() ? ins.patterns[0] : null;
  if (!top) return '';
  return `<p class="lately-note">${esc(top.text)}</p><button class="link small" data-act="nav" data-v="progress">More on ${esc(w('youTab'))} →</button>`;
}

export function todaySide() {
  const life = S.state.profile?.life;
  const body = life
    ? `${lifeGrid(life)}${growLine()}
    <p class="muted small">From your life check-in on ${esc(LC.shortDate(life.at))}. <button class="link small" data-act="life-checkin">Check in again</button></p>`
    : `<div class="life-grid">${checkinCell()}</div>
    <p class="muted small">See your whole life here: <button class="link small" data-act="life-checkin">check in (1 minute)</button>.</p>`;
  const note = noteHTML(INS.peek());
  return `<section class="panel lately" id="youLately">
    <div class="panel-title">${icon('heart')}<span>You lately</span></div>
    ${body}
    <div class="lately-pattern" id="latelyNote"${note ? '' : ' hidden'}>${note}</div>
  </section>`;
}

// The game, kept small: level, XP and the streak (when something is due: quests or the plan), and
// with the plan, strength and agility from the training.
export function gameLine() {
  const lv = S.levelInfo();
  const parts = [`Level ${lv.level}`, `${lv.xp.toLocaleString()} XP`];
  if (S.activeQuests().length || S.workoutsOn()) {
    const n = S.currentStreak();
    const best = S.bestStreak();
    parts.push(n ? `${n}-day streak${best > n ? ` (best ${best})` : ''}` : best ? `Best streak ${best} ${best === 1 ? 'day' : 'days'}` : 'No streak yet');
  }
  const st = S.workoutsOn() ? S.stats() : null;
  return `<p class="muted small game-line"><span>${parts.join(' · ')}</span>${st ? `<span>Training: Strength ${st.str} · Agility ${st.agi}</span>` : ''}</p>`;
}

// When the device is idle (or a moment after, where there's no way to tell), so reading the life
// log never holds up the first paint or the day line.
const idle = () =>
  new Promise((done) => {
    const ric = globalThis.requestIdleCallback;
    if (ric) ric(() => done(), { timeout: 4000 });
    else setTimeout(done, 1000);
  });

// After Today is drawn: the pattern, once it's worked out (when the device is idle, unless it was
// worked out already today). Only into the note that was there when it started, while Today is
// still on screen and the data is still the same.
export async function fillSide() {
  const el = $('#latelyNote');
  if (!el) return;
  const g = gen;
  let ins = null;
  try {
    const c = INS.peek();
    if (!c || c.day !== S.todayKey()) await idle();
    if (g !== gen || !el.isConnected) return;
    ins = await INS.get();
  } catch {}
  if (!ins || g !== gen || !el.isConnected || document.body.dataset.view !== 'today') return;
  const html = noteHTML(ins);
  el.innerHTML = html;
  el.hidden = !html;
}
