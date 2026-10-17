// PlayStation: which games the Player plays, for how long, and the trophies they get.
//
// Unofficial. Sony has no public API for this; Arise talks to the same servers the PlayStation
// App uses, the way the open-source psn-api library does (github.com/achievements-app/psn-api).
// Sony could block it at any time, and the app says so.
//
// The Player signs in on playstation.com, copies a code from Sony's page (the "NPSSO") and pastes
// it into Arise. Arise swaps it for its own sign-in right away and doesn't keep the code. That
// sign-in lasts about two months; then they paste a new code. Sony's servers don't allow web
// pages to call them, so this is in the iPhone app only, through its own HTTP.

import type { LifeEvent } from '../life/types';
import { ConnectError, arr, form, obj, request, retryAfter, text, type Res } from './http';
import { hand } from './sink';
import { hours } from './steam';
import type { SvcState } from './state';

const AUTH = 'https://ca.account.sony.com/api/authz/v3/oauth';
// The PlayStation App's own client, as psn-api uses it.
const CLIENT = '09515159-7237-4370-9b40-3806e67c0891';
const BASIC = 'Basic MDk1MTUxNTktNzIzNy00MzcwLTliNDAtMzgwNmU2N2MwODkxOnVjUGprYTV0bnRCMktxc1A=';
const REDIRECT = 'com.scee.psxandroid.scecompcall://redirect';
const SCOPE = 'psn:mobile.v2.core psn:clientapp';
const M = 'https://m.np.playstation.com/api';
export const GAP = 3 * 3600_000;
const DAY = 86_400_000;
export const BACK = 90 * DAY;
const TITLES_RUN = 8; // games whose trophies are looked at per sync

export const CODE_PAGE = 'https://ca.account.sony.com/api/v1/ssocookie';
export const SIGN_IN_PAGE = 'https://www.playstation.com/';

export interface Ctx {
  save(): void;
}

export const validNpsso = (v: string) => /^[A-Za-z0-9]{64}$/.test(v.trim());
// People paste the whole {"npsso":"…"} answer too.
export const npssoFrom = (v: string) => (/"npsso"\s*:\s*"([A-Za-z0-9]{64})"/.exec(v) || [])[1] || v.trim();

const EXPIRED = 'PlayStation signed Arise out. Paste a new code to connect again.';

function sonyError(res: Res): ConnectError {
  if (res.status === 401 || res.status === 403) return new ConnectError('auth', EXPIRED, 0, res.status);
  if (res.status === 429) return new ConnectError('rate', 'PlayStation is busy. Arise will try again later.', retryAfter(res), 429);
  if (res.status >= 500 || res.status === 0) return new ConnectError('net', "PlayStation didn't answer. Arise will try again later.", 0, res.status);
  return new ConnectError('other', `PlayStation said no (${res.status}).`, 0, res.status);
}

const keep = (st: SvcState, data: unknown, now: number) => {
  const d = obj(data);
  if (typeof d.access_token !== 'string' || !d.access_token) throw new ConnectError('auth', EXPIRED);
  st.auth.token = d.access_token;
  st.auth.expires = now + (Number(d.expires_in) > 0 ? Number(d.expires_in) : 3600) * 1000;
  if (typeof d.refresh_token === 'string' && d.refresh_token) {
    st.auth.refresh = d.refresh_token;
    st.auth.refreshExpires = now + (Number(d.refresh_token_expires_in) > 0 ? Number(d.refresh_token_expires_in) : 60 * 86400) * 1000;
  }
};

async function tokenRequest(body: Record<string, string>): Promise<unknown> {
  const res = await request({ url: `${AUTH}/token`, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: BASIC }, body: form(body) });
  if (res.status === 200) return res.data;
  if (res.status === 400) throw new ConnectError('auth', EXPIRED, 0, 400);
  throw sonyError(res);
}

// The pasted code → Arise's own sign-in (the code itself isn't kept).
export async function signIn(st: SvcState, npsso: string, now = Date.now()) {
  const q = new URLSearchParams({ access_type: 'offline', client_id: CLIENT, redirect_uri: REDIRECT, response_type: 'code', scope: SCOPE });
  const res = await request({ url: `${AUTH}/authorize?${q}`, headers: { Cookie: `npsso=${npsso.trim()}` }, noRedirect: true });
  const loc = res.headers.location || '';
  const code = /[?&]code=([^&]+)/.exec(loc)?.[1];
  if (!code) {
    if (res.status >= 500 || res.status === 0 || res.status === 429) throw sonyError(res);
    throw new ConnectError('auth', "PlayStation didn't take that code. Get a new one and try again.");
  }
  keep(st, await tokenRequest({ code: decodeURIComponent(code), redirect_uri: REDIRECT, grant_type: 'authorization_code', token_format: 'jwt' }), now);
}

async function refresh(st: SvcState, ctx: Ctx, now: number) {
  if (!st.auth.refresh || (st.auth.refreshExpires && st.auth.refreshExpires < now)) throw new ConnectError('auth', EXPIRED);
  keep(st, await tokenRequest({ refresh_token: st.auth.refresh, grant_type: 'refresh_token', token_format: 'jwt', scope: SCOPE }), now);
  ctx.save();
}

async function api(st: SvcState, ctx: Ctx, url: string, now: number): Promise<Record<string, unknown>> {
  if (!st.auth.token || (st.auth.expires || 0) - 60_000 < now) await refresh(st, ctx, now);
  const res = await request({ url, headers: { Authorization: `Bearer ${st.auth.token}`, 'Content-Type': 'application/json' } });
  if (res.status === 200) return obj(res.data);
  throw sonyError(res);
}

// "PT228H56M33S" → minutes
export function minutes(iso: unknown): number {
  const m = typeof iso === 'string' ? /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(iso) : null;
  if (!m) return 0;
  return Number(m[1] || 0) * 1440 + Number(m[2] || 0) * 60 + Number(m[3] || 0) + Number(m[4] || 0) / 60;
}


const safeId = (v: unknown, max = 60) => (typeof v === 'string' && v.length <= max && /^[\w.-]+$/.test(v) ? v : '');

interface Title {
  id: string;
  name: string;
  played: number; // minutes, all time
  last: number; // ms
}

export const titles = (data: unknown): Title[] =>
  arr(obj(data).titles)
    .map(obj)
    .map((t) => ({ id: safeId(t.titleId), name: text(t.localizedName || t.name, 120), played: Math.floor(minutes(t.playDuration)), last: Date.parse(String(t.lastPlayedDateTime || '')) || 0 }))
    .filter((t) => t.id && t.name);

// Play time since the last snapshot, as life events. The first time, a "Played X" for each game
// played in the last 90 days (without a duration: Sony only tells the total).
export function playEvents(list: Title[], snap: Record<string, number>, first: boolean, now: number): LifeEvent[] {
  const out: LifeEvent[] = [];
  for (const t of list) {
    if (!t.last || t.last > now + DAY) continue;
    if (first) {
      if (t.last >= now - BACK) out.push({ id: `psn:${t.id}:${Math.floor(t.last / 1000)}`, source: 'psn', kind: 'play', at: t.last, title: `Played ${t.name}`, tier: 2, meta: { app: 'playstation', game: t.name } });
      continue;
    }
    const more = t.played - (snap[t.id] ?? 0);
    if (more <= 0) continue;
    out.push({
      id: `psn:${t.id}:${Math.floor(t.last / 1000)}`,
      source: 'psn',
      kind: 'play',
      at: t.last - more * 60_000,
      end: t.last,
      title: `Played ${t.name} for ${hours(more)}`,
      value: more,
      unit: 'min',
      tier: 2,
      meta: { app: 'playstation', game: t.name, approx: true },
    });
  }
  return out;
}

const TYPES: Record<string, string> = { bronze: 'Bronze', silver: 'Silver', gold: 'Gold', platinum: 'Platinum' };

// The trophies the Player earned in one game since `since`, named from the game's trophy list.
export function trophyEvents(game: { id: string; name: string }, earned: unknown, names: unknown, since: number): LifeEvent[] {
  const nameOf = new Map(arr(obj(names).trophies).map(obj).map((t) => [Number(t.trophyId), text(t.trophyName, 120)]));
  const out: LifeEvent[] = [];
  for (const t of arr(obj(earned).trophies).map(obj)) {
    if (t.earned !== true || !Number.isInteger(t.trophyId)) continue;
    const at = Date.parse(String(t.earnedDateTime || ''));
    if (!Number.isFinite(at) || at < since) continue;
    const type = TYPES[String(t.trophyType)] || 'A';
    const name = nameOf.get(t.trophyId as number) || 'a trophy';
    out.push({
      id: `psn:trophy:${game.id}:${t.trophyId}`,
      source: 'psn',
      kind: 'play',
      at,
      title: `${type} trophy in ${game.name}: ${name}`,
      tier: 2,
      meta: { app: 'playstation', game: game.name, trophy: name, type: String(t.trophyType || '') },
    });
  }
  return out;
}

async function syncTrophies(st: SvcState, ctx: Ctx, now: number) {
  const since = Number(st.cursors['trophy.since']) || now - BACK;
  const data = await api(st, ctx, `${M}/trophy/v1/users/me/trophyTitles?limit=50`, now);
  const changed = arr(data.trophyTitles)
    .map(obj)
    .map((t) => ({ id: safeId(t.npCommunicationId), name: text(t.trophyTitleName, 120), service: t.npServiceName === 'trophy' ? 'trophy' : 'trophy2', at: Date.parse(String(t.lastUpdatedDateTime || '')) || 0 }))
    .filter((t) => t.id && t.name && t.at > since)
    .sort((a, b) => a.at - b.at)
    .slice(0, TITLES_RUN);
  let upTo = since;
  for (const g of changed) {
    const q = `npServiceName=${g.service}`;
    const earned = await api(st, ctx, `${M}/trophy/v1/users/me/npCommunicationIds/${g.id}/trophyGroups/all/trophies?${q}`, now);
    const names = await api(st, ctx, `${M}/trophy/v1/npCommunicationIds/${g.id}/trophyGroups/all/trophies?${q}`, now);
    await hand('psn', trophyEvents(g, earned, names, since));
    upTo = Math.max(upTo, g.at);
    st.cursors['trophy.since'] = String(upTo);
    ctx.save();
  }
}

export async function sync(st: SvcState, ctx: Ctx, now = Date.now()) {
  const data = await api(st, ctx, `${M}/gamelist/v2/users/me/titles?categories=ps4_game,ps5_native_game&limit=200&offset=0`, now);
  const list = titles(data);
  const first = !st.last;
  await hand('psn', playEvents(list, st.snap, first, now));
  const snap: Record<string, number> = {};
  for (const t of list) if (t.played > 0) snap[t.id] = t.played;
  st.snap = snap;
  ctx.save();
  await syncTrophies(st, ctx, now);
}
