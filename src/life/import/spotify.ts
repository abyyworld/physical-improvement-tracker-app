// Spotify: what was played.
//
// Account data (the last year): StreamingHistory_music_0.json, StreamingHistory_podcast_0.json
// (older: StreamingHistory0.json), each [{"endTime": "2024-01-02 03:04", "artistName": "…",
// "trackName": "…", "msPlayed": 215000}] or [{"endTime": …, "podcastName": "…", "episodeName": "…",
// "msPlayed": …}]. Times are UTC.
//
// Extended streaming history (all years): Streaming_History_Audio_2019-2020_0.json and
// Streaming_History_Video_*.json, each [{"ts": "2024-01-02T03:04:05Z", "ms_played": 215000,
// "master_metadata_track_name": "…", "master_metadata_album_artist_name": "…",
// "master_metadata_album_album_name": "…", "spotify_track_uri": "spotify:track:…",
// "episode_name": null, "episode_show_name": null, "spotify_episode_uri": null,
// "audiobook_title": null, "audiobook_chapter_title": null, "reason_start": "…", "skipped": false, …}].
// "ts" is when the play ended.
//
// A play that was paused and picked up again comes as several rows: those are joined into one.
// A song played again right after itself is not: the extended history's reason_end ("trackdone")
// and reason_start ("trackdone", "clickrow", "fwdbtn", "backbtn") say it's a new play.
// Plays under 30 seconds (skips) are left out, unless that's all the file has.

import type { LifeEvent } from '../types';
import type { TextInput } from './types';
import { JsonItems } from './json-stream';
import { clean, drain, duration, hashId, isoMs, num, round1, str, utcMs } from './util';

type Rec = Record<string, unknown>;

export const SHORT_MS = 30_000;
const JOIN_GAP_MS = 2 * 60_000;
const NEW_PLAY = new Set(['trackdone', 'clickrow', 'fwdbtn', 'backbtn']);

interface Play {
  what: 'music' | 'podcast' | 'audiobook';
  track: string;
  by: string; // artist, show or book
  album: string;
  uri: string;
  start: number;
  end: number;
  ms: number;
  reasonStart?: string; // the extended history's reason_start and reason_end
  reasonEnd?: string;
}

export function playOf(r: unknown): Play | null {
  if (!r || typeof r !== 'object') return null;
  const rec = r as Rec;
  const extended = 'ts' in rec || 'ms_played' in rec;
  const end = extended ? isoMs(rec.ts) : utcMs(rec.endTime);
  const ms = num(extended ? rec.ms_played : rec.msPlayed);
  if (!Number.isFinite(end) || !Number.isFinite(ms) || ms < 0) return null;
  let what: Play['what'];
  let track: string;
  let by: string;
  let album = '';
  let uri = '';
  if (extended) {
    if (str(rec.master_metadata_track_name)) {
      what = 'music';
      track = clean(rec.master_metadata_track_name, 150);
      by = clean(rec.master_metadata_album_artist_name, 100);
      album = clean(rec.master_metadata_album_album_name, 100);
      uri = str(rec.spotify_track_uri) ?? '';
    } else if (str(rec.episode_name)) {
      what = 'podcast';
      track = clean(rec.episode_name, 150);
      by = clean(rec.episode_show_name, 100);
      uri = str(rec.spotify_episode_uri) ?? '';
    } else if (str(rec.audiobook_title) || str(rec.audiobook_chapter_title)) {
      what = 'audiobook';
      track = clean(rec.audiobook_chapter_title || rec.audiobook_title, 150);
      by = clean(rec.audiobook_title, 100);
      uri = str(rec.audiobook_chapter_uri) ?? str(rec.audiobook_uri) ?? '';
    } else return null; // no name: nothing readable to keep
  } else if (str(rec.podcastName) || str(rec.episodeName)) {
    what = 'podcast';
    track = clean(rec.episodeName, 150);
    by = clean(rec.podcastName, 100);
  } else if (str(rec.trackName)) {
    what = 'music';
    track = clean(rec.trackName, 150);
    by = clean(rec.artistName, 100);
  } else return null;
  if (!track) return null;
  const p: Play = { what, track, by, album, uri, start: end - ms, end, ms };
  if (str(rec.reason_start)) p.reasonStart = rec.reason_start as string;
  if (str(rec.reason_end)) p.reasonEnd = rec.reason_end as string;
  return p;
}

function eventOf(p: Play, video: boolean): LifeEvent {
  const kind = video ? 'watch' : 'listen';
  const verb = video ? 'Watched' : 'Listened to';
  const title =
    p.what === 'music'
      ? `${verb} ${p.track}${p.by ? ` by ${p.by}` : ''}`
      : p.what === 'audiobook' && p.by && p.by !== p.track
        ? `${verb} ${p.track} (${p.by})`
        : `${verb} ${p.track}${p.by && p.what === 'podcast' ? ` (${p.by})` : ''}`;
  const e: LifeEvent = {
    // The minute it ended, so the same play from either kind of export gets the same id.
    id: `spotify:${hashId(kind, Math.floor(p.end / 60_000), p.track, p.by)}`,
    source: 'spotify',
    kind,
    at: p.start,
    end: p.end,
    title,
    value: round1(p.ms / 60_000),
    unit: 'min',
    tier: 2,
  };
  const detail = [p.album && p.album !== p.track ? p.album : '', p.what === 'podcast' ? 'Podcast' : p.what === 'audiobook' ? 'Audiobook' : '', p.ms >= 60_000 ? duration(p.ms / 60_000) : ''].filter(Boolean).join(' · ');
  if (detail) e.detail = detail;
  if (p.uri.startsWith('spotify:')) e.url = `https://open.spotify.com/${p.uri.split(':').slice(1).join('/')}`;
  return e;
}

export async function* parseSpotify(input: TextInput): AsyncGenerator<LifeEvent[]> {
  const video = /video/i.test(input.name);
  const items = new JsonItems();
  const out: LifeEvent[] = [];
  const short: LifeEvent[] = []; // kept in case nothing longer turns up
  const ids = new Set<string>();
  let kept = 0;
  let cur: Play | null = null;
  const flush = () => {
    if (!cur) return;
    const long = cur.ms >= SHORT_MS;
    const e = eventOf(cur, video);
    cur = null;
    if (ids.has(e.id)) return;
    ids.add(e.id);
    if (long) {
      out.push(e);
      kept++;
    } else if (!kept && short.length < 5000) short.push(e);
  };
  for await (const chunk of input.text) {
    for (const it of items.push(chunk)) {
      const p = playOf(it.value);
      if (!p) continue;
      const same = cur && (cur.uri && p.uri ? cur.uri === p.uri : cur.track === p.track && cur.by === p.by);
      // Played to the end, or started again on purpose: a new play, however close.
      const anew = cur?.reasonEnd === 'trackdone' || NEW_PLAY.has(p.reasonStart ?? '');
      if (cur && same && !anew && p.start >= cur.start && p.start - cur.end <= JOIN_GAP_MS) {
        cur.end = Math.max(cur.end, p.end);
        cur.ms += p.ms;
        cur.reasonEnd = p.reasonEnd;
      } else {
        flush();
        cur = p;
      }
    }
    yield* drain(out);
  }
  flush();
  if (!kept) out.push(...short);
  yield* drain(out, true);
}
