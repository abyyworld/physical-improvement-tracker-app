// Settings, Your life, Mac: linking Arise to the Mac helper, what it reads, and how it's doing.
// Shown only in a browser on a Mac (see mac-link.ts).

import * as MAC from './mac-link';
import { esc, icon, openSheet, toast } from '../ui.js';
import { isNative } from '../native.js';

const $ = (sel) => document.querySelector(sel);

const ROWS = [
  ['calls', 'Calls', 'Calls on this Mac and from your iPhone: who, when, how long, and the ones you missed.'],
  ['notifications', 'Notifications', 'Which app sent one, and when.'],
  ['messages', 'Messages', 'Who you messaged with, and when.'],
  ['text', 'Message and notification text', 'Also the words. When this is off, only who and when.'],
  ['safari', 'Safari history', 'Pages you visit, here and on your iPhone if Safari syncs with iCloud.'],
  ['apps', 'App use', 'Which app is in front, added up per hour.'],
];

const STATE = {
  waiting: 'Starting',
  ok: 'Reading',
  'no-access': 'Needs Full Disk Access',
  missing: 'Nothing to read on this Mac',
  error: "Couldn't read it",
};

function ago(ms) {
  const min = Math.round((Date.now() - ms) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

// Right after the installer has checked the helper. Later, the panel sends the Player back to the
// installer instead: Full Disk Access should only go to a program that was just checked.
const fdaSteps = () =>
  `System Settings, Privacy &amp; Security, Full Disk Access. Click +, press Command-Shift-G, paste <span class="mono">${esc(MAC.HELPER_PATH_HINT)}</span> and press Return, then click Open and turn its switch on.`;

function notLinked() {
  const safari = MAC.browser() === 'safari';
  return `<p>Let Arise see what happens on this Mac: calls from your iPhone (and the ones you missed), notifications, messages, Safari history and which apps you use. A small helper reads them on this Mac only. Nothing leaves it except through Arise's own end-to-end encrypted sync.</p>
    ${safari ? `<p class="error small">${esc(MAC.problemText('unreachable'))}</p>` : ''}
    <p class="label">1. Install the helper</p>
    <p class="small">Open Terminal on this Mac, paste this and press Return:</p>
    <div class="code-box small" id="macCmd">${esc(MAC.INSTALL_COMMAND)}</div>
    <button class="btn ghost small" data-act="mac-copy">Copy command</button>
    <p class="label">2. Give it Full Disk Access</p>
    <p class="small">${fdaSteps()} The installer opens that page for you. App use works without it.</p>
    <p class="muted small">Good to know: this goes to the helper's one signed program, and if anything changes it, macOS takes the permission away. But without a paid Apple developer signature, macOS still lets another app you run slip its own code into it as it starts. Other apps you run can still read the pairing code (in this browser, or in the helper's folder) and use it to turn on anything the helper can read, messages and their words too, and get what it reads. The switches here show what's on. So use the helper on a Mac where you trust what you install.</p>
    <p class="label">3. Enter the pairing code</p>
    <label class="field"><span class="k">Pairing code (the installer shows it)</span><input id="macCodeIn" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="40" placeholder="XXXXX-XXXXX-XXXXX-XXXXX"></label>
    <p class="error small" id="macErr" role="alert" hidden></p>
    <button class="btn primary" data-act="mac-link">Link this Mac</button>
    <p class="muted small">Chrome or Edge may ask to let this site reach apps on this device. Choose Allow.</p>`;
}

function linkedView() {
  const st = MAC.lastStatus();
  const problem = MAC.lastProblem();
  const totals = MAC.totals();
  const pulled = MAC.lastPull();
  const line = problem
    ? `<p class="error small">${esc(MAC.problemText(problem))}</p>`
    : `<p>Linked. ${pulled ? `Last brought in ${ago(pulled)}${MAC.lastNew() ? `: ${MAC.lastNew()} new` : ''}.` : 'Nothing brought in yet.'} Arise brings in what's new while it's open on this Mac.</p>`;
  const anyOn = st && MAC.SOURCES.some((k) => st.settings[k]);
  const needsFda = st && (st.fullDiskAccess === false || MAC.SOURCES.some((k) => st.settings[k] && st.sources[k].state === 'no-access'));
  const rows = ROWS.map(([k, label, sub]) => {
    const on = !!st?.settings[k];
    let note = '';
    if (on && k !== 'text' && st) {
      const s = st.sources[k];
      note = [STATE[s.state] || '', totals[k] ? `${totals[k]} brought in` : ''].filter(Boolean).join(' · ');
    }
    return `<button class="toggle-row" data-act="mac-switch" data-k="${k}" aria-pressed="${on}" ${st ? '' : 'disabled'}><span><b>${label}</b><small>${esc(sub)}${note ? ` <span class="muted">${esc(note)}</span>` : ''}</small></span><span class="switch ${on ? 'on' : ''}"></span></button>`;
  }).join('');
  return `${line}
    ${st?.olderNodeAccess === true ? `<p class="error small">"node", from the older helper, still has Full Disk Access, and any app on this Mac could use it. In System Settings, Privacy &amp; Security, Full Disk Access, select "node" and click the minus button.</p>` : ''}
    ${MAC.isOlderHelper(st) ? `<p class="error small">This is the older helper: its Full Disk Access goes to Node.js, which any app on this Mac could use. Run the install command again to update it. It keeps the pairing code and switches.</p>` : ''}
    ${MAC.isOutdatedHelper(st) ? `<p class="small">A newer helper is ready. To get it, run the install command again (Copy install command, below). It keeps the pairing code and switches, and shows how to turn Full Disk Access on again, since macOS ties it to one exact build.</p>` : ''}
    ${needsFda && !MAC.isOlderHelper(st) ? `<p class="error small">The helper needs Full Disk Access to read this.</p><p class="small">Run the install command again (Copy install command, below). It checks that the helper is Arise's own, then opens the right page in System Settings and shows what to do. macOS ties the permission to one exact build, so each update needs it again.</p>` : ''}
    <p class="label">What it reads</p>
    ${st ? '' : '<p class="muted small">Waiting for the helper…</p>'}
    ${rows}
    ${anyOn ? '' : '<p class="muted small">Everything starts off. Turn on what you want Arise to know.</p>'}
    <div class="row"><button class="btn primary small" data-act="mac-pull">${icon('refresh')} Bring in now</button><button class="btn ghost small" data-act="mac-copy">Copy install command</button><button class="btn ghost small" data-act="mac-unlink">Unlink</button></div>
    <p class="muted small">To update the helper, run the install command again in Terminal. To remove it from this Mac, run this: <span class="mono">${esc(MAC.UNINSTALL_COMMAND)}</span></p>`;
}

function body() {
  return `<div class="panel-title">${icon('system')}<span>Your life: Mac</span></div>${MAC.linked() ? linkedView() : notLinked()}`;
}

// (Called when the link's state changes, which can come after the page is gone.)
function refreshPanel() {
  if (typeof document === 'undefined') return;
  const p = $('#macPanel');
  if (p) p.innerHTML = body();
}

let asked = 0;

export function settingsPanel() {
  if (!MAC.available(isNative)) return '';
  // How the helper is doing, asked again at most every 10 seconds while Settings is open.
  if (MAC.linked() && Date.now() - asked > 10_000) {
    asked = Date.now();
    MAC.refresh().then(refreshPanel, refreshPanel);
  }
  return `<section class="panel" id="macPanel">${body()}</section>`;
}

function showError(text) {
  const el = $('#macErr');
  if (!el) return toast(text);
  el.textContent = text;
  el.hidden = !text;
}

async function busy(el, fn) {
  el.disabled = true;
  try {
    await fn();
  } finally {
    el.disabled = false;
  }
}

const problemOf = (err) => MAC.problemText(err instanceof MAC.HelperError ? err.problem : 'failed');

export async function handleAction(act, el) {
  switch (act) {
    case 'mac-copy':
      try {
        await navigator.clipboard.writeText(MAC.INSTALL_COMMAND);
        toast('Command copied. Paste it in Terminal.');
      } catch {
        // No clipboard: show the command to copy by hand.
        if (!$('#macCmd')) {
          openSheet(`<p class="kicker">Mac helper</p><h2 class="display sheet-title">Install command</h2>
            <p>Paste this in Terminal on this Mac and press Return:</p>
            <div class="code-box small" id="macCmd">${esc(MAC.INSTALL_COMMAND)}</div>
            <button class="btn primary block" data-act="sheet-close">Done</button>`);
        }
        getSelection()?.selectAllChildren($('#macCmd'));
        toast('Copy the command from the box.');
      }
      return true;
    case 'mac-link':
      await busy(el, async () => {
        showError('');
        try {
          await MAC.link($('#macCodeIn')?.value || '');
          toast('This Mac is linked. Turn on what you want Arise to know.');
          refreshPanel();
        } catch (err) {
          showError(problemOf(err));
        }
      });
      return true;
    case 'mac-switch': {
      const st = MAC.lastStatus();
      if (!st) return true;
      await busy(el, async () => {
        try {
          await MAC.setSwitches({ [el.dataset.k]: !st.settings[el.dataset.k] });
          // The helper reads a source as soon as it's on: bring it in shortly after.
          setTimeout(() => MAC.pull().then(refreshPanel, refreshPanel), 4000);
        } catch (err) {
          toast(problemOf(err));
        }
        refreshPanel();
      });
      return true;
    }
    case 'mac-pull':
      await busy(el, async () => {
        try {
          const n = await MAC.pull();
          toast(n ? `${n} new from this Mac.` : 'Nothing new from this Mac.');
          await MAC.refresh().catch(() => {});
        } catch (err) {
          toast(problemOf(err));
        }
      });
      refreshPanel();
      return true;
    case 'mac-unlink':
      MAC.unlink();
      toast('Unlinked. The helper keeps running on this Mac until you remove it.');
      refreshPanel();
      return true;
    default:
      return false;
  }
}

// When Arise starts: pull now and then while it's open (only on a Mac, only once linked).
export function initMacPanel() {
  MAC.initMacLink({ native: isNative, changed: refreshPanel });
}
