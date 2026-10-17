// A sign-in coming back from Google or Microsoft to Arise's own address, with a token or a code
// in the # part. main.ts checks for it before the app starts. Kept tiny and on its own, since the
// sign-in pop-up runs only this, not the app.
//
// The token or code is taken out of the address bar straight away, and handed to the waiting app
// through this device's storage: never sent anywhere (the part after # never reaches a server).

export const PENDING = 'arise-connect-pending';
export const RETURN = 'arise-connect-return';
export const CHANNEL = 'arise-connect';

export interface Back {
  state: string;
  params: string;
  at: number;
}

// The # part has a state plus a token, a code or an error.
export function isOAuthReturn(hash: string): boolean {
  if (!hash.startsWith('#')) return false;
  const p = new URLSearchParams(hash.slice(1));
  return !!p.get('state') && (p.has('access_token') || p.has('code') || p.has('error'));
}

// True when this window was only the sign-in pop-up: it passes the answer on and closes, and
// the app doesn't start in it.
export function handleOAuthReturn(): boolean {
  if (!isOAuthReturn(location.hash)) return false;
  const params = location.hash.slice(1);
  const state = new URLSearchParams(params).get('state') || '';
  history.replaceState(null, '', `${location.pathname}${location.search}#settings`);
  let pending: { state?: string; mode?: string } | null = null;
  try {
    pending = JSON.parse(localStorage.getItem(PENDING) || 'null');
  } catch {}
  // Not a sign-in this device started: ignored, and the app starts as usual.
  if (!pending || pending.state !== state) return false;
  const back: Back = { state, params, at: Date.now() };
  try {
    localStorage.setItem(RETURN, JSON.stringify(back));
  } catch {}
  if (pending.mode !== 'popup') return false; // the app picks it up as it starts (see connect/index.ts)
  try {
    const ch = new BroadcastChannel(CHANNEL);
    ch.postMessage(back);
    ch.close();
  } catch {}
  window.close();
  // Some browsers keep the window open (the sign-in page cut it off from Arise).
  const app = document.getElementById('app');
  if (app) app.innerHTML = '<section class="panel"><p>Done. You can close this window and go back to Arise.</p></section>';
  return true;
}
