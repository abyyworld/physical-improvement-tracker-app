// Arise Private: the paid plan for the private AI ($5 a month or $48 a year, sold by Lemon Squeezy).
//
// Everybody signed in gets a few private AI questions a day for free; Arise Private gives them the
// private AI all day. The AI proxy knows which plan an account has (worker/ai-proxy, /v1/plan) and
// counts the questions. The app asks it when it starts, once a day, from Settings and after the
// Player comes back from the checkout, and keeps the answer on this device only (never synced or
// in backups), so it can say so offline.
//
// Work nobody asked for just now (the daily message, the memory, the AI journal) only uses the
// private AI with Arise Private (see `allDay` and ai.js, engine), so the free questions are the
// Player's own.

import { PRIVATE_AI } from './ai-config';

export interface PlanInfo {
  plan: 'private' | 'free';
  left: number; // private AI questions left today
  limit: number; // of how many
  renewsAt: string; // ISO dates from Lemon Squeezy, or ''
  endsAt: string; // set once it's cancelled: it lasts until then
  portal: string; // where the Player manages their subscription
  checkout: { monthly: string; yearly: string }; // empty until it's on sale
}

// What this device knows, for one account. `off`: the proxy has no plans (an older proxy, before
// Arise Private): everybody has the private AI all day, as before.
type Saved = { uid: string; at: number } & ({ off: true } | ({ off?: undefined } & PlanInfo));

const KEY = 'arise-plan';
const DAY = 24 * 3600 * 1000;
export const FREE_QUESTIONS = 5;

interface Account {
  uid: () => string | null; // the account signed in now (and unlocked), or null
  email: () => string; // its email, for the checkout to fill in ('' for an account code)
  idToken: () => Promise<string | null>;
}
let account: Account = { uid: () => null, email: () => '', idToken: async () => null };
export function connectPlan(a: Account) {
  account = a;
}

const watchers = new Set<() => void>();
export function onPlanChange(cb: () => void): () => void {
  watchers.add(cb);
  return () => watchers.delete(cb);
}
function changed() {
  for (const cb of [...watchers]) {
    try {
      cb();
    } catch {}
  }
}

const date = (v: unknown) => (typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v)) ? v : '');
const https = (v: unknown) => (typeof v === 'string' && v.length <= 2000 && /^https:\/\/\S+$/.test(v) ? v : '');
const count = (v: unknown, max: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(max, Math.floor(v))) : 0);

// What the proxy says (or this device saved), checked like everything else the app reads.
export function cleanInfo(raw: unknown): PlanInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.plan !== 'private' && r.plan !== 'free') return null;
  const limit = count(r.limit, 100000);
  const c = (r.checkout && typeof r.checkout === 'object' ? r.checkout : {}) as Record<string, unknown>;
  return { plan: r.plan, left: Math.min(count(r.left, 100000), limit), limit, renewsAt: date(r.renewsAt), endsAt: date(r.endsAt), portal: https(r.portal), checkout: { monthly: https(c.monthly), yearly: https(c.yearly) } };
}

function read(): Saved | null {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!s || typeof s !== 'object' || typeof s.uid !== 'string' || typeof s.at !== 'number') return null;
    if (s.off === true) return { uid: s.uid, at: s.at, off: true };
    const info = cleanInfo(s);
    return info ? { uid: s.uid, at: s.at, ...info } : null;
  } catch {
    return null;
  }
}

function write(s: Saved | null) {
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch {}
}

const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10);

// What this device knows for the account signed in now, or null when it doesn't know yet.
// The count of questions left starts again at midnight UTC, like the proxy's. Arise Private that
// has reached its end isn't known any more, so the app asks again (see checkPlan).
function current(now = Date.now()): Saved | null {
  const uid = account.uid();
  const s = read();
  if (!uid || !s || s.uid !== uid) return null;
  if (s.off) return s;
  if (s.plan === 'private' && s.endsAt && Date.parse(s.endsAt) <= now) return null;
  if (utcDay(s.at) !== utcDay(now)) return { ...s, left: s.limit };
  return s;
}

// The account's plan, or null when it isn't known (yet), or the proxy has no plans.
export function plan(): PlanInfo | null {
  const s = current();
  return s && !s.off ? s : null;
}

// Whether the private AI may answer all day here: with Arise Private, or while the proxy has no
// plans. Not yet known counts as no, so nothing is used up before the app knows. Only what the
// proxy said today (UTC) counts: since then the plan may have ended, or the proxy got plans, and
// work nobody asked for would use up the day's free questions.
export function allDay(now = Date.now()): boolean {
  const s = current(now);
  return !!s && (s.off === true || s.plan === 'private') && utcDay(s.at) === utcDay(now);
}

// What the proxy says about plans, for the words about the private AI's cost: 'off' when it has
// none (the private AI all day for everybody), 'soon' before Arise Private is on sale, 'free' or
// 'private' for the account's plan, or null when it isn't known yet.
export function offer(): 'off' | 'soon' | 'free' | 'private' | null {
  const s = current();
  if (!s) return null;
  if (s.off) return 'off';
  if (s.plan === 'private') return 'private';
  return s.checkout.monthly || s.checkout.yearly ? 'free' : 'soon';
}

// Known to be on the free plan.
export const onFree = () => plan()?.plan === 'free';

// ---------- asking the proxy

let asking: Promise<PlanInfo | null> | null = null;
let lastTry = 0;
let seen = ''; // the account asked about since the app started

// Asks the proxy now. Keeps what it knew if the proxy can't be reached.
export function refreshPlan(): Promise<PlanInfo | null> {
  if (!asking) {
    asking = ask().finally(() => {
      asking = null;
    });
  }
  return asking;
}

async function ask(): Promise<PlanInfo | null> {
  const uid = account.uid();
  if (!uid || !PRIVATE_AI.proxy) return null;
  lastTry = Date.now();
  seen = uid;
  let res: Response;
  try {
    const token = await account.idToken();
    if (!token) return plan();
    res = await fetch(new URL('plan', PRIVATE_AI.proxy).toString(), { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' });
  } catch {
    return plan();
  }
  if (account.uid() !== uid) return null; // signed out, or another account, meanwhile
  // An older proxy, from before Arise Private: no plans, the private AI all day as before.
  if (res.status === 404) {
    write({ uid, at: Date.now(), off: true });
    changed();
    return null;
  }
  if (!res.ok) return plan();
  const info = cleanInfo(await res.json().catch(() => null));
  if (!info) return plan();
  write({ uid, at: Date.now(), ...info });
  changed();
  return info;
}

// Asks again when what this device knows is older than `maxAge` or from an earlier day (UTC), or
// the plan has reached its end, and always the first time after the app starts or another account
// signs in. Never more than twice a minute.
export function checkPlan(maxAge = DAY) {
  const uid = account.uid();
  if (!uid || !PRIVATE_AI.proxy || asking || Date.now() - lastTry < 30_000) return;
  const s = current();
  if (seen === uid && s && Date.now() - s.at < maxAge && utcDay(s.at) === utcDay(Date.now())) return;
  refreshPlan().catch(() => {});
}

// ---------- what the private AI's answers say

// One private question answered: one fewer left today (the proxy keeps the real count).
export function usedOne() {
  const s = current();
  if (!s || s.off) return;
  write({ ...s, left: Math.max(0, s.left - 1) });
}

// The proxy said today's free private questions are used up. Its words, so the app can tell this
// error apart from others wherever it shows it.
const limitWords = new Set<string>();
export async function usedUp(message: string): Promise<void> {
  limitWords.add(message);
  const s = current();
  if (s && !s.off) {
    write({ ...s, plan: 'free', left: 0 });
    changed();
    return;
  }
  // Not known here yet (or the proxy has plans now): ask, so the message can offer the plan. Not
  // for long: the message matters more.
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([refreshPlan().catch(() => null), new Promise((ok) => (timer = setTimeout(ok, 5000)))]);
  clearTimeout(timer);
  changed();
}
export const isUsedUp = (message: unknown) => typeof message === 'string' && [...limitWords].some((m) => message.includes(m));

// ---------- buying it

// The checkout link for one of the two, with the account it's for (and its email, to save typing).
// Lemon Squeezy hands the account id back to the proxy with the subscription.
export function checkoutUrl(which: 'monthly' | 'yearly'): string {
  const base = plan()?.checkout[which];
  const uid = account.uid();
  if (!base || !uid) return '';
  try {
    const u = new URL(base);
    if (u.protocol !== 'https:') return '';
    u.searchParams.set('checkout[custom][uid]', uid);
    const email = account.email();
    if (email) u.searchParams.set('checkout[email]', email);
    return u.toString();
  } catch {
    return '';
  }
}

// The Player opened the checkout. When they come back to Arise, it asks the proxy a few times: the
// payment can take a few seconds to reach it.
let checkoutAt = 0;
let backAt = 0;
export function openedCheckout() {
  checkoutAt = Date.now();
}
export function cameBack() {
  const now = Date.now();
  if (!checkoutAt || now - checkoutAt > 2 * 3600 * 1000 || now - backAt < 60_000) return;
  backAt = now;
  for (const ms of [0, 5000, 20000, 60000]) {
    setTimeout(() => {
      if (plan()?.plan !== 'private') refreshPlan().catch(() => {});
    }, ms);
  }
}

// Forgets it (Erase all data).
export function forgetPlan() {
  write(null);
  seen = '';
}
