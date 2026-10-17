// What this device knows about each linked account: its sign-in, where each sync left off, and
// what the Player sees in Settings. Kept in localStorage on this device only: never synced, never
// in a backup, and gone with "Erase all data". Like everything read from storage, it's rebuilt
// field by field on the way in (see clean), so a bad value can't break the app.

export type ServiceId = 'google' | 'microsoft' | 'steam' | 'psn';
export const SERVICES: readonly ServiceId[] = ['google', 'microsoft', 'steam', 'psn'];

export interface Auth {
  token?: string; // an access token, or Steam's API key
  expires?: number; // when the access token runs out (ms)
  refresh?: string; // a refresh token (Microsoft, PlayStation)
  refreshExpires?: number;
}

export interface SvcState {
  on: boolean; // connected
  account: string; // shown to the Player: an email, a Steam name…
  user: string; // the service's id for them (a SteamID), or a sign-in hint (an email)
  auth: Auth;
  parts: string[]; // which parts they chose: 'calendar', 'mail'
  cursors: Record<string, string>; // where each part's sync left off
  snap: Record<string, number>; // play time per game at the last look (Steam, PlayStation), in minutes
  last: number; // the last sync that worked
  next: number; // no automatic sync before this (after "too many requests")
  count: number; // how many things Arise got from it, on this device
  needs: '' | 'tap' | 'reconnect';
  error: string;
}

export const blank = (): SvcState => ({ on: false, account: '', user: '', auth: {}, parts: [], cursors: {}, snap: {}, last: 0, next: 0, count: 0, needs: '', error: '' });

const KEY = (id: ServiceId) => `arise-connect-${id}`;
const PARTS = ['calendar', 'mail'];

const o = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const s = (v: unknown, max: number) => (typeof v === 'string' && v.length <= max && !/[\u0000-\u001f]/.test(v) ? v : '');
const t = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 8.64e15 ? Math.round(v) : 0);

export function clean(raw: unknown): SvcState {
  const r = o(raw);
  const a = o(r.auth);
  const auth: Auth = {};
  if (s(a.token, 8000)) auth.token = a.token as string;
  if (t(a.expires)) auth.expires = t(a.expires);
  if (s(a.refresh, 8000)) auth.refresh = a.refresh as string;
  if (t(a.refreshExpires)) auth.refreshExpires = t(a.refreshExpires);
  const cursors: Record<string, string> = {};
  for (const [k, v] of Object.entries(o(r.cursors)).slice(0, 60)) if (/^[\w:.-]{1,64}$/.test(k) && s(v, 8000)) cursors[k] = v as string;
  const snap: Record<string, number> = {};
  for (const [k, v] of Object.entries(o(r.snap)).slice(0, 5000)) if (/^[\w:.-]{1,64}$/.test(k) && typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1e9) snap[k] = Math.round(v);
  return {
    on: r.on === true,
    account: s(r.account, 200),
    user: s(r.user, 200),
    auth,
    parts: Array.isArray(r.parts) ? [...new Set(r.parts.filter((p): p is string => PARTS.includes(p as string)))] : [],
    cursors,
    snap,
    last: t(r.last),
    next: t(r.next),
    count: typeof r.count === 'number' && Number.isFinite(r.count) && r.count > 0 ? Math.min(Math.round(r.count), 1e9) : 0,
    needs: r.needs === 'tap' || r.needs === 'reconnect' ? r.needs : '',
    error: s(r.error, 300),
  };
}

export function load(id: ServiceId): SvcState {
  try {
    return clean(JSON.parse(localStorage.getItem(KEY(id)) || 'null'));
  } catch {
    return blank();
  }
}

export function save(id: ServiceId, st: SvcState) {
  try {
    localStorage.setItem(KEY(id), JSON.stringify(st));
  } catch {}
}

export function remove(id: ServiceId) {
  try {
    localStorage.removeItem(KEY(id));
  } catch {}
}
