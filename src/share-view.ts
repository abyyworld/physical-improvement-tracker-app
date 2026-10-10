// The page a friend sees when they open a shared goal's link (main.ts sends them here). It reads
// the goal's page from the cloud and opens it with the key in the link, which never leaves this
// browser. Read-only, and made for someone who never used Arise: no account, no intro, and
// nothing is kept on their device. Nothing here writes to the browser's storage, no service
// worker is set up, and the fetch skips the browser's cache (lib/share.ts).
//
// The app itself isn't loaded at all, so nothing of the visitor's own Arise (if they have it)
// is read or changed either.

import { FIREBASE } from './firebase-config.js';
import { fetchShare, openSnapshot, parseShareHash, type DayMark, type Snapshot } from './lib/share';
import { icon } from './icons.js';

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const num = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 2 });
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// Date keys like 2026-10-09, in the sharer's days.
const pad = (n: number) => String(n).padStart(2, '0');
const parseKey = (k: string) => {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const addDays = (k: string, n: number) => {
  const d = parseKey(k);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const fmt = (k: string, o: Intl.DateTimeFormatOptions) => parseKey(k).toLocaleDateString(undefined, o);

// The app, for "Get Arise": this address without the link's part, so it opens as usual.
const home = () => location.pathname || './';

const DAY: Record<DayMark, { cls: string; label: string }> = {
  d: { cls: 'done', label: 'done' },
  m: { cls: 'missed', label: 'missed' },
  o: { cls: 'off', label: 'day off' },
  t: { cls: 'today', label: 'not done yet' },
};

function daysPanel(s: Snapshot) {
  if (!s.days) return '';
  const lead = (parseKey(s.from).getDay() + 6) % 7; // Monday first
  const cells = [...s.days].map((m, i) => {
    const k = addDays(s.from, i);
    const d = DAY[m as DayMark] || DAY.o;
    const label = `${fmt(k, { weekday: 'short', day: 'numeric', month: 'short' })}: ${d.label}`;
    return `<span class="sd ${d.cls}" role="img" title="${esc(label)}" aria-label="${esc(label)}">${m === 'd' ? icon('check') : ''}</span>`;
  });
  return `<section class="panel">
    <div class="panel-title">${icon('today')}<span>Last ${plural(s.days.length, 'day')}</span></div>
    <div class="sdays">
      ${['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((x) => `<span class="dn" aria-hidden="true">${x}</span>`).join('')}
      ${'<span class="sd before" aria-hidden="true"></span>'.repeat(lead)}${cells.join('')}
    </div>
    <p class="legend"><span><i class="sd done"></i>Done</span><span><i class="sd missed"></i>Missed</span><span><i class="sd off"></i>Day off</span><span><i class="sd today"></i>Not done yet</span></p>
  </section>`;
}

function questsPanel(s: Snapshot) {
  if (!s.quests.length) return '';
  return `<section class="panel">
    <div class="panel-title">${icon('target')}<span>Quests</span></div>
    <ul class="sum-list">${s.quests
      .map(
        (q) => `<li><span>${esc(q.title)}<small>${esc(q.when)}</small></span><span class="mono">${
          q.streak > 0 ? `${icon('flame')} ${plural(q.streak, q.weekly ? 'week' : 'day')}` : '<span class="muted">no streak yet</span>'
        }</span></li>`,
      )
      .join('')}</ul>
  </section>`;
}

function measuresPanel(s: Snapshot) {
  if (!s.measures.length) return '';
  return `<section class="panel">
    <div class="panel-title">${icon('progress')}<span>Measures</span></div>
    <div class="measures">${s.measures
      .map(
        (m) => `<div class="measure static">
          <span class="k">${esc(m.name)}</span>
          <b>${m.value != null ? esc(num(m.value)) : '-'}<small> ${esc(m.unit)}</small></b>
          ${m.target != null ? `<span class="s">target ${esc(num(m.target))} ${esc(m.unit)}</span>` : ''}
          <span class="s">${m.on ? `logged ${esc(fmt(m.on, { day: 'numeric', month: 'short' }))}` : 'nothing logged yet'}</span>
        </div>`,
      )
      .join('')}</div>
  </section>`;
}

function milestonesPanel(s: Snapshot) {
  if (!s.milestonesOf) return '';
  return `<section class="panel">
    <div class="panel-title">${icon('up')}<span>Milestones</span></div>
    <p class="muted small">${s.milestones.length} of ${s.milestonesOf} reached.</p>
    ${
      s.milestones.length
        ? `<ul class="sum-list">${s.milestones.map((m) => `<li><span>${icon('check')} ${esc(m.title)}</span><span class="muted small">${esc(fmt(m.done, { day: 'numeric', month: 'short', year: 'numeric' }))}</span></li>`).join('')}</ul>`
        : ''
    }
  </section>`;
}

const getArise = `<section class="panel share-cta">
    <p><b>Arise</b> turns any goal into small daily quests, with streaks and a private AI coach. It's free.</p>
    <a class="btn primary block" href="${esc(home())}">Get Arise</a>
  </section>`;

export function pageHTML(s: Snapshot) {
  const done = [...s.days].filter((m) => m === 'd').length;
  const status = s.status === 'done' ? ' <span class="tag gold">Achieved</span>' : s.status === 'paused' ? ' <span class="tag">Paused</span>' : '';
  const updated = new Date(s.updated).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  return `<header class="page-head">
      <div><p class="kicker">Shared from Arise</p><h1 class="display">${s.name ? `${esc(s.name)}'s progress` : 'Progress'}</h1></div>
    </header>
    <section class="panel glow">
      <p class="kicker">${esc(s.area || 'Goal')}${status}</p>
      <h2 class="display goal-title">${esc(s.title)}</h2>
      <div class="share-stats">
        <div><span class="k">${icon('flame')} Streak</span><b>${s.streak}</b><small>${s.streak === 1 ? 'day' : 'days'} in a row, all goals</small></div>
        <div><span class="k">Last ${s.days.length} days</span><b>${done}</b><small>${done === 1 ? 'day' : 'days'} done</small></div>
        ${s.milestonesOf ? `<div><span class="k">Milestones</span><b>${s.milestones.length}</b><small>of ${s.milestonesOf}</small></div>` : ''}
      </div>
    </section>
    ${daysPanel(s)}${questsPanel(s)}${measuresPanel(s)}${milestonesPanel(s)}
    <p class="muted small share-foot">Updated ${esc(updated)}. This page is end-to-end encrypted: the key is in the link, so only people with the link can see it.</p>
    ${getArise}`;
}

function messageHTML(title: string, text: string, retry = false) {
  return `<section class="panel glow share-msg">
      <p class="kicker">Shared from Arise</p>
      <h1 class="display">${esc(title)}</h1>
      <p>${esc(text)}</p>
      ${retry ? '<button class="btn ghost" data-share-retry>Try again</button>' : ''}
    </section>
    ${getArise}`;
}

export const NOT_FOUND = 'This link was turned off or replaced.';
const BROKEN = "This link isn't complete. Ask for it again, or copy all of it.";
const OFFLINE = "Couldn't load it. Check your internet connection and try again.";

// Shows the share in `hash` (the page's # part). Returns what it showed.
export async function showShare(hash = location.hash): Promise<'shown' | 'gone' | 'broken' | 'offline'> {
  const root = document.getElementById('app')!;
  document.body.dataset.view = 'share';
  document.getElementById('tabs')?.setAttribute('hidden', '');
  document.title = 'Shared progress | Arise';
  const ref = parseShareHash(hash);
  if (!ref) {
    root.innerHTML = messageHTML('Link not complete', BROKEN);
    return 'broken';
  }
  if (!FIREBASE) {
    root.innerHTML = messageHTML('Link turned off', NOT_FOUND);
    return 'gone';
  }
  root.innerHTML = '<p class="muted">Loading…</p>';
  let sealed;
  try {
    sealed = await fetchShare(ref.id, FIREBASE);
  } catch {
    root.innerHTML = messageHTML("Couldn't load it", OFFLINE, true);
    return 'offline';
  }
  if (!sealed) {
    root.innerHTML = messageHTML('Link turned off', `${NOT_FOUND} Ask the person who sent it for the new one.`);
    return 'gone';
  }
  let snap: Snapshot | null = null;
  try {
    snap = await openSnapshot(ref, sealed);
  } catch {}
  if (!snap) {
    root.innerHTML = messageHTML('Link not complete', BROKEN);
    return 'broken';
  }
  root.innerHTML = pageHTML(snap);
  return 'shown';
}

document.addEventListener('click', (e) => {
  if ((e.target as Element).closest?.('[data-share-retry]')) void showShare();
});
// Another link opened in this tab, or the app's own address: start again with that.
window.addEventListener('hashchange', () => location.reload());

export const shown = showShare();
