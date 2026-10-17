// @vitest-environment jsdom
// Steam (official Web API, the Player's own key) and PlayStation (unofficial, the PlayStation
// App's servers), both through the iPhone app's own HTTP: play time snapshots turned into "Played
// X for 2 h", trophies with when they were earned, and the sign-in and its renewal.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeNet, useNative, type Net } from '../test/fake-http';
import { fakeLife } from '../test/fake-life';
import * as STEAM from './steam';
import * as PSN from './psn';
import * as IDS from './ids';
import { blank, type SvcState } from './state';

const NOW = Date.parse('2026-10-17T12:00:00Z');
const ctx = { save: vi.fn() };
const KEY = '0123456789ABCDEF0123456789ABCDEF';
const ME = '76561197960435530';

let net: Net;
let life: ReturnType<typeof fakeLife>;

beforeEach(() => {
  net = fakeNet();
  useNative(net);
  life = fakeLife();
  IDS.resetForTests();
});

// ---------- Steam, as its Web API answers

const owned = (hades: number, celeste: number, last = 1760640000) => ({
  response: {
    game_count: 3,
    games: [
      { appid: 1145360, name: 'Hades', playtime_forever: hades, img_icon_url: 'abc', has_community_visible_stats: true, playtime_windows_forever: hades, playtime_mac_forever: 0, playtime_linux_forever: 0, playtime_deck_forever: 0, rtime_last_played: last, playtime_disconnected: 0, playtime_2weeks: 240 },
      { appid: 504230, name: 'Celeste', playtime_forever: celeste, img_icon_url: 'def', rtime_last_played: 1750000000, playtime_disconnected: 0 },
      { appid: 400, name: 'Portal', playtime_forever: 0, img_icon_url: 'ghi', rtime_last_played: 0 },
    ],
  },
});

function steamUser(): SvcState {
  return { ...blank(), on: true, account: 'Robin', user: ME, auth: { token: KEY } };
}

describe('Steam', () => {
  it('finds the SteamID from a profile link or a custom name', async () => {
    net.on(/ResolveVanityURL/, (c) => ({ body: new URL(c.url).searchParams.get('vanityurl') === 'robin' ? { response: { steamid: ME, success: 1 } } : { response: { success: 42, message: 'No match' } } }));
    expect(await STEAM.resolveProfile(KEY, `https://steamcommunity.com/profiles/${ME}/`)).toBe(ME);
    expect(await STEAM.resolveProfile(KEY, ME)).toBe(ME);
    expect(await STEAM.resolveProfile(KEY, 'https://steamcommunity.com/id/robin/')).toBe(ME);
    await expect(STEAM.resolveProfile(KEY, 'nobody')).rejects.toThrow(/doesn't know that profile/);
    expect(net.calls.every((c) => c.url.startsWith('https://api.steampowered.com/'))).toBe(true);
  });

  it('the first time, adds the last two weeks per game; then the play time since the last look', async () => {
    net.on(/GetOwnedGames/, { body: owned(1835, 600) });
    net.on(/GetRecentlyPlayedGames/, { body: { response: { total_count: 1, games: [{ appid: 1145360, name: 'Hades', playtime_2weeks: 240, playtime_forever: 1835, img_icon_url: 'abc' }] } } });
    const st = steamUser();
    await STEAM.sync(st, ctx, NOW);
    expect(life.list()).toEqual([
      {
        id: `steam:1145360:2w${Math.floor(NOW / 86_400_000)}`,
        source: 'steam',
        kind: 'play',
        at: 1760640000_000 - 240 * 60_000,
        end: 1760640000_000,
        title: 'Played Hades for 4 h',
        value: 240,
        unit: 'min',
        tier: 2,
        meta: { app: 'steam', game: 'Hades', approx: true, appid: 1145360, span: '2 weeks' },
      },
    ]);
    expect(st.snap).toEqual({ '1145360': 1835, '504230': 600 });

    // A day later: 2.5 more hours of Hades, nothing else.
    st.last = NOW;
    net.on(/GetOwnedGames/, { body: owned(1985, 600, 1760720000) });
    await STEAM.sync(st, ctx, NOW + 86_400_000);
    const played = life.list().at(-1)!;
    expect(played).toMatchObject({ id: 'steam:1145360:1760720000', title: 'Played Hades for 2.5 h', value: 150, at: 1760720000_000 - 150 * 60_000, end: 1760720000_000 });
    expect(life.events.size).toBe(2);
    // The same snapshot again adds nothing.
    await STEAM.sync(st, ctx, NOW + 2 * 86_400_000);
    expect(life.events.size).toBe(2);
  });

  it('says so plainly when the profile keeps its games private', async () => {
    net.on(/GetOwnedGames/, { body: { response: {} } });
    await expect(STEAM.sync(steamUser(), ctx, NOW)).rejects.toMatchObject({ kind: 'private', message: expect.stringMatching(/Game details to Public/) });
  });

  it('asks to connect again when Steam refuses the key (403)', async () => {
    net.on(/GetOwnedGames/, { status: 403, body: '<html><head><title>Forbidden</title></head><body><h1>Forbidden</h1></body></html>' });
    await expect(STEAM.sync(steamUser(), ctx, NOW)).rejects.toMatchObject({ kind: 'auth' });
  });

  it('backs off when Steam is busy (429)', async () => {
    net.on(/GetOwnedGames/, { status: 429, body: 'Too Many Requests' });
    await expect(STEAM.sync(steamUser(), ctx, NOW)).rejects.toMatchObject({ kind: 'rate' });
  });

  it('formats play time in plain words', () => {
    expect([STEAM.hours(1), STEAM.hours(45), STEAM.hours(60), STEAM.hours(150), STEAM.hours(601)]).toEqual(['1 min', '45 min', '1 h', '2.5 h', '10 h']);
  });
});

// ---------- PlayStation, as its servers answer (shapes from psn-api's types)

const NPSSO = 'a'.repeat(64);
const tokens = (access = 'eyJ.access', refresh = 'eyJ.refresh') => ({ access_token: access, token_type: 'bearer', expires_in: 3599, scope: 'psn:mobile.v2.core psn:clientapp', id_token: 'eyJ.id', refresh_token: refresh, refresh_token_expires_in: 5183999 });
const titles = (duration: string, last: string) => ({
  titles: [
    {
      titleId: 'PPSA01411_00',
      name: "Marvel's Spider-Man 2",
      localizedName: "Marvel's Spider-Man 2",
      imageUrl: 'https://image.api.playstation.com/x.png',
      localizedImageUrl: 'https://image.api.playstation.com/x.png',
      category: 'ps5_native_game',
      service: 'none_purchased',
      playCount: 12,
      concept: { id: 10002694, titleIds: ['PPSA01411_00'], name: "Marvel's Spider-Man 2", media: { audios: [], videos: [], images: [] } },
      media: {},
      firstPlayedDateTime: '2026-09-01T18:00:00.000Z',
      lastPlayedDateTime: last,
      playDuration: duration,
    },
    { titleId: 'CUSA00419_00', name: 'Bloodborne', localizedName: 'Bloodborne', category: 'ps4_game', playCount: 40, firstPlayedDateTime: '2019-01-01T00:00:00Z', lastPlayedDateTime: '2024-01-01T00:00:00Z', playDuration: 'PT80H' },
  ],
  totalItemCount: 2,
  nextOffset: 2,
  previousOffset: 0,
});
const trophyTitles = {
  trophyTitles: [
    { npServiceName: 'trophy2', npCommunicationId: 'NPWR22578_00', trophySetVersion: '01.00', trophyTitleName: "Marvel's Spider-Man 2", trophyTitlePlatform: 'PS5', hasTrophyGroups: true, progress: 40, earnedTrophies: { bronze: 10, silver: 2, gold: 1, platinum: 0 }, hiddenFlag: false, lastUpdatedDateTime: '2026-10-16T21:10:00Z' },
    { npServiceName: 'trophy', npCommunicationId: 'NPWR07897_00', trophySetVersion: '01.00', trophyTitleName: 'Bloodborne', trophyTitlePlatform: 'PS4', progress: 100, earnedTrophies: { bronze: 30, silver: 8, gold: 4, platinum: 1 }, lastUpdatedDateTime: '2024-01-01T00:00:00Z' },
  ],
  totalItemCount: 2,
};

function psnUser(): SvcState {
  return { ...blank(), on: true, account: 'PlayStation account', auth: { token: 'eyJ.access', expires: NOW + 3000_000, refresh: 'eyJ.refresh', refreshExpires: NOW + 50 * 86400_000 } };
}

describe('PlayStation', () => {
  it("swaps the pasted code for Arise's own sign-in, without following Sony's redirect", async () => {
    net.on(/oauth\/authorize/, (c) => {
      expect(c.headers.Cookie).toBe(`npsso=${NPSSO}`);
      expect(c.noRedirect).toBe(true);
      return { status: 302, headers: { location: 'com.scee.psxandroid.scecompcall://redirect/?code=v3.AbCdEf&cid=1234' } };
    });
    net.on(/oauth\/token/, (c) => {
      expect(Object.fromEntries(new URLSearchParams(c.body))).toEqual({ code: 'v3.AbCdEf', redirect_uri: 'com.scee.psxandroid.scecompcall://redirect', grant_type: 'authorization_code', token_format: 'jwt' });
      expect(c.headers.Authorization).toMatch(/^Basic /);
      return { body: tokens() };
    });
    const st = blank();
    await PSN.signIn(st, NPSSO, NOW);
    expect(st.auth).toEqual({ token: 'eyJ.access', expires: NOW + 3599_000, refresh: 'eyJ.refresh', refreshExpires: NOW + 5183999_000 });
    expect(JSON.stringify(st)).not.toContain(NPSSO);
  });

  it("says so when Sony doesn't take the code", async () => {
    net.on(/oauth\/authorize/, { status: 302, headers: { location: 'com.scee.psxandroid.scecompcall://redirect/?error=login_required' } });
    await expect(PSN.signIn(blank(), NPSSO, NOW)).rejects.toMatchObject({ kind: 'auth' });
    expect(PSN.npssoFrom(`{"npsso":"${NPSSO}"}`)).toBe(NPSSO);
    expect(PSN.validNpsso('short')).toBe(false);
  });

  it('turns play time and trophies into life events', async () => {
    net.on(/gamelist\/v2\/users\/me\/titles/, { body: titles('PT22H15M7S', '2026-10-16T21:30:00.000Z') });
    net.on(/trophyTitles/, { body: trophyTitles });
    net.on(/users\/me\/npCommunicationIds\/NPWR22578_00\/trophyGroups\/all\/trophies\?npServiceName=trophy2/, {
      body: { trophySetVersion: '01.00', hasTrophyGroups: true, lastUpdatedDateTime: '2026-10-16T21:10:00Z', trophies: [{ trophyId: 0, trophyHidden: false, earned: false, trophyType: 'platinum', trophyRare: 0, trophyEarnedRate: '5.2' }, { trophyId: 7, trophyHidden: false, earned: true, earnedDateTime: '2026-10-16T21:10:00Z', trophyType: 'gold', trophyRare: 1, trophyEarnedRate: '12.0' }], totalItemCount: 2 },
    });
    net.on(/\/trophy\/v1\/npCommunicationIds\/NPWR22578_00\/trophyGroups\/all\/trophies/, { body: { trophySetVersion: '01.00', hasTrophyGroups: true, trophies: [{ trophyId: 0, trophyHidden: false, trophyType: 'platinum', trophyName: 'Be Greater. Together.', trophyGroupId: 'default' }, { trophyId: 7, trophyHidden: false, trophyType: 'gold', trophyName: 'Symbiote Showdown', trophyGroupId: 'default' }], totalItemCount: 2 } });
    const st = psnUser();
    await PSN.sync(st, ctx, NOW);
    expect(life.titles()).toEqual(["Gold trophy in Marvel's Spider-Man 2: Symbiote Showdown", "Played Marvel's Spider-Man 2"]);
    expect(st.snap).toEqual({ PPSA01411_00: 1335, CUSA00419_00: 4800 });
    // Bloodborne's trophies are old: not even asked for.
    expect(net.urls().some((u) => u.includes('NPWR07897_00'))).toBe(false);
    expect(net.calls.every((c) => c.headers.Authorization === 'Bearer eyJ.access')).toBe(true);

    // The next evening: 1 h 30 more (the hour-long access token is renewed on the way).
    st.last = NOW;
    net.on(/oauth\/token/, { body: tokens('eyJ.access2') });
    net.on(/gamelist\/v2\/users\/me\/titles/, { body: titles('PT23H45M7S', '2026-10-17T21:00:00.000Z') });
    await PSN.sync(st, ctx, NOW + 86_400_000);
    expect(life.list().at(-1)).toMatchObject({ title: "Played Marvel's Spider-Man 2 for 1.5 h", value: 90, end: Date.parse('2026-10-17T21:00:00Z'), tier: 2 });
  });

  it('gets the trophies of every game when more changed than one sync looks at', async () => {
    const DAY = 86_400_000;
    const iso = (t: number) => new Date(t).toISOString();
    // 12 games with trophies in the last 90 days. Game 10's latest came 2 days ago, but it also
    // has one from 60 days ago, before the 8 games looked at first.
    const games = Array.from({ length: 12 }, (_, i) => ({ n: i + 1, id: `NPWR${10001 + i}_00`, at: i + 1 === 10 ? NOW - 2 * DAY : NOW - (40 - i) * DAY }));
    const earnedIn = (n: number) => (n === 10 ? [{ id: 1, at: NOW - 60 * DAY }, { id: 2, at: NOW - 2 * DAY }] : [{ id: 1, at: games[n - 1].at }]);
    net.on(/gamelist/, { body: { titles: [] } });
    net.on(/trophyTitles/, { body: { trophyTitles: games.map((g) => ({ npServiceName: 'trophy2', npCommunicationId: g.id, trophyTitleName: `Game ${g.n}`, lastUpdatedDateTime: iso(g.at) })), totalItemCount: 12 } });
    const gameOf = (url: string) => games.find((g) => url.includes(`/${g.id}/`))!;
    net.on(/users\/me\/npCommunicationIds\//, (c) => ({ body: { trophies: earnedIn(gameOf(c.url).n).map((t) => ({ trophyId: t.id, earned: true, earnedDateTime: iso(t.at), trophyType: 'bronze' })) } }));
    net.on(/\/trophy\/v1\/npCommunicationIds\//, (c) => ({ body: { trophies: earnedIn(gameOf(c.url).n).map((t) => ({ trophyId: t.id, trophyName: t.at < NOW - 50 * DAY ? 'Early one' : `Trophy ${gameOf(c.url).n}` })) } }));
    const asked = () => new Set(net.urls().filter((u) => u.includes('users/me/npCommunicationIds')).map((u) => gameOf(u).n));

    const st = psnUser();
    await PSN.sync(st, ctx, NOW);
    expect([...asked()].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]); // the oldest 8 first
    st.last = NOW;
    net.calls.length = 0;
    await PSN.sync(st, ctx, NOW + 60_000);
    expect([...asked()].sort((a, b) => a - b)).toEqual([9, 10, 11, 12]);
    expect(life.titles()).toContain('Bronze trophy in Game 10: Early one');
    expect(life.titles().filter((t) => t.includes('trophy'))).toHaveLength(13);
    expect(st.cursors['trophy.floor']).toBeUndefined();
    expect(st.cursors['trophy.since']).toBe(String(NOW - 2 * DAY));
  });

  it('renews the sign-in when it ran out, and asks for a new code when that fails', async () => {
    const st = psnUser();
    st.auth.expires = NOW - 1;
    net.on(/oauth\/token/, (c) => {
      expect(new URLSearchParams(c.body).get('grant_type')).toBe('refresh_token');
      return { body: tokens('eyJ.access2', 'eyJ.refresh2') };
    });
    net.on(/gamelist/, (c) => {
      expect(c.headers.Authorization).toBe('Bearer eyJ.access2');
      return { body: { titles: [] } };
    });
    net.on(/trophyTitles/, { body: { trophyTitles: [] } });
    await PSN.sync(st, ctx, NOW);
    expect(st.auth.refresh).toBe('eyJ.refresh2');

    st.auth.expires = NOW - 1;
    net.on(/oauth\/token/, { status: 400, body: { error: 'invalid_grant', error_description: 'Invalid refresh token' } });
    await expect(PSN.sync(st, ctx, NOW + 10)).rejects.toMatchObject({ kind: 'auth', message: expect.stringMatching(/new code/) });
  });

  it('reads play time as Sony writes it', () => {
    expect(PSN.minutes('PT228H56M33S')).toBeCloseTo(228 * 60 + 56.55);
    expect(PSN.minutes('PT45M')).toBe(45);
    expect(PSN.minutes('P1DT2H')).toBe(1560);
    expect(PSN.minutes('nonsense')).toBe(0);
  });
});
