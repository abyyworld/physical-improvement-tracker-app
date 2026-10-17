// What a me link holds, drawn in plain words: for the Player before they make one and whenever
// they look at one (life/me-ui.js), and for whoever opens the link in a browser (share-view.ts).
// On its own, so that page loads none of the app. Everything in it is escaped text.

import { icon } from './icons.js';
import type { MePayload } from './lib/me';

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const dayText = (k: string) => {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
};

export function meHTML(p: MePayload): string {
  const out: string[] = [];
  if (p.name) out.push(`<p class="label">First name</p><p>${esc(p.name)}</p>`);
  if (p.about) out.push(`<p class="label">About me</p><p class="me-about">${esc(p.about)}</p>`);
  if (p.goals.length) {
    out.push(`<p class="label">Goals</p><ul class="sum-list">${p.goals
      .map((g) => `<li><span>${esc(g.title)}${g.why ? `<small>${esc(g.why)}</small>` : ''}</span><span class="mono">${g.streak ? `${icon('flame')} ${plural(g.streak, 'day')}` : '<span class="muted">no streak yet</span>'}</span></li>`)
      .join('')}</ul>`);
  }
  if (p.facts.length) out.push(`<p class="label">Facts</p><ul class="changes">${p.facts.map((f) => `<li>${esc(f.text)}</li>`).join('')}</ul>`);
  if (p.today) {
    out.push(`<p class="label">Today's quests</p>${
      p.today.quests.length
        ? `<ul class="sum-list">${p.today.quests.map((q) => `<li><span>${esc(q.title)}</span><span class="muted small">${q.done ? `${icon('check')} done` : 'not yet'}</span></li>`).join('')}</ul>`
        : '<p class="muted small">No quests today.</p>'
    }`);
  }
  if (p.days) {
    out.push(`<p class="label">Last 7 days</p>${
      p.days.length ? `<ul class="changes">${p.days.map((d) => `<li><b>${esc(dayText(d.day))}:</b> ${esc(d.text)}</li>`).join('')}</ul>` : '<p class="muted small">Arise hasn\'t summed up these days yet.</p>'
    }`);
  }
  return out.join('') || '<p class="muted">Nothing yet. Pick more, or let Arise learn about you first.</p>';
}

// The same, exactly as the app receives it.
export const exactHTML = (p: MePayload) => `<details class="other"><summary>The exact data</summary><pre class="me-json">${esc(JSON.stringify(p, null, 2))}</pre></details>`;
