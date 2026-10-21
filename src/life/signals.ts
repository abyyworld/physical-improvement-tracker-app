// What Arise saw in each day, worked out on this device from what the Player's devices already
// record, so nobody has to rate or write anything: how long they slept (from Health, or worked out
// from when their phone and computer were in use), steps and workouts, the places they went, how
// many people they were in touch with, their focused time, fun and social feeds, meetings, and
// time on screens after midnight. Their own check-in and quests come along when they're there.
//
// Every field is optional: unknown when no source covers that day, so a Mac that was off isn't
// "no focus at all". Each one keeps the tier of what it came from (src/life/types.ts), so the
// coach only gets what its AI may read, and the source it came from in plain words ("phone",
// "Mac", "browser"), for "from your phone, Mac and browser".
//
// No AI and no network: the life log is read on this device and nothing leaves it. What this
// makes is kept in memory only (src/life/insight.ts).
//
// Pure, apart from daySignals reading the life log and the app's data: signalsFrom takes both.

import * as S from '../store';
import * as G from '../lib/goals';
import type { Category as GoalCategory } from '../lib/goals';
import { appOf, categorize, isBrowserApp, siteOf as domainOf, type Category } from '../lib/categories';
import type { DayRow } from '../lib/patterns';
import type { State } from '../lib/validate';
import * as L from './log';
import { hasLifeStore } from './store-port';
import { addDays, dayEnd, dayKey, dayStart } from './dates';
import { siteOf as siteName } from './diary';
import { rowsFrom, wentThrough } from './rows';
import type { LifeEvent, LifeKind, LifeTier } from './types';

import { SOURCE_ORDER } from './areas';
export { lifeAreas, seenToday, sourcesText, weekCompare, signalsText, NOT_ENOUGH, SOURCE_ORDER, type LifeArea, type Seen, type Trend, type WeekCompare, type WeekField } from './areas';

const MIN = 60000;
const HOUR = 60 * MIN;

// Where something came from, in the words people use for their devices.
export type SourceWord = 'phone' | 'Mac' | 'browser' | 'bank statements' | 'imports' | 'Arise';

export type SignalField =
  | 'sleepMin'
  | 'bedtime'
  | 'wake'
  | 'steps'
  | 'active'
  | 'places'
  | 'outside'
  | 'people'
  | 'calls'
  | 'messages'
  | 'focusMin'
  | 'funMin'
  | 'socialMin'
  | 'screenMin'
  | 'meetingsMin'
  | 'lateMin'
  | 'spent'
  | 'quests'
  | 'trained'
  | 'mood';

// One day. A missing field is unknown.
export interface DaySignals {
  day: string; // 2026-10-17
  // The night that ended this morning: from Health, else worked out from when the devices were
  // in use ('inferred', said as "about").
  sleepMin?: number;
  sleepFrom?: 'health' | 'inferred';
  bedtime?: number; // minutes after this day's midnight: -60 is 23:00 the evening before
  wake?: number; // 420 is 07:00
  steps?: number;
  active?: number; // minutes of workouts: in Arise, and recorded by other apps
  places?: number; // places they went other than home (where they were at 3 am most often; until that's known, every place)
  outside?: boolean; // went somewhere, or were on the move
  people?: number; // people in touch: calls, messages, emails from people (not notifications)
  talked?: boolean; // a call or a message with someone, not an email (rows.ts's "in touch")
  calls?: number; // calls that went through
  messages?: number; // messages sent and received (not emails)
  focusMin?: number; // time in work and study apps and sites
  funMin?: number; // videos, games and music
  socialMin?: number; // social feeds
  screenMin?: number; // all the time in apps and on sites
  meetingsMin?: number; // timed calendar events, clipped to the day
  lateMin?: number; // time on a device between midnight and 5 am
  spent?: number; // money out, from bank statements
  spentUnit?: string; // its currency, as the statement had it
  due?: number; // quests due that day (rows.ts)
  done?: number;
  questsBy?: Partial<Record<GoalCategory, { due: number; done: number }>>; // the same, by the goal's kind
  trained?: boolean; // a workout in Arise or another app
  mood?: number; // their check-in, else a mood they added, else Apple's State of Mind (rows.ts)
  s?: number; // their own check-in, when there is one (optional extras, never needed)
  e?: number;
  m?: number;
  top?: Partial<Record<Exclude<Category, 'other'>, string[]>>; // the apps and sites with the most time, most first
  tier: Partial<Record<SignalField, LifeTier>>;
  from: Partial<Record<SignalField, SourceWord[]>>;
}

// ---------- where it came from

export function sourceWord(e: Pick<LifeEvent, 'source' | 'id'>): SourceWord {
  switch (e.source) {
    case 'arise':
    case 'manual':
      return 'Arise';
    case 'mac':
      return 'Mac';
    case 'browser':
      return 'browser';
    case 'health':
    case 'android':
    case 'shortcut':
    case 'calendar':
      return 'phone';
    case 'maps':
      // The iPhone's motion and places; a Maps Timeline export is an import.
      return /^maps:(motion|visit):/.test(e.id) ? 'phone' : 'imports';
    case 'bank':
      return 'bank statements';
    default:
      return 'imports';
  }
}

const words = (xs: Iterable<SourceWord>): SourceWord[] => {
  const set = new Set(xs);
  return SOURCE_ORDER.filter((w) => set.has(w));
};
const maxTier = (xs: Iterable<LifeTier>, floor: LifeTier = 1): LifeTier => {
  let t = floor;
  for (const x of xs) if (x > t) t = x;
  return t;
};

// ---------- times

// How long it lasted: the minutes the source recorded, else from its start to its end.
const minutesOf = (e: LifeEvent) => (typeof e.value === 'number' && e.value > 0 && /^min/i.test(e.unit || '') ? e.value : e.end && e.end > e.at ? (e.end - e.at) / MIN : 0);
const local = (t: number) => new Date(t);
const atMidnight = (t: number) => local(t).getHours() === 0 && local(t).getMinutes() === 0;
// On the hour to the millisecond: where Arise files something that has no time of its own (a
// quest ticked for another day goes at noon), not a moment the Player was there.
const placeholder = (t: number) => {
  const d = local(t);
  return d.getMinutes() === 0 && d.getSeconds() === 0 && d.getMilliseconds() === 0;
};
// Things that belong to the day or to a stretch of days, not to a time in it (as diary.ts).
const untimed = (e: LifeEvent) =>
  e.meta?.dateOnly === true || e.meta?.allDay === true || typeof e.meta?.span === 'string' || e.meta?.approx === true || (!!e.end && e.end - e.at >= 20 * HOUR && (typeof e.meta?.day === 'string' || atMidnight(e.at)));

// ---------- when the Player was using something

// A stretch of time the Player was doing something on a device: `from` and `to` for when it
// started and ended, `use` for how much of it was really in use (an hour's app time is often a few
// minutes in it). `own`: Arise itself (a check-in, a quest ticked), which helps but can't show a
// night on its own.
export interface Span {
  from: number;
  to: number;
  use: number; // ms
  tier: LifeTier;
  word: SourceWord;
  own?: boolean;
  // On a phone or a computer (an app, a site, a message sent, something saved in Arise, a game or
  // a video), not a trip, a workout, a call or a place: what "on a screen after midnight" counts.
  screen?: boolean;
}

const point = (t: number, e: LifeEvent, screen = false): Span => ({ from: t, to: t + MIN, use: 2 * MIN, tier: e.tier, word: sourceWord(e), own: e.source === 'arise' || undefined, screen: screen || undefined });
const whole = (e: LifeEvent, from: number, to: number, screen = false): Span => ({ from, to, use: to - from, tier: e.tier, word: sourceWord(e), own: e.source === 'arise' || undefined, screen: screen || undefined });

// When an event shows the Player awake and doing something (an empty list: it doesn't). Not:
// anything that comes in on its own while they sleep (notifications, messages and emails
// received, missed calls, music playing), calendar events, sleep itself, and things with only a
// date.
export function spansOf(e: LifeEvent): Span[] {
  if (untimed(e)) return [];
  if (e.source === 'arise') {
    if (placeholder(e.at)) return [];
    if (e.kind === 'workout' && e.end && e.end > e.at) return [whole(e, e.at, e.end)];
    return ['quest', 'mood', 'note', 'message', 'health', 'other', 'workout'].includes(e.kind) ? [point(e.at, e, true)] : [];
  }
  switch (e.kind as LifeKind) {
    case 'app': {
      const m = Math.min(minutesOf(e), 60) * MIN;
      if (!(m > 0)) return [point(e.at, e, true)];
      // The browser extension: time on a site in one hour, up to `end`.
      if (e.source === 'browser' && e.end && e.end > e.at) return [{ from: Math.max(e.at, e.end - m), to: e.end, use: m, tier: e.tier, word: sourceWord(e), screen: true }];
      // The Mac helper: first and last use in that hour; Shortcuts: opened and closed.
      if (e.end && e.end > e.at) return [{ from: e.at, to: e.end, use: Math.min(m, e.end - e.at), tier: e.tier, word: sourceWord(e), screen: true }];
      // Android: so many minutes somewhere in that hour, taken from its middle.
      const mid = e.at + 30 * MIN;
      return [{ from: mid - m / 2, to: mid + m / 2, use: m, tier: e.tier, word: sourceWord(e), screen: true }];
    }
    case 'visit':
    case 'search':
      return [point(e.at, e, true)];
    case 'message':
      return e.meta?.direction === 'out' && e.meta?.channel !== 'email' ? [point(e.at, e, true)] : [];
    case 'call': {
      if (e.meta?.missed === true) return [];
      return [e.end && e.end > e.at ? whole(e, e.at, e.end) : point(e.at, e)];
    }
    case 'steps':
      // Only steps with a time (not a day's total).
      return e.end && e.end > e.at && e.end - e.at <= 3 * HOUR ? [whole(e, e.at, e.end)] : [];
    case 'trip':
    case 'workout':
      return [e.end && e.end > e.at && e.end - e.at <= 16 * HOUR ? whole(e, e.at, e.end) : point(e.at, e)];
    case 'play':
    case 'watch':
      return [e.end && e.end > e.at && e.end - e.at <= 16 * HOUR ? whole(e, e.at, e.end, true) : point(e.at, e, true)];
    case 'place':
      // Arriving and leaving are moments they were up; the stay in between may be a night's sleep.
      return [point(e.at, e), ...(e.end && e.end > e.at ? [point(e.end, e)] : [])];
    default:
      return [];
  }
}

// Arise's own moments from the app's data: check-ins saved, quests ticked, workouts, questions to
// the coach. (They are in the life log too when it keeps up; twice does no harm here.)
export function ownSpans(st: Pick<State, 'logs' | 'checks' | 'sessions' | 'ai'>): Span[] {
  const out: Span[] = [];
  const add = (t: unknown, to?: unknown, screen = true) => {
    if (typeof t !== 'number' || !(t > 0) || placeholder(t)) return;
    const end = typeof to === 'number' && to > t && to - t < 6 * HOUR ? to : t + MIN;
    out.push({ from: t, to: end, use: end - t, tier: 1, word: 'Arise', own: true, screen: screen || undefined });
  };
  for (const l of Object.values(st.logs || {})) add(l?.at);
  for (const day of Object.values(st.checks || {})) for (const c of Object.values(day || {})) add(c?.at);
  for (const s of st.sessions || []) add(s.started, s.finished, false);
  for (const m of st.ai?.chat || []) if (m.role === 'user') add(m.at);
  return out;
}

// ---------- sleep from activity

export interface Night {
  min: number; // minutes asleep
  bed: number; // when it started (ms)
  wake: number; // when it ended (ms)
  tier: LifeTier;
  from: SourceWord[];
}

const SHORT_WAKE = 20 * MIN; // up in the night this long or less (between 00:30 and 06:30)...
const BACK_ASLEEP = 90 * MIN; // ...with this long asleep on the other side: the same night

// The night that ended on the morning of `day`, from when the Player's devices were in use: the
// longest stretch with nothing between the evening (from 18:00) and the morning (until 14:00),
// with activity on both sides of it, its middle in the night (22:00 to 10:00), and a short time up
// in the night (a few minutes on the phone at 3 am, with 90 minutes or more asleep on each side)
// still part of it. Kept when it's 3 to 12 hours, starts at 21:00 or later and ends at 04:00 or
// later: a laptop shut at 19:00 and opened at 08:30 is a gap, not a 13-hour night. Arise's own
// moments count, but only with something else on one side of the night: a check-in before bed and
// another in the morning aren't enough on their own. Not while the night may still be going on:
// it needs to have ended an hour before `now`, and a few minutes up in the night with nothing
// after them yet isn't the morning (the hour's app time often comes in only after the hour).
export function inferSleep(spans: readonly Span[], day: string, now = Date.now()): Night | null {
  const midnight = dayStart(day);
  const start = midnight - 6 * HOUR;
  const stop = midnight + 14 * HOUR;
  const win = spans.filter((s) => s.to > start && s.from < stop).map((s) => ({ ...s, from: Math.max(s.from, start), to: Math.min(s.to, stop) }));
  if (!win.some((s) => !s.own)) return null;
  win.sort((a, b) => a.from - b.from);
  // Busy stretches, with what's in each.
  const blocks: { from: number; to: number; spans: Span[] }[] = [];
  for (const s of win) {
    const last = blocks.at(-1);
    if (last && s.from <= last.to + MIN) {
      last.to = Math.max(last.to, s.to);
      last.spans.push(s);
    } else blocks.push({ from: s.from, to: s.to, spans: [s] });
  }
  if (blocks.length < 2) return null;
  const gaps = blocks.slice(1).map((b, i) => ({ i, from: blocks[i].to, to: b.from, len: b.from - blocks[i].to }));
  const night = gaps.filter((g) => {
    const mid = (g.from + g.to) / 2;
    return mid >= midnight - 2 * HOUR && mid <= midnight + 10 * HOUR;
  });
  if (!night.length) return null;
  const longest = night.reduce((a, b) => (b.len > a.len ? b : a));
  let first = longest.i;
  let last = longest.i;
  // Back to sleep after a short time up in the night, on either side.
  const shortWake = (b: { from: number; to: number }) => {
    const mid = (b.from + b.to) / 2;
    return b.to - b.from <= SHORT_WAKE && mid >= midnight + 30 * MIN && mid <= midnight + 6.5 * HOUR;
  };
  while (first > 0 && shortWake(blocks[first]) && gaps[first - 1].len >= BACK_ASLEEP) first--;
  while (last < gaps.length - 1 && shortWake(blocks[last + 1]) && gaps[last + 1].len >= BACK_ASLEEP) last++;
  const asleep = gaps.slice(first, last + 1).reduce((n, g) => n + g.len, 0);
  const bed = gaps[first].from;
  const wake = gaps[last].to;
  if (asleep < 3 * HOUR || wake - bed > 12 * HOUR) return null;
  if (bed < midnight - 3 * HOUR || wake < midnight + 4 * HOUR) return null;
  if (now - wake < HOUR) return null;
  if (last + 1 === blocks.length - 1 && shortWake(blocks[last + 1])) return null;
  const used = [...blocks[first].spans, ...blocks[last + 1].spans];
  if (!used.some((s) => !s.own)) return null;
  // Sleep is sensitive whatever it was worked out from (src/life/tiers.ts).
  return { min: Math.round(asleep / MIN), bed, wake, tier: maxTier(win.map((s) => s.tier), 3), from: words(used.filter((s) => !s.own).map((s) => s.word)) };
}

// Minutes in use between `from` and `to`, each moment once however many devices were busy.
function usedBetween(spans: readonly Span[], from: number, to: number): number {
  const parts = spans
    .map((s) => ({ a: Math.max(s.from, from), b: Math.min(s.from + Math.max(s.use, MIN), s.to + MIN, to) }))
    .filter((p) => p.b > p.a)
    .sort((x, y) => x.a - y.a);
  let total = 0;
  let a = -Infinity;
  let b = -Infinity;
  for (const p of parts) {
    if (p.a > b) {
      if (b > a) total += b - a;
      a = p.a;
      b = p.b;
    } else b = Math.max(b, p.b);
  }
  if (b > a) total += b - a;
  return Math.round(total / MIN);
}

// ---------- people

const AUTOMATED = /^(no-?reply|do-?not-?reply|donotreply|notifications?|notify|alerts?|news(letters?)?|info|support|help|hello|hi|team|updates?|marketing|mailer(-daemon)?|bounces?|billing|receipts?|orders?|accounts?|service|contact|admin|security|feedback|digest|community|jobs|careers|events?|promo(tions)?|offers?|deals?|store|shop|sales)([+._-][^@]*)?@/i;
// "no.reply", "account-noreply", "auto-confirm": a machine anywhere in the part before the @.
const AUTOMATED_PART = /(^|[._+-])(no[._-]?reply|do[._-]?not[._-]?reply|donotreply|mailer[._-]?daemon|bounces?|auto[._-]?(confirm|reply|mated)?|notifications?)([._+-][^@]*)?@/i;
const AUTOMATED_NAME = /\b(no-?reply|newsletter|notifications?|team|support|digest|updates?)\b/i;
const digits = (s: string) => s.replace(/\D/g, '');
const machine = (address: string) => AUTOMATED.test(address) || AUTOMATED_PART.test(address);

// The same person however they're written: a phone number by its last 9 digits, an address or a
// name in lower case.
function personKey(raw: string): string {
  const s = raw.trim().toLowerCase();
  if (!s) return '';
  const d = digits(s);
  if (/^[\d\s+().-]+$/.test(s) && d.length >= 7) return `tel:${d.slice(-9)}`;
  return s.replace(/^mailto:/, '');
}

// Who the call or message was with, from what the source kept, else from its title.
const WHO = [
  /^(?:missed |declined a |blocked a )?(?:[\w-]+ )?call (?:from|to) (.+?)(?:, .*)?$/i,
  /^called (.+?)(?: \(.*\))?$/i,
  /^voicemail from (.+)$/i,
  /^message (?:from|to) (.+?)(?: in .+)?$/i,
  /^(?:message|email): (.+)$/i,
  /^email from (.+)$/i,
  /^chatted with (.+?): \d.*$/i,
];
function whoOf(e: LifeEvent): string {
  for (const k of ['with', 'number', 'chat', 'name'] as const) {
    const v = e.meta?.[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  for (const re of WHO) {
    const m = re.exec(e.title.trim());
    if (m) return m[1];
  }
  return '';
}
const isEmail = (e: LifeEvent) => e.source === 'email' || e.meta?.channel === 'email' || e.meta?.via === 'email';

// The address in "Jane Doe <jane@example.com>", or the first in a list of them.
const addressIn = (s: string) => (/<([^<>\s]+@[^<>\s]+)>/.exec(s)?.[1] || /[^\s<>,;"']+@[^\s<>,;"']+/.exec(s)?.[0] || '').toLowerCase();
const nameIn = (s: string) => (s.includes('<') ? s.slice(0, s.indexOf('<')).replace(/["']/g, '').trim() : '');

// An email's person: the address it came from or went to, never its subject (Gmail and Outlook
// title an email "Email from Jane: Lunch?"), and nobody when it's a machine.
function emailPerson(e: LifeEvent): string {
  const raw = (['with', 'to', 'from'] as const).map((k) => e.meta?.[k]).find((v): v is string => typeof v === 'string' && !!v.trim()) || '';
  // A linked account's title has the subject in it; a Shortcut's, what the email said.
  const titled = e.source === 'email' || e.source === 'shortcut';
  const address = addressIn(raw || (e.source === 'shortcut' ? e.title : ''));
  const name = nameIn(raw) || (titled ? '' : /^email from (.+)$/i.exec(e.title.trim())?.[1] || '');
  if (AUTOMATED_NAME.test(name)) return '';
  if (address) return machine(address) ? '' : address;
  if (titled) return '';
  const who = raw || name;
  return /^(someone|an unknown number)$/i.test(who) ? '' : personKey(who);
}

// A Shortcuts automation logs the message itself, unless they picked the Sender ("Message: Alex",
// "Message: +44 7700 900123"): a name or a number looks like one, a sentence doesn't.
const OPENERS = /^(hi|hey|hello|hiya|yo|ok|okay|yes|yeah|no|nope|thanks|thank|cheers|good|happy|merry|see|love|miss|sorry|on|in|at|i|i'm|im|me|we|you|your|my|the|a|what|when|where|who|how|why|sure|cool|great|nice|lol|haha|omg|call|just|can|could|will|did|are|is|let's|lets|morning|night)$/i;
function senderIn(text: string): string {
  const s = text.trim();
  if (/^[\d\s+().-]+$/.test(s) && digits(s).length >= 7) return s;
  if (addressIn(s)) return addressIn(s);
  const words = s.split(/\s+/);
  if (!s || words.length > 3 || s.length > 40 || OPENERS.test(words[0])) return '';
  return words.every((w) => /^\p{Lu}[\p{L}'’.-]*$/u.test(w)) ? s : '';
}

// A handle that isn't a person: a short code ("72975", a sign-in code) or a sender's name in
// letters ("AMAZON", "HMRC"). A person's handle is a phone number or an address.
const machineHandle = (h: string) => !h.includes('@') && digits(h).length < 7;

// The person a call or message was with, or '' when it wasn't someone (the coach, a newsletter,
// a missed call, a call nobody answered, a text from a company).
export function personOf(e: LifeEvent): string {
  if (e.source === 'arise' || (e.kind !== 'call' && e.kind !== 'message')) return '';
  if (!wentThrough(e)) return '';
  if (isEmail(e)) return emailPerson(e);
  if (e.source === 'shortcut') return personKey(senderIn(/^message: (.+)$/i.exec(e.title.trim())?.[1] || ''));
  const handle = (['with', 'number'] as const).map((k) => e.meta?.[k]).find((v): v is string => typeof v === 'string' && !!v.trim());
  if (handle && machineHandle(handle)) return '';
  const who = whoOf(e);
  if (/^(someone|an unknown number|a private number)$/i.test(who)) return '';
  return personKey(who);
}

// ---------- time on screens

const hourOf = (t: number) => {
  const d = local(t);
  d.setMinutes(0, 0, 0);
  return d.getTime();
};
const onMac = (e: LifeEvent) => (e.source === 'mac' && e.meta?.device !== 'other') || (e.source === 'browser' && typeof e.meta?.browser === 'string' && /mac/i.test(e.meta.browser) && e.meta?.otherDevice !== true);

interface Screen {
  min: Record<Category, number>;
  tiers: Record<Category, LifeTier[]>;
  words: SourceWord[];
  names: Record<Category, Map<string, number>>;
}

// The day's time in apps and on sites, by kind. Time in a browser is split by the sites visited
// on that device in that hour; where the browser extension timed the sites itself (on a Mac), its
// time takes the place of the same hour's browser time from the Mac helper, so nothing counts
// twice.
function screenOf(apps: readonly LifeEvent[], visits: readonly LifeEvent[]): Screen | null {
  if (!apps.length) return null;
  const out: Screen = {
    min: { work: 0, fun: 0, social: 0, other: 0 },
    tiers: { work: [], fun: [], social: [], other: [] },
    words: [],
    names: { work: new Map(), fun: new Map(), social: new Map(), other: new Map() },
  };
  const add = (c: Category, m: number, tier: LifeTier, name: string) => {
    if (!(m > 0)) return;
    out.min[c] += m;
    out.tiers[c].push(tier);
    if (name) out.names[c].set(name, (out.names[c].get(name) || 0) + m);
  };
  // The extension's time in each browser on a Mac, by hour: it stands in for that browser's time
  // from the Mac helper. ("Chrome on macOS": Chrome; "Chromium" is any browser built on it.)
  const timed: { hour: number; family: string; min: number }[] = [];
  for (const e of apps) {
    if (e.source !== 'browser' || !onMac(e)) continue;
    const family = String(e.meta?.browser || '').split(' ')[0].toLowerCase();
    const hour = hourOf(e.at);
    const t = timed.find((x) => x.hour === hour && x.family === family);
    if (t) t.min += minutesOf(e);
    else timed.push({ hour, family, min: minutesOf(e) });
  }
  const same = (family: string, app: LifeEvent) => {
    if (!family || family === 'chromium' || family === 'browser') return true;
    const { name, id } = appOf(app);
    return `${name} ${id}`.toLowerCase().includes(family);
  };
  const visitsIn = new Map<number, LifeEvent[]>();
  for (const v of visits) {
    const h = hourOf(v.at);
    const list = visitsIn.get(h);
    if (list) list.push(v);
    else visitsIn.set(h, [v]);
  }
  for (const e of apps) {
    out.words.push(sourceWord(e));
    let m = minutesOf(e);
    if (e.source === 'browser') {
      const site = domainOf(e);
      add(categorize(e), m, e.tier, site ? siteName({ url: `https://${site}/`, title: site }) : '');
      continue;
    }
    if (!isBrowserApp(e)) {
      add(categorize(e), m, e.tier, appOf(e).name);
      continue;
    }
    const h = hourOf(e.at);
    if (e.source === 'mac') {
      for (const t of timed) {
        if (t.hour !== h || !(t.min > 0) || !same(t.family, e)) continue;
        const took = Math.min(m, t.min);
        t.min -= took;
        m -= took;
      }
    }
    if (!(m > 0)) continue;
    // The sites visited on this device in this hour, each a share of the time: in this browser
    // when the visits say which (the Mac helper reads Safari's history and Chrome's, Arc's...).
    const here = (visitsIn.get(h) || []).filter((v) => v.source === e.source && (e.source !== 'mac' || onMac(v)));
    const inThis = here.filter((v) => typeof v.meta?.browser === 'string' && v.meta.browser.trim() !== '' && same(v.meta.browser.trim().toLowerCase(), e));
    const seen = inThis.length ? inThis : here;
    if (!seen.length) {
      add('other', m, e.tier, appOf(e).name);
      continue;
    }
    for (const v of seen) add(v.kind === 'search' ? 'other' : categorize(v), m / seen.length, maxTier([e.tier, v.tier]), v.kind === 'search' ? '' : siteName(v));
  }
  return out;
}

// The service a game or a video came from, by its history ("netflix", "spotify", "steam").
const serviceOf = (e: LifeEvent) => {
  const s = String(e.source || '').toLowerCase();
  return s.length >= 4 && s !== 'arise' && s !== 'manual' ? s : '';
};

// The minutes of games and videos (Netflix's or Spotify's own history, a console) that the
// devices hadn't already counted: an episode watched on netflix.com or in the Netflix app is in
// both, so each hour's time on a service counts once.
function notCounted(played: readonly LifeEvent[], apps: readonly LifeEvent[], visits: readonly LifeEvent[]): number {
  const left = new Map<string, number>(); // "netflix 1760900400000": a device's minutes on it in that hour
  for (const service of new Set(played.map(serviceOf).filter(Boolean))) {
    for (const a of apps) {
      const h = hourOf(a.at);
      const { name, id } = appOf(a);
      let m = 0;
      if (`${name} ${id} ${domainOf(a)}`.toLowerCase().includes(service)) m = minutesOf(a);
      else if (isBrowserApp(a)) {
        // A browser's share of the hour on that service's site, as screenOf splits it.
        const seen = visits.filter((v) => v.source === a.source && hourOf(v.at) === h);
        const on = seen.filter((v) => domainOf(v).includes(service)).length;
        if (on) m = (minutesOf(a) * on) / seen.length;
      }
      if (m > 0) left.set(`${service} ${h}`, (left.get(`${service} ${h}`) || 0) + m);
    }
  }
  let total = 0;
  for (const e of played) {
    const service = serviceOf(e);
    const end = e.at + minutesOf(e) * MIN;
    for (let t = e.at; t < end; ) {
      const h = hourOf(t);
      const to = Math.min(end, h + HOUR);
      const m = (to - t) / MIN;
      const key = `${service} ${h}`;
      const took = service ? Math.min(left.get(key) || 0, m) : 0;
      if (took) left.set(key, (left.get(key) || 0) - took);
      total += m - took;
      t = to > t ? to : end;
    }
  }
  return total;
}

const top = (names: Map<string, number>) =>
  [...names.entries()]
    .filter(([n, m]) => n && m >= 5)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([n]) => n);

// ---------- the days

// The days of the range that a kind of source covers: from its first day to its last, and on to
// the end of the range when it was still going in the last 3 days (a source that stopped leaves
// the days after it unknown, not empty).
function covered(days: readonly string[], toKey: string | null): (k: string) => boolean {
  if (!days.length) return () => false;
  const first = days.reduce((a, b) => (b < a ? b : a));
  let last = days.reduce((a, b) => (b > a ? b : a));
  if (toKey && last >= addDays(toKey, -3)) last = toKey;
  return (k) => k >= first && k <= last;
}

const rating = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 5 ? v : undefined);

// Where a place is, when the source said.
const coordsOf = (e: LifeEvent) => {
  const lat = e.meta?.lat;
  const lon = e.meta?.lon ?? e.meta?.lng;
  return typeof lat === 'number' && typeof lon === 'number' && Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
};
// Metres between two points, near enough for a street.
const metres = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) =>
  Math.hypot((b.lon - a.lon) * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180) * 111320, (b.lat - a.lat) * 110540);
const NEAR = 150;

// A time as minutes after `midnight` on the clock (-60 is 23:00 the evening before), so a night the
// clocks change doesn't move bedtime or waking by an hour.
const clockMin = (t: number, midnight: number) => {
  const d = local(t);
  const m = d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60 + d.getMilliseconds() / MIN;
  return Math.round(t < midnight ? m - 1440 : m);
};

// Minutes covered by some stretches of time, each moment once.
const unionMin = (parts: [number, number][]) => {
  let total = 0;
  let to = -Infinity;
  for (const [a, b] of [...parts].sort((x, y) => x[0] - y[0])) {
    if (b <= to) continue;
    total += b - Math.max(a, to);
    to = b;
  }
  return total / MIN;
};

// Football in Arise is a day, not a time: a match or a training counts as this long.
const FOOTBALL_MIN = 90;

const isPurchase =(e: LifeEvent) => e.kind === 'purchase' && typeof e.value === 'number' && Number.isFinite(e.value);

// Signals for the days from `fromKey` to `toKey` (both included), oldest first, from the life log
// (from the evening before the first day) and the app's data.
export function signalsFrom(events: readonly LifeEvent[], fromKey: string, toKey: string, st: Pick<State, 'logs' | 'sessions' | 'goals' | 'checks' | 'ai'> & Partial<Pick<State, 'football'>>): DaySignals[] {
  const rows = new Map(rowsFrom(events, fromKey, toKey, st).map((r) => [r.day, r]));
  const byDay = new Map<string, LifeEvent[]>();
  for (const e of events) {
    const k = dayKey(e.at);
    const list = byDay.get(k);
    if (list) list.push(e);
    else byDay.set(k, [e]);
  }
  const on = (k: string) => byDay.get(k) || [];
  const own = (e: LifeEvent) => e.source === 'arise';

  // Every moment the Player was up and doing something.
  const spans = [...events.flatMap(spansOf), ...ownSpans(st)].sort((a, b) => a.from - b.from);
  const daysOf = (f: (e: LifeEvent) => boolean) => [...new Set(events.filter(f).map((e) => dayKey(e.at)))];

  // Calls and messages with someone; places and moving about; the calendar; bank statements.
  const talk = (e: LifeEvent) => (e.kind === 'call' || e.kind === 'message') && !own(e);
  const talkDays = covered(daysOf(talk), toKey);
  const placeKind = (e: LifeEvent) => (e.kind === 'place' || e.kind === 'trip') && !untimed(e);
  const placeDays = covered(daysOf(placeKind), toKey);
  const calendar = (e: LifeEvent) => e.kind === 'event' && !own(e);
  const calDays = covered(daysOf(calendar), toKey);
  const bank = events.filter((e) => e.source === 'bank' && isPurchase(e));
  const bankDays = covered(daysOf((e) => e.source === 'bank' && isPurchase(e)), null); // a statement covers its first day to its last
  const units = new Map<string, number>();
  for (const e of bank) units.set(e.unit || '', (units.get(e.unit || '') || 0) + 1);
  const unit = [...units.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
  // Workouts: Arise's training, or another app that records them.
  const workouts = events.filter((e) => e.kind === 'workout' && !own(e) && !untimed(e));
  const football = new Set(st.football || []);
  const trains = st.sessions.length > 0 || football.size > 0;
  // Health's nights (as rows.ts): not a nap, 3 hours or more.
  const sleeps = events.filter((e) => e.kind === 'sleep' && e.end && !/^napped/i.test(e.title) && minutesOf(e) >= 180);
  // Where a field known to be empty came from: that kind of source, on any day.
  const wordsOf = (f: (e: LifeEvent) => boolean) => words(events.filter(f).map(sourceWord));
  const talkWords = wordsOf(talk);
  const placeWords = wordsOf(placeKind);
  const calWords = wordsOf(calendar);
  const isWorkout = new Set(workouts);
  const workoutWords = wordsOf((e) => isWorkout.has(e) || e.kind === 'steps');

  // Home: where they were at 3 am most often. A place with coordinates is home when it's within
  // 150 m of where most nights were spent (the iPhone's visits move about a little); one with a
  // name (a Shortcut's "Arrived at Home") when it's that name or "Home".
  const placeId = (e: LifeEvent) => {
    if (typeof e.meta?.placeId === 'string') return `id:${e.meta.placeId}`;
    const c = coordsOf(e);
    if (c) return `${c.lat.toFixed(3)},${c.lon.toFixed(3)}`;
    return e.title.replace(/^(At|Arrived at|Left|Wi-Fi:)\s+/i, '').trim().toLowerCase();
  };
  const nights = new Map<string, number>();
  const nightSpots: { lat: number; lon: number }[] = [];
  for (const e of events) {
    if (e.kind !== 'place' || !e.end) continue;
    for (let k = dayKey(e.at); k <= dayKey(e.end); k = addDays(k, 1)) {
      const three = dayStart(k) + 3 * HOUR;
      if (!(e.at <= three && e.end >= three)) continue;
      const c = coordsOf(e);
      if (c) nightSpots.push(c);
      else nights.set(placeId(e), (nights.get(placeId(e)) || 0) + 1);
    }
  }
  let homeAt: { lat: number; lon: number } | null = null;
  let homeNights = 0;
  for (const a of nightSpots) {
    const near = nightSpots.filter((b) => metres(a, b) <= NEAR);
    if (near.length > homeNights) {
      homeNights = near.length;
      homeAt = { lat: near.reduce((n, b) => n + b.lat, 0) / near.length, lon: near.reduce((n, b) => n + b.lon, 0) / near.length };
    }
  }
  const [homeKey, homeKeyNights] = [...nights.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  if (homeKeyNights > homeNights) homeAt = null;
  const atHome = (e: LifeEvent) => {
    const c = coordsOf(e);
    if (c && homeAt) return metres(c, homeAt) <= NEAR;
    const id = placeId(e);
    return id === 'home' || (!homeAt && id === homeKey);
  };
  // Joining a Wi-Fi network isn't going somewhere (it may be home's, again).
  const wifi = (e: LifeEvent) => e.meta?.via === 'wifi' || /^Wi-Fi\b/i.test(e.title);

  // Quests by the kind of goal, as rows.ts counts them (the few-times-a-week ones aren't due on a day).
  const quests = st.goals.filter((g) => g.status === 'active').flatMap((g) => g.quests.filter((q) => q.schedule.kind !== 'weekly').map((q) => ({ q, cat: g.category })));
  // Arise's workouts, as the time they took (one with no times counts as a workout, not as minutes).
  const sessionTimes = new Map<string, [number, number][]>();
  for (const s of st.sessions) {
    const m = s.finished > s.started && s.started ? Math.min(240, Math.round((s.finished - s.started) / MIN)) : 0;
    const list = sessionTimes.get(s.date) || [];
    if (m > 0) list.push([s.started, s.started + m * MIN]);
    sessionTimes.set(s.date, list);
  }

  const out: DaySignals[] = [];
  for (let k = fromKey; k <= toKey; k = addDays(k, 1)) {
    const r: DayRow = rows.get(k) || { day: k };
    const sig: DaySignals = { day: k, tier: {}, from: {} };
    const set = <F extends SignalField>(f: F, tier: LifeTier, from: Iterable<SourceWord>) => {
      sig.tier[f] = tier;
      const w = words(from);
      if (w.length) sig.from[f] = w;
    };
    const day = on(k);
    const midnight = dayStart(k);

    // Sleep: Health's night (rows.ts), else worked out from the devices.
    const healthNight = sleeps.filter((e) => e.end! >= midnight && e.end! < dayEnd(k)).sort((a, b) => minutesOf(b) - minutesOf(a))[0];
    if (typeof r.sleepMin === 'number') {
      sig.sleepMin = r.sleepMin;
      sig.sleepFrom = 'health';
      const t = maxTier([r.tier?.sleepMin || 3], 3);
      set('sleepMin', t, healthNight ? [sourceWord(healthNight)] : ['phone']);
      if (healthNight) {
        sig.bedtime = clockMin(healthNight.at, midnight);
        sig.wake = clockMin(healthNight.end!, midnight);
        set('bedtime', t, [sourceWord(healthNight)]);
        set('wake', t, [sourceWord(healthNight)]);
      }
    } else {
      const n = inferSleep(spans, k);
      if (n) {
        sig.sleepMin = n.min;
        sig.sleepFrom = 'inferred';
        sig.bedtime = clockMin(n.bed, midnight);
        sig.wake = clockMin(n.wake, midnight);
        for (const f of ['sleepMin', 'bedtime', 'wake'] as const) set(f, n.tier, n.from);
      }
    }

    // Up after midnight: known when the devices were in use that night at all. Only time on a
    // phone or a computer counts (a drive home, a workout or getting somewhere isn't a screen).
    const night = spans.filter((s) => s.to > midnight - 6 * HOUR && s.from < midnight + 14 * HOUR);
    if (night.some((s) => !s.own)) {
      const late = night.filter((s) => s.screen && s.to > midnight && s.from < midnight + 5 * HOUR);
      sig.lateMin = usedBetween(late, midnight, midnight + 5 * HOUR);
      set('lateMin', maxTier((late.length ? late : night.filter((s) => !s.own)).map((s) => s.tier)), (late.length ? late : night).filter((s) => !s.own).map((s) => s.word));
    }

    // Steps (rows.ts: the source that counted most).
    if (typeof r.steps === 'number') {
      sig.steps = r.steps;
      set('steps', r.tier?.steps || 2, day.filter((e) => e.kind === 'steps').map(sourceWord));
    }

    // Workouts.
    const wk = workouts.filter((e) => dayKey(e.at) === k);
    // Known with Arise's training, or with Health or another app that would have recorded one.
    const recorded = workouts.length > 0 || sig.steps != null;
    if (trains || recorded) {
      // Each moment once: an Arise workout a watch recorded too, or a workout read live from Health
      // and again from its export, is one workout.
      const times: [number, number][] = [...(sessionTimes.get(k) || [])];
      for (const e of wk) if (minutesOf(e) > 0) times.push([e.at, e.at + minutesOf(e) * MIN]);
      const kicked = football.has(k) && !wk.some((e) => /football|soccer/i.test(`${e.title} ${e.meta?.type ?? ''} ${e.meta?.activity ?? ''}`));
      sig.active = Math.round(unionMin(times) + (kicked ? FOOTBALL_MIN : 0));
      set('active', recorded ? maxTier(wk.map((e) => e.tier), 2) : 1, [...(trains ? (['Arise'] as SourceWord[]) : []), ...(recorded ? (wk.length ? wk.map(sourceWord) : workoutWords) : [])]);
    }
    if (typeof r.trained === 'boolean') {
      sig.trained = r.trained;
      set('trained', r.tier?.trained || 1, wk.length ? wk.map(sourceWord) : ['Arise']);
    }

    // Places.
    if (placeDays(k)) {
      const here = day.filter(placeKind);
      const visited = new Set(here.filter((e) => e.kind === 'place' && !wifi(e) && !atHome(e)).map(placeId).filter(Boolean));
      sig.places = visited.size;
      sig.outside = visited.size > 0 || here.some((e) => e.kind === 'trip');
      const t = maxTier(here.map((e) => e.tier), 3);
      const w = here.length ? here.map(sourceWord) : placeWords;
      set('places', t, w);
      set('outside', t, w);
    }

    // People.
    if (talkDays(k)) {
      const these = day.filter(talk);
      const who = new Set(these.map(personOf).filter(Boolean));
      sig.people = who.size;
      sig.calls = these.filter((e) => e.kind === 'call' && wentThrough(e)).length;
      sig.messages = Math.round(these.filter((e) => e.kind === 'message' && !isEmail(e)).reduce((n, e) => n + (e.unit === 'messages' && typeof e.value === 'number' && e.value > 0 ? e.value : 1), 0));
      const w = these.length ? these.map(sourceWord) : talkWords;
      for (const f of ['people', 'calls', 'messages'] as const) set(f, 3, w);
    }
    // rows.ts's "in touch with someone": a call or a message, not an email.
    if (typeof r.people === 'boolean') sig.talked = r.people;

    // Screens: focused, fun, social and the rest.
    const apps = day.filter((e) => e.kind === 'app' && minutesOf(e) > 0);
    const screen = screenOf(
      apps,
      day.filter((e) => e.kind === 'visit' || e.kind === 'search'),
    );
    // Games and videos with a length, from anywhere (a console, the TV): fun, not screen time here.
    const played = day.filter((e) => (e.kind === 'play' || e.kind === 'watch') && !untimed(e) && minutesOf(e) > 0);
    if (screen) {
      const all = (Object.values(screen.tiers) as LifeTier[][]).flat();
      const t = maxTier(all, 2);
      sig.screenMin = Math.round(Object.values(screen.min).reduce((a, b) => a + b, 0));
      set('screenMin', t, screen.words);
      sig.focusMin = Math.round(screen.min.work);
      set('focusMin', screen.min.work > 0 ? maxTier(screen.tiers.work, 2) : t, screen.words);
      sig.socialMin = Math.round(screen.min.social);
      set('socialMin', screen.min.social > 0 ? maxTier(screen.tiers.social, 2) : t, screen.words);
      sig.funMin = Math.round(screen.min.fun);
      set('funMin', screen.min.fun > 0 ? maxTier(screen.tiers.fun, 2) : t, screen.words);
      const names = { work: top(screen.names.work), fun: top(screen.names.fun), social: top(screen.names.social) };
      for (const c of ['work', 'fun', 'social'] as const) if (names[c].length) (sig.top ||= {})[c] = names[c];
    }
    if (played.length) {
      sig.funMin = Math.round((sig.funMin || 0) + notCounted(played, apps, day.filter((e) => e.kind === 'visit')));
      set('funMin', maxTier([...played.map((e) => e.tier), sig.tier.funMin || 1]), [...(sig.from.funMin || []), ...played.map(sourceWord)]);
      const games = [...new Set(played.map((e) => (typeof e.meta?.game === 'string' ? e.meta.game : '')).filter(Boolean))];
      if (games.length) (sig.top ||= {}).fun = [...new Set([...(sig.top?.fun || []), ...games])].slice(0, 3);
    }

    // Meetings: the calendar's timed events (rows.ts), from the first day there's a calendar.
    if (calDays(k) && typeof r.calMin === 'number') {
      sig.meetingsMin = r.calMin;
      const cal = day.filter(calendar);
      set('meetingsMin', r.tier?.calMin || 2, cal.length ? cal.map(sourceWord) : calWords);
    }

    // Money out, from bank statements.
    if (bankDays(k)) {
      sig.spent = Math.round(day.filter((e) => e.source === 'bank' && isPurchase(e) && (e.unit || '') === unit && e.value! < 0).reduce((n, e) => n - e.value!, 0) * 100) / 100;
      if (unit) sig.spentUnit = unit;
      set('spent', 3, ['bank statements']);
    }

    // Quests and their own check-in.
    if (r.due) {
      sig.due = r.due;
      sig.done = r.done || 0;
      set('quests', 1, ['Arise']);
    }
    for (const { q, cat } of quests) {
      if (!G.dueOn(q, k)) continue;
      const by = ((sig.questsBy ||= {})[cat] ||= { due: 0, done: 0 });
      by.due++;
      if (G.isDone(st.checks, k, q.id)) by.done++;
    }
    if (typeof r.mood === 'number') {
      sig.mood = r.mood;
      set('mood', r.tier?.mood || 1, r.tier?.mood && r.tier.mood > 1 ? day.filter((e) => e.kind === 'mood').map(sourceWord) : ['Arise']);
    }
    const l = st.logs[k];
    for (const f of ['s', 'e', 'm'] as const) {
      const v = rating(l?.[f]);
      if (v) sig[f] = v;
    }
    out.push(sig);
  }
  return out;
}

// What a day's patterns are made from (src/lib/patterns.ts): rows.ts's own fields, with the sleep
// worked out from the devices where Health had none, the time on screens without counting a
// browser twice, the calendar from its first day, and the rest of the signals.
export function rowsOf(signals: readonly DaySignals[]): DayRow[] {
  return signals.map((s) => {
    const r: DayRow = { day: s.day };
    const tier: NonNullable<DayRow['tier']> = {};
    if (s.e != null) r.e = s.e;
    if (s.s != null) r.s = s.s;
    if (s.mood != null) {
      r.mood = s.mood;
      tier.mood = s.tier.mood || 1;
    }
    if (s.sleepMin != null) {
      r.sleepMin = s.sleepMin;
      r.sleepFrom = s.sleepFrom;
      tier.sleepMin = s.tier.sleepMin || 3;
    }
    if (s.steps != null) {
      r.steps = s.steps;
      tier.steps = s.tier.steps || 2;
    }
    r.trained = !!s.trained;
    tier.trained = s.tier.trained || 1;
    if (s.talked != null) {
      r.people = s.talked;
      tier.people = 3;
    }
    if (s.people != null) {
      r.peopleN = s.people;
      tier.peopleN = 3;
    }
    if (s.screenMin != null && s.screenMin > 0) {
      r.screenMin = s.screenMin;
      tier.screenMin = s.tier.screenMin || 2;
    }
    for (const f of ['focusMin', 'funMin', 'socialMin', 'lateMin'] as const) {
      const v = s[f];
      if (v != null) {
        r[f] = v;
        tier[f] = s.tier[f] || 3;
      }
    }
    if (s.meetingsMin != null) {
      r.calMin = s.meetingsMin;
      tier.calMin = s.tier.meetingsMin || 2;
    }
    if (s.due) {
      r.due = s.due;
      r.done = s.done || 0;
    }
    r.tier = tier;
    return r;
  });
}

// What the life log needs to be read for: everything that can show a day, except what's in it
// for other reasons (body measures, notifications, notes, the rest).
const KINDS: ReadonlySet<LifeKind> = new Set(['sleep', 'steps', 'workout', 'app', 'call', 'message', 'mood', 'event', 'visit', 'search', 'place', 'trip', 'watch', 'listen', 'play', 'purchase', 'quest']);

// Signals for the days from `fromKey` to `toKey`, from the life log on this device (a week at a
// time, each read in one go, so a busy log is read in full and quickly) and the app's data.
// Without a life log, only Arise's own.
export async function daySignals(fromKey: string, toKey: string): Promise<DaySignals[]> {
  const events: LifeEvent[] = [];
  if (hasLifeStore() && L.hasLifeDB()) {
    try {
      // From noon the day before: the first night started then.
      const end = dayEnd(toKey);
      for (let t = dayStart(fromKey) - 12 * HOUR; t < end; t += 7 * 24 * HOUR) {
        for (const e of await L.eventsBetween(t, Math.min(t + 7 * 24 * HOUR, end), { limit: 100000 })) if (KINDS.has(e.kind)) events.push(e);
      }
    } catch {
      events.length = 0;
    }
  }
  return signalsFrom(events, fromKey, toKey, S.state);
}
