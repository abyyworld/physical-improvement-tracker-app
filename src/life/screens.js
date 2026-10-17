// The life log on screen: "Your days" (each day's journal, hour by hour, and everything in the log
// that day with its summary; search; adding a note), "What Arise knows" (the profile, the facts,
// learning, what's in the log), the day so far, the yesterday card and the way into the journal on
// Today, and the panel in Settings. Same look as the rest of the app; the log is read from
// IndexedDB, so each screen draws at once and fills in its parts when they're read.

import * as AI from '../ai.js';
import * as S from '../store';
import * as N from '../native.js';
import * as SYS from '../system.js';
import { esc, fmt, icon, openSheet, closeSheet, toast } from '../ui.js';
import * as L from './log';
import * as M from './memory';
import * as P from './policy';
import * as CLOUD from './cloud';
import * as MEUI from './me-ui.js';
import * as HUB from './connect-hub.js';
import { deleteCoachQuestion, isCoachQuestion } from './ingest';
import { SOURCE_NAMES } from './tiers';
import { addDays, dayEnd, dayKey, dayStart, monthStart, parseDay, parseWhen, withoutWhen } from './dates';
import { PART_NAMES, shareText, splitLine, toText } from './diary';
import { WAITS, byText } from './strength';
import { CHECKIN, hasCheckin } from '../lib/life-check';
import { hasLifeStore } from './store-port';

// (Parts of these screens fill in after reading the log; by then a test may have gone.)
const $ = (sel, root = globalThis.document) => root?.querySelector(sel) ?? null;
let app = { go: () => {}, render: () => {}, view: () => 'today', saveFile: async () => {} };

const today = () => dayKey(Date.now());
// pane: what a day opens on, its journal or everything in the log ('events'). cal: the month the
// calendar was moved to, and the day it was moved from (it follows the day again once that changes).
const fresh = () => ({ day: null, pane: 'journal', query: '', results: null, loose: false, searching: false, when: null, mood: 0, counts: null, progress: null, cal: null });
const ui = fresh();
// Where the life log and what Arise learns are kept: synced with an account, or only here.
const whereLine = () => CLOUD.lines().main;

export function initLife(hooks) {
  app = { ...app, ...hooks };
  // Anything changing in the log or the memory: the screen showing it catches up.
  let t = null;
  const refresh = () => {
    clearTimeout(t);
    t = setTimeout(() => {
      const v = app.view();
      if (v === 'days') {
        fillDay();
        fillCalendar();
      } else if (v === 'knows') fillKnows();
      else if (v === 'today') {
        fillRecap();
        fillDayLine();
      }
    }, 250);
  };
  L.onChange((c) => {
    if (c.type === 'clear') forgetScreens();
    else forgetCounts(c.days);
    refresh();
  });
  M.onMemoryChange(refresh);
}

// The log was emptied (or this device's data wiped): nothing from it stays on screen, like the
// last search's results, which the next person would otherwise see.
export function forgetScreens() {
  Object.assign(ui, fresh());
  recapCache = null;
  dayLineCache = null;
  journals.clear();
  forgetCounts();
  recapGen++; // a recap still on its way is from before
  dayLineGen++; // and so is a day line
  editing.id = null;
  $('#lifeResults')?.replaceChildren();
  $('#lifeRecap')?.replaceChildren();
  const line = $('#dayLine');
  if (line) line.textContent = DAY_LINE_WAIT;
  MEUI.forgetMeScreens();
}

// ---------- icons and words

const KIND_ICON = { quest: 'check', workout: 'bolt', play: 'ball', note: 'note', mood: 'note', health: 'scale', event: 'target', other: 'progress', message: 'system' };
const SOURCE_ICON = {
  arise: 'bolt',
  manual: 'note',
  google: 'search',
  youtube: 'play',
  chrome: 'globe',
  maps: 'pin',
  spotify: 'music',
  netflix: 'film',
  health: 'heart',
  whatsapp: 'chat',
  email: 'note',
  calendar: 'today',
  shortcut: 'system',
  browser: 'globe',
  mac: 'globe',
  android: 'bell',
  steam: 'game',
  psn: 'game',
  bank: 'card',
  other: 'note',
};
const eventIcon = (e) => icon(e.source === 'arise' ? KIND_ICON[e.kind] || 'bolt' : SOURCE_ICON[e.source] || 'note');
const timeOf = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const dayLabel = (k) => (k === today() ? 'Today' : k === addDays(today(), -1) ? 'Yesterday' : fmt(k, { weekday: 'long', day: 'numeric', month: 'long', year: k.slice(0, 4) === today().slice(0, 4) ? undefined : 'numeric' }));
// "Fri 16 Oct", with the year only when it isn't this one.
const shortDay = (k) => fmt(k, { weekday: 'short', day: 'numeric', month: 'short', year: k.slice(0, 4) === today().slice(0, 4) ? undefined : 'numeric' });
const plural = (n, one, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const MOODS = ['Low', 'Meh', 'Okay', 'Good', 'Great'];
const lifeError = (err) => err?.message || "The life log couldn't be read.";

// =====================================================================
// Today: the day so far, in the journal's words
// =====================================================================

const DAY_LINE_WAIT = 'Your day fills in here as it goes.';
let dayLineCache = null; // { day, html }, so Today draws it straight away next time
let dayLineGen = 0; // goes up with each fill, and when the log is emptied

// The line at the top of Today, from the last time it was worked out today.
export function dayLine() {
  return `<p class="day-line" id="dayLine">${dayLineCache && dayLineCache.day === today() ? dayLineCache.html : esc(DAY_LINE_WAIT)}</p>`;
}

// Called after Today is drawn, and when the log changes. The start of today's journal (as the
// journal tells it, in the voice they picked); else whether anything was ever there.
// Like fillRecap: only into the line that was there when it started, and only the latest fill
// (not one from before the log changed again, or was emptied). A read that fails keeps the line.
export async function fillDayLine() {
  const el = $('#dayLine');
  const gen = ++dayLineGen;
  const k = today();
  let html;
  try {
    const intro = (await M.builtJournal(k)).intro.trim();
    if (intro) html = esc(intro);
    else if ((await L.span()) || Object.values(S.state.logs).some(hasCheckin)) html = esc('Nothing in your day yet. It fills in as the day goes.');
    else html = `${esc('Arise writes your day here as it happens. Check in below, and connect your phone or apps so it fills in the rest.')} <button class="link" data-act="nav" data-v="${HUB.VIEW}">Connect →</button>`;
  } catch {
    return;
  }
  if (gen !== dayLineGen) return;
  dayLineCache = { day: k, html };
  if (el?.isConnected && app.view() === 'today') el.innerHTML = html;
}

// =====================================================================
// Today: yesterday, from memory
// =====================================================================

const RECAP_HIDDEN = 'arise-recap-hidden';
let recapCache = null; // { day, text, from }, so Today draws it straight away next time
let recapGen = 0; // goes up when the log is emptied

export function recapSlot() {
  return `<div id="lifeRecap">${recapCache && recapCache.day === addDays(today(), -1) && !recapHidden() ? recapCard(recapCache) : ''}</div>`;
}

function recapHidden() {
  try {
    return localStorage.getItem(RECAP_HIDDEN) === today();
  } catch {
    return false;
  }
}

const recapCard = (r) => `<section class="panel recap">
    <div class="panel-head"><p class="kicker">${icon('days')} Yesterday</p><button class="icon-btn small" data-act="life-recap-hide" aria-label="Hide until tomorrow">${icon('close')}</button></div>
    <p class="recap-text">${esc(r.text)}</p>
    <button class="link" data-act="life-journal" data-day="${esc(r.day)}">Read your journal ${icon('next')}</button>
  </section>`;

// Called after Today is drawn.
// Only into the card that was there when it started, and not after the log was emptied
// meanwhile: Today may have been drawn again since, for another account's data.
export async function fillRecap() {
  if (recapHidden()) return;
  const el = $('#lifeRecap');
  const gen = recapGen;
  let r = null;
  try {
    r = await M.recap(addDays(today(), -1));
  } catch {
    return;
  }
  if (gen !== recapGen) return;
  recapCache = r;
  if (el?.isConnected && app.view() === 'today') el.innerHTML = r ? recapCard(r) : '';
}

// The way into the journal on Today: a row at the foot of the day's card.
export function journalEntry() {
  return `<button class="journal-entry" data-act="life-journal" data-day="${esc(today())}"><span>${icon('note')}</span><span><b>Today's journal</b><small>Your day, hour by hour.</small></span><span class="go">Open ${icon('next')}</span></button>`;
}

// Opens a day's journal (from Today, a link, or a tapped notification).
export function openJournal(day) {
  closeSheet();
  ui.day = /^\d{4}-\d{2}-\d{2}$/.test(day || '') && day <= today() ? day : today();
  ui.pane = 'journal';
  ui.cal = null;
  if (app.view() === 'days') app.render();
  else app.go('days');
}

// =====================================================================
// Your days
// =====================================================================

export function renderDays(root) {
  if (!ui.day || ui.day > today()) ui.day = today();
  const k = ui.day;
  root.innerHTML = `
    <header class="page-head">
      <div><p class="kicker">Your life log</p><h1 class="display">Your days</h1></div>
      <button class="btn small ghost" data-act="nav" data-v="knows">${icon('system')} What Arise knows</button>
    </header>
    ${HUB.entryRow()}
    <div class="cols">
      <div class="col">
        ${calendarCard()}
        <section class="panel">
          <form class="life-search" id="lifeSearch" role="search" autocomplete="off">
            <label class="sr-only" for="lifeQ">Search your life log</label>
            <input id="lifeQ" type="search" enterkeyhint="search" maxlength="200" placeholder="What did I do…" value="${esc(ui.query)}">
            <button class="icon-btn send" type="submit" aria-label="Search">${icon('search')}</button>
          </form>
          <div id="lifeResults">${resultsHTML()}</div>
        </section>
        <section class="panel">
          <div class="life-nav">
            <button class="icon-btn" data-act="life-day" data-d="-1" aria-label="The day before">${icon('back')}</button>
            <div class="life-nav-day">
              <b>${esc(dayLabel(k))}</b>
              <label class="sr-only" for="lifeDate">Pick a day</label>
              <input id="lifeDate" type="date" value="${esc(k)}" max="${esc(today())}">
            </div>
            <button class="icon-btn" data-act="life-day" data-d="1" aria-label="The day after" ${k >= today() ? 'disabled' : ''}>${icon('next')}</button>
          </div>
          ${k !== today() ? '<button class="link" data-act="life-today">Back to today</button>' : ''}
          <div class="seg life-panes" role="group" aria-label="Show">${paneButton('journal', 'Journal')}${paneButton('events', 'Everything')}</div>
          <div id="lifeDay"><div class="thinking"><span class="dots"><i></i><i></i><i></i></span> Reading your day…</div></div>
          <button class="btn primary block" data-act="life-add">${icon('note')} Add to your day</button>
        </section>
      </div>
      <div class="col">
        <section class="panel small-print life-about">
          <p class="small">Arise keeps a log of your days: your quests, workouts and journal, the notes you add here, and what you bring in from other apps. The coach uses it to answer with what really happened.</p>
          <p class="small">Each day opens on its journal: written from your log hour by hour, and by the AI too when it may read the whole day. Edit it as you like. Your words stay yours.</p>
          <p class="small">${esc(whereLine())}</p>
        </section>
      </div>
    </div>`;
  fillDay();
}

const paneButton = (v, label) => `<button class="${ui.pane === v ? 'on' : ''}" data-act="life-pane" data-v="${v}" aria-pressed="${ui.pane === v}">${label}</button>`;

let dayToken = 0;

// The day: its journal, and everything in the log with its summary. Both are drawn; the switch
// above shows one (so it's instant, and today's journal fills in like the rest).
async function fillDay() {
  const k = ui.day;
  const token = ++dayToken;
  const el = () => (token === dayToken && app.view() === 'days' ? $('#lifeDay') : null);
  let events = [];
  let journal = null;
  try {
    await M.load().catch(() => {});
    [events, journal] = await Promise.all([L.eventsBetween(dayStart(k), dayEnd(k), { limit: 5000 }), M.journalView(k).catch(() => null)]);
  } catch (err) {
    const box = el();
    if (box) box.innerHTML = `<p class="error small">${esc(lifeError(err))}</p>`;
    return;
  }
  const box = el();
  if (!box) return;
  if (journal) journals.set(k, journal);
  box.innerHTML = `<div data-pane="journal" ${ui.pane === 'journal' ? '' : 'hidden'}>${journal ? journalHTML(k, journal) : ''}</div>
    <div data-pane="events" ${ui.pane === 'events' ? '' : 'hidden'}>${summaryHTML(k, events) + timelineHTML(events)}</div>`;
}

function showPane(v) {
  ui.pane = v === 'events' ? 'events' : 'journal';
  for (const p of document.querySelectorAll('#lifeDay [data-pane]')) p.toggleAttribute('hidden', p.dataset.pane !== ui.pane);
  for (const b of document.querySelectorAll('.life-panes [data-act="life-pane"]')) {
    b.classList.toggle('on', b.dataset.v === ui.pane);
    b.setAttribute('aria-pressed', String(b.dataset.v === ui.pane));
  }
}

// ---------- the month at a glance

// How full a day's log is: 0 nothing, 1 a little, 2 a lot, 3 very full. (Arise alone makes a few
// things a day; the phone, imports and browser history make many more.)
export const activityLevel = (n) => (n >= 40 ? 3 : n >= 10 ? 2 : n > 0 ? 1 : 0);
const LEVEL_TEXT = ['Nothing in your log', 'A little in your log', 'A lot in your log', 'Your log is very full'];

const monthOf = (k) => k.slice(0, 7); // '2026-10'
const addMonths = (m, n) => monthOf(dayKey(new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1 + n, 1)));
const monthTitle = (m) => fmt(`${m}-01`, { month: 'long', year: 'numeric' });
const monthDays = (m) => {
  const n = new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0).getDate();
  return Array.from({ length: n }, (_, i) => `${m}-${String(i + 1).padStart(2, '0')}`);
};
// The month on show: where the arrows moved it, else the open day's. Never after this month.
const calMonth = () => {
  const m = ui.cal && ui.cal.day === ui.day ? ui.cal.month : monthOf(ui.day || today());
  return m > monthOf(today()) ? monthOf(today()) : m;
};
// The calendar shades days only when this device keeps a life log (you.js asks the same).
const logHere = () => hasLifeStore() && L.hasLifeDB();

const calCounts = new Map(); // month -> { day: how many things }, read once and kept until the log changes
let calGen = 0; // goes up with each fill, and when the counts are forgotten

// The log changed on these days (none named: maybe any): their months are read again.
function forgetCounts(days) {
  calGen++;
  if (days?.length) for (const k of days) calCounts.delete(monthOf(k));
  else calCounts.clear();
}

// The day's check-in as a dot: its mood, else its energy.
function feltOn(k) {
  const l = S.state.logs?.[k];
  const f = l?.m ? 'm' : l?.e ? 'e' : null;
  if (!f) return null;
  const v = l[f];
  return { tone: v <= 2 ? 'low' : v === 3 ? 'mid' : 'high', text: `${CHECKIN[f].label}: ${CHECKIN[f].words[v - 1].toLowerCase()}` };
}

function cellLabel(k, counts) {
  const felt = feltOn(k);
  return [fmt(k, { weekday: 'long', day: 'numeric', month: 'long' }), counts && LEVEL_TEXT[activityLevel(counts[k] || 0)], felt?.text].filter(Boolean).join('. ');
}

function calendarHTML() {
  const m = calMonth();
  const now = today();
  const thisMonth = monthOf(now);
  const days = monthDays(m);
  const lead = (parseDay(days[0]).getDay() + 6) % 7; // Monday first
  const counts = logHere() ? calCounts.get(m) : null;
  const monday = '2026-10-12'; // any Monday, for the names of the days
  const head = Array.from({ length: 7 }, (_, i) => `<span class="cal-wd" aria-hidden="true">${esc(fmt(addDays(monday, i), { weekday: 'short' }))}</span>`).join('');
  const cells = days
    .map((k) => {
      const felt = feltOn(k);
      const cls = ['cal-day', k === now && 'today', k === ui.day && 'on'].filter(Boolean).join(' ');
      return `<button class="${cls}" data-act="life-cal-day" data-day="${k}" data-lvl="${counts ? activityLevel(counts[k] || 0) : 0}" aria-label="${esc(cellLabel(k, counts))}" aria-pressed="${k === ui.day}"${k === now ? ' aria-current="date"' : ''}${k > now ? ' disabled' : ''}><span class="cal-n">${Number(k.slice(8))}</span>${felt ? `<i class="cal-dot ${felt.tone}"></i>` : ''}</button>`;
    })
    .join('');
  const scale = `<span class="cal-scale" aria-hidden="true">${[0, 1, 2, 3].map((n) => `<i data-lvl="${n}"></i>`).join('')}</span>`;
  return `<section class="panel cal" id="lifeCal" data-month="${m}" aria-label="Calendar">
    <div class="cal-head">
      <h2 class="cal-title" aria-live="polite">${esc(monthTitle(m))}</h2>
      ${m !== thisMonth ? '<button class="btn small ghost" data-act="life-cal-today">Today</button>' : ''}
      <button class="icon-btn small" data-act="life-cal-month" data-d="-1" aria-label="Previous month">${icon('back')}</button>
      <button class="icon-btn small" data-act="life-cal-month" data-d="1" aria-label="Next month"${m >= thisMonth ? ' disabled' : ''}>${icon('next')}</button>
    </div>
    <div class="cal-grid" role="group" aria-label="${esc(monthTitle(m))}">${head}${'<span></span>'.repeat(lead)}${cells}</div>
    <p class="muted small cal-legend">${logHere() ? `${scale} Darker days have more in them. The dot is how you felt.` : 'The dot is how you felt.'}</p>
  </section>`;
}

// The month at the top of Your days. Once it's on screen, it shades each day by what's in the log.
function calendarCard() {
  queueMicrotask(fillCalendar);
  return calendarHTML();
}

// Reads the month's counts (once; again after the log changes), then shades the days. Like
// fillRecap: only into the calendar still on screen for that month, and only the latest fill.
async function fillCalendar() {
  if (!logHere()) return;
  const gen = ++calGen;
  const m = calMonth();
  let counts = calCounts.get(m);
  if (!counts) {
    try {
      const y = Number(m.slice(0, 4));
      const mo = Number(m.slice(5, 7)) - 1;
      counts = await L.countByDay(monthStart(y, mo), monthStart(y, mo + 1));
    } catch {
      return;
    }
    if (gen !== calGen) return;
    calCounts.set(m, counts);
  }
  const el = $('#lifeCal');
  if (!el?.isConnected || app.view() !== 'days' || el.dataset.month !== m) return;
  for (const b of el.querySelectorAll('.cal-day')) {
    b.dataset.lvl = String(activityLevel(counts[b.dataset.day] || 0));
    b.setAttribute('aria-label', cellLabel(b.dataset.day, counts));
  }
}

// Another month: only the calendar is drawn again, and the arrow keeps the focus.
function showMonth(n) {
  const m = addMonths(calMonth(), n);
  ui.cal = { month: m > monthOf(today()) ? monthOf(today()) : m, day: ui.day };
  const el = $('#lifeCal');
  if (!el) return app.render();
  el.outerHTML = calendarCard();
  const arrow = $(`#lifeCal [data-act="life-cal-month"][data-d="${n > 0 ? 1 : -1}"]`);
  (arrow && !arrow.disabled ? arrow : $('#lifeCal [data-act="life-cal-month"][data-d="-1"]'))?.focus();
}

// ---------- the journal

const journals = new Map(); // day -> what was drawn last, for Edit, Copy and Share

const SOURCE_LINE = { built: 'Written from your log.', edited: "Your own words. Arise won't change them." };
const journalTitle = (k) => fmt(k, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const canShare = () => N.canShareLink() || typeof navigator.share === 'function';
// The AI in use is too weak to write the memory. (With keys whose model is only known once asked,
// what the last try found.)
const memoryWaits = () => {
  const s = AI.memoryStrength();
  return AI.ready() && (s === 'weak' || (s === 'maybe' && M.learning.waits));
};

function journalHTML(k, v) {
  const isToday = k === today();
  const { doc } = v;
  const own = v.built.own;
  const empty = !doc.intro && !doc.parts.length;
  const by = v.source === 'ai' ? `Written by ${byText(v.stored?.by) || 'your AI'}, from your log.` : SOURCE_LINE[v.source];
  const ask = isToday ? `<div class="journal-ask"><p class="journal-ask-q">How was today?</p><button class="btn small primary" data-act="life-add">${icon('note')} Add a note or your mood</button></div>` : '';
  const ownHTML = own ? `<div class="journal-own"><p class="journal-own-k">In my words${own.energy ? ` · energy ${own.energy} of 5` : ''}</p>${own.text ? `<p>${esc(own.text)}</p>` : ''}</div>` : '';
  const parts = doc.parts
    .map((p) => {
      const rows = p.lines.map(splitLine);
      const body = rows.every((r) => r.time)
        ? `<ol class="journal-lines">${rows.map((r) => `<li><time>${esc(r.time)}</time><span>${esc(r.text)}</span></li>`).join('')}</ol>`
        : rows.map((r) => `<p>${r.time ? `<time>${esc(r.time)}</time> ` : ''}${esc(r.text)}</p>`).join('');
      return `<section class="journal-part"><h3 class="journal-part-name">${esc(PART_NAMES[p.part])}</h3>${body}</section>`;
    })
    .join('');
  const again =
    v.source !== 'built'
      ? `<button class="btn ghost small" data-act="life-j-again" data-day="${esc(k)}">Write it again</button>`
      : !isToday && !empty && AI.ready() && !memoryWaits()
        ? `<button class="btn ghost small" data-act="life-j-again" data-day="${esc(k)}">${icon('system')} Write it with AI</button>`
        : '';
  const acts = empty && !own ? again : `<button class="btn ghost small" data-act="life-j-edit" data-day="${esc(k)}">Edit</button><button class="btn ghost small" data-act="life-j-copy" data-day="${esc(k)}">Copy</button>${canShare() ? `<button class="btn ghost small" data-act="life-j-share" data-day="${esc(k)}">${icon('share')} Share</button>` : ''}${again}`;
  return `<article class="journal" aria-label="Your journal for ${esc(journalTitle(k))}">
    ${ask}
    ${empty ? `<p class="muted journal-empty">${isToday ? 'Nothing in your journal yet today. It fills in as the day goes.' : 'Nothing in your journal for this day.'}</p>` : doc.intro ? `<p class="journal-intro">${esc(doc.intro)}</p>` : ''}
    ${ownHTML}
    ${parts}
    ${empty ? '' : `<p class="muted small journal-by">${esc(by)}</p>`}
    ${v.partial ? `<p class="muted small journal-partial">This day has more in your log than a journal can hold, so the end of it is left out. Everything is still in the log.</p>` : ''}
    ${!isToday && memoryWaits() && v.source === 'built' ? `<p class="muted small journal-waits">${esc(WAITS)}</p>` : ''}
    ${acts ? `<div class="row journal-acts">${acts}</div>` : ''}
  </article>`;
}

const journalText = (k) => {
  const v = journals.get(k);
  return v ? shareText(v.doc, { title: journalTitle(k), own: v.built.own }) : '';
};

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {}
  // Older browsers: through a text box, selected and copied.
  const box = document.createElement('textarea');
  box.value = text;
  box.setAttribute('readonly', '');
  box.style.position = 'fixed';
  box.style.opacity = '0';
  document.body.append(box);
  box.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {}
  box.remove();
  return ok;
}

function editJournal(k) {
  const v = journals.get(k);
  if (!v) return;
  editing.day = k;
  openSheet(`<p class="kicker">Edit your journal</p>
    <h2 class="display sheet-title">${esc(dayLabel(k))}</h2>
    <label class="field"><span class="k">Your journal</span><textarea id="lifeJournalEdit" class="log-text journal-edit" rows="14" maxlength="8000">${esc(toText(v.doc))}</textarea></label>
    <p class="muted small">Keep a line that says Morning, Afternoon, Evening or Night on its own to start that part of the day.</p>
    <button class="btn primary block" data-act="life-j-save">Save</button>
    <p class="muted small">Once you edit it, it's yours: the AI won't write over it unless you tap Write it again.</p>`);
  $('#lifeJournalEdit')?.focus();
}

function summaryHTML(k, events) {
  const s = M.summaryFor('day', k);
  if (s) return `<div class="ai-reply life-summary"><p class="sys-line">[Your day]</p><p>${esc(s.text)}</p></div>`;
  if (!events.length || k >= today()) return '';
  if (M.learning.running) return `<div class="thinking"><span class="dots"><i></i><i></i><i></i></span> Learning from your days…</div>`;
  if (!AI.ready()) return '';
  return `<button class="btn ghost small" data-act="life-sum" data-day="${esc(k)}">${icon('system')} Sum up this day</button>`;
}

function timelineHTML(events) {
  if (!events.length) return `<p class="muted life-empty">Nothing in your log for this day yet.</p>`;
  const hours = new Map();
  for (const e of events) {
    const h = new Date(e.at).getHours();
    hours.set(h, [...(hours.get(h) || []), e]);
  }
  const SHOW = 10;
  const row = (e) => `<li><button class="tl-ev" data-act="life-ev" data-id="${esc(e.id)}">
      <span class="tl-icon">${eventIcon(e)}</span>
      <span class="tl-body"><span class="tl-title">${esc(e.title)}</span><small>${esc(SOURCE_NAMES[e.source] || e.source)} · ${esc(timeOf(e.at))}</small></span>
    </button></li>`;
  return `<div class="timeline">${[...hours.entries()]
    .map(([h, list]) => {
      const shown = list.slice(0, SHOW).map(row).join('');
      const more = list.length > SHOW ? `<details class="other"><summary>${list.length - SHOW} more at this hour</summary><ul class="tl-list">${list.slice(SHOW).map(row).join('')}</ul></details>` : '';
      return `<div class="tl-hour"><p class="tl-h">${esc(timeOf(new Date(2000, 0, 1, h).getTime()))}</p><ul class="tl-list">${shown}</ul>${more}</div>`;
    })
    .join('')}</div>`;
}

// ---------- search

function resultsHTML() {
  if (ui.searching) return `<div class="thinking"><span class="dots"><i></i><i></i><i></i></span> Searching your log…</div>`;
  if (!ui.results) return '';
  const ask = `<button class="btn ghost small" data-act="life-ask">${icon('system')} Ask the coach</button>`;
  if (!ui.results.length) return `<p class="muted small">Nothing in your log matches “${esc(ui.query)}”${ui.when ? ` (${esc(ui.when)})` : ''}.</p><div class="row">${ask}</div>`;
  const list = ui.results
    .map(
      (e) => `<li><button class="tl-ev" data-act="life-open-day" data-day="${esc(dayKey(e.at))}">
      <span class="tl-icon">${eventIcon(e)}</span>
      <span class="tl-body"><span class="tl-title">${esc(e.title)}</span><small>${esc(shortDay(dayKey(e.at)))} · ${esc(timeOf(e.at))} · ${esc(SOURCE_NAMES[e.source] || e.source)}</small></span>
    </button></li>`,
    )
    .join('');
  const loose = ui.loose === 'when' ? 'Nothing had those words, so here is everything from then: ' : ui.loose ? 'Nothing had every word, so here are the closest: ' : '';
  return `<p class="muted small">${loose}${plural(ui.results.length, 'thing')} found${ui.when ? `, ${esc(ui.when)}` : ''}. Tap one to see its day.</p>
    <ul class="tl-list life-results">${list}</ul>
    <div class="row">${ask}<button class="btn ghost small" data-act="life-clear">Clear</button></div>`;
}

async function runSearch(q) {
  ui.query = q.trim().slice(0, 200);
  ui.results = null;
  ui.loose = false;
  ui.when = null;
  if (!ui.query) {
    paintResults();
    return;
  }
  ui.searching = true;
  paintResults();
  try {
    const when = parseWhen(ui.query);
    const words = L.queryWords(withoutWhen(ui.query, when));
    const range = when ? { from: when.from, to: when.to } : {};
    ui.when = when ? when.label : null;
    ui.results = [];
    if (words.length) {
      ui.results = await L.search(words.join(' '), { ...range, limit: 50 });
      if (!ui.results.length) {
        ui.results = await L.search(words.join(' '), { ...range, limit: 30, any: true });
        ui.loose = ui.results.length > 0;
      }
    }
    // A date alone, or one whose other words aren't in the log: everything then.
    if (!ui.results.length && when) {
      ui.results = await L.eventsBetween(when.from, when.to, { limit: 100, newest: true });
      ui.loose = words.length > 0 && ui.results.length > 0 ? 'when' : false;
    }
  } catch (err) {
    ui.results = null;
    toast(lifeError(err));
  }
  ui.searching = false;
  paintResults();
}

function paintResults() {
  const el = $('#lifeResults');
  if (el) el.innerHTML = resultsHTML();
}

// ---------- one event

async function showEvent(id) {
  const e = await L.getEvent(id).catch(() => null);
  if (!e) return;
  const value = e.value != null && e.unit ? `<p class="muted small">${esc(e.value)} ${esc(e.unit)}</p>` : '';
  openSheet(`<p class="kicker">${eventIcon(e)} ${esc(SOURCE_NAMES[e.source] || e.source)}</p>
    <h2 class="display sheet-title life-ev-title">${esc(e.title)}</h2>
    <p class="muted">${esc(fmt(dayKey(e.at), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }))}, ${esc(timeOf(e.at))}${e.end && e.end > e.at ? ` to ${esc(timeOf(e.end))}` : ''}</p>
    ${e.detail ? `<p class="life-detail">${esc(e.detail)}</p>` : ''}
    ${value}
    ${e.url ? `<p class="small"><a href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">Open the link ${icon('ext')}</a></p>` : ''}
    <p class="muted small">${esc(P.tierText(e.tier))}</p>
    ${
      e.source === 'arise' && !isCoachQuestion(e.id)
        ? '<p class="muted small">This comes from Arise itself. To change it, change it where you made it.</p>'
        : `${isCoachQuestion(e.id) ? '<p class="muted small">You asked the coach this. Deleting it here takes it out of your log for good. The chat keeps it until you start a new chat.</p>' : ''}<button class="btn ghost block danger" data-act="life-ev-del" data-id="${esc(e.id)}">Delete from your log</button>`
    }`);
}

// ---------- adding to a day

function openAdd() {
  ui.mood = 0;
  const k = ui.day || today();
  const now = new Date();
  const time = k === today() ? `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}` : '12:00';
  openSheet(`<p class="kicker">Add to your day</p>
    <h2 class="display sheet-title">${esc(dayLabel(k))}</h2>
    <label class="field"><span class="k">What happened</span><textarea id="lifeNote" class="log-text" rows="4" maxlength="2000" placeholder="Lunch with Sam in the park. Felt good after."></textarea></label>
    <p class="label">Mood <span class="muted">· if you like</span></p>
    <div class="seg" role="group" aria-label="Mood">${MOODS.map((m, i) => `<button data-act="life-mood" data-v="${i + 1}" aria-pressed="false">${m}</button>`).join('')}</div>
    <label class="field inline"><span class="k">Time</span><input id="lifeTime" type="time" value="${time}"></label>
    <button class="btn primary block" data-act="life-add-save">Save</button>
    <p class="muted small life-note">Only the private AI and the AI on your device read your notes, unless you allow more in What Arise knows.</p>`);
  $('#lifeNote')?.focus();
}

async function saveNote() {
  const k = ui.day || today();
  const text = ($('#lifeNote')?.value || '').trim();
  const mood = ui.mood;
  if (!text && !mood) {
    toast('Write a few words or pick a mood first.');
    return;
  }
  const [h, m] = ($('#lifeTime')?.value || '12:00').split(':').map(Number);
  const d = new Date(dayStart(k));
  d.setHours(Number.isFinite(h) ? h : 12, Number.isFinite(m) ? m : 0);
  const first = text.split('\n')[0].trim();
  const event = {
    id: `manual:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    source: 'manual',
    kind: text ? 'note' : 'mood',
    at: Math.min(d.getTime(), Date.now()),
    title: text ? (first.length > 90 ? `${first.slice(0, 89)}…` : first) : `Mood: ${MOODS[mood - 1]}`,
    tier: 2,
    ...(text ? { detail: `${text}${mood ? `\n\nMood: ${MOODS[mood - 1]}.` : ''}` } : {}),
    ...(mood ? { value: mood, unit: 'mood (1-5)', meta: { mood: MOODS[mood - 1] } } : {}),
  };
  try {
    const n = await L.addEvents([event]);
    if (!n) throw new Error("That couldn't be saved.");
  } catch (err) {
    toast(lifeError(err));
    return;
  }
  closeSheet();
  toast('Added to your day.');
  if (app.view() === 'days') fillDay();
}

// =====================================================================
// What Arise knows
// =====================================================================

const editing = { id: null, day: null };

export function renderKnows(root) {
  const pr = P.prefs();
  root.innerHTML = `
    <header class="page-head life-back-head"><button class="icon-btn" data-act="nav" data-v="days" aria-label="Back to your days">${icon('back')}</button><div><p class="kicker">Your memory</p><h1 class="display">What Arise knows</h1></div></header>
    <div class="cols">
      <div class="col">
        <section class="panel glow">
          <div class="panel-title">${icon('system')}<span>Profile</span></div>
          <p class="muted small">The coach reads this with every answer. Pin a fact to keep it here.</p>
          <div id="lifeProfile">${profileHTML()}</div>
        </section>
        <section class="panel">
          <div class="panel-title"><span>Facts</span></div>
          <form class="life-search" id="lifeFactForm" autocomplete="off">
            <label class="sr-only" for="lifeFactIn">Add a fact</label>
            <input id="lifeFactIn" type="text" maxlength="240" placeholder="Add a fact about you">
            <button class="btn primary small" type="submit">Add</button>
          </form>
          <div id="lifeFacts">${factsHTML()}</div>
        </section>
      </div>
      <div class="col">
        ${MEUI.aboutPanel()}
        ${MEUI.appsPanel()}
        <section class="panel">
          <div class="panel-title"><span>Learning</span></div>
          <p id="lifeLearn" class="small">${learnText()}</p>
          <button class="toggle-row" data-act="life-pause" data-on="${!pr.paused}" aria-pressed="${pr.paused}"><span><b>Stop learning</b><small>Arise keeps your log but doesn't sum up days or learn new facts.</small></span><span class="switch ${pr.paused ? 'on' : ''}"></span></button>
          <button class="toggle-row" data-act="life-less-private" data-on="${!pr.lessPrivate}" aria-pressed="${pr.lessPrivate}"><span><b>Let less private AIs read my life log</b><small>Off: the free AI and your own AI service only see your goals and quests in Arise. On: they can read your notes and everything you bring in, like searches, places and messages. Those companies can read what they're sent. Gemini's free tier also says not to send it personal information.</small></span><span class="switch ${pr.lessPrivate ? 'on' : ''}"></span></button>
        </section>
        <section class="panel">
          <div class="panel-title"><span>What's in your log</span></div>
          <div id="lifeSources">${sourcesHTML()}</div>
          <div class="row">
            <button class="btn ghost small" data-act="life-export">Download all</button>
            <button class="btn ghost small danger" data-act="life-wipe">Delete everything</button>
          </div>
          <p class="muted small life-note">${esc(whereLine())}</p>
        </section>
      </div>
    </div>`;
  fillKnows();
}

function profileHTML() {
  if (!M.isLoaded()) return '<p class="muted small">Reading…</p>';
  const lines = M.buildProfile(M.allFacts(), { cap: 3, chars: 1500 });
  if (!lines.length) return '<p class="muted">Nothing yet. Arise learns as your days fill up, or add something below.</p>';
  return `<ul class="changes">${lines.map((l) => `<li>${esc(l.replace(/^- /, ''))}</li>`).join('')}</ul>`;
}

const factMeta = (f) =>
  [f.from === 'you' ? 'Added by you' : `Learned from ${plural(f.sources.length || 1, 'day')}`, `since ${fmt(f.since, { day: 'numeric', month: 'short', year: 'numeric' })}`, f.until ? `until ${fmt(f.until, { day: 'numeric', month: 'short', year: 'numeric' })}` : '', f.pinned ? 'pinned' : '']
    .filter(Boolean)
    .join(' · ');

function factRow(f) {
  return `<li class="fact ${f.pinned ? 'pinned' : ''}">
    <p class="fact-text">${f.pinned ? `${icon('pin')} ` : ''}${esc(f.text)}</p>
    <p class="muted small">${esc(factMeta(f))}</p>
    <div class="fact-acts">
      ${f.until ? `<button class="link" data-act="life-fact-back" data-id="${esc(f.id)}">Still true</button>` : `<button class="link" data-act="life-pin" data-id="${esc(f.id)}">${f.pinned ? 'Unpin' : 'Pin'}</button><button class="link" data-act="life-fact-edit" data-id="${esc(f.id)}">Edit</button>`}
      ${f.from === 'ai' ? `<button class="link" data-act="life-why" data-id="${esc(f.id)}">Why?</button>` : ''}
      <button class="link danger-link" data-act="life-fact-del" data-id="${esc(f.id)}">Delete</button>
    </div>
  </li>`;
}

function factsHTML() {
  if (!M.isLoaded()) return '';
  const all = M.allFacts();
  const live = all.filter((f) => !f.until).sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.sources.length - a.sources.length || (b.since > a.since ? 1 : -1));
  const old = all.filter((f) => f.until).sort((a, b) => (b.until > a.until ? 1 : -1));
  return `${live.length ? `<ul class="fact-list">${live.map(factRow).join('')}</ul>` : '<p class="muted small">No facts yet.</p>'}
    ${old.length ? `<details class="other"><summary>No longer true (${old.length})</summary><ul class="fact-list">${old.map(factRow).join('')}</ul></details>` : ''}`;
}

function learnText() {
  const pr = P.prefs();
  const e = AI.engine();
  if (pr.paused) return "Paused. Arise isn't learning anything new.";
  if (!e) return 'Turn on the AI coach in Settings, and Arise starts learning from your days.';
  // Only strong models write the memory (life/strength.ts).
  if (memoryWaits()) return `${esc(WAITS)} The coach still answers with the AI you use now.`;
  if (M.learning.running) return 'Learning from your days…';
  const p = ui.progress;
  let text = p ? `${plural(p.done, 'day')} of ${plural(p.days, 'day')} in your log summed up so far. A few more each time you open the app.` : 'Arise sums up a few of your days each time you open the app.';
  if (P.lessPrivate(e) && P.cap() < 3) text += ' The AI you use now is less private, so it only learns from your goals and quests in Arise.';
  if (M.learning.error) text += ` Last try: ${M.learning.error}`;
  return esc(text);
}

function sourcesHTML() {
  const c = ui.counts;
  if (!c) return '<p class="muted small">Reading…</p>';
  const list = Object.entries(c).sort((a, b) => b[1] - a[1]);
  if (!list.length) return '<p class="muted small">Your log is empty.</p>';
  return `<ul class="src-list">${list
    .map(
      ([s, n]) => `<li><span class="tl-icon">${icon(SOURCE_ICON[s] || 'note')}</span><span class="src-name"><b>${esc(SOURCE_NAMES[s] || s)}</b><small>${esc(plural(n, 'thing'))}</small></span>${
        s === 'arise' ? '<small class="muted">from the app</small>' : `<button class="btn ghost small danger" data-act="life-src-del" data-src="${esc(s)}">Delete</button>`
      }</li>`,
    )
    .join('')}</ul>`;
}

let knowsToken = 0;

async function fillKnows() {
  const token = ++knowsToken;
  try {
    await M.load();
    const [counts, days] = await Promise.all([L.countBySource(), L.daysWithEvents({ limit: 20000 })]);
    ui.counts = counts;
    const summed = new Set(M.daySummaries().map((s) => s.key));
    ui.progress = { days: days.length, done: days.filter((k) => summed.has(k)).length };
  } catch (err) {
    ui.counts = {};
    if (token === knowsToken && app.view() === 'knows') toast(lifeError(err));
  }
  if (token !== knowsToken || app.view() !== 'knows') return;
  const set = (id, html) => {
    const el = $(id);
    if (el) el.innerHTML = html;
  };
  set('#lifeProfile', profileHTML());
  set('#lifeFacts', factsHTML());
  set('#lifeSources', sourcesHTML());
  const learn = $('#lifeLearn');
  if (learn) learn.innerHTML = learnText();
  MEUI.fillMe();
}

function showWhy(id) {
  const f = M.allFacts().find((x) => x.id === id);
  if (!f) return;
  const days = [...f.sources].reverse();
  openSheet(`<p class="kicker">Why Arise thinks this</p>
    <h2 class="display sheet-title life-ev-title">${esc(f.text)}</h2>
    <p class="muted small">Learned from ${plural(days.length, 'day')} in your log. ${esc(P.tierText(f.tier))}</p>
    <ul class="hist-list">${days
      .map((k) => {
        const s = M.summaryFor('day', k);
        return `<li><button class="hist" data-act="life-open-day" data-day="${esc(k)}"><span class="hist-date">${esc(shortDay(k))}</span><span class="hist-name">${s ? esc(s.text) : 'See this day'}</span></button></li>`;
      })
      .join('')}</ul>`);
}

function editFact(id) {
  const f = M.allFacts().find((x) => x.id === id);
  if (!f) return;
  editing.id = id;
  openSheet(`<p class="kicker">Edit a fact</p>
    <h2 class="display sheet-title">What's true</h2>
    <label class="field"><span class="k">The fact</span><textarea id="lifeFactEdit" class="log-text" rows="3" maxlength="240">${esc(f.text)}</textarea></label>
    <button class="btn primary block" data-act="life-fact-save">Save</button>
    <p class="muted small">Once you edit a fact, it's yours: the AI won't change it.</p>`);
  $('#lifeFactEdit')?.focus();
}

// =====================================================================
// Settings
// =====================================================================

export function settingsPanel() {
  const voice = S.state.settings.journalVoice;
  const opt = (v, label) => `<button class="${voice === v ? 'on' : ''}" data-act="life-voice" data-v="${v}" aria-pressed="${voice === v}">${label}</button>`;
  const { main, note } = CLOUD.lines();
  return `<section class="panel">
    <div class="panel-title">${icon('days')}<span>Your life log</span></div>
    <p>Arise keeps a log of your days and learns what matters to you, so the coach knows you well. ${esc(main)}</p>
    ${note ? `<p class="muted small" id="lifeSyncNote">${esc(note)}</p>` : ''}
    <div class="row"><button class="btn ghost small" data-act="nav" data-v="knows">What Arise knows</button><button class="btn ghost small" data-act="nav" data-v="days">Your days</button></div>
    <p class="label">Your journal is written as</p>
    <div class="seg" role="group" aria-label="Your journal is written as">${opt('first', '“I”, like a diary')}${opt('you', '“You”')}</div>
  </section>`;
}

// =====================================================================
// Taps
// =====================================================================

export async function handleAction(act, el) {
  if (act.startsWith('me-')) return MEUI.handleAction(act, el);
  const d = el.dataset;
  switch (act) {
    case 'life-day': {
      const next = addDays(ui.day || today(), Number(d.d) || 0);
      ui.day = next > today() ? today() : next;
      app.render();
      return true;
    }
    case 'life-today':
      ui.day = today();
      app.render();
      return true;
    // The calendar: a day opens like picking it, on its journal.
    case 'life-cal-day':
    case 'life-cal-today':
      ui.cal = null;
      ui.day = act === 'life-cal-today' || !/^\d{4}-\d{2}-\d{2}$/.test(d.day || '') || d.day > today() ? today() : d.day;
      ui.pane = 'journal';
      app.render();
      return true;
    case 'life-cal-month':
      showMonth(Number(d.d) < 0 ? -1 : 1);
      return true;
    case 'life-open-day':
      closeSheet();
      ui.day = d.day && d.day <= today() ? d.day : today();
      ui.cal = null;
      app.go('days');
      return true;
    case 'life-recap-hide':
      try {
        localStorage.setItem(RECAP_HIDDEN, today());
      } catch {}
      $('#lifeRecap')?.replaceChildren();
      return true;
    case 'life-journal':
      openJournal(d.day);
      return true;
    case 'life-pane':
      showPane(d.v);
      return true;
    case 'life-j-edit':
      editJournal(d.day);
      return true;
    case 'life-j-save': {
      const k = editing.day;
      if (!k) return true;
      try {
        await M.saveJournalEdit(k, $('#lifeJournalEdit')?.value || '');
      } catch (err) {
        toast(lifeError(err));
        return true;
      }
      closeSheet();
      toast("Saved. Arise won't change your words.");
      if (app.view() === 'days') fillDay();
      return true;
    }
    case 'life-j-copy':
      toast((await copyText(journalText(d.day))) ? 'Copied.' : "Couldn't copy it on this device.");
      return true;
    case 'life-j-share': {
      const text = journalText(d.day);
      const title = `My journal, ${journalTitle(d.day)}`;
      try {
        if (N.canShareLink()) await N.shareLink({ title, text });
        else await navigator.share({ title, text });
      } catch (err) {
        if (err?.name !== 'AbortError') toast((await copyText(text)) ? "Couldn't share it, so it's copied instead." : "Couldn't share it.");
      }
      return true;
    }
    case 'life-j-again': {
      const k = d.day;
      if (M.journalFor(k)?.edited && !confirm("Write this day's journal again? Your edits go.")) return true;
      if (M.learning.running) {
        toast('Arise is learning from your days right now. Try again in a moment.');
        return true;
      }
      el.disabled = true;
      el.textContent = 'Writing…';
      const r = await M.rewriteJournal(k).catch(() => 'failed');
      const why = !AI.ready() ? 'Turn on the AI coach in Settings to have it written.' : memoryWaits() ? WAITS : 'Your AI may not read all of this day.';
      if (r === 'built') toast(`Back to the journal from your log. ${why}`);
      else if (r === 'kept') toast(`It stays as it is. ${why}`);
      else if (r === 'failed') toast(M.learning.waits ? WAITS : M.learning.error || "It couldn't be written just now. Try again later.");
      if (app.view() === 'days') fillDay();
      return true;
    }
    case 'life-voice': {
      const v = d.v === 'you' ? 'you' : 'first';
      if (S.state.settings.journalVoice === v) return true;
      S.state.settings.journalVoice = v;
      S.save();
      toast(v === 'you' ? 'Your journal says "you" from now on.' : 'Your journal says "I" from now on.');
      app.render();
      return true;
    }
    case 'life-ev':
      showEvent(d.id);
      return true;
    case 'life-ev-del': {
      if (!confirm('Delete this from your log?')) return true;
      try {
        if (isCoachQuestion(d.id)) await deleteCoachQuestion(d.id);
        else await L.removeIds([d.id]);
      } catch (err) {
        toast(lifeError(err));
      }
      closeSheet();
      if (app.view() === 'days') fillDay();
      return true;
    }
    case 'life-add':
      openAdd();
      return true;
    case 'life-mood': {
      const v = Number(d.v);
      ui.mood = ui.mood === v ? 0 : v;
      for (const b of el.parentElement.querySelectorAll('button')) {
        const on = Number(b.dataset.v) === ui.mood;
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', String(on));
      }
      return true;
    }
    case 'life-add-save':
      await saveNote();
      return true;
    case 'life-sum': {
      if (M.learning.running) {
        toast('Arise is learning from your days right now. Try again in a moment.');
        return true;
      }
      el.disabled = true;
      el.textContent = 'Summing up…';
      const n = await M.learn({ days: [d.day] });
      if (!n) toast(M.learning.error || "This day couldn't be summed up. Try again later.");
      if (app.view() === 'days') fillDay();
      return true;
    }
    case 'life-ask':
      SYS.askCoach(ui.query);
      return true;
    case 'life-clear':
      ui.query = '';
      ui.results = null;
      ui.when = null;
      app.render();
      return true;
    case 'life-pin': {
      const f = M.allFacts().find((x) => x.id === d.id);
      if (f) await M.pinFact(f.id, !f.pinned);
      return true;
    }
    case 'life-fact-edit':
      editFact(d.id);
      return true;
    case 'life-fact-save': {
      const text = $('#lifeFactEdit')?.value || '';
      if (!text.trim()) {
        toast('Write the fact first, or delete it.');
        return true;
      }
      await M.editFact(editing.id, text);
      closeSheet();
      return true;
    }
    case 'life-fact-del':
      if (confirm('Delete this fact? Arise forgets it.')) await M.deleteFact(d.id);
      return true;
    case 'life-fact-back':
      await M.restoreFact(d.id);
      return true;
    case 'life-why':
      showWhy(d.id);
      return true;
    case 'life-pause': {
      const paused = d.on === 'true';
      if (paused === P.prefs().paused) return true;
      P.setPrefs({ paused });
      if (paused) M.stopLearning();
      toast(paused ? "Learning paused. Your log stays." : 'Learning again.');
      app.render();
      if (!paused) M.learn().catch(() => {});
      return true;
    }
    case 'life-less-private': {
      const on = d.on === 'true';
      if (on === P.prefs().lessPrivate) return true;
      if (on && !confirm("Let the free AI and your own AI service read your whole life log? Those companies can read your notes, searches, places and messages whenever the coach sends them. Gemini's free tier says not to send it personal information.")) return true;
      P.setPrefs({ lessPrivate: on });
      app.render();
      return true;
    }
    case 'life-src-del': {
      const s = d.src;
      const n = ui.counts?.[s] || 0;
      if (!confirm(`Delete everything from ${SOURCE_NAMES[s] || s} in your log (${plural(n, 'thing')})? What Arise learned only from it goes too.`)) return true;
      try {
        const { days } = await L.deleteWhereDays({ source: s });
        await M.forgetDays(days);
        toast('Deleted.');
      } catch (err) {
        toast(lifeError(err));
      }
      fillKnows();
      return true;
    }
    case 'life-export': {
      try {
        const data = await L.exportAll();
        await app.saveFile(`arise-life-${today()}.json`, 'application/json', JSON.stringify(data, null, 2));
      } catch (err) {
        toast(lifeError(err));
      }
      return true;
    }
    case 'life-wipe': {
      // Signed in: from the Player's other devices and the cloud too (life/packs.ts).
      const everywhere = CLOUD.signedIn();
      if (!confirm(`Delete your whole life log and everything Arise learned from it${everywhere ? ', on all your devices' : ''}? Your goals, quests and journal stay in the app.`)) return true;
      if (!confirm('Are you sure? This cannot be undone. Download it first if you might want it.')) return true;
      try {
        await L.eraseAll({ everywhere });
        toast('Your life log is empty.');
      } catch (err) {
        toast(lifeError(err));
      }
      app.render();
      return true;
    }
    default:
      return false;
  }
}

// Forms: the search box and adding a fact.
document.addEventListener('submit', async (e) => {
  if (e.target.id === 'lifeSearch') {
    e.preventDefault();
    runSearch($('#lifeQ')?.value || '');
  } else if (e.target.id === 'lifeFactForm') {
    e.preventDefault();
    const input = $('#lifeFactIn');
    const text = input?.value || '';
    if (!text.trim()) return;
    try {
      if (await M.addFact(text)) {
        input.value = '';
        toast('Arise will remember that.');
      }
    } catch (err) {
      toast(lifeError(err));
    }
  }
});

document.addEventListener('change', (e) => {
  if (e.target.id === 'lifeDate' && /^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) {
    ui.day = e.target.value > today() ? today() : e.target.value;
    app.render();
  }
});
