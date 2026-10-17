// A day's journal, written hour by hour from the life log, like a diary:
//
//   07:40 Woke up after 7 h 10 min of sleep
//   09:00 to 10:05 Push workout, 7 exercises
//   13:20 Searched flights to Rome
//   21:00 Played Elden Ring for 2 h
//
// grouped into the parts of the day, with a short paragraph at the top. This is the journal that
// always works, with no AI: busy stretches are merged so it stays readable (many pages in one
// hour become "Browsed: news, YouTube, Reddit", app use becomes "Instagram 25 min", songs become
// one stretch of music). When an AI may read the whole day, the memory (memory.ts) also writes it
// again in a warm diary voice; that one, and the Player's own edits of it, are kept as text in
// the same shape (toText / parseText).
//
// Pure (no app imports): times are the device's local time, so a day is what its clock showed,
// through daylight saving changes too.

import type { LifeEvent } from './types';
import { dayEnd, dayStart } from './dates';

export type Part = 'early' | 'morning' | 'afternoon' | 'evening' | 'night';
export const PARTS: readonly Part[] = ['early', 'morning', 'afternoon', 'evening', 'night'];
export const PART_NAMES: Record<Part, string> = { early: 'After midnight', morning: 'Morning', afternoon: 'Afternoon', evening: 'Evening', night: 'Night' };
export const partOf = (hour: number): Part => (hour < 5 ? 'early' : hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : hour < 22 ? 'evening' : 'night');

export type Voice = 'first' | 'you';

export interface Own {
  text: string; // the Player's own words for the day (their Daily log)
  energy: number | null; // 1 to 5
}

export interface JournalDoc {
  intro: string;
  parts: { part: Part; lines: string[] }[]; // lines: '07:40 Woke up…' (built), or paragraphs (the AI's)
}

export interface Built extends JournalDoc {
  day: string;
  count: number; // how many things in the log it was made from
  own: Own | null;
  empty: boolean;
}

// ---------- words and numbers

const pad = (n: number) => String(n).padStart(2, '0');
export const clockOf = (t: number) => {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
export function duration(min: number): string {
  const m = Math.max(1, Math.round(min));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}
const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t);
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`;
const list = (items: string[], max = 3) => {
  const shown = items.slice(0, max);
  const rest = items.length - shown.length;
  if (rest > 0) return `${shown.join(', ')} and ${rest} more`;
  return shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}` : shown[0] || '';
};
const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))];
// 'Walked and ran 3.1 km' inside a sentence; a name or 'HRV' stays as it is.
const lower = (t: string) => (/^[A-Z][a-z]/.test(t) ? t[0].toLowerCase() + t.slice(1) : t);
const bare = (t: string, n: number) => clip(t.trim().replace(/[.!?]+$/, ''), n);
// How long it lasted: the minutes the source recorded (Health's time asleep, without the time
// awake in the night), else from its start to its end.
const minutesOf = (e: LifeEvent) => (typeof e.value === 'number' && e.value > 0 && /^min/i.test(e.unit || '') ? e.value : e.end && e.end > e.at ? (e.end - e.at) / 60000 : 0);

// Things that belong to the day, not to a time in it: the day totals from Apple Health and
// Health Connect (midnight to midnight), all-day calendar events, and rows with only a date
// (Netflix's, placed at noon). And totals over a stretch of time (Steam's last two weeks, when
// first connected). None of them goes under a clock time; the paragraph at the top has them.
const HOUR = 3600000;
const atMidnight = (t: number) => {
  const d = new Date(t);
  return d.getHours() === 0 && d.getMinutes() === 0;
};
const wholeDay = (e: LifeEvent) =>
  e.kind !== 'sleep' && (e.meta?.dateOnly === true || e.meta?.allDay === true || (!!e.end && e.end - e.at >= 20 * HOUR && (typeof e.meta?.day === 'string' || atMidnight(e.at))));
const spanOf = (e: LifeEvent) => (e.kind !== 'sleep' && typeof e.meta?.span === 'string' ? e.meta.span : '');
const untimed = (e: LifeEvent) => wholeDay(e) || !!spanOf(e);

// Well-known sites by name; others by the main part of their address ("bbc.co.uk": "bbc").
const SITES: Record<string, string> = {
  'youtube.com': 'YouTube',
  'youtu.be': 'YouTube',
  'reddit.com': 'Reddit',
  'news.ycombinator.com': 'Hacker News',
  'github.com': 'GitHub',
  'wikipedia.org': 'Wikipedia',
  'twitter.com': 'X',
  'x.com': 'X',
  'instagram.com': 'Instagram',
  'facebook.com': 'Facebook',
  'linkedin.com': 'LinkedIn',
  'amazon.com': 'Amazon',
  'amazon.co.uk': 'Amazon',
  'netflix.com': 'Netflix',
  'bbc.co.uk': 'BBC',
  'bbc.com': 'BBC',
  'theguardian.com': 'The Guardian',
  'nytimes.com': 'The New York Times',
  'google.com': 'Google',
  'mail.google.com': 'Gmail',
  'docs.google.com': 'Google Docs',
  'stackoverflow.com': 'Stack Overflow',
  'chatgpt.com': 'ChatGPT',
  'claude.ai': 'Claude',
};
const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu']);
export function siteOf(e: Pick<LifeEvent, 'url' | 'title'>): string {
  let host = '';
  try {
    host = e.url ? new URL(e.url).hostname.toLowerCase().replace(/^(www|m|en|mobile)\./, '') : '';
  } catch {}
  if (!host) return clip(e.title.replace(/^(Visited|Read|Opened)\s+/i, ''), 40);
  for (let h = host; h.includes('.'); h = h.slice(h.indexOf('.') + 1)) if (SITES[h]) return SITES[h];
  const parts = host.split('.');
  const name = parts.length >= 3 && SECOND_LEVEL.has(parts.at(-2)!) ? parts.at(-3)! : parts.at(-2) || parts[0];
  return name ? name[0].toUpperCase() + name.slice(1) : host;
}

// What a title says without its usual opening words: 'Searched "flights to Rome"' → 'flights to Rome'.
const unquote = (t: string) => t.replace(/^["“'](.*)["”']$/, '$1');
const searchOf = (t: string) => unquote(t.replace(/^Searched( for)?\s*/i, '').trim());
const appOf = (e: LifeEvent) => (typeof e.meta?.app === 'string' && e.meta.app) || e.title.replace(/^(Used|Opened|Closed)\s+/i, '').replace(/\s+for\s+\d.*$/i, '').trim();
// Who made what was playing: Spotify's 'Listened to One More Time by Daft Punk', a podcast's or
// audiobook's '(Show)' at the end, a YouTube Music video's channel, or 'Daft Punk: One More Time'.
const artistOf = (e: LifeEvent) => {
  if (e.source === 'youtube' && e.detail) return clip(e.detail.replace(/\s+-\s+Topic$/i, '').trim(), 40);
  const s = e.title.replace(/^(Listened to|Watched)\s+/i, '').trim();
  const show = /\(([^()]+)\)$/.exec(s);
  const by = s.lastIndexOf(' by ');
  const colon = s.indexOf(':');
  const who = show && /\b(Podcast|Audiobook)\b/.test(e.detail || '') ? show[1] : by > 0 ? s.slice(by + 4) : show ? show[1] : colon > 0 ? s.slice(0, colon) : s;
  return clip(who.trim(), 40);
};
// A game's name: from where it came, else the title without "Played" and how long
// ('Played Hades for 2 h' is 'Hades').
const gameOf = (e: LifeEvent) =>
  (typeof e.meta?.game === 'string' && e.meta.game.trim()) ||
  e.title
    .replace(/^Played\s+/i, '')
    .replace(/\s+for\s+\d[\d.]*\s*(h|min)\b.*$/i, '')
    .trim();
const showOf = (t: string) => {
  const s = t.replace(/^Watched\s+/i, '');
  const i = s.indexOf(':');
  return (i > 0 ? s.slice(0, i) : s).trim();
};

// ---------- entries

interface Entry {
  at: number;
  end?: number; // shown as a range when it lasted
  text: string;
}

const GAP = 30 * 60000; // songs or play sessions closer than this are one stretch

// Things that happen in runs (songs, games): one entry per run.
function runs(events: LifeEvent[], keyOf: (e: LifeEvent) => string): LifeEvent[][] {
  const out: LifeEvent[][] = [];
  const open = new Map<string, LifeEvent[]>();
  for (const e of events) {
    const k = keyOf(e);
    const cur = open.get(k);
    const last = cur?.at(-1);
    const lastEnd = last ? Math.max(last.end || last.at, last.at + minutesOf(last) * 60000) : 0;
    if (cur && e.at - lastEnd <= GAP) cur.push(e);
    else {
      const next = [e];
      out.push(next);
      open.set(k, next);
    }
  }
  return out;
}

const runEnd = (run: LifeEvent[]) => Math.max(...run.map((e) => Math.max(e.end || e.at, e.at + minutesOf(e) * 60000)));

// The night's sleep: waking up (on the day it ends) and going to sleep (on the day it starts).
function sleepEntries(e: LifeEvent, from: number, to: number): Entry[] {
  const mins = minutesOf(e);
  const nap = /^napped/i.test(e.title) || (!/^slept/i.test(e.title) && mins > 0 && mins < 180);
  const inDay = (t: number) => t >= from && t < to;
  if (!e.end || !mins) return inDay(e.at) ? [{ at: e.at, text: clip(e.title, 120) }] : [];
  if (nap) return inDay(e.at) ? [{ at: e.at, end: e.end, text: `Nap, ${duration(mins)}` }] : [];
  const out: Entry[] = [];
  if (inDay(e.at)) out.push({ at: e.at, text: 'Went to sleep' });
  if (inDay(e.end)) out.push({ at: e.end, text: `Woke up after ${duration(mins)} of sleep` });
  return out;
}

function workoutText(e: LifeEvent): string {
  if (e.source !== 'arise') return clip(e.title, 120);
  const name = e.title.replace(/^Workout:\s*/i, '').trim();
  const n = e.detail && !/^No sets logged/i.test(e.detail) ? e.detail.split(';').filter((x) => x.trim()).length : 0;
  return `${name}${/workout/i.test(name) ? '' : ' workout'}${n ? `, ${plural(n, 'exercise')}` : ''}`;
}

const hourKey = (e: LifeEvent) => {
  const d = new Date(e.at);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${d.getHours()}`;
};

// Groups of things that pile up within an hour (or a part of the day), one entry each.
function grouped(events: LifeEvent[], keyOf: (e: LifeEvent) => string, text: (g: LifeEvent[]) => string | null): Entry[] {
  const groups = new Map<string, LifeEvent[]>();
  for (const e of events) {
    const k = keyOf(e);
    groups.set(k, [...(groups.get(k) || []), e]);
  }
  const out: Entry[] = [];
  for (const g of groups.values()) {
    const t = text(g);
    if (t) out.push({ at: g[0].at, text: t });
  }
  return out;
}

// Everything that day as entries, oldest first. `events` may hold the night before's sleep (it
// started before the day), which only gives its waking up.
export function entries(events: readonly LifeEvent[], day: string): Entry[] {
  const from = dayStart(day);
  const to = dayEnd(day);
  const sorted = [...events].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  const out: Entry[] = [];
  const by = new Map<string, LifeEvent[]>();
  const add = (k: string, e: LifeEvent) => by.set(k, [...(by.get(k) || []), e]);
  for (const e of sorted) {
    if (e.kind === 'sleep') {
      out.push(...sleepEntries(e, from, to));
      continue;
    }
    if (e.at < from || e.at >= to) continue;
    if (e.id.startsWith('arise:journal:')) continue; // the Player's own words: shown on their own
    if (untimed(e)) continue; // in the paragraph, with no time
    if (e.kind === 'steps' || e.kind === 'notification') continue; // in the paragraph, or just noise
    if (e.source === 'arise' && e.kind === 'message') add('coach', e);
    else if (e.kind === 'health' && e.source !== 'arise') add('health', e);
    else if (e.source === 'email') add('email', e);
    else add(e.kind, e);
  }
  const part = (e: LifeEvent) => `${new Date(e.at).getDate()}-${partOf(new Date(e.at).getHours())}`;

  for (const [kind, evs] of by) {
    switch (kind) {
      case 'workout':
      case 'event':
      case 'call':
        for (const e of evs) {
          const text = kind === 'workout' ? workoutText(e) : kind === 'call' && minutesOf(e) && !e.end ? `${clip(e.title, 100)}, ${duration(minutesOf(e))}` : clip(e.title, 120);
          out.push({ at: e.at, ...(e.end && e.end - e.at >= 5 * 60000 ? { end: e.end } : {}), text });
        }
        break;
      case 'listen':
        for (const run of runs(evs, () => 'music')) {
          const end = runEnd(run);
          const artists = uniq(run.map(artistOf));
          if (run.length === 1) out.push({ at: run[0].at, text: clip(run[0].title, 120) });
          else out.push({ at: run[0].at, ...(end - run[0].at >= 5 * 60000 ? { end } : {}), text: `Music: ${list(artists)}` });
        }
        break;
      case 'play':
        // Sessions of the same game, by its name (each source's title says how long already); a
        // trophy on its own.
        for (const run of runs(evs, (e) => (e.meta?.trophy ? `trophy|${e.id}` : `game|${gameOf(e).toLowerCase()}`))) {
          if (run[0].meta?.trophy) {
            out.push({ at: run[0].at, text: clip(run[0].title, 120) });
            continue;
          }
          const mins = run.reduce((n, e) => n + minutesOf(e), 0);
          const game = clip(gameOf(run[0]), 100);
          out.push({ at: run[0].at, text: mins >= 1 ? `Played ${game} for ${duration(mins)}` : `Played ${game}` });
        }
        break;
      case 'watch':
        out.push(
          ...grouped(evs, (e) => `${hourKey(e)}|${e.source === 'youtube' ? 'yt' : showOf(e.title)}`, (g) => {
            if (g.length === 1) return clip(g[0].title, 120);
            if (g[0].source === 'youtube') return `Watched on YouTube: ${list(uniq(g.map((e) => clip(e.title.replace(/^Watched\s+/i, ''), 40))), 2)}`;
            return `Watched ${clip(showOf(g[0].title), 60)}, ${plural(g.length, 'episode')}`;
          }),
        );
        break;
      case 'visit':
        out.push(...grouped(evs, hourKey, (g) => (g.length === 1 && !g[0].url ? clip(g[0].title, 120) : `Browsed: ${list(uniq(g.map(siteOf)))}`)));
        break;
      case 'search':
        out.push(...grouped(evs, hourKey, (g) => (g.length === 1 ? `Searched ${clip(searchOf(g[0].title), 100)}` : `Searched: ${list(uniq(g.map((e) => clip(searchOf(e.title), 40))))}`)));
        break;
      case 'quest':
        out.push(...grouped(evs, hourKey, (g) => `Done: ${list(uniq(g.map((e) => clip(e.title.replace(/^Done:\s*/i, ''), 50))), 4)}`));
        break;
      case 'app':
        out.push(
          ...grouped(evs, part, (g) => {
            const mins = new Map<string, number>();
            for (const e of g) mins.set(appOf(e), (mins.get(appOf(e)) || 0) + minutesOf(e));
            const apps = [...mins.entries()].sort((a, b) => b[1] - a[1]).map(([a, m]) => (m >= 1 ? `${clip(a, 30)} ${duration(m)}` : clip(a, 30)));
            return apps.length === 1 ? apps[0] : `Apps: ${list(apps)}`;
          }),
        );
        break;
      case 'health':
        out.push(...grouped(evs, part, (g) => (g.length === 1 ? clip(g[0].title, 120) : `${clip(g[0].title, 80)}, and ${plural(g.length - 1, 'more health note')}`)));
        break;
      case 'message':
        out.push(...grouped(evs, hourKey, (g) => (g.length === 1 ? clip(g[0].title, 120) : `${plural(g.length, 'message')}`)));
        break;
      case 'email':
        out.push(...grouped(evs, hourKey, (g) => (g.length === 1 ? clip(g[0].title, 120) : `${plural(g.length, 'email')}`)));
        break;
      case 'coach':
        out.push(...grouped(evs, hourKey, (g) => (g.length === 1 ? `Asked my coach: ${clip(g[0].title.replace(/^Asked the coach:\s*/i, ''), 100)}` : `Asked my coach ${plural(g.length, 'question')}`)));
        break;
      case 'purchase':
        out.push(...grouped(evs, hourKey, (g) => (g.length === 1 ? clip(g[0].title, 120) : `Spent: ${list(uniq(g.map((e) => clip(e.title, 40))))}`)));
        break;
      default:
        // Notes, moods, places, trips and the rest: one each, without the same thing twice in an hour.
        out.push(...grouped(evs, (e) => `${hourKey(e)}|${e.title}`, (g) => clip(g[0].title, 140)));
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

const lineOf = (e: Entry) => `${clockOf(e.at)}${e.end && e.end > e.at ? ` to ${clockOf(e.end)}` : ''} ${e.text}`;

// ---------- the paragraph at the top

function intro(events: readonly LifeEvent[], day: string, own: Own | null, { voice = 'first', today = false }: { voice?: Voice; today?: boolean }): string {
  const from = dayStart(day);
  const to = dayEnd(day);
  const inDay = events.filter((e) => e.at >= from && e.at < to);
  const of = (k: LifeEvent['kind']) => inDay.filter((e) => e.kind === k);
  const sleep = events.filter((e) => e.kind === 'sleep' && e.end && e.end >= from && e.end < to && !/^napped/i.test(e.title) && minutesOf(e) >= 180);
  const steps = of('steps').reduce((n, e) => n + (typeof e.value === 'number' ? e.value : 0), 0);
  const workouts = of('workout');
  const quests = of('quest');
  const play = of('play').filter((e) => !spanOf(e));
  const playMin = play.reduce((n, e) => n + minutesOf(e), 0);
  const games = uniq(play.map(gameOf));
  const listenMin = runs(of('listen'), () => 'm').reduce((n, r) => n + (runEnd(r) - r[0].at) / 60000, 0);
  const shows = uniq(of('watch').filter((e) => e.source !== 'youtube').map((e) => showOf(e.title)));
  const notes = inDay.filter((e) => e.kind === 'note' && !e.id.startsWith('arise:journal:'));
  const searches = of('search');
  const bits: string[] = [];
  if (sleep.length) bits.push(`slept ${duration(minutesOf(sleep.at(-1)!))}`);
  if (workouts.length) bits.push(workouts.length === 1 ? `did ${workouts[0].source === 'arise' ? 'a workout' : `a workout (${clip(workouts[0].title.split(',')[0], 30)})`}` : `did ${workouts.length} workouts`);
  if (quests.length) bits.push(`finished ${plural(quests.length, 'quest')}`);
  if (steps >= 100) bits.push(`walked ${Math.round(steps).toLocaleString('en-GB')} steps`);
  if (playMin >= 5) bits.push(games.length === 1 ? `played ${clip(games[0], 40)} for ${duration(playMin)}` : `played games for ${duration(playMin)}`);
  else if (play.length) bits.push(games.length === 1 ? `played ${clip(games[0], 40)}` : `played ${plural(games.length, 'game')}`);
  if (shows.length) bits.push(shows.length === 1 ? `watched ${clip(shows[0], 40)}` : `watched ${plural(shows.length, 'show')}`);
  if (listenMin >= 10) bits.push(`listened to music for ${duration(listenMin)}`);
  if (notes.length) bits.push(`wrote ${plural(notes.length, 'note')}`);
  if (searches.length && bits.length < 4) bits.push(`looked up ${plural(searches.length, 'thing')}`);
  const I = voice === 'first' ? 'I' : 'you';
  const my = voice === 'first' ? 'My' : 'Your';
  const out: string[] = [];
  if (bits.length) {
    const body = `${I} ${list(bits.slice(0, 5), 5)}.`;
    out.push(today ? `So far today, ${body}` : body[0].toUpperCase() + body.slice(1));
  } else if (inDay.length || sleep.length) out.push(today ? 'A few things so far today.' : 'A quiet day, with a few things in the log.');
  // What the day holds with no time to it (steps and shows are in the sentence above), and totals
  // over a longer stretch.
  const allDay = uniq(inDay.filter((e) => wholeDay(e) && !['steps', 'watch', 'notification'].includes(e.kind)).map((e) => bare(e.source === 'health' ? lower(e.title) : e.title, 60)));
  if (allDay.length) out.push(`All day: ${list(allDay, 4)}.`);
  const spans = new Map<string, string[]>();
  for (const e of inDay) {
    const span = spanOf(e);
    if (!span || e.kind === 'notification') continue;
    const mins = minutesOf(e);
    spans.set(span, [...(spans.get(span) || []), e.kind === 'play' ? `played ${clip(gameOf(e), 40)}${mins >= 1 ? ` for ${duration(mins)}` : ''}` : bare(lower(e.title), 60)]);
  }
  for (const [span, items] of spans) out.push(`Over ${span}: ${list(uniq(items), 4)}.`);
  if (own?.energy) out.push(`${my} energy was ${own.energy} out of 5.`);
  return out.join(' ');
}

// ---------- the journal

// The Player's own words for the day, from their Daily log (or its event in the log).
export function ownFrom(events: readonly LifeEvent[], day: string, given?: Partial<Own> | null): Own | null {
  if (given && (given.text?.trim() || given.energy)) return { text: (given.text || '').trim(), energy: given.energy || null };
  const e = events.find((x) => x.id === `arise:journal:${day}`);
  if (!e) return null;
  const energy = typeof e.value === 'number' && e.unit?.startsWith('energy') ? e.value : null;
  const text = (e.detail || '').replace(/\n*Energy \d\/5\.\s*$/, '').trim();
  return text || energy ? { text, energy } : null;
}

export function buildJournal(events: readonly LifeEvent[], day: string, { voice = 'first', now = Date.now(), own: given }: { voice?: Voice; now?: number; own?: Partial<Own> | null } = {}): Built {
  const own = ownFrom(events, day, given);
  const list = entries(events, day);
  const parts: JournalDoc['parts'] = [];
  for (const e of list) {
    const p = partOf(new Date(e.at).getHours());
    const last = parts.at(-1);
    if (last?.part === p) last.lines.push(lineOf(e));
    else parts.push({ part: p, lines: [lineOf(e)] });
  }
  const today = now >= dayStart(day) && now < dayEnd(day);
  const inDay = events.filter((e) => e.at >= dayStart(day) && e.at < dayEnd(day));
  // Something with no time to it (a show with only its date, say) counts too.
  const aside = inDay.some((e) => untimed(e) && e.kind !== 'steps' && e.kind !== 'notification');
  return { day, intro: intro(events, day, own, { voice, today }), parts, own, count: inDay.length, empty: !list.length && !aside && !own };
}

// ---------- as text: kept for the AI's journal and the Player's edits, and for sharing

const HEADING = new RegExp(`^(${PARTS.map((p) => PART_NAMES[p]).join('|')}):?$`, 'i');
const partByName = (name: string) => PARTS.find((p) => PART_NAMES[p].toLowerCase() === name.toLowerCase().replace(/:$/, ''))!;

export function toText(doc: JournalDoc): string {
  const out: string[] = [];
  if (doc.intro.trim()) out.push(doc.intro.trim());
  for (const p of doc.parts) if (p.lines.length) out.push(`${PART_NAMES[p.part]}\n${p.lines.join('\n')}`);
  return out.join('\n\n');
}

export function parseText(text: string): JournalDoc {
  const intro: string[] = [];
  const parts: JournalDoc['parts'] = [];
  for (const raw of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (HEADING.test(line)) {
      const part = partByName(line);
      const same = parts.find((p) => p.part === part);
      if (same) parts.push(parts.splice(parts.indexOf(same), 1)[0]);
      else parts.push({ part, lines: [] });
      continue;
    }
    if (parts.length) parts.at(-1)!.lines.push(line);
    else intro.push(line);
  }
  return { intro: intro.join('\n'), parts: parts.filter((p) => p.lines.length) };
}

// A line of a built journal, split into its time and what happened, for the screen.
export function splitLine(line: string): { time: string; text: string } {
  const m = /^(\d{2}:\d{2}(?: to \d{2}:\d{2})?)\s+(.*)$/.exec(line);
  return m ? { time: m[1], text: m[2] } : { time: '', text: line };
}

// One line about the day, for a notification: the start of the paragraph at the top.
export function lineFor(doc: JournalDoc, max = 140): string {
  const first = doc.intro.split('\n')[0].trim() || doc.parts[0]?.lines[0] || '';
  const sentence = /^(.+?[.!?])(\s|$)/.exec(first)?.[1] || first;
  return clip(sentence, max);
}

// The journal as text to share or copy, with the Player's own words.
export function shareText(doc: JournalDoc, { title, own }: { title: string; own?: Own | null }): string {
  const out = [title, '', toText(doc)];
  if (own?.text || own?.energy) out.push('', `In my words${own.energy ? ` (energy ${own.energy}/5)` : ''}${own.text ? `: ${own.text}` : ''}`);
  return out.join('\n').trim();
}
