import { describe, expect, it } from 'vitest';
import { parseSpotify } from './spotify';
import { input, run, titles, wellFormed } from '../../test/life-fixtures';

// Account data (Privacy settings, "Account data"): the last year.
const music = [
  { endTime: '2024-01-02 08:03', artistName: 'Queen', trackName: 'Bohemian Rhapsody', msPlayed: 354000 },
  { endTime: '2024-01-02 08:04', artistName: 'Queen', trackName: 'Under Pressure', msPlayed: 12000 },
  { endTime: '2024-01-02 08:08', artistName: 'David Bowie', trackName: 'Heroes', msPlayed: 240000 },
];
const podcast = [{ endTime: '2024-01-03 07:45', podcastName: 'Huberman Lab', episodeName: 'Sleep Toolkit', msPlayed: 1800000 }];

// Extended streaming history (all years).
const extended = (over: object) => ({
  ts: '2023-05-01T10:04:00Z',
  username: 'someone',
  platform: 'iOS 16.4 (iPhone14,2)',
  ms_played: 240000,
  conn_country: 'GB',
  ip_addr_decrypted: '10.0.0.1',
  user_agent_decrypted: 'unknown',
  master_metadata_track_name: 'Blinding Lights',
  master_metadata_album_artist_name: 'The Weeknd',
  master_metadata_album_album_name: 'After Hours',
  spotify_track_uri: 'spotify:track:0VjIjW4GlUZAMYd2vXMi3b',
  episode_name: null,
  episode_show_name: null,
  spotify_episode_uri: null,
  reason_start: 'clickrow',
  reason_end: 'trackdone',
  shuffle: false,
  skipped: false,
  offline: false,
  offline_timestamp: 0,
  incognito_mode: false,
  ...over,
});

describe('Spotify', () => {
  it('reads songs and podcasts from Account data, leaving out skips', async () => {
    const songs = await run(parseSpotify(input('Spotify Account Data/StreamingHistory_music_0.json', JSON.stringify(music, null, 2))));
    expect(titles(songs.events)).toEqual(['Listened to Bohemian Rhapsody by Queen', 'Listened to Heroes by David Bowie']);
    expect(songs.events[0]).toMatchObject({ source: 'spotify', kind: 'listen', tier: 2, end: Date.UTC(2024, 0, 2, 8, 3), at: Date.UTC(2024, 0, 2, 8, 3) - 354000, value: 5.9, unit: 'min', detail: '6 min' });
    const pods = await run(parseSpotify(input('StreamingHistory_podcast_0.json', JSON.stringify(podcast))));
    expect(pods.events[0]).toMatchObject({ title: 'Listened to Sleep Toolkit (Huberman Lab)', value: 30, detail: 'Podcast · 30 min' });
    expect([...songs.events, ...pods.events].every(wellFormed)).toBe(true);
  });

  it('reads the extended history: songs, podcasts, audiobooks and videos', async () => {
    const rows = [
      extended({}),
      extended({ ts: '2023-05-01T11:00:00Z', ms_played: 1500000, master_metadata_track_name: null, master_metadata_album_artist_name: null, master_metadata_album_album_name: null, spotify_track_uri: null, episode_name: 'Episode 12', episode_show_name: 'The Daily', spotify_episode_uri: 'spotify:episode:abc' }),
      extended({ ts: '2023-05-01T12:00:00Z', ms_played: 900000, master_metadata_track_name: null, master_metadata_album_artist_name: null, master_metadata_album_album_name: null, spotify_track_uri: null, audiobook_title: 'Atomic Habits', audiobook_uri: 'spotify:show:x', audiobook_chapter_uri: 'spotify:episode:y', audiobook_chapter_title: 'Chapter 1' }),
      extended({ ts: '2023-05-01T13:00:00Z', master_metadata_track_name: null, master_metadata_album_artist_name: null, master_metadata_album_album_name: null, spotify_track_uri: null }), // no names left
    ];
    const { events } = await run(parseSpotify(input('Spotify Extended Streaming History/Streaming_History_Audio_2023_3.json', JSON.stringify(rows))));
    expect(titles(events)).toEqual(['Listened to Blinding Lights by The Weeknd', 'Listened to Episode 12 (The Daily)', 'Listened to Chapter 1 (Atomic Habits)']);
    expect(events[0]).toMatchObject({ url: 'https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b', detail: 'After Hours · 4 min' });
    const video = await run(parseSpotify(input('Streaming_History_Video_2023.json', JSON.stringify([rows[1]]))));
    expect(video.events[0]).toMatchObject({ kind: 'watch', title: 'Watched Episode 12 (The Daily)' });
  });

  it('joins a play that was paused and picked up again into one', async () => {
    const rows = [
      extended({ ts: '2023-05-01T10:01:00Z', ms_played: 60000, reason_end: 'endplay' }),
      extended({ ts: '2023-05-01T10:03:30Z', ms_played: 120000, reason_start: 'playbtn' }),
      extended({ ts: '2023-05-01T10:30:00Z', ms_played: 200000 }), // played again later: its own play
    ];
    const { events } = await run(parseSpotify(input('Streaming_History_Audio_2023.json', JSON.stringify(rows))));
    expect(events.length).toBe(2);
    expect(events[0]).toMatchObject({ at: Date.parse('2023-05-01T10:00:00Z'), end: Date.parse('2023-05-01T10:03:30Z'), value: 3 });
  });

  it('keeps a song on repeat as one play each time, and still joins one picked up after the app closed', async () => {
    const repeat = [
      extended({ ts: '2023-05-01T10:03:20Z', ms_played: 200000, spotify_track_uri: 'spotify:track:1', reason_start: 'clickrow', reason_end: 'trackdone' }),
      extended({ ts: '2023-05-01T10:06:40Z', ms_played: 200000, spotify_track_uri: 'spotify:track:1', reason_start: 'trackdone', reason_end: 'trackdone' }),
      extended({ ts: '2023-05-01T10:10:00Z', ms_played: 200000, spotify_track_uri: 'spotify:track:1', reason_start: 'trackdone', reason_end: 'trackdone' }),
    ];
    const a = await run(parseSpotify(input('Streaming_History_Audio_2023.json', JSON.stringify(repeat))));
    expect(a.events.map((e) => e.value)).toEqual([3.3, 3.3, 3.3]);
    const resumed = [
      extended({ ts: '2023-05-01T10:01:40Z', ms_played: 100000, spotify_track_uri: 'spotify:track:1', reason_end: 'unexpected-exit-while-paused' }),
      extended({ ts: '2023-05-01T10:04:00Z', ms_played: 100000, spotify_track_uri: 'spotify:track:1', reason_start: 'appload', reason_end: 'trackdone' }),
    ];
    const b = await run(parseSpotify(input('Streaming_History_Audio_2023.json', JSON.stringify(resumed))));
    expect(b.events.map((e) => e.value)).toEqual([3.3]);
  });

  it('keeps the short plays when that is all there is', async () => {
    const rows = [
      { endTime: '2024-01-02 08:04', artistName: 'A', trackName: 'One', msPlayed: 12000 },
      { endTime: '2024-01-02 08:05', artistName: 'B', trackName: 'Two', msPlayed: 9000 },
    ];
    expect(titles((await run(parseSpotify(input('StreamingHistory_music_1.json', JSON.stringify(rows))))).events)).toEqual(['Listened to One by A', 'Listened to Two by B']);
  });

  it('gives a play the same id in both exports, and repeats of one file add nothing', async () => {
    const account = [{ endTime: '2023-05-01 10:04', artistName: 'The Weeknd', trackName: 'Blinding Lights', msPlayed: 240000 }];
    const a = await run(parseSpotify(input('StreamingHistory_music_0.json', JSON.stringify(account))));
    const b = await run(parseSpotify(input('Streaming_History_Audio_2023.json', JSON.stringify([extended({ ts: '2023-05-01T10:04:31Z' })]))));
    expect(a.events[0].id).toBe(b.events[0].id);
    const twice = await run(parseSpotify(input('x.json', JSON.stringify([...music, ...music]))));
    expect(new Set(twice.events.map((e) => e.id)).size).toBe(twice.events.length);
  });

  it('handles empty files and huge ones', async () => {
    expect((await run(parseSpotify(input('StreamingHistory_music_0.json', '[]')))).events).toEqual([]);
    async function* big() {
      yield '[';
      for (let i = 0; i < 20_000; i++) yield `${i ? ',' : ''}${JSON.stringify(extended({ ts: new Date(Date.UTC(2020, 0, 1) + i * 300_000).toISOString(), master_metadata_track_name: `Song ${i}`, spotify_track_uri: `spotify:track:${i}` }))}`;
      yield ']';
    }
    const { batches, events } = await run(parseSpotify({ name: 'Streaming_History_Audio_2020.json', text: big() }));
    expect(events.length).toBe(20_000);
    expect(Math.max(...batches.map((b) => b.length))).toBe(500);
  });
});
