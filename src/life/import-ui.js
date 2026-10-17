// The Import screen: bring in years of history from the files Google, Spotify, Netflix, Apple
// Health, WhatsApp and banks give people. The file is read here, on the device (in a worker,
// life/import/client.ts), and what it finds goes to the store it's given: the life log.

import { esc, icon } from '../ui.js';
import { importer as sharedImporter } from './import/client';

const $ = (sel, root = document) => root.querySelector(sel);
const n = (x) => Number(x || 0).toLocaleString('en-US');
const plural = (k, one, many = `${one}s`) => `${n(k)} ${k === 1 ? one : many}`;

export const VIEW = 'life-import';
export const PRIVATE = 'Nothing leaves this device: Arise reads the file here and keeps what it finds in your private life log.';

// Where each file comes from, in plain steps with the menus' real names.
export const SOURCES = [
  {
    id: 'google',
    name: 'Google: searches, YouTube and Chrome',
    what: 'What you searched for, the YouTube videos you watched, and the sites you visited in Chrome.',
    steps: [
      'Go to takeout.google.com and sign in.',
      'Tap “Deselect all”. Then tick “My Activity”, and “YouTube and YouTube Music” and “Chrome” if you want them too.',
      'Under My Activity, tap “Multiple formats” and choose JSON. Do the same for history under YouTube.',
      'Tap “Next step”. Keep “.zip” as the file type and tap “Create export”.',
      'When Google emails you, download the zip and choose it here. If it comes in parts, choose them all.',
    ],
  },
  {
    id: 'maps',
    name: 'Google Maps Timeline',
    what: 'The places you went and how you got there.',
    steps: [
      'Android: open Settings, then Location, then Location services, then Timeline. Tap “Export Timeline data”.',
      'iPhone: in Google Maps, tap your picture, then “Your Timeline”, then ⋯, then “Location and privacy settings”. Tap “Export Timeline data”.',
      'Save the file (Timeline.json) to Files or Downloads.',
      'Choose Timeline.json here. An older Google Takeout with “Semantic Location History” works too.',
    ],
  },
  {
    id: 'spotify',
    name: 'Spotify',
    what: 'The songs, podcasts and audiobooks you played.',
    steps: [
      'Go to spotify.com, log in, and open Account, then “Privacy settings”.',
      'Under “Download your data”, tick “Extended streaming history” (all years) or “Account data” (the last year). Tap “Request data”.',
      'Tap the link in the email Spotify sends. The data comes by email, in a few days (up to 30).',
      'Download the zip (my_spotify_data.zip) and choose it here.',
    ],
  },
  {
    id: 'netflix',
    name: 'Netflix',
    what: 'The shows and films you watched.',
    steps: [
      'Quick way: on netflix.com, open Account, then Profiles. Pick your profile and open “Viewing activity”.',
      'Tap “Download all” at the bottom, and choose NetflixViewingHistory.csv here. It has the days, not the times.',
      'With times too: go to netflix.com/account/getmyinfo and tap “Submit request”. Confirm it in the email.',
      'When Netflix emails you, download the zip and choose it here.',
    ],
  },
  {
    id: 'health',
    name: 'Apple Health',
    what: 'Workouts, sleep, steps, resting heart rate and weight, a day at a time.',
    steps: [
      'On your iPhone, open the Health app.',
      'Tap your picture at the top right, then “Export All Health Data”, then “Export”.',
      'Wait a few minutes while it gets ready. Then tap “Save to Files”.',
      'Choose export.zip here. Big files are fine: Arise reads them a bit at a time.',
    ],
  },
  {
    id: 'whatsapp',
    name: 'WhatsApp chats',
    what: 'How much you talked with someone each day, with the first few words of each day.',
    steps: [
      'Open the chat in WhatsApp.',
      'iPhone: tap the name at the top, then “Export Chat”. Android: tap ⋮, then More, then “Export chat”.',
      'Choose “Without media” and save the file to Files or Downloads.',
      'Choose it here. One chat at a time.',
    ],
  },
  {
    id: 'bank',
    name: 'Bank or card statements',
    what: 'What you spent, where, and what came in.',
    steps: [
      'In your bank’s app or website, open the account and find its statements or transactions.',
      'Choose “Export” or “Download”, and pick CSV.',
      'Choose the file here. Then check which columns are the date, the description and the amount.',
    ],
  },
];

const PROBLEM = {
  html: {
    text: 'This is the HTML version of your Google data. Arise needs JSON. Make the export again:',
    steps: ['Go to takeout.google.com.', 'Under My Activity (and YouTube), tap “Multiple formats”.', 'Choose JSON, tap OK, and create the export again.'],
  },
  tgz: { text: 'This is a .tgz file. At takeout.google.com, choose “.zip” as the file type and make the export again.' },
  'zip-method': { text: 'Arise can’t open this zip. Unzip it in the Files app or on a computer, then choose the file inside (like export.xml or Timeline.json).' },
  empty: { text: 'This file is empty.' },
  unknown: { text: 'Arise doesn’t know this file. Check the steps below for the service it came from.' },
};

// A button any screen can show to bring people here.
export function importButton(label = 'Bring in your history', cls = 'btn ghost') {
  return `<button class="${esc(cls)}" data-act="nav" data-v="${VIEW}">${esc(label)}</button>`;
}

// ---------- state

let ctx = { store: null, importer: null, back: 'settings' };
const importer = () => ctx.importer ?? sharedImporter();
let resolvedStore; // undefined: not looked for yet; null: there's none
// The answers given so far (mapping, profiles) stay in `st`, so a redraw of the screen (a sync,
// say) doesn't undo them.
const st = { phase: 'idle', queue: [], file: null, detection: null, mapping: null, profiles: null, progress: null, results: [], ctrl: null, error: '' };

async function getStore() {
  const s = ctx.store;
  const got = typeof s === 'function' ? await s() : s;
  resolvedStore = got && typeof got.addEvents === 'function' ? got : null;
  return resolvedStore;
}

// ---------- the screen

// `store`: { addEvents(events) → Promise<number> }, or a function giving one (or null).
// `importer`: for tests; the app uses the shared one (a worker).
/**
 * @typedef {import('./store-port').LifeStore} LifeStore
 * @param {HTMLElement} root
 * @param {{ store?: LifeStore | null | (() => LifeStore | null | Promise<LifeStore | null>), importer?: import('./import/client').Importer | null, back?: string }} [opts]
 */
export function renderImport(root, { store = null, importer = null, back = 'settings' } = {}) {
  ctx = { store, importer, back };
  root.innerHTML = `
    <header class="page-head"><button class="icon-btn" data-act="nav" data-v="${esc(back)}" aria-label="Back">${icon('back')}</button><div><p class="kicker">Life log</p><h1 class="display">Your history</h1></div></header>
    <div class="cols">
      <div class="col">
        <section class="panel" id="importPanel">
          <div class="panel-title"><span>Bring in a file</span></div>
          <p>Choose a file you downloaded from Google, Spotify, Netflix, Apple Health, WhatsApp or your bank. Arise works out what it is.</p>
          <p class="muted small">${PRIVATE}</p>
          <input type="file" id="lifeImportFile" multiple hidden>
          <div id="importStatus">${statusHTML()}</div>
        </section>
      </div>
      <div class="col">
        <section class="panel" id="importHow">
          <div class="panel-title"><span>How to get your files</span></div>
          ${SOURCES.map(
            (s) => `<details class="other" data-source="${s.id}"><summary>${esc(s.name)}</summary>
            <p class="small">${esc(s.what)}</p>
            <ol class="changes small">${s.steps.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>
          </details>`,
          ).join('')}
        </section>
      </div>
    </div>`;
  const had = resolvedStore;
  getStore().then((s) => {
    if (st.phase === 'idle' && s !== had) paint();
  });
}

function paint() {
  const el = $('#importStatus');
  if (el) el.innerHTML = statusHTML();
}

const years = (from, to) => {
  if (from === undefined || to === undefined) return '';
  const a = new Date(from).getFullYear();
  const b = new Date(to).getFullYear();
  return a === b ? ` from ${a}` : ` from ${a}-${b}`;
};

function resultLine(r) {
  if (r.problem && !r.found) return '';
  if (r.cancelled) return `Stopped. ${r.added ? `Added ${plural(r.added, 'event')} before that.` : 'Nothing was added.'}`;
  if (!r.found) return 'Nothing to bring in from this file.';
  if (!r.added) return `Nothing new: you already have all ${plural(r.found, 'event')}${years(r.from, r.to)}.`;
  return `Added ${plural(r.added, 'event')}${years(r.from, r.to)}.`;
}

function problemHTML(code) {
  const p = PROBLEM[code] ?? PROBLEM.unknown;
  return `<p class="error small">${esc(p.text)}</p>${p.steps ? `<ol class="changes small">${p.steps.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>` : ''}`;
}

function resultsHTML() {
  const rs = st.results;
  if (!rs.length) return '';
  const total = rs.reduce((s, r) => s + (r.added || 0), 0);
  const froms = rs.map((r) => r.from).filter((x) => x !== undefined);
  const tos = rs.map((r) => r.to).filter((x) => x !== undefined);
  const lines = rs.map((r) => {
    const line = resultLine(r);
    const what = r.labels?.length ? `<span class="muted"> (${esc(r.labels.join(', '))})</span>` : '';
    return `<li><b>${esc(r.name)}</b>: ${line ? esc(line) : ''}${what}${r.problem && !r.found ? problemHTML(r.problem) : ''}${r.html ? '<p class="muted small">Some parts were saved as HTML and left out. To bring them in, export them again as JSON.</p>' : ''}</li>`;
  });
  const span = froms.length ? years(Math.min(...froms), Math.max(...tos)) : '';
  const head = rs.length === 1 ? (resultLine(rs[0]) ? `<p class="ok" id="importResult" role="status">${esc(resultLine(rs[0]))}</p>` : '') : `<p class="ok" id="importResult" role="status">${total ? `Added ${plural(total, 'event')}${span}.` : 'Nothing new was added.'}</p>`;
  const one = rs.length === 1 ? rs[0] : null;
  const detail = one
    ? `${one.labels?.length ? `<p class="muted small">From: ${esc(one.labels.join(', '))}.</p>` : ''}${one.problem && !one.found ? problemHTML(one.problem) : ''}${one.html ? '<p class="muted small">Some parts were saved as HTML and left out. To bring them in, export them again as JSON.</p>' : ''}`
    : `<ul class="changes small">${lines.join('')}</ul>`;
  return head + detail;
}

function statusHTML() {
  const pick = (label) => `<button class="btn primary" data-act="life-import-pick" ${resolvedStore === null ? 'disabled' : ''}>${esc(label)}</button>`;
  if (resolvedStore === null && st.phase === 'idle') {
    return `<p class="muted small" id="importNoStore">Your life log isn’t on this device yet, so there’s nowhere to keep what Arise finds. It comes in an update.</p>${pick('Choose a file')}`;
  }
  switch (st.phase) {
    case 'looking':
      return `<p id="importNow" aria-live="polite">Looking at ${esc(st.file?.name ?? 'the file')}…</p>`;
    case 'ask':
      return askHTML();
    case 'running': {
      const p = st.progress ?? { read: 0, total: 1, found: 0, label: '' };
      const pct = p.total ? Math.min(100, Math.round((p.read / p.total) * 100)) : 0;
      return `<p id="importNow"><b>${esc(reading(p.label))}</b>${st.queue.length ? ` <span class="muted">(${plural(st.queue.length, 'more file')} after this)</span>` : ''}</p>
        <div class="xp-bar" role="progressbar" aria-label="Reading the file" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><i id="importBar" style="width:${pct}%"></i></div>
        <p class="muted small" id="importCount" aria-live="polite">${countText(pct, p.found)}</p>
        <p class="muted small">Keep Arise open until it’s done.</p>
        <button class="btn ghost" data-act="life-import-cancel">Cancel</button>`;
    }
    case 'done':
      return `${resultsHTML()}${st.error ? `<p class="error small" role="alert">${esc(st.error)}</p>` : ''}<div class="row">${pick('Choose another file')}</div>`;
    default:
      return `${st.error ? `<p class="error small" role="alert">${esc(st.error)}</p>` : ''}${pick('Choose a file')}`;
  }
}

// ---------- questions before reading: whose Netflix, which bank columns

function needsAsking(d) {
  return d.found.some((f) => (f.kind === 'netflix-activity' && (f.profiles?.length ?? 0) > 1) || f.kind === 'bank-csv');
}

function askHTML() {
  const d = st.detection;
  const parts = [];
  for (const f of d.found) {
    if (f.kind === 'netflix-activity' && (f.profiles?.length ?? 0) > 1) {
      parts.push(`<fieldset class="ways" id="importProfiles"><legend class="label">Whose viewing is it?</legend>
        <p class="small">This Netflix account has more than one profile. Tick the ones that are yours.</p>
        ${f.profiles.map((p, i) => `<label class="check"><input type="checkbox" name="importProfile" value="${esc(p)}" ${(st.profiles ? st.profiles.includes(p) : i === 0) ? 'checked' : ''}> ${esc(p)}</label>`).join('')}
      </fieldset>`);
    }
    if (f.kind === 'bank-csv' && f.csv) parts.push(mappingHTML(f));
  }
  return `<p id="importNow"><b>${esc(st.file?.name ?? '')}</b></p>${parts.join('')}
    <p class="error small" id="importAskErr" role="alert" hidden></p>
    <div class="row"><button class="btn primary" data-act="life-import-go">Bring it in</button><button class="btn ghost" data-act="life-import-cancel">Cancel</button></div>`;
}

function mappingHTML(f) {
  const g = f.csv;
  const m = st.mapping ?? g.mapping;
  const opts = (sel, extra = '') => g.columns.map((c, i) => `<option value="${i}" ${sel === i ? 'selected' : ''}>${esc(c)}</option>`).join('') + extra;
  const two = m.amount === undefined;
  return `<div id="importMap">
    <p class="label">Which column is which?</p>
    ${g.ok ? '' : '<p class="small">Arise couldn’t tell for sure. Check each one.</p>'}
    <label class="field"><span class="k">Date</span><select class="imp-map" data-k="date">${opts(m.date)}</select></label>
    <label class="field"><span class="k">Description</span><select class="imp-map" data-k="description">${opts(m.description)}</select></label>
    <label class="field"><span class="k">Amount</span><select class="imp-map" data-k="amount">${opts(two ? -1 : m.amount, `<option value="two" ${two ? 'selected' : ''}>Two columns: money out and money in</option>`)}</select></label>
    <div id="importTwo" ${two ? '' : 'hidden'}>
      <label class="field"><span class="k">Money out</span><select class="imp-map" data-k="out">${opts(m.out ?? -1)}</select></label>
      <label class="field"><span class="k">Money in</span><select class="imp-map" data-k="in">${opts(m.in ?? -1)}</select></label>
    </div>
    <label class="field"><span class="k">Dates are written</span><select class="imp-map" data-k="dateOrder">
      ${[['dmy', 'Day first (31/12/2024)'], ['mdy', 'Month first (12/31/2024)'], ['ymd', 'Year first (2024-12-31)']].map(([v, l]) => `<option value="${v}" ${m.dateOrder === v ? 'selected' : ''}>${l}</option>`).join('')}
    </select></label>
    <label class="field" id="importSpending" ${two ? 'hidden' : ''}><span class="k">Money you spend shows as</span><select class="imp-map" data-k="spending">
      <option value="minus" ${m.spending === 'minus' ? 'selected' : ''}>A minus (−12.30)</option>
      <option value="plus" ${m.spending === 'plus' ? 'selected' : ''}>A plus (12.30)</option>
    </select></label>
    <p class="muted small" id="importPreview">${previewHTML(f, m)}</p>
  </div>`;
}

// The first rows as Arise will read them, so the Player can see the columns are right.
function previewHTML(f, m) {
  const rows = f.csv.sample.slice(0, 3);
  if (!rows.length) return '';
  const lines = rows.map((r) => {
    const raw = m.amount !== undefined ? amountText(r[m.amount], m.spending === 'plus') : `${r[m.out ?? -1] ? `−${r[m.out]}` : ''}${r[m.in ?? -1] ? `+${r[m.in]}` : ''}`;
    return `${esc(r[m.date] ?? '')} · ${esc((r[m.description] ?? '').slice(0, 40))} · ${esc(raw)}`;
  });
  return `For example: ${lines.join('<br>')}`;
}

function amountText(v, flip) {
  const s = String(v ?? '').trim();
  if (!flip || !s) return s;
  return s.startsWith('-') ? s.slice(1) : `−${s}`;
}

function readMapping(f) {
  const m = { ...f.csv.mapping };
  for (const sel of document.querySelectorAll('#importMap .imp-map')) {
    const k = sel.dataset.k;
    const v = sel.value;
    if (k === 'dateOrder' || k === 'spending') m[k] = v;
    else if (k === 'amount') {
      if (v === 'two') delete m.amount;
      else m.amount = Number(v);
    } else m[k] = Number(v);
  }
  if (m.amount !== undefined) {
    delete m.out;
    delete m.in;
  }
  return m;
}

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.id === 'lifeImportFile') {
    const files = [...(t.files ?? [])];
    t.value = '';
    if (files.length) start(files);
  } else if (t.name === 'importProfile') {
    st.profiles = [...document.querySelectorAll('input[name="importProfile"]')].filter((b) => b.checked).map((b) => b.value);
  } else if (t.classList?.contains('imp-map')) {
    const f = st.detection?.found.find((x) => x.kind === 'bank-csv');
    if (!f) return;
    const m = readMapping(f);
    st.mapping = m;
    $('#importTwo')?.toggleAttribute('hidden', m.amount !== undefined);
    $('#importSpending')?.toggleAttribute('hidden', m.amount === undefined);
    const p = $('#importPreview');
    if (p) p.innerHTML = previewHTML(f, m);
  }
});

// ---------- doing it

async function start(files) {
  st.queue = files;
  st.results = [];
  st.error = '';
  await next();
}

async function next() {
  const file = st.queue.shift();
  if (!file) {
    st.phase = 'done';
    st.file = null;
    paint();
    return;
  }
  st.file = file;
  st.detection = null;
  st.mapping = null;
  st.profiles = null;
  st.phase = 'looking';
  paint();
  try {
    st.detection = await importer().detect(file);
  } catch (err) {
    st.results.push({ name: file.name, found: 0, added: 0, labels: [], problem: 'unknown' });
    st.error = err?.message ?? '';
    return next();
  }
  const d = st.detection;
  if (!d.found.length) {
    st.results.push({ name: file.name, found: 0, added: 0, labels: [], problem: d.problem ?? 'unknown' });
    return next();
  }
  if (needsAsking(d)) {
    st.phase = 'ask';
    paint();
    return;
  }
  return run({});
}

async function run(choices) {
  const store = resolvedStore ?? (await getStore());
  if (!store) {
    st.phase = 'idle';
    st.queue = [];
    paint();
    return;
  }
  const file = st.file;
  const ctrl = new AbortController();
  st.ctrl = ctrl;
  st.phase = 'running';
  st.progress = { read: 0, total: st.detection.found.reduce((s, f) => s + f.size, 0), found: 0, label: st.detection.found[0]?.label ?? '' };
  paint();
  try {
    const r = await importer().run(file, {
      detection: st.detection,
      ...choices,
      signal: ctrl.signal,
      onEvents: (batch) => store.addEvents(batch),
      onProgress: (p) => {
        st.progress = p;
        showProgress();
      },
    });
    st.results.push({ name: file.name, html: st.detection.html, ...r });
    if (r.cancelled) st.queue = [];
  } catch (err) {
    st.results.push({ name: file.name, found: 0, added: 0, labels: [] });
    st.error = `Arise couldn’t finish this file. ${err?.message ?? ''}`.trim();
    st.queue = [];
  }
  st.ctrl = null;
  return next();
}

const reading = (label) => (label ? `Reading ${label}…` : 'Reading…');
// Some files (Apple Health) only give their events at the end: no "0 found" until then.
const countText = (pct, found) => `${pct}% read${found ? ` · ${plural(found, 'event')} found so far` : ''}`;

// Only the bar and the count change, so the Cancel button stays put under a finger.
function showProgress() {
  const p = st.progress;
  if (st.phase !== 'running' || !p) return;
  const pct = p.total ? Math.min(100, Math.round((p.read / p.total) * 100)) : 0;
  const bar = $('#importBar');
  if (!bar) return;
  bar.style.width = `${pct}%`;
  bar.parentElement?.setAttribute('aria-valuenow', String(pct));
  const count = $('#importCount');
  if (count) count.textContent = countText(pct, p.found);
  const now = $('#importNow b');
  if (now && now.textContent !== reading(p.label)) now.textContent = reading(p.label);
}

// Returns true when it handled the action.
export function handleAction(act) {
  switch (act) {
    case 'life-import-pick':
      $('#lifeImportFile')?.click();
      return true;
    case 'life-import-cancel':
      if (st.phase === 'running') st.ctrl?.abort();
      else if (st.phase === 'ask') {
        st.results.push({ name: st.file?.name ?? '', found: 0, added: 0, labels: [], cancelled: true });
        st.queue = [];
        next();
      }
      return true;
    case 'life-import-go': {
      if (st.phase !== 'ask') return true;
      const choices = {};
      const boxes = document.querySelectorAll('input[name="importProfile"]');
      if (boxes.length) {
        choices.profiles = [...boxes].filter((b) => b.checked).map((b) => b.value);
        if (!choices.profiles.length) {
          const err = $('#importAskErr');
          if (err) {
            err.textContent = 'Tick at least one profile.';
            err.hidden = false;
          }
          return true;
        }
      }
      const bank = st.detection.found.find((f) => f.kind === 'bank-csv');
      if (bank) choices.csv = readMapping(bank);
      run(choices);
      return true;
    }
  }
  return false;
}

// For tests: back to the start.
export function _reset() {
  st.phase = 'idle';
  st.queue = [];
  st.file = null;
  st.detection = null;
  st.mapping = null;
  st.profiles = null;
  st.progress = null;
  st.results = [];
  st.ctrl = null;
  st.error = '';
  resolvedStore = undefined;
}

export const _state = st;
