// Arise as "me" for other apps, on screen, in What Arise knows (me.ts does the work):
//   - About me: a short text from what Arise knows, which the Player picks, reads, changes and
//     copies into any AI app.
//   - Connected apps: one private me link per app, which keeps the app up to date with only what
//     the Player picked. What each gets, when it was updated, and turning it off.
// Nothing leaves the device until the Player copies, shares or makes a link.

import * as M from './memory';
import * as ME from '../me';
import * as SYNC from '../sync';
import * as N from '../native.js';
import { ABOUT_SECTIONS, SECTIONS, SECTION_LABELS, TIER_LABELS, TIER_TEXT, ABOUT_MAX, LINK_DEFAULT, aboutText, bodyOf, buildMe, choiceText, fitMe, meLink } from '../lib/me';
import { SITE_URL } from '../lib/pages';
import { meHTML, exactHTML } from '../me-html';
import { esc, icon, openSheet, closeSheet, toast } from '../ui.js';
import { TOOL_WORDS } from '../lib/feed';
import { hasLifeStore } from './store-port';

const $ = (sel, root = globalThis.document) => root?.querySelector(sel) ?? null;

const KEEPS = "The app you give this link to can read what's in it and keep a copy.";
const SEALED = "It's end-to-end encrypted: the key is in the link, so nobody else can read it, not the people who run Arise and not Google, who host it.";
const DOCS = 'https://github.com/abyyworld/physical-improvement-tracker-app/blob/main/docs/ME-LINK.md';
const MCP = 'https://github.com/abyyworld/physical-improvement-tracker-app/blob/main/mcp/README.md';
const WEB_HOW = 'https://github.com/abyyworld/physical-improvement-tracker-app/blob/main/mcp/README.md#claude-chatgpt-and-gemini-on-the-web';

// Before the web connector can be turned on for an app: what it costs, in plain words.
export const WEB_WHY = [
  "Claude, ChatGPT and Gemini on the web can't open your link themselves. So this app gets an address of its own, and Arise's connector, a small server Arise runs on Cloudflare, opens it for a moment each time the app asks, and hands the app what it needs.",
  'While it does, that server and Cloudflare could read what this app gets. And the AI company (like Anthropic, OpenAI or Google) gets what its app reads, as with anything you tell it.',
  "The connector keeps none of it. It keeps only a log of what the app did, and any notes it adds, sealed so only your Arise can read them, until your Arise picks them up.",
  'Everything else in Arise stays end-to-end encrypted. You can turn this off any time, and the address stops working for good.',
];
const LESS = '<span class="tag less">Less private</span>';
const DAY_MS = 86_400_000;
const ENDS = [
  [7, 'A week'],
  [30, 'A month'],
  [0, 'No end'],
];
const whenDay = (t) => new Date(t).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

// Where an app's link points: this page's own address on the web; in the iPhone app, whose pages
// are only on the phone, the website.
const linkTo = (l) => meLink(N.isNative ? __APP_UPDATE_SITE__ || SITE_URL : `${location.origin}${location.pathname}`, l);
const canSend = () => N.canShareLink() || typeof navigator.share === 'function';
const when = (t) => new Date(t).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

function picksHTML(c, sections, act) {
  return `<p class="label">What goes in</p>
    <div class="chips" role="group" aria-label="What goes in">${sections
      .map((s) => {
        const on = c.sections.includes(s);
        return `<button class="chip ${on ? 'on' : ''}" data-act="${act}-sec" data-s="${s}" aria-pressed="${on}">${esc(SECTION_LABELS[s])}</button>`;
      })
      .join('')}</div>
    <p class="label">How private</p>
    <div class="seg" role="group" aria-label="How private">${[1, 2, 3]
      .map((t) => `<button class="${c.tier === t ? 'on' : ''}" data-act="${act}-tier" data-t="${t}" aria-pressed="${c.tier === t}">${TIER_LABELS[t]}</button>`)
      .join('')}</div>
    <p class="muted small">${esc(TIER_TEXT[c.tier])}</p>`;
}

const toggled = (c, s) => ({ ...c, sections: c.sections.includes(s) ? c.sections.filter((x) => x !== s) : [...c.sections, s] });

// =====================================================================
// About me
// =====================================================================

// The words as the Player changed them, kept until what goes in changes, and the words this put
// in the box last (anything else there was typed or pasted, and stays).
const about = { edited: false, text: '', shown: '' };

const aboutNow = () => (about.edited ? about.text : M.isLoaded() ? aboutText(ME.sourceNow(), ME.aboutChoice()) : '');
const countText = (n) => `${n.toLocaleString()} ${n === 1 ? 'character' : 'characters'}.${n > ABOUT_MAX ? ` ChatGPT takes up to ${ABOUT_MAX.toLocaleString()}.` : ''}`;

export function aboutPanel() {
  const text = aboutNow();
  about.shown = text;
  return `<section class="panel" id="aboutMe">
    <div class="panel-title">${icon('note')}<span>About me, for any app</span></div>
    <p class="small">Tell an AI app about yourself. Pick what goes in, read it, change any words, then copy it.</p>
    ${picksHTML(ME.aboutChoice(), ABOUT_SECTIONS, 'me-about')}
    <label class="field"><span class="k">Your About me</span><textarea id="aboutMeText" class="log-text" rows="10" maxlength="4000" placeholder="${M.isLoaded() ? 'Nothing to say yet. Pick more above, or add facts about you.' : 'Reading…'}">${esc(text)}</textarea></label>
    <p class="muted small" id="aboutMeCount">${countText(text.length)}</p>
    <div class="row">
      <button class="btn primary small" data-act="me-about-copy">Copy</button>
      ${canSend() ? '<button class="btn ghost small" data-act="me-about-share">Share…</button>' : ''}
    </div>
    <p class="label">Where to paste it</p>
    <ul class="changes small">
      <li><b>ChatGPT:</b> Settings, Personalization, Custom instructions.</li>
      <li><b>Claude:</b> Settings, Profile.</li>
      <li><b>Any AI app:</b> its "about you" field.</li>
    </ul>
    <p class="muted small life-note">Nothing leaves Arise until you copy or share it.</p>
  </section>`;
}

// After the memory is read, or changes: the text catches up, unless the Player is changing it.
function fillAbout({ force = false } = {}) {
  if (force) about.edited = false;
  const box = $('#aboutMeText');
  if (!box || (!force && (about.edited || box.value !== about.shown || globalThis.document.activeElement === box))) return;
  box.value = about.shown = aboutNow();
  const count = $('#aboutMeCount');
  if (count) count.textContent = countText(box.value.length);
}

// What goes in changed: the words start again from it.
function repaintAbout() {
  about.edited = false;
  if (typeof document === 'undefined') return; // (it can come after the page is gone)
  const el = $('#aboutMe');
  if (el) el.outerHTML = aboutPanel();
}

async function copyText(text, done) {
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
    return true;
  } catch {
    return false;
  }
}

async function send({ title, text, url }) {
  try {
    if (N.canShareLink()) await N.shareLink({ title, text, url });
    else await navigator.share(url ? { title, text, url } : { title, text });
    return true;
  } catch (err) {
    return err?.name === 'AbortError';
  }
}

// =====================================================================
// Connected apps
// =====================================================================

export function appsPanel() {
  return `<section class="panel" id="meApps">
    <div class="panel-title">${icon('share')}<span>Connected apps</span></div>
    <p class="small">Give an app its own private link to you, like a buddy app or an AI assistant. It always has your latest, and only what you pick. You can turn it off any time.</p>
    <div id="meAppList">${appListHTML()}</div>
    <button class="btn primary block" data-act="me-connect">${icon('share')} Connect an app</button>
    <p class="muted small life-note">${esc(KEEPS)}</p>
  </section>`;
}

function statusLine(l) {
  const err = ME.note(l.id);
  if (err) return `<p class="error small">Couldn't update it: ${esc(err)}</p>`;
  return l.sent ? `<p class="muted small">Updated ${esc(when(l.sent))}</p>` : '';
}

// On the web or not, and when the app last did something there.
function webLine(l) {
  if (!l.web) return '';
  const last = ME.feedOf(l.id).at(-1);
  const ended = !ME.webNow(l);
  return `<p class="muted small">${ended ? `On the web${l.web.until ? ` until ${esc(whenDay(l.web.until))}` : ''}, now ended.` : `On the web${l.web.until ? ` until ${esc(whenDay(l.web.until))}` : ''}${l.web.notes ? ', may add notes and to-dos' : ''}.`}${last ? ` Last used ${esc(when(last.at))}.` : ''}</p>`;
}

function appListHTML() {
  const list = ME.links();
  if (!list.length) return '<p class="muted small">No apps connected yet.</p>';
  return `<ul class="fact-list me-apps">${list
    .map(
      (l) => `<li class="fact">
      <p class="fact-text">${esc(l.app)}</p>
      <p class="muted small">Gets: ${esc(choiceText(l.choice))}</p>
      ${webLine(l)}
      ${statusLine(l)}
      <div class="fact-acts">
        <button class="link" data-act="me-app" data-id="${esc(l.id)}">See what it gets</button>
        <button class="link" data-act="me-app-new" data-id="${esc(l.id)}">New link</button>
        <button class="link danger-link" data-act="me-app-off" data-id="${esc(l.id)}">Turn off</button>
      </div>
    </li>`,
    )
    .join('')}</ul>`;
}

function repaintApps() {
  if (typeof document === 'undefined') return;
  const el = $('#meAppList');
  if (el) el.innerHTML = appListHTML();
}

// Called with the rest of What Arise knows, once the memory is read and after it changes. The
// sheet's preview catches up too, unless the Player is typing in it.
export function fillMe() {
  fillAbout();
  repaintApps();
  if (!sheet?.el?.contains(globalThis.document.activeElement)) repaintSheet();
}

// ---------- the sheet: connecting an app, and one app's link

// mode: 'new' (picking for a new app), 'view' (one app's link), 'edit' (changing what it gets).
let sheet = null;

function needsAccount() {
  if (!SYNC.configured) return '<p>Connecting an app needs the cloud, and this copy of Arise has none set up.</p>';
  if (SYNC.status.user) return '';
  if (SYNC.status.loading) return '<p>Your account is still loading. Try again in a moment.</p>';
  return `<p><b>Connecting an app needs an account</b>, since the link's page is kept in the cloud. Make one, or sign in, under Settings, Account.</p>
    <button class="btn primary block" data-act="nav" data-v="settings">Go to Account</button>`;
}

// What the app gets is what's left once it's trimmed to fit in a page (lib/me.ts sealMe). That's
// measured in the background (it seals it); until then, and nearly always, it's all of it.
const TRIMMED = "That's too much for one link, so the app gets less: the oldest days are left out first, then the facts Arise is least sure of. Pick less to send it all.";
const fits = new Map(); // what a payload says (bodyOf) -> { payload, trimmed }
const measuring = new Set();

function measure(body, p) {
  if (measuring.has(body)) return;
  measuring.add(body);
  fitMe(p)
    .then((fit) => {
      if (fits.size > 20) fits.clear();
      fits.set(body, fit);
      if (fit.trimmed) repaintPreview();
    })
    .catch(() => {})
    .finally(() => measuring.delete(body));
}

function previewHTML(choice) {
  if (!M.isLoaded()) return '<p class="muted small">Reading…</p>';
  const p = buildMe(ME.sourceNow(), choice);
  const body = bodyOf(p);
  const fit = fits.get(body);
  if (!fit) measure(body, p);
  const shown = fit ? { ...fit.payload, updated: p.updated } : p;
  return `<div class="me-preview">${fit?.trimmed ? `<p class="error small">${esc(TRIMMED)}</p>` : ''}${meHTML(shown)}${exactHTML(shown)}</div>`;
}

// Only the preview, so what's being typed in the sheet stays as it is.
function repaintPreview() {
  const el = sheet?.el?.isConnected ? $('.me-preview', sheet.el) : null;
  if (!el) return;
  const l = sheet.mode === 'view' ? ME.links().find((x) => x.id === sheet.id) : null;
  el.outerHTML = previewHTML(l ? l.choice : sheet.choice);
}

function sheetHTML() {
  const head = (title) => `<div class="me-sheet"><p class="kicker">Connected apps</p><h2 class="display sheet-title">${esc(title)}</h2>`;
  const error = sheet.error ? `<p class="error small">${esc(sheet.error)}</p>` : '';
  const busy = sheet.busy ? 'disabled' : '';
  if (sheet.mode === 'new') {
    const blocked = needsAccount();
    return `${head('Connect an app')}
      <p>Make a private link for one app. It reads only what you pick here, and gets your changes by itself. Make one link for each app, so you can turn each off on its own.</p>
      <label class="field"><span class="k">Which app</span><input id="meAppName" type="text" maxlength="40" autocomplete="off" placeholder="My buddy app" value="${esc(sheet.app)}"></label>
      ${picksHTML(sheet.choice, SECTIONS, 'me')}
      <p class="label">What it gets now</p>
      ${previewHTML(sheet.choice)}
      <p class="muted small">${esc(KEEPS)} ${esc(SEALED)}</p>
      ${blocked || `<button class="btn primary block" data-act="me-make" ${busy}>${sheet.busy ? 'Making the link…' : 'Make the link'}</button>`}
      ${error}</div>`;
  }
  const l = ME.links().find((x) => x.id === sheet.id);
  // Gone from the list: turned off, or (New link said why) another account's, waiting for it.
  if (!l) return sheet.error ? `${head(sheet.app)}${error}</div>` : `${head('Turned off')}<p>This link was turned off.</p></div>`;
  const user = SYNC.status.user;
  if (sheet.mode === 'web') {
    const w = sheet.web;
    return `${head(l.app)}
      <p class="label">Use it on the web ${LESS}</p>
      ${WEB_WHY.map((t) => `<p class="small">${esc(t)}</p>`).join('')}
      ${webPicksHTML(w)}
      <div class="row">
        <button class="btn primary small" data-act="me-web-on" ${busy}>${sheet.busy ? 'Turning it on…' : 'Turn it on'}</button>
        <button class="btn ghost small" data-act="me-app" data-id="${esc(l.id)}">Cancel</button>
      </div>
      ${error}</div>`;
  }
  if (sheet.mode === 'edit') {
    return `${head(l.app)}
      ${picksHTML(sheet.choice, SECTIONS, 'me')}
      <p class="label">What it gets now</p>
      ${previewHTML(sheet.choice)}
      <div class="row">
        <button class="btn primary small" data-act="me-app-save" ${busy}>${sheet.busy ? 'Saving…' : 'Save'}</button>
        <button class="btn ghost small" data-act="me-app" data-id="${esc(l.id)}">Cancel</button>
      </div>
      ${error}</div>`;
  }
  return `${head(l.app)}
    <p>Give this link to ${esc(l.app)}. It updates by itself after your changes${user ? '' : ', whenever you are signed in'}.</p>
    <label class="field"><span class="k">Link</span><input id="meLinkIn" type="text" readonly value="${esc(linkTo(l))}"></label>
    <div class="row">
      <button class="btn primary small" data-act="me-link-copy">Copy link</button>
      ${canSend() ? '<button class="btn ghost small" data-act="me-link-send">Share…</button>' : ''}
    </div>
    <p class="muted small">${esc(KEEPS)} Keep the link private, like a password.</p>
    <p class="small">Making an app? <a href="${DOCS}" target="_blank" rel="noopener">How to read the link ${icon('ext')}</a>. For Claude Desktop and other AI apps: <a href="${MCP}" target="_blank" rel="noopener">the Arise MCP server ${icon('ext')}</a>.</p>
    <p class="label">What it gets now</p>
    <p class="muted small">${esc(choiceText(l.choice))}</p>
    ${previewHTML(l.choice)}
    ${statusLine(l)}
    ${webHTML(l, user, busy)}
    ${error}
    ${
      user
        ? `<div class="row">
      <button class="btn ghost small" data-act="me-app-edit" ${busy}>Change what it gets</button>
      <button class="btn ghost small" data-act="me-app-new" data-id="${esc(l.id)}" ${busy}>New link</button>
      <button class="btn ghost small danger" data-act="me-app-off" data-id="${esc(l.id)}" ${busy}>Turn off</button>
    </div>
    <p class="muted small"><b>New link</b> gives the app a new link, and the old one stops working for good. <b>Turn off</b> stops the link for good. The app keeps what it already read.</p>`
        : '<p class="small">Sign in, under Settings, Account, to change it or turn it off.</p>'
    }
    </div>`;
}

// Whether the app may add notes, and for how long it's on.
function webPicksHTML(w) {
  // Notes go into the life log: a build without one only offers reading.
  const notes = hasLifeStore()
    ? `<p class="label">May it add notes and to-dos?</p>
    <div class="seg" role="group" aria-label="May it add notes">${[
      [false, 'No, only read'],
      [true, 'Yes'],
    ]
      .map(([v, t]) => `<button class="${w.notes === v ? 'on' : ''}" data-act="me-web-notes" data-v="${v ? 1 : 0}" aria-pressed="${w.notes === v}">${t}</button>`)
      .join('')}</div>
    <p class="muted small">${w.notes ? 'When you ask it to ("log that I ran 5 km", "remind me to call mum on Friday"), it can add a note to your day or a to-do to your list, marked with its name. It can never change or delete anything.' : 'It only reads what you picked above.'}</p>`
    : '';
  return `${notes}
    <p class="label">For how long</p>
    <div class="seg" role="group" aria-label="For how long">${ENDS.map(([d, t]) => `<button class="${w.days === d ? 'on' : ''}" data-act="me-web-days" data-d="${d}" aria-pressed="${w.days === d}">${t}</button>`).join('')}</div>`;
}

// The web part of one app's sheet: off, with a way to turn it on, or on, with the address to give
// the app, its settings and what it did.
function webHTML(l, user, busy) {
  const ready = ME.connectorReady();
  if (!l.web) {
    if (!ready || !user) return '';
    return `<div class="me-web">
      <p class="label">Use it on the web ${LESS}</p>
      <p class="small">Let Claude, ChatGPT or Gemini on the web read what this app gets, through Arise's connector. Off until you turn it on.</p>
      <button class="btn ghost small" data-act="me-web-explain" ${busy}>Use it on the web…</button>
    </div>`;
  }
  const live = ME.webNow(l);
  const reach = ME.connectorReachable();
  const log = ME.feedOf(l.id).slice(-10).reverse();
  const days = l.web.until ? null : 0;
  return `<div class="me-web">
    <p class="label">On the web ${LESS}</p>
    <p class="small">${live ? `On${l.web.until ? ` until ${esc(whenDay(l.web.until))}` : ', with no end date'}. ${l.web.notes ? 'It may add notes and to-dos.' : 'It only reads.'}` : `Ended${l.web.until ? ` on ${esc(whenDay(l.web.until))}` : ''}, and its address no longer works. Pick for how long below to turn it on again, with a new address.`}</p>
    ${reach === false ? '<p class="error small">The connector isn\'t answering right now, so AI apps on the web can\'t reach this yet. It works as soon as it does.</p>' : ''}
    <label class="field"><span class="k">Connector address</span><input id="meWebIn" type="text" readonly value="${esc(ME.connectorAddress(l))}"></label>
    <div class="row"><button class="btn primary small" data-act="me-web-copy">Copy address</button></div>
    <ul class="small me-web-how">
      <li><b>Claude</b> (claude.ai): Settings, Connectors, Add custom connector. Paste the address.</li>
      <li><b>ChatGPT</b>: Settings, Apps and connectors, Advanced settings, turn on Developer mode. Then Create, paste the address, and pick No authentication.</li>
      <li><b>Gemini and other apps</b>: anywhere that takes an MCP server address.</li>
    </ul>
    <p class="muted small">Keep the address private, like a password. <a href="${WEB_HOW}" target="_blank" rel="noopener">More help ${icon('ext')}</a></p>
    ${user ? webPicksHTML({ notes: l.web.notes, days: sheet.webDays ?? days }) : ''}
    <p class="label">What it did</p>
    ${
      log.length
        ? `<ul class="fact-list me-web-log">${log
            .map((e) => `<li class="small"><span class="muted">${esc(when(e.at))}</span> ${esc(e.client || l.app)} ${esc(TOOL_WORDS[e.tool])}${e.ok ? '' : ' (refused)'}${e.note ? `: “${esc(e.note.length > 120 ? `${e.note.slice(0, 119)}…` : e.note)}”` : ''}</li>`)
            .join('')}</ul>`
        : '<p class="muted small">Nothing yet.</p>'
    }
    <div class="row">
      <button class="link" data-act="me-web-check">Check now</button>
      ${user ? `<button class="link danger-link" data-act="me-web-off" ${busy}>Turn off on the web</button>` : ''}
    </div>
  </div>`;
}

function showSheet(next) {
  sheet = next;
  openSheet(sheetHTML());
  sheet.el = $('#sheet .sheet-body .me-sheet');
}

// Only while this sheet is the one showing. What's typed in the app's name stays.
function repaintSheet() {
  if (!sheet?.el?.isConnected) return;
  const name = $('#meAppName', sheet.el);
  if (name) sheet.app = name.value;
  const body = sheet.el.parentElement;
  body.innerHTML = sheetHTML();
  sheet.el = $('.me-sheet', body);
}

function openApp(id, mode = 'view') {
  const l = ME.links().find((x) => x.id === id);
  if (!l) return;
  showSheet({ mode, id, app: l.app, choice: l.choice, busy: false, error: '', web: { notes: false, days: 30 } });
  if (l.web) {
    void ME.checkConnector().then(repaintSheet);
    void ME.pullFeeds({ force: true });
  }
}

ME.onFeed(() => {
  repaintApps();
  if (sheet?.mode === 'view' && !sheet.busy) repaintSheet();
});

const untilFor = (days) => (days ? Date.now() + days * DAY_MS : 0);

async function busy(fn) {
  if (!sheet || sheet.busy) return;
  const mine = sheet;
  mine.busy = true;
  mine.error = '';
  repaintSheet();
  try {
    await fn(mine);
  } catch (err) {
    mine.error = ME.problem(err);
  }
  mine.busy = false;
  if (sheet === mine) repaintSheet();
  repaintApps();
}

// =====================================================================
// Taps
// =====================================================================

export async function handleAction(act, el) {
  const d = el.dataset;
  switch (act) {
    case 'me-about-sec':
      ME.setAboutChoice(toggled(ME.aboutChoice(), d.s));
      repaintAbout();
      return true;
    case 'me-about-tier':
      ME.setAboutChoice({ ...ME.aboutChoice(), tier: Number(d.t) });
      repaintAbout();
      return true;
    case 'me-about-copy': {
      const box = $('#aboutMeText');
      if (!box?.value.trim()) {
        toast('Nothing to copy yet.');
        return true;
      }
      if (!(await copyText(box.value, 'Copied. Paste it into the app.'))) {
        box.focus();
        box.select();
        toast('Copy the text from the box.');
      }
      return true;
    }
    case 'me-about-share': {
      const text = $('#aboutMeText')?.value || '';
      if (text.trim() && !(await send({ title: 'About me', text }))) await copyText(text, 'Copied. Paste it into the app.');
      return true;
    }
    case 'me-connect':
      showSheet({ mode: 'new', app: '', choice: { ...LINK_DEFAULT, sections: [...LINK_DEFAULT.sections] }, busy: false, error: '' });
      M.load()
        .then(repaintSheet)
        .catch(() => {});
      return true;
    case 'me-sec':
      if (!sheet) return true;
      sheet.choice = toggled(sheet.choice, d.s);
      repaintSheet();
      return true;
    case 'me-tier':
      if (!sheet) return true;
      sheet.choice = { ...sheet.choice, tier: Number(d.t) };
      repaintSheet();
      return true;
    case 'me-make': {
      const name = ($('#meAppName')?.value || '').trim();
      if (!name) {
        toast('Give the app a name first, so you know which link is which.');
        $('#meAppName')?.focus();
        return true;
      }
      await busy(async (s) => {
        s.app = name;
        const l = await ME.connect(name, s.choice);
        Object.assign(s, { mode: 'view', id: l.id, choice: l.choice });
        toast('Link made. Copy it into the app.');
      });
      return true;
    }
    case 'me-app':
      openApp(d.id);
      return true;
    case 'me-app-edit':
      if (!sheet) return true;
      sheet.mode = 'edit';
      repaintSheet();
      return true;
    case 'me-app-save':
      await busy(async (s) => {
        await ME.setChoice(s.id, s.choice);
        s.mode = 'view';
        toast('Saved. The app gets this from now on.');
      });
      return true;
    case 'me-app-new': {
      const l = ME.links().find((x) => x.id === d.id);
      if (!l || !confirm(`Make a new link for ${l.app}? The old one stops working for good, so give the app the new one.`)) return true;
      if (!sheet?.el?.isConnected || sheet.id !== l.id) openApp(l.id);
      await busy(async (s) => {
        const next = await ME.newLink(l.id);
        if (next) s.id = next.id;
        toast('New link made. The old one no longer works.');
      });
      return true;
    }
    case 'me-app-off': {
      const l = ME.links().find((x) => x.id === d.id);
      if (!l || !confirm(`Turn off the link for ${l.app}? It stops working for good. The app keeps what it already read.`)) return true;
      try {
        await ME.turnOff(l.id);
        toast(`Turned off. ${l.app} can't read anything new.`);
      } catch (err) {
        toast(ME.problem(err)); // (another account's link waits for it, and this says so)
      }
      if (!ME.links().some((x) => x.id === l.id)) {
        if (sheet?.id === l.id && sheet.el?.isConnected) closeSheet();
        sheet = null;
      }
      repaintApps();
      return true;
    }
    case 'me-web-explain':
      if (!sheet) return true;
      sheet.mode = 'web';
      sheet.web = { notes: false, days: 30 };
      repaintSheet();
      return true;
    case 'me-web-notes': {
      if (!sheet) return true;
      const notes = d.v === '1';
      if (sheet.mode === 'web') {
        sheet.web = { ...sheet.web, notes };
        repaintSheet();
        return true;
      }
      const l = ME.links().find((x) => x.id === sheet.id);
      if (!l?.web) return true;
      await busy(async (s) => {
        await ME.setWeb(s.id, { ...l.web, notes });
        toast(notes ? `${l.app} may add notes and to-dos now.` : `${l.app} only reads now.`);
      });
      return true;
    }
    case 'me-web-days': {
      if (!sheet) return true;
      const days = Number(d.d) || 0;
      if (sheet.mode === 'web') {
        sheet.web = { ...sheet.web, days };
        repaintSheet();
        return true;
      }
      const l = ME.links().find((x) => x.id === sheet.id);
      if (!l?.web) return true;
      await busy(async (s) => {
        const until = untilFor(days);
        await ME.setWeb(s.id, { notes: l.web.notes && hasLifeStore(), ...(until ? { until } : {}) });
        s.webDays = days;
        toast(until ? `On until ${whenDay(until)}.` : 'On with no end date.');
      });
      return true;
    }
    case 'me-web-on':
      await busy(async (s) => {
        const until = untilFor(s.web.days);
        await ME.setWeb(s.id, { notes: s.web.notes && hasLifeStore(), ...(until ? { until } : {}) });
        s.mode = 'view';
        s.webDays = s.web.days;
        toast('On for the web. Copy the address into the app.');
        void ME.checkConnector().then(repaintSheet);
      });
      return true;
    case 'me-web-off': {
      const l = sheet && ME.links().find((x) => x.id === sheet.id);
      if (!l || !confirm(`Turn off ${l.app} on the web? Its address stops working for good, and the app keeps what it already read. The link itself keeps working where you gave it.`)) return true;
      await busy(async (s) => {
        await ME.setWeb(s.id, null);
        s.webDays = undefined;
        toast('Off on the web.');
      });
      return true;
    }
    case 'me-web-copy': {
      const input = $('#meWebIn');
      if (input && !(await copyText(input.value, 'Address copied. Paste it into the app.'))) {
        input.focus();
        input.select();
        toast('Copy the address from the box.');
      }
      return true;
    }
    case 'me-web-check':
      await ME.checkConnector();
      await ME.pullFeeds({ force: true });
      repaintSheet();
      return true;
    case 'me-link-copy': {
      const input = $('#meLinkIn');
      if (input && !(await copyText(input.value, 'Link copied.'))) {
        input.focus();
        input.select();
        toast('Copy the link from the box.');
      }
      return true;
    }
    case 'me-link-send': {
      const l = sheet && ME.links().find((x) => x.id === sheet.id);
      if (l && !(await send({ title: 'Arise', text: `My Arise link for ${l.app}`, url: linkTo(l) }))) await copyText(linkTo(l), 'Link copied.');
      return true;
    }
    default:
      return false;
  }
}

// Typing in the About me text keeps it as typed, until what goes in changes.
globalThis.document?.addEventListener('input', (e) => {
  if (e.target?.id !== 'aboutMeText') return;
  about.edited = true;
  about.text = e.target.value;
  const count = $('#aboutMeCount');
  if (count) count.textContent = countText(e.target.value.length);
});

// The memory or the log was wiped: nothing of it stays on screen.
export function forgetMeScreens() {
  about.text = '';
  sheet = null;
  fillAbout({ force: true });
}
