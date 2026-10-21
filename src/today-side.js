// Today's right column in the Arise look (on a phone, after the rest of Today): You lately, each
// part of their life worked out from their days (life/areas.ts: the last week next to their own
// usual, nothing for them to rate), what they want to grow, and the clearest thing Arise noticed in
// their days; then one small line of level, XP and streak. Also what Arise saw today, for the day
// card in both looks (app.js): short chips and where they came from. All of it is worked out on
// this device with no AI and no network (life/insight.ts). The System look keeps its status window
// instead of You lately (statusWindow in app.js). The week of training is on Training.

import './styles/today.css';
import * as S from './store';
import * as AI from './ai.js';
import * as LC from './lib/life-check';
import * as INS from './life/insight';
import * as L from './life/log';
import { seenToday, sourcesText } from './life/signals';
import { lessPrivate } from './life/policy';
import { VIEW as CONNECT } from './life/connect-hub.js';
import { esc, icon } from './ui.js';
import { w } from './words';

// (Parts fill in after the days are worked out; by then a test may have gone.)
const $ = (sel, root = globalThis.document) => root?.querySelector(sel) ?? null;
const DOTS = [1, 2, 3, 4, 5];
const MAX_AGE = 10 * 60000; // what Arise saw, worked out again when Today is drawn after this long
// Said plainly wherever what Arise saw shows, and only what's true for the AI in use now: a less
// private AI (the free AI or the Player's own keys) that they let read the life log gets it too,
// as far as it may (life/policy.ts), each time the coach answers.
export const PRIVATE = 'Worked out on this device. Nobody else can see it, not even Arise.';
export function lifeShared() {
  const e = AI.engine();
  return lessPrivate(e) && AI.lifeCap(e) > 1;
}
export const privateLine = () =>
  lifeShared() ? `Worked out on this device. It also goes to the AI you picked when ${w('coach')} answers, because you let less private AIs read your life log.` : PRIVATE;

let gen = 0; // goes up when the data goes, so a part still on its way doesn't land
const forget = () => gen++;
S.onReset(forget);
L.onClearing(forget);

// What was worked out, if it was today.
function kept() {
  const c = INS.peek();
  return c && c.day === S.todayKey() ? c : null;
}

// Anything from a device or an import in the last 6 weeks, not only Arise's own.
const fromDevices = (ins) => ins.signals.some((s) => Object.values(s.from).some((ws) => ws?.some((x) => x !== 'Arise')));

// What they want to grow first, from the life check-in (now optional).
export function growLine() {
  const grow = (S.state.profile?.life?.grow || []).filter(LC.isArea);
  return grow.length ? `<p class="goal-line">${icon('heart')} <span>Growing first: ${esc(grow.map((a) => LC.AREAS[a].label).join(' and '))}</span></p>` : '';
}

// =====================================================================
// The day card: what Arise saw today and last night
// =====================================================================

// "Slept about 7 h 10 min", "6,400 steps"…, only what's known, and where they came from. Before
// any device or import has told Arise anything, how to connect one. Nothing until it's worked out.
export function seenHTML(ins = kept()) {
  if (!ins) return '';
  const seen = seenToday(ins.signals, ins.day);
  if (seen.length) {
    const from = sourcesText(seen.flatMap((x) => x.from));
    return `<p class="day-chips seen-chips">${seen.map((x) => `<span>${esc(x.text)}</span>`).join('')}</p>
      <p class="seen-from">${from ? `From ${esc(from)}. ` : ''}${esc(privateLine())}</p>`;
  }
  if (fromDevices(ins)) return '';
  return `<p class="seen-empty">Connect your phone or Mac and Arise fills this in by itself. <button class="link" data-act="nav" data-v="${CONNECT}">Connect →</button></p>`;
}

// =====================================================================
// You lately
// =====================================================================

const TREND = { up: ['↑', 'better than usual'], down: ['↓', 'worse than usual'], same: ['', 'like usual'] };
// One word each, so four fit in a row (the full name is read aloud and on Me).
const SHORT = { sleep: 'Sleep', body: 'Body', mind: 'Mind', people: 'People', work: 'Work', money: 'Money', fun: 'Fun', meaning: 'Purpose' };

// One part of life: five dots from its score (3 is like usual for them) and an arrow when it's
// better or worse than usual. Why, on hover; the Me tab says it in full.
function cell(a) {
  const v = a.score || 0;
  const t = TREND[a.trend || 'same'];
  const label = v ? `${a.label}: ${v} of 5, ${t[1]}` : `${a.label}: not enough to go on yet`;
  const dots = DOTS.map((n) => `<i${n <= v ? ' class="on"' : ''}></i>`).join('');
  const move = v && t[0] ? `<span class="life-move ${a.trend}" aria-hidden="true">${t[0]}</span>` : '';
  return `<div class="life-cell${v ? '' : ' unknown'}" title="${esc(a.reason)}"><span class="k" aria-hidden="true">${esc(SHORT[a.id] || a.label)}</span><span class="dots" role="img" aria-label="${esc(label)}">${dots}</span>${move}</div>`;
}

function areasHTML(ins) {
  if (!ins) return '<p class="muted small">Looking at your days…</p>';
  if (!ins.areas.some((a) => a.score != null)) {
    return `<p class="lately-empty">Connect your phone or Mac and Arise works out how your life is going.</p>
      <button class="link small" data-act="nav" data-v="${CONNECT}">Connect →</button>`;
  }
  return `<div class="life-grid">${ins.areas.map(cell).join('')}</div>
    <p class="muted small">Worked out from your days. Compared with your usual.</p>
    ${fromDevices(ins) ? '' : `<p class="muted small">Connect your phone or Mac and Arise sees more. <button class="link small" data-act="nav" data-v="${CONNECT}">Connect →</button></p>`}`;
}

// The clearest pattern Arise found in their days, if it was worked out today. On the screen only.
function noteHTML(ins) {
  const top = ins && ins.day === S.todayKey() ? ins.patterns[0] : null;
  if (!top) return '';
  return `<p class="lately-note">${esc(top.text)}</p><button class="link small" data-act="nav" data-v="progress">More on ${esc(w('youTab'))} →</button>`;
}

export function todaySide() {
  const ins = kept();
  const note = noteHTML(ins);
  return `<section class="panel lately" id="youLately">
    <div class="panel-title">${icon('heart')}<span>You lately</span></div>
    <div class="lately-areas" id="latelyAreas">${areasHTML(ins)}</div>
    ${growLine()}
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

// After Today is drawn: what Arise saw, the parts of life and the pattern, once they're worked out
// (when the device is idle, unless they were worked out today already). Only into the parts that
// were there when it started, while Today is still on screen and the data is still the same.
// Gives what was worked out, or null when nothing landed.
export async function fillSide() {
  const els = ['#daySeen', '#latelyAreas', '#latelyNote'].map((sel) => $(sel));
  if (!els.some(Boolean)) return null;
  const g = gen;
  let ins = null;
  try {
    if (!kept()) await idle();
    if (g !== gen || !els.some((el) => el?.isConnected)) return null;
    ins = await INS.get({ maxAge: MAX_AGE });
  } catch {}
  if (!ins || g !== gen || globalThis.document?.body?.dataset.view !== 'today') return null;
  const [seen, areas, note] = els;
  if (seen?.isConnected) seen.innerHTML = seenHTML(ins);
  if (areas?.isConnected) areas.innerHTML = areasHTML(ins);
  if (note?.isConnected) {
    const html = noteHTML(ins);
    note.innerHTML = html;
    note.hidden = !html;
  }
  return seen?.isConnected || areas?.isConnected || note?.isConnected ? ins : null;
}
