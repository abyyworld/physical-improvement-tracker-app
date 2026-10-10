// Shared screen helpers: escaping, dates, icons, the pop-up sheet, toasts and safe Markdown.

import * as S from './store';
export { icon } from './icons.js';

const $ = (sel, root = document) => root.querySelector(sel);

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
export const fmt = (k, o) => S.parseKey(k).toLocaleDateString(undefined, o);
export const clock = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

// ---------- sheet, toast, XP pop

// While a pop-up is open, everything behind it is inert: Tab and screen readers stay inside it.
export const BACKGROUND = ['#tabs', '#app', '#restbar'];
export function setBackgroundInert(on) {
  // The app lock keeps it all inert, and sorts this out when it opens (see app-lock.js).
  if (document.body.classList.contains('locked')) return;
  for (const sel of BACKGROUND) $(sel)?.toggleAttribute('inert', on);
}
// What's behind should be inert: a pop-up or the intro is open.
export const backgroundInert = () => ($('#sheet') ? !$('#sheet').hidden : false) || document.body.classList.contains('onboarding');

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
