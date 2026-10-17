// Settings, Your life, Accounts: each service with Connect and Disconnect, what it reads, the
// last sync, how much came from it, and "Delete what Arise got from it". Its buttons use the
// app's data-act clicks (app.js hands them to handleAction).

import { GOOGLE } from '../connect-config';
import { esc, icon, openSheet, closeSheet, toast } from '../ui.js';
import * as G from './google';
import * as MS from './microsoft';
import * as STEAM from './steam';
import * as PSN from './psn';
import * as OAUTH from './oauth';
import { ConnectError, isNative } from './http';
import { INFO, available, busy, deleteData, disconnect, finish, linked, syncNow, initEngine } from './engine';
import { SERVICES, load, type ServiceId } from './state';

const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const isService = (v: unknown): v is ServiceId => SERVICES.includes(v as ServiceId);

export function ago(t: number, now = Date.now()): string {
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 2 * 86400) return 'yesterday';
  return `on ${new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
}

const items = (n: number) => `${n.toLocaleString()} ${n === 1 ? 'item' : 'items'}`;
const btn = (act: string, id: ServiceId, label: string, cls = 'ghost') => `<button class="btn small ${cls}" data-act="${act}" data-s="${id}">${label}</button>`;

function card(id: ServiceId): string {
  const info = INFO[id];
  const st = load(id);
  const where = available(id);
  const tag = info.unofficial ? '<span class="tag">Unofficial: Sony could block it</span>' : '';
  const lines: string[] = [];
  const buttons: string[] = [];
  if (where === 'setup') {
    lines.push('<small>Not set up yet.</small>');
    // Only on the owner's own computer (npm run dev): where to set it up.
    if (import.meta.env.DEV) lines.push('<small class="muted">Owner: add its client ID in src/connect-config.ts (docs/LAUNCH.md, Turning on linked accounts).</small>');
  } else if (where === 'iphone') {
    lines.push('<small>iPhone app only.</small>');
  } else if (where === 'web') {
    lines.push('<small>Use Arise on the web for this: in Safari or on a computer.</small>');
  } else if (!st.on) {
    buttons.push(btn('acct-connect', id, 'Connect', 'primary'));
  } else {
    const what = st.parts.length && info.parts ? info.parts.filter((p) => st.parts.includes(p.id)).map((p) => p.label).join(' and ') : '';
    const who = st.account ? ` as ${esc(st.account)}` : '';
    if (busy(id)) lines.push('<small>Syncing…</small>');
    else if (st.needs === 'reconnect') lines.push(`<small class="error">${esc(st.error || 'Signed out. Connect again.')}</small>`);
    else if (st.needs === 'tap') lines.push(`<small>${esc(id === 'google' ? G.TAP : MS.TAP)} Tap Sync now.</small>`);
    else if (st.error) lines.push(`<small class="error">${esc(st.error)}</small>`);
    lines.push(`<small>Connected${who}${what ? ` (${esc(what)})` : ''}. ${st.last ? `Last sync ${ago(st.last)}` : 'Not synced yet'}. ${items(st.count)} so far.</small>`);
    if (st.needs === 'reconnect') buttons.push(btn('acct-connect', id, 'Connect again', 'primary'));
    else buttons.push(`<button class="btn small primary" data-act="acct-sync" data-s="${id}" ${busy(id) ? 'disabled' : ''}>${icon('refresh')} Sync now</button>`);
    buttons.push(btn('acct-off', id, 'Disconnect'));
  }
  if (!st.on && st.count) lines.push(`<small>${items(st.count)} from it on this device.</small>`);
  const del = st.count ? `<button class="link small" data-act="acct-del" data-s="${id}">Delete what Arise got from it</button>` : '';
  return `<div class="engine" style="cursor:default" id="acct-${id}">
    <span class="engine-head"><b>${esc(info.name)}</b>${tag}</span>
    ${where === 'setup' ? '' : `<small>${esc(info.reads)}</small>`}
    ${lines.join('')}
    ${buttons.length ? `<div class="row">${buttons.join('')}</div>` : ''}
    ${del}
  </div>`;
}

// The Accounts part on its own, for a "Your life" section to hold.
export function accountsBlock(): string {
  return `<p class="label">Accounts</p>
    <p class="small">Link your accounts so Arise knows your days. It reads them straight from each service, with nothing in between, and keeps what it gets on this device. Your sign-ins stay on this device too.</p>
    <div class="engines">${SERVICES.map(card).join('')}</div>`;
}

export function settingsPanel(): string {
  return `<section class="panel" id="accountsPanel">
    <div class="panel-title">${icon('today')}<span>Your life</span></div>
    ${accountsBlock()}
  </section>`;
}

// Redraws only this panel, so nothing else in Settings (like a half-typed field) is touched.
export function refresh() {
  const el = document.getElementById('accountsPanel');
  if (el) el.outerHTML = settingsPanel();
}

export function initConnect() {
  initEngine({ render: refresh, toast });
}

// ---------- the connect sheets

const err = (text: string) => {
  const el = $('#acctErr');
  if (el) {
    el.textContent = text;
    el.hidden = !text;
  }
};

const partBoxes = (id: ServiceId) =>
  (INFO[id].parts || []).map((p) => `<label class="check"><input type="checkbox" class="acct-part" value="${p.id}" checked> ${esc(p.label)}</label>`).join('');

function connectSheet(id: ServiceId) {
  const native = isNative();
  if (id === 'google') {
    openSheet(`<p class="kicker">Your life</p><h2 class="display sheet-title">Connect Google</h2>
      <p>${esc(INFO.google.reads)}</p>
      ${partBoxes('google')}
      <p class="muted small">Google asks you to sign in and say yes. Arise reads straight from Google and keeps what it gets on this device.</p>
      ${GOOGLE.testing ? "<p class=\"muted small\">Arise's Google access is still in test mode: only people Arise's owner adds can connect, and Google asks you to say yes again every 7 days.</p>" : ''}
      <p class="error small" id="acctErr" role="alert" hidden></p>
      <button class="btn primary block" data-act="acct-go" data-s="google">Continue to Google</button>`);
  } else if (id === 'microsoft') {
    openSheet(`<p class="kicker">Your life</p><h2 class="display sheet-title">Connect Microsoft</h2>
      <p>${esc(INFO.microsoft.reads)}</p>
      ${partBoxes('microsoft')}
      <p class="muted small">${native ? "You'll get a short code to type on Microsoft's page in Safari." : 'Microsoft asks you to sign in and say yes.'} Arise reads straight from Microsoft and keeps what it gets on this device.</p>
      <p class="error small" id="acctErr" role="alert" hidden></p>
      <button class="btn primary block" data-act="acct-go" data-s="microsoft">Continue to Microsoft</button>`);
  } else if (id === 'steam') {
    openSheet(`<p class="kicker">Your life</p><h2 class="display sheet-title">Connect Steam</h2>
      <p>${esc(INFO.steam.reads)}</p>
      <ol class="changes">
        <li>Get your key at <a href="https://steamcommunity.com/dev/apikey" target="_blank" rel="noopener">steamcommunity.com/dev/apikey ${icon('ext')}</a>. Sign in, type any name (like arise) for Domain, and copy the key.</li>
        <li>In Steam, under Edit Profile, Privacy Settings, set Game details to Public.</li>
      </ol>
      <label class="field"><span class="k">Steam Web API key</span><input id="acctKey" type="password" autocomplete="off" spellcheck="false"></label>
      <label class="field"><span class="k">Your Steam profile (link or ID)</span><input id="acctUser" type="text" autocomplete="off" spellcheck="false" placeholder="steamcommunity.com/id/…"></label>
      <p class="muted small">The key stays on this phone. You can cancel it on that Steam page any time.</p>
      <p class="error small" id="acctErr" role="alert" hidden></p>
      <button class="btn primary block" data-act="acct-go" data-s="steam">Connect Steam</button>`);
  } else {
    openSheet(`<p class="kicker">Your life</p><h2 class="display sheet-title">Connect PlayStation</h2>
      <p><span class="tag">Unofficial: Sony could block it</span></p>
      <p>${esc(INFO.psn.reads)}</p>
      <ol class="changes">
        <li>In Safari, sign in at <a href="${PSN.SIGN_IN_PAGE}" target="_blank" rel="noopener">playstation.com ${icon('ext')}</a>.</li>
        <li>Then open <a href="${PSN.CODE_PAGE}" target="_blank" rel="noopener">Sony's code page ${icon('ext')}</a>. Copy the long code after "npsso" (64 letters and numbers).</li>
        <li>Paste it here.</li>
      </ol>
      <label class="field"><span class="k">Code</span><input id="acctKey" type="password" autocomplete="off" spellcheck="false"></label>
      <p class="muted small">The code works like a password, so Arise doesn't keep it: it swaps it for its own sign-in, which stays on this phone. After about two months you paste a new one.</p>
      <p class="error small" id="acctErr" role="alert" hidden></p>
      <button class="btn primary block" data-act="acct-go" data-s="psn">Connect PlayStation</button>`);
  }
}

const chosen = () => [...document.querySelectorAll<HTMLInputElement>('.acct-part')].filter((b) => b.checked).map((b) => b.value);

// Google or Microsoft in the web app. Runs straight from the tap: the pop-up opens first.
function signInWeb(id: 'google' | 'microsoft', parts: string[], hint = '') {
  const redirect = OAUTH.redirectUri();
  const p =
    id === 'google'
      ? OAUTH.begin('google', parts, ({ state }) => G.authUrl({ state, parts, hint, redirect }))
      : OAUTH.begin('microsoft', parts, ({ state, challenge }) => MS.authUrl({ state, challenge: challenge || '', hint, redirect, parts }), { pkce: true });
  openSheet(`<p class="kicker">Your life</p><h2 class="display sheet-title">Finish signing in</h2>
    <p id="acctFinish">Finish in the ${id === 'google' ? 'Google' : 'Microsoft'} window that opened, then come back here.</p>
    <button class="btn ghost block" data-act="acct-cancel">Cancel</button>`);
  // Only this sign-in's own sheet is closed (not one opened since).
  const done = () => {
    if (document.getElementById('acctFinish')) closeSheet();
  };
  p.then(async (answer) => {
    done();
    await finish(answer);
  }).catch((e) => {
    if ((e as Error)?.message === 'cancelled') return;
    done();
    toast("The sign-in didn't finish. Try again.");
  });
}

// Microsoft in the iPhone app: a short code to type on Microsoft's page.
let deviceRun = 0;
async function signInDevice(parts: string[]) {
  const run = ++deviceRun;
  let dc: MS.DeviceCode;
  try {
    dc = await MS.deviceCode(parts);
  } catch (e) {
    err(e instanceof ConnectError ? e.message : "Couldn't reach Microsoft. Try again.");
    return;
  }
  openSheet(`<p class="kicker">Your life</p><h2 class="display sheet-title">Connect Microsoft</h2>
    <p>1. Copy this code:</p>
    <p class="display" id="acctDevice" style="font-size:34px;letter-spacing:0.08em">${esc(dc.code)}</p>
    <button class="btn ghost small" data-act="acct-copy" data-code="${esc(dc.code)}">Copy code</button>
    <p>2. Open <a href="${esc(dc.url)}" target="_blank" rel="noopener">${esc(dc.url.replace(/^https:\/\//, ''))} ${icon('ext')}</a>, paste the code, sign in and say yes.</p>
    <p>3. Come back here. Arise carries on by itself.</p>
    <p class="muted small" id="acctWait">Waiting for Microsoft…</p>
    <p class="error small" id="acctErr" role="alert" hidden></p>
    <button class="btn ghost block" data-act="acct-cancel">Cancel</button>`);
  const st = load('microsoft');
  let wait = dc.interval;
  while (run === deviceRun && Date.now() < dc.expires && document.getElementById('acctDevice')) {
    await new Promise((r) => setTimeout(r, wait));
    if (run !== deviceRun || !document.getElementById('acctDevice')) return;
    try {
      const r = await MS.devicePoll(st, dc);
      if (r === 'slow') wait += 5000;
      if (r === 'done') {
        st.parts = parts;
        st.account = ''; // who it is: checked on the first sync (another account starts afresh)
        closeSheet();
        toast('Microsoft is linked. Getting your data…');
        linked('microsoft', st);
        return;
      }
    } catch (e) {
      if (e instanceof ConnectError && (e.kind === 'net' || e.kind === 'rate')) continue;
      err(e instanceof ConnectError ? e.message : "The sign-in didn't work. Try again.");
      return;
    }
  }
  if (run === deviceRun && document.getElementById('acctDevice')) err('The code ran out. Try again.');
}

async function connectSteam(button: HTMLButtonElement) {
  const key = ($<HTMLInputElement>('#acctKey')?.value || '').trim();
  const profile = ($<HTMLInputElement>('#acctUser')?.value || '').trim();
  if (!STEAM.validKey(key)) return err('The key is 32 letters and numbers. Copy it from the Steam page.');
  if (!profile) return err('Paste the link to your Steam profile.');
  button.disabled = true;
  err('');
  try {
    const steamid = await STEAM.resolveProfile(key, profile);
    const name = await STEAM.playerName(key, steamid);
    const st = load('steam');
    // The same profile again carries on from its last snapshot; another one starts afresh.
    if (st.user !== steamid) {
      st.snap = {};
      st.last = 0;
    }
    st.auth = { token: key };
    st.user = steamid;
    st.account = name;
    closeSheet();
    toast('Steam is linked. Getting your games…');
    linked('steam', st);
  } catch (e) {
    err(e instanceof ConnectError ? e.message : "Couldn't reach Steam. Try again.");
    button.disabled = false;
  }
}

async function connectPsn(button: HTMLButtonElement) {
  const code = PSN.npssoFrom($<HTMLInputElement>('#acctKey')?.value || '');
  if (!PSN.validNpsso(code)) return err('The code is 64 letters and numbers. Copy the part after "npsso".');
  button.disabled = true;
  err('');
  try {
    const st = load('psn');
    await PSN.signIn(st, code);
    st.account = 'PlayStation account';
    st.snap = {};
    st.last = 0;
    st.cursors = {};
    closeSheet();
    toast('PlayStation is linked. Getting your games…');
    linked('psn', st);
  } catch (e) {
    err(e instanceof ConnectError ? e.message : "Couldn't reach PlayStation. Try again.");
    button.disabled = false;
  }
}

// ---------- taps

// True when it was one of this panel's buttons.
export async function handleAction(act: string, el: HTMLElement): Promise<boolean> {
  if (!act.startsWith('acct-')) return false;
  const id = el.dataset.s;
  switch (act) {
    case 'acct-connect':
      if (isService(id) && available(id) === 'ok') connectSheet(id);
      return true;
    case 'acct-go': {
      if (!isService(id) || available(id) !== 'ok') return true;
      if (id === 'google' || id === 'microsoft') {
        const parts = chosen();
        if (!parts.length) return err('Pick at least one.'), true;
        if (id === 'microsoft' && isNative()) await signInDevice(parts);
        else signInWeb(id, parts, load(id).user);
      } else if (id === 'steam') await connectSteam(el as HTMLButtonElement);
      else await connectPsn(el as HTMLButtonElement);
      return true;
    }
    case 'acct-sync': {
      if (!isService(id)) return true;
      const st = load(id);
      // The web sign-in ran out: sign in again from this tap, then sync.
      if (st.needs === 'tap' && (id === 'google' || (id === 'microsoft' && !isNative()))) signInWeb(id, st.parts, st.user);
      else await syncNow(id, { manual: true });
      return true;
    }
    case 'acct-off':
      if (isService(id) && confirm(`Disconnect ${INFO[id].name}? Arise stops getting new things from it. What it already got stays until you delete it.`)) {
        disconnect(id);
        refresh();
        toast(`${INFO[id].name} is disconnected.${id === 'steam' ? ' You can also cancel the key on the Steam page.' : ''}`);
      }
      return true;
    case 'acct-del': {
      if (!isService(id)) return true;
      const st = load(id);
      const note = st.on ? ' While it stays connected, new things still come in.' : '';
      if (!confirm(`Delete everything Arise got from ${INFO[id].name} on this device?${note}`)) return true;
      try {
        toast((await deleteData(id)) === 'done' ? `Deleted what Arise got from ${INFO[id].name}.` : "Arise can't delete these yet. Try again after Arise updates.");
        refresh();
      } catch {
        toast("Your life log isn't ready yet. Try again in a moment.");
      }
      return true;
    }
    case 'acct-copy':
      try {
        await navigator.clipboard.writeText(el.dataset.code || '');
        toast('Code copied.');
      } catch {
        toast('Select the code and copy it.');
      }
      return true;
    case 'acct-cancel':
      deviceRun++;
      OAUTH.cancel();
      closeSheet();
      return true;
  }
  return false;
}
