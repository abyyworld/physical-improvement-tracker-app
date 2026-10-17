// Running the linked accounts: syncing each one when the app opens and every few minutes while
// it's open, finishing a sign-in that came back, disconnecting, and deleting what came from one.
//
// Each sync goes straight from this device to the service, picks up where the last one left off
// (the cursors in state.ts), and hands what's new to the life log (sink.ts). Sign-ins stay on this
// device: never synced, never in a backup.

import * as G from './google';
import * as MS from './microsoft';
import * as STEAM from './steam';
import * as PSN from './psn';
import * as IDS from './ids';
import { ConnectError, isNative, nativeHttp } from './http';
import { redirectUri, returnError, takeReturn, cancel as cancelSignIn, type Done } from './oauth';
import { sink, takeAllBack, unwatch, watch } from './sink';
import { SERVICES, blank, load, remove, save, type ServiceId, type SvcState } from './state';

export interface Info {
  name: string;
  reads: string; // what it reads, in one line
  parts?: { id: string; label: string }[];
  unofficial?: boolean;
  gap: number; // between automatic syncs
}

export const INFO: Record<ServiceId, Info> = {
  google: {
    name: 'Google',
    reads: 'Calendar events, and for each email: who wrote, the subject, date, labels and a short preview. Never the whole email.',
    parts: [
      { id: 'calendar', label: 'Calendar' },
      { id: 'mail', label: 'Gmail' },
    ],
    gap: 10 * 60_000,
  },
  microsoft: {
    name: 'Microsoft (Outlook)',
    reads: 'Outlook calendar events, and for each email: who wrote, the subject, date and a short preview. Never the whole email. Work, school or personal accounts.',
    parts: [
      { id: 'calendar', label: 'Calendar' },
      { id: 'mail', label: 'Outlook email' },
    ],
    gap: 10 * 60_000,
  },
  steam: { name: 'Steam', reads: 'Which games you play, and for how long.', gap: STEAM.GAP },
  psn: { name: 'PlayStation', reads: 'Which games you play, for how long, and the trophies you get.', unofficial: true, gap: PSN.GAP },
};

// Whether it can be used here: 'ok', 'setup' (the owner hasn't registered Arise with it yet),
// 'web' (use Arise on the web for it), 'iphone' (the iPhone app only).
export type Where = 'ok' | 'setup' | 'web' | 'iphone';
export function available(id: ServiceId): Where {
  const native = isNative();
  if (id === 'google') return !G.configured() ? 'setup' : native ? 'web' : 'ok';
  if (id === 'microsoft') return !MS.configured() ? 'setup' : native && !nativeHttp() ? 'web' : 'ok';
  return nativeHttp() ? 'ok' : 'iphone';
}

let hooks = { render: () => {}, toast: (_msg: string) => {} };

// The sync running for each account, and the generation it started in.
const running = new Map<ServiceId, { p: Promise<void>; gen: number }>();
// Bumped by signing in, disconnecting and forgetting. A sync still running from before stops at
// its next step (sink.ts, goOn) and can't write its old state back.
const generation: Record<ServiceId, number> = { google: 0, microsoft: 0, steam: 0, psn: 0 };

export const busy = (id: ServiceId) => running.has(id);

// Once the sync running now (if any) has stopped.
const settled = (id: ServiceId) => running.get(id)?.p.catch(() => {});

async function runSync(st: SvcState, id: ServiceId, save: () => void, now: number) {
  const ctx = { save, native: isNative() };
  if (id === 'google') return G.sync(st, ctx, now);
  if (id === 'microsoft') return MS.sync(st, ctx, now);
  if (id === 'steam') return STEAM.sync(st, ctx, now);
  return PSN.sync(st, ctx, now);
}

const AGAIN = "Couldn't sync. Arise will try again later.";

async function run(id: ServiceId, manual: boolean) {
  const gen = generation[id];
  const st = load(id);
  const now = Date.now();
  if (!st.on || available(id) !== 'ok') return;
  if (!manual && (st.needs || st.next > now)) return;
  const alive = () => generation[id] === gen;
  const keep = () => {
    if (alive()) save(id, st);
  };
  watch(id, alive);
  try {
    await sink(); // nothing is fetched until the life log can take it
    await runSync(st, id, keep, now);
    st.last = Date.now();
    st.error = '';
    st.needs = '';
    st.next = 0;
  } catch (e) {
    const err = e instanceof ConnectError ? e : new ConnectError('other', AGAIN);
    if (err.kind === 'tap') {
      st.needs = 'tap';
      st.error = '';
    } else if (err.kind === 'auth') {
      st.needs = 'reconnect';
      st.error = err.message;
    } else if (err.kind === 'rate') {
      st.next = now + Math.max(err.retryAfter, 60_000);
      if (manual) hooks.toast(err.message);
    } else if (err.kind === 'net' || err.kind === 'gone') {
      st.next = now + 5 * 60_000;
      if (manual) hooks.toast(err.message);
    } else {
      st.error = err.message || AGAIN;
      st.next = now + (err.kind === 'private' ? 6 * 3600_000 : 30 * 60_000);
    }
  } finally {
    unwatch(id, alive);
  }
  const n = await IDS.count(id).catch(() => 0);
  st.count = n || st.count;
  keep();
}

// Syncs one account now (`manual`: the Player asked, so a wait or a problem doesn't stop it).
export function syncNow(id: ServiceId, { manual = false } = {}): Promise<void> {
  const already = running.get(id);
  // One that was stopped (a new sign-in since): a fresh one once it has.
  if (already) return already.gen === generation[id] ? already.p : already.p.then(() => syncNow(id, { manual }));
  const gen = generation[id];
  const p = run(id, manual).finally(() => {
    running.delete(id);
    hooks.render();
  });
  running.set(id, { p, gen });
  hooks.render();
  return p;
}

// Every account whose turn it is.
export function syncDue(now = Date.now()) {
  for (const id of SERVICES) {
    const st = load(id);
    if (!st.on || st.needs || st.next > now || running.has(id) || available(id) !== 'ok') continue;
    if (now - st.last >= INFO[id].gap) syncNow(id);
  }
}

// ---------- signing in

// A Google or Microsoft sign-in that came back (pop-up or whole page). True when it linked.
export async function finish(done: Done): Promise<boolean> {
  const { pending, params } = done;
  const id = pending.service;
  const problem = returnError(params);
  if (problem) {
    hooks.toast(problem);
    return false;
  }
  const st = load(id);
  try {
    if (id === 'google') {
      const t = G.readToken(params, pending.parts.length ? pending.parts : ['calendar', 'mail']);
      st.auth = { token: t.token, expires: t.expires };
      st.parts = t.parts;
    } else if (id === 'microsoft') {
      const code = params.get('code');
      if (!code || !pending.verifier) throw new ConnectError('auth', "The sign-in didn't work. Try again.");
      st.parts = pending.parts.length ? pending.parts : ['calendar', 'mail'];
      await MS.redeem(st, code, pending.verifier, redirectUri(), st.parts);
    } else return false;
  } catch (e) {
    hooks.toast(e instanceof ConnectError ? e.message : "The sign-in didn't work. Try again.");
    return false;
  }
  // Who signed in is checked on the next sync: another account than before starts afresh.
  st.account = '';
  const again = st.on;
  st.on = true;
  st.needs = '';
  st.error = '';
  st.next = 0;
  generation[id]++;
  save(id, st);
  hooks.toast(again ? `${INFO[id].name}: signed in again. Syncing…` : `${INFO[id].name} is linked. Getting your data…`);
  syncNow(id, { manual: true });
  return true;
}

// Saves a sign-in made in the app itself (Microsoft's device code, Steam, PlayStation) and syncs.
export function linked(id: ServiceId, st: SvcState) {
  st.on = true;
  st.needs = '';
  st.error = '';
  st.next = 0;
  generation[id]++;
  save(id, st);
  syncNow(id, { manual: true });
}

// ---------- disconnecting and deleting

// Stops it: the sign-in and where each sync was are forgotten. What it already gave stays in the
// life log until the Player deletes it. A sync running then stops at its next step; what it
// handed over until then is counted too, so "Delete what Arise got from it" can take it back.
export async function disconnect(id: ServiceId): Promise<void> {
  const gen = ++generation[id];
  const st = load(id);
  if (id === 'google' && st.auth.token) G.revoke(st.auth.token);
  save(id, { ...blank(), count: st.count });
  hooks.render();
  await settled(id);
  const n = await IDS.count(id).catch(() => 0);
  const off = load(id);
  if (generation[id] !== gen || !n || n === off.count) return;
  off.count = n;
  save(id, off);
  hooks.render();
}

// Takes everything that came from it back out of the life log. 'later' when the life log
// can't remove things yet. A sync running now finishes (or stops) first, so nothing it hands
// over is missed.
export async function deleteData(id: ServiceId): Promise<'done' | 'later'> {
  await settled(id);
  if (!(await takeAllBack(id))) return 'later';
  const st = load(id);
  st.count = 0;
  save(id, st);
  hooks.render();
  return 'done';
}

// The data on this device going ("Erase all data", signing out with the data removed, or another
// account's data taking its place): every sign-in goes, at once. The list of what came from each
// is forgotten once the syncs running then have stopped (so none of them adds to it after).
export async function forgetAll() {
  cancelSignIn();
  const stopping: Promise<void>[] = [];
  for (const id of SERVICES) {
    generation[id]++;
    const st = load(id);
    if (id === 'google' && st.auth.token) G.revoke(st.auth.token);
    remove(id);
    const s = settled(id);
    if (s) stopping.push(s);
  }
  hooks.render();
  await Promise.all(stopping);
  for (const id of SERVICES) await IDS.forget(id).catch(() => {});
  hooks.render();
}

// ---------- start

let started = false;

export function initEngine(h: Partial<typeof hooks> = {}) {
  hooks = { ...hooks, ...h };
  if (started) return;
  started = true;
  // A sign-in that came back to this page (the whole page went to Google or Microsoft).
  const done = takeReturn();
  if (done) finish(done);
  setTimeout(() => syncDue(), 3000);
  setInterval(() => {
    if (document.visibilityState !== 'hidden') syncDue();
  }, 5 * 60_000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncDue();
  });
}
