// The extension's menu (the toolbar button), and the small window that opens to compare the 4
// words while linking (popup.html?pair=1). Built with DOM calls, never HTML strings.

import { api, ARISE } from './api';
import { POPUP_NS, type PopupRequest, type PopupState } from './lib/recorder';

const main = document.getElementById('main')!;
const inWindow = new URLSearchParams(location.search).has('pair');

type Child = Node | string | null | false;
function h(tag: string, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('data-')) el.dataset[k.slice(5)] = v;
    else el.setAttribute(k, v);
  }
  for (const c of children) if (c !== null && c !== false) el.append(c);
  return el;
}
const button = (act: string, label: string, cls = '', data: Record<string, string> = {}) => h('button', { class: cls, 'data-act': act, ...Object.fromEntries(Object.entries(data).map(([k, v]) => [`data-${k}`, v])) }, label);

async function ask(msg: PopupRequest): Promise<PopupState | null> {
  const r = (await api.runtime.sendMessage({ ns: POPUP_NS, msg }).catch(() => null)) as PopupState | { ok: false; error: string } | null;
  if (r && 'ok' in r && r.ok === false) {
    main.prepend(h('p', { class: 'warn' }, r.error));
    return null;
  }
  return r as PopupState | null;
}

function ago(t: number) {
  if (!t) return 'not yet';
  const m = Math.round((Date.now() - t) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const hours = Math.round(m / 60);
  if (hours < 48) return `${hours} h ago`;
  return new Date(t).toLocaleDateString();
}

function view(s: PopupState): Node[] {
  if (s.pairing) {
    const link = { link: s.pairing.link };
    return [
      h(
        'div',
        { class: 'box' },
        h('h2', {}, 'Link this browser to Arise'),
        h('p', {}, 'Does Arise show these 4 words?'),
        h('p', { class: 'code' }, s.pairing.code.join(' · ')),
        h('div', { class: 'row' }, button('confirm', 'They match', 'primary', link), button('decline', "They don't match", '', link)),
      ),
      h('p', { class: 'small muted' }, 'Only press "They match" if the words are the same. Then this browser seals what it records so only that Arise can open it.'),
    ];
  }
  if (!s.linked) {
    return [
      h('p', {}, 'Not linked yet.'),
      h('p', {}, 'Open Arise, go to Settings, then "Your life: browser", and press "Link this browser".'),
      button('open', 'Open Arise', 'primary block'),
      h('p', { class: 'small muted' }, "Until it's linked, nothing is recorded."),
    ];
  }
  const skip = h('textarea', { id: 'skip', spellcheck: 'false', placeholder: 'example.com' }) as HTMLTextAreaElement;
  skip.value = s.skip.join('\n');
  return [
    h('p', { class: 'ok' }, 'Linked to Arise'),
    h(
      'p',
      { class: 'small' },
      s.paused
        ? 'Paused. Nothing is recorded until you resume.'
        : `Recording the sites you visit, what you search, and your time on each site. It's sealed right away, so only your Arise can read it.${s.backfilling ? ' Reading the last 90 days now…' : ''}`,
    ),
    h('dl', { class: 'stats' }, h('dt', {}, 'Waiting for Arise'), h('dd', {}, s.waiting.toLocaleString()), h('dt', {}, 'Last sent'), h('dd', {}, ago(s.sent.at))),
    h('p', { class: 'small muted' }, "Arise collects them when it's open in this browser."),
    s.paused ? button('resume', 'Resume', 'block primary') : button('pause', 'Pause', 'block'),
    button('forget', 'Forget the last hour', 'block'),
    h(
      'div',
      { class: 'box' },
      h('label', { for: 'skip' }, 'Sites to skip, one per line'),
      skip,
      h('div', { class: 'row', style: 'margin-top:8px' }, button('skip', 'Save'), h('span', { class: 'saved', id: 'saved', hidden: '' }, 'Saved')),
      h('p', { class: 'small muted', style: 'margin:8px 0 0' }, 'Always skipped: banks, health portals, adult sites, password managers and sign-in pages, and private windows.'),
    ),
    button('unlink', 'Unlink this browser', 'block danger'),
  ];
}

let shown = '';
let editing = false;

function render(s: PopupState, { force = false } = {}) {
  document.getElementById('browserName')!.textContent = s.browser;
  // Redrawn only when something changed, and never while the list of sites is being typed.
  const key = JSON.stringify({ ...s, sent: ago(s.sent.at) });
  if ((key === shown && !force) || editing) return;
  shown = key;
  main.replaceChildren(...view(s));
}

async function refresh() {
  const s = await ask({ t: 'state' });
  if (s) render(s);
}

main.addEventListener('focusin', (e) => {
  if ((e.target as HTMLElement).id === 'skip') editing = true;
});
main.addEventListener('focusout', (e) => {
  if ((e.target as HTMLElement).id === 'skip') editing = false;
});

// A second press within a few seconds does it (menus can't show an "Are you sure?" box everywhere).
function armed(el: HTMLButtonElement, text: string): boolean {
  if (el.dataset.armed) return true;
  const was = el.textContent;
  el.dataset.armed = '1';
  el.textContent = text;
  setTimeout(() => {
    if (!el.isConnected) return;
    delete el.dataset.armed;
    el.textContent = was;
  }, 4000);
  return false;
}

main.addEventListener('click', async (e) => {
  const el = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]');
  if (!el || el.disabled) return;
  const act = el.dataset.act!;
  const link = el.dataset.link || '';
  el.disabled = true;
  let s: PopupState | null = null;
  switch (act) {
    case 'confirm':
    case 'decline':
      s = await ask({ t: act, link });
      if (s && inWindow) return window.close();
      break;
    case 'open':
      await api.tabs.create({ url: `${ARISE[0]}#settings` });
      return window.close();
    case 'pause':
    case 'resume':
      s = await ask({ t: act });
      break;
    case 'forget':
      if (!armed(el, 'Press again to forget the last hour')) break;
      s = await ask({ t: 'forget' });
      break;
    case 'skip': {
      const text = (document.getElementById('skip') as HTMLTextAreaElement).value;
      editing = false;
      s = await ask({ t: 'skip', text });
      break;
    }
    case 'unlink':
      if (!armed(el, 'Press again: stop recording and delete what is waiting')) break;
      s = await ask({ t: 'unlink' });
      break;
  }
  el.disabled = false;
  if (s) {
    render(s, { force: true });
    if (act === 'skip') document.getElementById('saved')?.removeAttribute('hidden');
  }
});

void refresh();
setInterval(refresh, 1500);
