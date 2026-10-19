// Settings, AI coach: "Your computer's AI" (Ollama or LM Studio on this computer, lib/local-ai.ts).
// system.js shows its card with the others (on a computer, or once it's on), and this panel under
// them while it's picked, or on with the app picking: what was found, the model, whether that
// model may write the memory, and how to set it up.

import * as L from './lib/local-ai';
import * as S from './store';
import { esc, openSheet, toast } from './ui.js';

let app = { render: () => {}, view: () => '' };
// system.js's hooks: redraw Settings when what was found changes.
export function initLocalUI(hooks) {
  app = hooks;
}
L.onChange(() => {
  if (app.view() === 'settings') app.render();
});
// "Erase all data" turns it off and forgets the trusted models. (Another account's data taking
// this device's place keeps it: which AI this device uses is its own.)
S.onReset((keepsDevice) => {
  if (!keepsDevice) L.forget();
});

// On a phone it can't run, so the card only shows on a computer, or once it's on.
export const offered = () => L.prefs().on || L.onComputer();
// The panel: picked, or on while the app picks.
export const showPanel = (picked) => picked === 'local' || (!picked && L.prefs().on);

export const CARD_TEXT =
  'Runs in Ollama or LM Studio, free apps you install on this computer. Nothing leaves it, there are no keys or limits, and it works offline. It answers while Arise is open on that computer.';

// "Right now it picks for you: …", and "Let the app pick (… first)".
export const autoOrder = () => (L.prefs().on ? "your computer's AI, then the private AI, then this device" : 'the private AI, then this device');
export const autoFirst = () => (L.prefs().on ? 'your computer' : 'private');

const serverName = (kind) => L.SERVERS[L.serverWith(kind) || 'ollama'].name;

// The line on its card.
export function cardStatus() {
  const at = L.current();
  if (at) return { ok: true, text: `Ready: ${at.id} in ${L.SERVERS[at.server].name}.` };
  const st = L.status();
  if (st === 'off') return { ok: false, text: 'Pick it to set it up. On a Mac it takes one command.' };
  if (st === 'checking') return { ok: false, text: 'Looking for Ollama or LM Studio on this computer…' };
  if (st === 'no-model') return { ok: false, text: `${serverName('no-model')} is running, but has no AI model yet.` };
  if (st === 'blocked') return { ok: false, text: `${serverName('blocked')} is running, but doesn't let Arise in yet.` };
  if (st === 'ask') return { ok: false, text: 'Waiting for your OK in this browser.' };
  if (st === 'denied') return { ok: false, text: 'This browser is blocking it.' };
  if (st === 'safari') return { ok: false, text: "Safari doesn't allow it. Use Chrome, Edge or Firefox." };
  return { ok: false, text: 'Not found on this computer.' };
}

// What to do now, in plain words.
function help() {
  const st = L.status();
  const ollama = (kind) => L.serverWith(kind) !== 'lmstudio';
  if (st === 'checking') return 'Looking for Ollama or LM Studio on this computer…';
  if (st === 'blocked')
    return ollama('blocked')
      ? 'Ollama is running, but only answers apps it trusts. Run the command below once: it lets Arise in and restarts Ollama.'
      : "LM Studio is running, but doesn't let websites in yet. In LM Studio, open the Developer tab, then its settings, and turn on Enable CORS. Then tap Check again.";
  if (st === 'no-model')
    return ollama('no-model')
      ? 'Ollama is running, but has no AI model yet. The command below downloads one that fits this computer.'
      : 'LM Studio is running, but has no AI model yet. Download one in LM Studio (for example Qwen2.5 7B Instruct), then tap Check again.';
  if (st === 'ask') return 'Tap Check again. Your browser then asks to let Arise reach apps on this computer: choose Allow.';
  if (st === 'denied')
    return 'This browser is blocking Arise from reaching apps on this computer. Click the icon to the left of the web address, open Site settings, and allow Local network access. Then tap Check again.';
  if (st === 'safari') return "Safari doesn't let websites reach apps on this computer. Open Arise in Chrome, Edge or Firefox here, and pick this again.";
  return "Arise couldn't find Ollama or LM Studio on this computer. Set one up below, or open it if you have it. Then tap Check again.";
}

const here = () => (typeof location !== 'undefined' ? location.origin : '');
const command = () => L.setupCommand(here());

function setup() {
  const o = L.origins(here());
  return `<p class="label">On a Mac: one command</p>
    <p class="small">Open Terminal, paste this and press Return. It installs Ollama if it isn't there, lets Arise talk to it, and downloads a model that fits this Mac (5 to 20 GB, once).</p>
    <div class="code-box small" id="localCmd">${esc(command())}</div>
    <button class="btn ghost small" data-act="local-copy">Copy command</button>
    <details class="other"><summary>Windows, Linux or LM Studio</summary>
      <p class="small"><b>Ollama on Windows:</b> install it from ollama.com. In PowerShell, run <span class="mono">setx OLLAMA_ORIGINS "${esc(o)}"</span>, quit Ollama (its icon by the clock) and open it again, then run <span class="mono">ollama pull qwen2.5:7b</span>.</p>
      <p class="small"><b>Ollama on Linux:</b> run <span class="mono">sudo systemctl edit ollama</span>, add the lines <span class="mono">[Service]</span> and <span class="mono">Environment="OLLAMA_ORIGINS=${esc(o)}"</span>, then <span class="mono">sudo systemctl restart ollama</span> and <span class="mono">ollama pull qwen2.5:7b</span>.</p>
      <p class="small"><b>LM Studio:</b> download a model, for example Qwen2.5 7B Instruct. In the Developer tab, start the server and turn on Enable CORS in its settings. Load the model with a context length of 16384 or more.</p>
    </details>
    <p class="muted small">Chrome or Edge may ask to let this site reach apps on this device. Choose Allow. Safari doesn't allow it at all.</p>`;
}

function modelPicker(at) {
  const p = L.prefs();
  const best = L.best();
  const list = L.models();
  const value = (m) => `${m.server}|${m.id}`;
  const picked = p.model ? `${p.server}|${p.model}` : '';
  const gone = !!picked && !list.some((m) => value(m) === picked);
  const groups = Object.values(L.SERVERS)
    .map((s) => [s, list.filter((m) => m.server === s.id)])
    .filter(([, ms]) => ms.length)
    .map(
      ([s, ms]) =>
        `<optgroup label="${esc(s.name)}">${ms.map((m) => `<option value="${esc(value(m))}" ${value(m) === picked ? 'selected' : ''}>${esc(m.id)}${m.params ? ` (${esc(String(Number(m.params.toFixed(1))))}B)` : ''}</option>`).join('')}</optgroup>`,
    )
    .join('');
  return `<label class="field"><span class="k">Model</span>
      <select id="localModel">
        <option value="" ${picked && !gone ? '' : 'selected'}>Best one here${best ? ` (${esc(best.id)})` : ''}</option>
        ${groups}
      </select>
    </label>
    ${gone ? `<p class="muted small">${esc(p.model)} isn't here now, so ${esc(at.id)} answers.</p>` : ''}
    <p class="muted small">Bigger models answer better but more slowly. Nothing you send leaves this computer.</p>`;
}

// Whether the model may write the memory (life/strength.ts), like a key's in Your AI keys.
function memoryLine(at) {
  const m = L.memoryOf(at.id, at.params);
  if (m === 'strong') return '<p class="muted small">Big enough to write your memory too.</p>';
  if (m === 'weak') return '<p class="muted small">This model is too small to write your memory, so Arise stops learning while you use it. It still answers you.</p>';
  const on = m === 'trusted';
  return `<button class="toggle-row key-trust" data-act="local-trust" aria-pressed="${on}"><span><b>Trust this model to write my memory</b><small>Arise doesn't know ${esc(at.id)}. Only turn this on for a large model: a small one's mistakes would stay in your memory.</small></span><span class="switch ${on ? 'on' : ''}"></span></button>`;
}

export function panel() {
  const at = L.current();
  const looking = L.busy();
  return `<div class="stack own-key" id="localAI">
      ${at ? `${modelPicker(at)}${memoryLine(at)}<details class="other"><summary>Set it up on another computer</summary>${setup()}</details>` : `<p class="small">${esc(help())}</p>${setup()}`}
      <div class="row">
        <button class="btn ghost small" data-act="local-check" ${looking ? 'disabled' : ''}>${looking ? 'Looking…' : 'Check again'}</button>
        <button class="btn ghost small" data-act="local-off">Stop using it</button>
      </div>
    </div>`;
}

// Picking its card: on, and look now (the browser may ask the Player, who just tapped).
export function turnOn() {
  L.setPrefs({ on: true });
  L.check({ asked: true });
}

export async function handleAction(act) {
  switch (act) {
    case 'local-check':
      L.setPrefs({ on: true });
      await L.check({ asked: true });
      return true;
    case 'local-copy':
      try {
        await navigator.clipboard.writeText(command());
        toast('Command copied. Paste it in Terminal.');
      } catch {
        // No clipboard: show the command to copy by hand.
        if (!document.getElementById('localCmd')?.offsetParent) {
          openSheet(`<p class="kicker">${esc(L.NAME)}</p><h2 class="display sheet-title">Set-up command</h2>
            <p>Paste this in Terminal on this Mac and press Return:</p>
            <div class="code-box small" id="localCmdSheet">${esc(command())}</div>
            <button class="btn primary block" data-act="sheet-close">Done</button>`);
        }
        const box = document.getElementById('localCmdSheet') || document.getElementById('localCmd');
        if (box) getSelection()?.selectAllChildren(box);
        toast('Copy the command from the box.');
      }
      return true;
    case 'local-off':
      if (S.state.settings.aiEngine === 'local') {
        S.state.settings.aiEngine = '';
        S.save();
      }
      L.setPrefs({ on: false }); // (Settings is drawn again when it changes)
      toast("Arise won't use the AI on this computer any more.");
      return true;
    case 'local-trust': {
      const at = L.current();
      if (!at) return true;
      const on = L.memoryOf(at.id, at.params) !== 'trusted';
      if (on && !confirm(`Let ${at.id} write your memory? Only do this if it's a large model. You can turn it off again here.`)) return true;
      L.trust(at.id, on);
      return true;
    }
  }
  return false;
}

if (typeof document !== 'undefined') {
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t?.id !== 'localModel') return;
    const i = String(t.value).indexOf('|');
    L.setPrefs(i > 0 ? { server: t.value.slice(0, i), model: t.value.slice(i + 1) } : { server: '', model: '' });
  });
}
