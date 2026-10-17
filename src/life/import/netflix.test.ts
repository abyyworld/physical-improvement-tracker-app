import { describe, expect, it } from 'vitest';
import { dateParts, netflixProfiles, parseNetflixActivity, parseNetflixHistory } from './netflix';
import { input, run, titles, wellFormed } from '../../test/life-fixtures';

// ViewingActivity.csv from the full data request (CONTENT_INTERACTION folder).
const activity = `﻿Profile Name,Start Time,Duration,Attributes,Title,Supplemental Video Type,Device Type,Bookmark,Latest Bookmark,Country
Anna,2024-02-10 20:15:03,00:47:12,,"Breaking Bad: Season 1: Pilot (Episode 1)",,Apple TV 4K,00:47:12,00:47:12,GB (United Kingdom)
Anna,2024-02-10 21:05:00,00:00:31,Autoplayed: user action: None; ,"Breaking Bad: Season 1: Cat's in the Bag... (Episode 2)",,Apple TV 4K,00:00:31,Not latest view,GB (United Kingdom)
Anna,2024-02-10 19:59:00,00:01:10,,Breaking Bad: Season 1 (Trailer),TRAILER,Apple TV 4K,00:01:10,00:01:10,GB (United Kingdom)
Kids,2024-02-11 09:00:00,00:22:00,,"Bluey: Season 1: ""Magic Xylophone""",,Samsung TV,00:22:00,00:22:00,GB (United Kingdom)
Anna,2024-02-12 22:00:00,01:58:00,,"Glass Onion: A Knives Out Mystery",,iPhone 13,01:58:00,01:58:00,GB (United Kingdom)
`;

describe('Netflix viewing activity (full data request)', () => {
  it('reads what was watched, leaving out trailers and anything under a minute', async () => {
    const { events } = await run(parseNetflixActivity(input('CONTENT_INTERACTION/ViewingActivity.csv', activity)));
    expect(titles(events)).toEqual(['Watched Breaking Bad: Season 1: Pilot (Episode 1)', 'Watched Bluey: Season 1: "Magic Xylophone"', 'Watched Glass Onion: A Knives Out Mystery']);
    expect(events[0]).toMatchObject({ source: 'netflix', kind: 'watch', tier: 2, at: Date.UTC(2024, 1, 10, 20, 15, 3), value: 47, unit: 'min', detail: 'Profile Anna · Apple TV 4K', meta: { profile: 'Anna' } });
    expect(events[0].end).toBe(Date.UTC(2024, 1, 10, 20, 15, 3) + (47 * 60 + 12) * 1000);
    expect(events.every(wellFormed)).toBe(true);
  });

  it('lists the profiles and reads only the ones chosen', async () => {
    expect(await netflixProfiles(input('ViewingActivity.csv', activity))).toEqual(['Anna', 'Kids']);
    const { events } = await run(parseNetflixActivity(input('ViewingActivity.csv', activity), { profiles: ['Anna'] }));
    expect(events.map((e) => e.meta?.profile)).toEqual(['Anna', 'Anna']);
  });

  it('gives stable ids and copes with an empty file', async () => {
    const a = await run(parseNetflixActivity(input('ViewingActivity.csv', activity)));
    const b = await run(parseNetflixActivity(input('ViewingActivity.csv', activity.replace(/\n/g, '\r\n'), 3)));
    expect(b.events.map((e) => e.id)).toEqual(a.events.map((e) => e.id));
    expect((await run(parseNetflixActivity(input('ViewingActivity.csv', '')))).events).toEqual([]);
    expect((await run(parseNetflixActivity(input('ViewingActivity.csv', 'Profile Name,Start Time,Duration,Attributes,Title\n')))).events).toEqual([]);
  });
});

describe('Netflix viewing history (the quick download)', () => {
  it('reads US dates (month first)', async () => {
    const csv = 'Title,Date\n"Wednesday: Season 1: Woe Is the Loneliest Number","12/25/22"\n"Wednesday: Season 1: Friend or Woe","1/3/23"\n"The Crown","1/3/23"\n';
    const { events } = await run(parseNetflixHistory(input('NetflixViewingHistory.csv', csv)));
    expect(titles(events)).toEqual(['Watched Wednesday: Season 1: Woe Is the Loneliest Number', 'Watched Wednesday: Season 1: Friend or Woe', 'Watched The Crown']);
    expect(new Date(events[1].at).getMonth()).toBe(0);
    expect(new Date(events[1].at).getDate()).toBe(3);
    expect(events[0]).toMatchObject({ source: 'netflix', kind: 'watch', tier: 2, meta: { dateOnly: true } });
  });

  it('reads day-first dates from other countries', async () => {
    const csv = 'Title,Date\nDark,13.01.2023\nDark,02.01.2023\n';
    const { events } = await run(parseNetflixHistory(input('NetflixViewingHistory.csv', csv)));
    expect(events.map((e) => [new Date(e.at).getDate(), new Date(e.at).getMonth() + 1])).toEqual([[13, 1], [2, 1]]);
    const uk = 'Title,Date\nDark,25/01/2023\nDark,02/03/2023\n';
    const r = await run(parseNetflixHistory(input('NetflixViewingHistory.csv', uk)));
    expect(new Date(r.events[1].at).getMonth() + 1).toBe(3);
  });

  it('keeps the same title twice on one day as two, with stable ids', async () => {
    const csv = 'Title,Date\nDark,1/3/23\nDark,1/3/23\n';
    const a = await run(parseNetflixHistory(input('NetflixViewingHistory.csv', csv)));
    const b = await run(parseNetflixHistory(input('NetflixViewingHistory.csv', csv, 2)));
    expect(a.events.length).toBe(2);
    expect(new Set(a.events.map((e) => e.id)).size).toBe(2);
    expect(b.events.map((e) => e.id)).toEqual(a.events.map((e) => e.id));
  });

  it('reads the ways dates are written', () => {
    expect(dateParts('1/31/23')).toEqual([1, 31, 23]);
    expect(dateParts('2023-01-31')).toEqual([2023, 1, 31]);
    expect(dateParts('2023. 1. 31.')).toEqual([2023, 1, 31]);
    expect(dateParts('soon')).toBeNull();
  });
});
