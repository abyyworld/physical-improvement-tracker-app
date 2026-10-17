// Runs only on Arise's own pages. It passes messages between the page and the extension, and
// nothing else: it never reads the page.

import { api } from './api';
import { NS, parsePush } from './lib/pairing';

window.addEventListener('message', (e: MessageEvent) => {
  if (e.source !== window || e.origin !== location.origin) return;
  const d = e.data as { ns?: string; from?: string; id?: string; msg?: unknown };
  if (!d || d.ns !== NS || d.from !== 'page' || typeof d.id !== 'string') return;
  const id = d.id;
  api.runtime.sendMessage({ ns: NS, msg: d.msg }).then(
    (reply) => window.postMessage({ ns: NS, from: 'ext', re: id, reply }, location.origin),
    // The extension was updated or removed: this page has to reload to reach it again.
    () => window.postMessage({ ns: NS, from: 'ext', re: id, reply: { ok: false, error: 'gone' } }, location.origin),
  );
});

api.runtime.onMessage.addListener((m) => {
  const push = parsePush((m as { ns?: string; push?: unknown })?.ns === NS ? (m as { push?: unknown }).push : null);
  if (push) window.postMessage({ ns: NS, from: 'ext', push }, location.origin);
});

// Tells a page that's already listening that the extension is here.
window.postMessage({ ns: NS, from: 'ext', push: { t: 'here' } }, location.origin);
