// Settings, "Your life: browser": getting the Arise extension, linking this browser to Arise, and
// the browsers that are linked. The work is in browser-link.ts.

import * as BL from './browser-link';
import { EXTENSION_STORES, EXTENSION_UPDATES, EXTENSION_XPI, EXTENSION_ZIP } from './browser-config';
import { esc, openSheet, closeSheet, toast } from '../ui.js';

const UA = typeof navigator === 'undefined' ? '' : navigator.userAgent;
const FIREFOX = /Firefox\//.test(UA);
const EDGE = /Edg\//.test(UA);
const PHONE = /Android|iPhone|iPad|Mobile/.test(UA);

let render = () => {};
let xpiReady = null; // Firefox: whether the copy Mozilla signed is on the website (null: not checked)

export function initBrowserUI({ accountKey, render: r }) {
  render = r;
  return BL.initBrowserLink({ accountKey, render: r });
}

const day = (t) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
function ago(t) {
  if (!t) return 'nothing yet';
  const m = Math.round((Date.now() - t) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : day(t);
}

function getIt() {
  if (PHONE) return '<p class="muted small">This works on a computer, in Chrome, Edge, Brave, Arc or Firefox.</p>';
  const store = EDGE ? EXTENSION_STORES.edge || EXTENSION_STORES.chrome : EXTENSION_STORES.chrome;
  if (FIREFOX) {
    if (xpiReady === null) {
      xpiReady = false;
      fetch(EXTENSION_UPDATES, { cache: 'no-store' })
        .then((r) => {
          xpiReady = r.ok;
          if (r.ok) render();
        })
        .catch(() => {});
    }
    return xpiReady
      ? `<a class="btn primary" href="${esc(EXTENSION_XPI)}">Add the Arise extension</a>
        <p class="muted small">Firefox asks if you want to add it. Then reload this page.</p>`
      : '<p class="muted small">Firefox needs a copy of the extension signed by Mozilla, and it isn\'t ready yet. Chrome, Edge, Brave and Arc work now.</p>';
  }
  if (store) {
    return `<a class="btn primary" href="${esc(store)}" target="_blank" rel="noopener">Add the Arise extension</a>
      <p class="muted small">Then reload this page and press "Link this browser".</p>`;
  }
  return `<p class="label">Add the extension (4 steps)</p>
    <ol class="small">
      <li><a href="${esc(EXTENSION_ZIP)}" download>Download the extension</a> and unzip it.</li>
      <li>Open <b>${EDGE ? 'edge://extensions' : 'chrome://extensions'}</b> in a new tab and turn on Developer mode.</li>
      <li>Press "Load unpacked" and pick the unzipped folder.</li>
      <li>Reload this page and press "Link this browser".</li>
    </ol>
    <p class="muted small">Works in Chrome, Edge, Brave and Arc.</p>`;
}

function linkRow(r) {
  const here = BL.status.hello?.linked === r.id;
  const locked = BL.status.locked.includes(r.id);
  return `<div class="bl-link">
    <p><b>${esc(r.name)}</b><br><span class="muted small">Linked ${esc(day(r.linkedAt || r.createdAt))}. Last got data: ${esc(ago(r.lastDelivery))}. ${Number(r.received || 0).toLocaleString()} things so far.</span></p>
    ${locked ? '<p class="error small">Sign in to get what it saved. It waits in the browser until then.</p>' : ''}
    ${!here ? '<p class="muted small">Not found in this browser right now.</p>' : ''}
    ${here && !BL.status.logReady ? '<p class="muted small">Waiting for your life log to start.</p>' : ''}
    <div class="row">
      ${here && !locked && BL.status.logReady ? '<button class="btn small ghost" data-act="bl-now">Get it now</button>' : ''}
      <button class="btn small ghost danger" data-act="bl-unlink" data-id="${esc(r.id)}">Unlink</button>
    </div>
  </div>`;
}

export function browserPanel() {
  BL.recheck();
  const s = BL.status;
  const links = s.links.filter((r) => r.state === 'linked');
  const linkedHere = !!s.hello?.linked && links.some((r) => r.id === s.hello.linked);
  let body;
  if (!s.checked) body = '<p class="muted small">Looking for the extension…</p>';
  else if (s.pairing) {
    body = `<p>A small Arise window opened. Check it shows these 4 words, then press "They match" there.</p>
      <p class="code-box">${s.pairing.code.map(esc).join(' · ')}</p>
      <p class="muted small">No window? Click the Arise button in the browser's toolbar (it may be under the puzzle piece).</p>
      <button class="btn ghost small" data-act="bl-cancel">Cancel</button>`;
  } else if (!s.hello) {
    body = `${getIt()}
      <button class="btn ghost small" data-act="bl-check">Check again</button>`;
  } else if (!linkedHere) {
    body = `<button class="btn primary" data-act="bl-link" ${s.busy ? 'disabled' : ''}>Link this browser</button>
      <p class="muted small">You'll compare 4 words here with the extension's, so you know it's your Arise.</p>
      <p class="muted small">Sites you never want in your log? Add them in the extension's menu first (the Arise button in the toolbar): linking also reads the last 90 days.</p>`;
  } else body = '';
  return `<section class="panel" id="browserPanel">
    <div class="panel-title"><span>Your life: browser</span></div>
    <p>Arise can keep a private log of the sites you visit, what you search, and your time on each site in this browser. The extension seals it right away, so only your Arise can read it.</p>
    ${s.error ? `<p class="error small" role="alert">${esc(s.error)}</p>` : ''}
    ${body}
    ${links.map(linkRow).join('')}
    ${
      links.length || s.hello
        ? `<p class="muted small bl-note">Pause, "forget the last hour" and your own list of sites to skip are in the extension's menu (the Arise button in the toolbar). Never recorded: private windows, banks, health portals, adult sites, password managers and sign-in pages.</p>`
        : ''
    }
  </section>`;
}

// Returns true when it handled the action.
export async function handleAction(act, el) {
  switch (act) {
    case 'bl-check':
      el.disabled = true;
      await BL.detect();
      render();
      if (!BL.status.hello) toast('Not found yet. If you just added it, reload this page.');
      return true;
    case 'bl-link':
      BL.status.busy = true;
      BL.status.error = '';
      render();
      try {
        await BL.startLink();
      } catch (err) {
        BL.status.error = err.message || "Couldn't start linking. Reload this page and try again.";
      }
      BL.status.busy = false;
      render();
      return true;
    case 'bl-cancel':
      await BL.cancelLink();
      render();
      return true;
    case 'bl-now': {
      el.disabled = true;
      const n = await Promise.race([BL.deliver(), new Promise((r) => setTimeout(() => r(-1), 15_000))]);
      toast(n < 0 ? 'Still collecting. It goes on in the background.' : n ? `${n.toLocaleString()} new things from this browser.` : 'Nothing new from this browser.');
      render();
      return true;
    }
    case 'bl-unlink': {
      const r = BL.status.links.find((x) => x.id === el.dataset.id);
      if (!r) return true;
      openSheet(`<p class="kicker">Your life: browser</p><h2 class="display sheet-title">Unlink ${esc(r.name)}?</h2>
        <p>Its key is deleted from Arise, so nothing it saved can be opened any more. If it's this browser, the extension stops recording and deletes what it hasn't sent. What Arise already has stays.</p>
        <button class="btn primary block danger" data-act="bl-unlink-yes" data-id="${esc(r.id)}">Unlink</button>
        <button class="btn ghost block" data-act="sheet-close">Keep it</button>`);
      return true;
    }
    case 'bl-unlink-yes':
      el.disabled = true;
      await BL.unlink(el.dataset.id);
      closeSheet();
      toast('Unlinked.');
      render();
      return true;
  }
  return false;
}

export const forgetAll = () => BL.forgetAll();
