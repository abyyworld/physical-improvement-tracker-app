// Steam: which games the Player plays and for how long, with Steam's official Web API, a key they
// make themselves (steamcommunity.com/dev/apikey) and their SteamID.
//
// Steam's API doesn't allow requests from web pages (no CORS), so this works in the iPhone app
// only, through its own HTTP. Steam only tells total play time per game, so Arise takes a
// snapshot when it syncs (every few hours, at least once a day when the app is opened) and turns
// the difference into "Played Hades for 2 h". When first connected, it adds the last 2 weeks,
// which Steam keeps per game.

import type { LifeEvent } from '../life/types';
import { ConnectError, arr, obj, request, retryAfter, text, type Res } from './http';
import { hand } from './sink';
import type { SvcState } from './state';

const API = 'https://api.steampowered.com';
export const GAP = 3 * 3600_000;

export interface Ctx {
  save(): void;
}

export const validKey = (k: string) => /^[0-9A-F]{32}$/i.test(k.trim());

function steamError(res: Res): ConnectError {
  if (res.status === 401 || res.status === 403) return new ConnectError('auth', 'Steam said no to this key. Check it and connect again.', 0, res.status);
  if (res.status === 429) return new ConnectError('rate', 'Steam is busy. Arise will try again later.', retryAfter(res), 429);
  if (res.status >= 500 || res.status === 0) return new ConnectError('net', "Steam didn't answer. Arise will try again later.", 0, res.status);
  return new ConnectError('other', `Steam said no (${res.status}).`, 0, res.status);
}

async function api(path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await request({ url: `${API}/${path}?${new URLSearchParams({ ...params, format: 'json' })}` });
  if (res.status === 200) return obj(obj(res.data).response);
  throw steamError(res);
}

// A SteamID64, a profile link (…/profiles/7656…, …/id/name) or a custom profile name → SteamID64.
export async function resolveProfile(key: string, input: string): Promise<string> {
  const v = input.trim();
  const id = /^(\d{17})$/.exec(v) || /steamcommunity\.com\/profiles\/(\d{17})/.exec(v);
  if (id) return id[1];
  const vanity = (/steamcommunity\.com\/id\/([^/?#\s]+)/.exec(v) || [])[1] || (/^[\w-]{2,32}$/.test(v) ? v : '');
  if (!vanity) throw new ConnectError('other', "That doesn't look like a Steam profile. Paste its link.");
  const r = await api('ISteamUser/ResolveVanityURL/v1/', { key, vanityurl: vanity });
  if (r.success === 1 && typeof r.steamid === 'string' && /^\d{17}$/.test(r.steamid)) return r.steamid;
  throw new ConnectError('other', "Steam doesn't know that profile. Paste its link.");
}

export async function playerName(key: string, steamid: string): Promise<string> {
  const r = await api('ISteamUser/GetPlayerSummaries/v2/', { key, steamids: steamid });
  return text(obj(arr(r.players)[0]).personaname, 64);
}

interface Game {
  appid: number;
  name: string;
  forever: number; // minutes
  weeks2: number;
  last: number; // ms, when last played (0: not known)
}

const games = (list: unknown): Game[] =>
  arr(list)
    .map(obj)
    .filter((g) => Number.isInteger(g.appid) && (g.appid as number) > 0)
    .map((g) => ({
      appid: g.appid as number,
      name: text(g.name, 120) || `Game ${g.appid}`,
      forever: Math.max(0, Number(g.playtime_forever) || 0),
      weeks2: Math.max(0, Number(g.playtime_2weeks) || 0),
      last: Number(g.rtime_last_played) > 0 ? Number(g.rtime_last_played) * 1000 : 0,
    }));

export const hours = (min: number) => (min < 60 ? `${Math.max(1, Math.round(min))} min` : `${Math.round((min / 60) * 10) / 10} h`);

const play = (id: string, name: string, minutes: number, end: number, extra: Record<string, string | number | boolean> = {}): LifeEvent => ({
  id,
  source: 'steam',
  kind: 'play',
  at: end - minutes * 60_000,
  end,
  title: `Played ${name} for ${hours(minutes)}`,
  value: minutes,
  unit: 'min',
  tier: 2,
  meta: { app: 'steam', game: name, approx: true, ...extra },
});

// What changed since the last snapshot, as life events. The first time (no snapshot), the last
// two weeks per game instead.
export function playEvents(list: Game[], snap: Record<string, number>, first: boolean, now: number): LifeEvent[] {
  const out: LifeEvent[] = [];
  for (const g of list) {
    if (first) {
      if (g.weeks2 > 0) out.push(play(`steam:${g.appid}:2w${Math.floor(now / 86_400_000)}`, g.name, g.weeks2, g.last || now, { appid: g.appid, span: '2 weeks' }));
      continue;
    }
    const before = snap[String(g.appid)] ?? 0;
    const more = g.forever - before;
    if (more <= 0) continue;
    const end = g.last && g.last <= now ? g.last : now;
    out.push(play(`steam:${g.appid}:${Math.floor(end / 1000)}`, g.name, more, end, { appid: g.appid }));
  }
  return out;
}

export async function sync(st: SvcState, ctx: Ctx, now = Date.now()) {
  const key = st.auth.token || '';
  const steamid = st.user;
  if (!validKey(key) || !/^\d{17}$/.test(steamid)) throw new ConnectError('auth', 'Connect Steam again.');
  const r = await api('IPlayerService/GetOwnedGames/v1/', { key, steamid, include_appinfo: '1', include_played_free_games: '1', skip_unvetted_apps: '0' });
  // A private profile answers with nothing at all.
  if (!('games' in r) && !('game_count' in r)) throw new ConnectError('private', "Steam doesn't share your games. In Steam, set Game details to Public.");
  const list = games(r.games);
  const first = !Object.keys(st.snap).length && !st.last;
  let recent = list;
  if (first) {
    // The two-week totals come with recently played games.
    const rr = await api('IPlayerService/GetRecentlyPlayedGames/v1/', { key, steamid, count: '0' });
    const lastOf = new Map(list.map((g) => [g.appid, g.last]));
    recent = games(rr.games).map((g) => ({ ...g, last: lastOf.get(g.appid) || g.last }));
  }
  await hand('steam', playEvents(recent, st.snap, first, now));
  const snap: Record<string, number> = {};
  for (const g of list) if (g.forever > 0) snap[String(g.appid)] = g.forever;
  st.snap = snap;
  ctx.save();
}
