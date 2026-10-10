// Shared screen helpers: escaping, dates, icons, the pop-up sheet, toasts and safe Markdown.

import * as S from './store';

const $ = (sel, root = document) => root.querySelector(sel);

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
export const fmt = (k, o) => S.parseKey(k).toLocaleDateString(undefined, o);
export const clock = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

const ICON = {
  today: '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4M9 15.2l2 2 4-4"/>',
  plan: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4.5 6h.01M4.5 12h.01M4.5 18h.01" stroke-width="3"/>',
  progress: '<path d="M3 20h18"/><path d="M5 16l4-5 4 3 6-8"/><path d="M15 6h4v4"/>',
  settings: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  ext: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  timer: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5M9 2h6"/>',
  share: '<path d="M12 3v12M7 8l5-5 5 5"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/>',
  up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
  flame: '<path d="M12 3c1 3.5 5 5.5 5 10a5 5 0 0 1-10 0c0-2 1-3.5 2-4.5.3 1.8 1.2 2.8 2.2 3.2C10.5 9 11 6 12 3z"/>',
  ball: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5l3.8 2.8-1.5 4.4H9.7l-1.5-4.4zM12 3v4.5M20.5 9.5l-4.7.8M17.5 19l-3.2-4.3M6.5 19l3.2-4.3M3.5 9.5l4.7.8"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  bell: '<path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  system: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  send: '<path d="M4 12l16-8-6 16-2.5-6.5z"/><path d="M11.5 13.5L20 4"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M14.5 8.5l2 2"/>',
  scale: '<rect x="3.5" y="4" width="17" height="16" rx="3"/><path d="M8 10a4 4 0 0 1 8 0z"/><path d="M12 10l1.6-2.2"/>',
};
export const icon = (n) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICON[n]}</svg>`;

// ---------- sheet, toast, XP pop

// While a pop-up is open, everything behind it is inert: Tab and screen readers stay inside it.
const BACKGROUND = ['#tabs', '#app', '#restbar'];
export function setBackgroundInert(on) {
  for (const sel of BACKGROUND) $(sel)?.toggleAttribute('inert', on);
}

let opener = null;
export function openSheet(html) {
  const sheet = $('#sheet');
  if (sheet.hidden) opener = document.activeElement;
  $('.sheet-body', sheet).innerHTML = html;
  sheet.hidden = false;
  document.body.classList.add('sheet-open');
  setBackgroundInert(true);
  $('.sheet-panel', sheet).scrollTop = 0;
  $('.sheet-close', sheet).focus({ preventScroll: true });
}
export function closeSheet() {
  const sheet = $('#sheet');
  if (sheet.hidden) return;
  sheet.hidden = true;
  $('.sheet-body', sheet).innerHTML = ''; // stops any playing video
  document.body.classList.remove('sheet-open');
  if (!document.body.classList.contains('onboarding')) setBackgroundInert(false);
  // Back to the button that opened it, if it's still on screen.
  if (opener?.isConnected) opener.focus({ preventScroll: true });
  opener = null;
}

let toastTimer = null;
export function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  // Long enough to read: a long message stays longer.
  toastTimer = setTimeout(() => t.classList.remove('show'), Math.max(2600, String(msg).length * 50));
}

export function xpPop(text) {
  const el = document.createElement('span');
  el.className = 'xp-pop';
  el.textContent = text;
  document.body.append(el);
  setTimeout(() => el.remove(), 1200);
}

// Minimal, safe Markdown for AI replies. Everything is escaped first; then only **bold**, *italic*,
// `code`, bullet/numbered lists, headings (shown as bold lines) and line breaks are turned into HTML.
export function md(text) {
  const inline = (t) =>
    t
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/(^|[\s(])\*(?!\s)([^*]+?)\*(?=[\s.,!?;:)]|$)/g, '$1<i>$2</i>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
  let html = '';
  let para = [];
  let list = null;
  const flushPara = () => {
    if (para.length) html += `<p>${inline(para.join('<br>'))}</p>`;
    para = [];
  };
  const flushList = () => {
    if (list) html += `<${list.type}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.type}>`;
    list = null;
  };
  for (const raw of esc(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    const ul = line.match(/^[-*•]\s+(.*)$/);
    const ol = line.match(/^\d+[.)]\s+(.*)$/);
    const h = line.match(/^#{1,6}\s+(.*)$/);
    if (ul || ol) {
      flushPara();
      const type = ul ? 'ul' : 'ol';
      if (!list || list.type !== type) {
        flushList();
        list = { type, items: [] };
      }
      list.items.push((ul || ol)[1]);
    } else if (!line) {
      flushPara();
      flushList();
    } else if (h) {
      flushPara();
      flushList();
      html += `<p><b>${inline(h[1])}</b></p>`;
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();
  return html;
}
