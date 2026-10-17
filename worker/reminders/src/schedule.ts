// When each device's next reminder is due, in UTC, from its time zone and local reminder times.
//
// Local times are turned into UTC with the time zone rules built into the runtime
// (Intl.DateTimeFormat), so a 07:30 reminder stays at 07:30 on the clock when daylight saving
// time starts or ends. Dates are 'YYYY-MM-DD' strings in the device's time zone.

// morning and evening: the quests' reminders. recap and checkin: the journal's morning "Yesterday"
// and evening check-in, which come every day (the weekdays and a day marked done are the quests').
export type Kind = 'morning' | 'evening' | 'recap' | 'checkin';
export const KINDS: readonly Kind[] = ['morning', 'evening', 'recap', 'checkin'];

export interface Schedule {
  tz: string; // an IANA time zone, like Europe/London
  morning: string; // 'HH:MM'
  evening: string | null; // 'HH:MM', later than the morning, or null for no evening check
  days: number; // which weekdays get the quests' reminders: bit 0 is Sunday, bit 6 Saturday
  recap?: string | null; // 'HH:MM', or null (or left out) for none
  checkin?: string | null;
}

export interface Due {
  at: number; // ms since 1970, UTC
  kind: Kind;
  date: string; // the local date it's for
}

const DAY = 86_400_000;
export const ALL_DAYS = 0b1111111;
export const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
export const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

// One formatter per time zone: making them is slow, and there are only a few hundred zones. Kept
// under the name in lower case, as Intl accepts any capitalisation: otherwise each new one sent
// would keep another formatter for good.
const formats = new Map<string, Intl.DateTimeFormat>();
function format(tz: string): Intl.DateTimeFormat {
  const key = tz.toLowerCase();
  let f = formats.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    formats.set(key, f);
  }
  return f;
}

// The zone's own name for it (Intl accepts any capitalisation), or '' if the runtime doesn't know it.
export function timeZone(tz: unknown): string {
  if (typeof tz !== 'string' || !/^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/.test(tz)) return '';
  try {
    return format(tz).resolvedOptions().timeZone;
  } catch {
    return '';
  }
}

// What a clock in that time zone shows at time t, written as if it were UTC.
function wall(t: number, tz: string): number {
  const p: Record<string, number> = {};
  for (const { type, value } of format(tz).formatToParts(new Date(t))) p[type] = Number(value);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second);
}

// How far ahead of UTC the zone's clocks are at time t.
const offsetAt = (t: number, tz: string) => wall(t, tz) - Math.floor(t / 1000) * 1000;

export function localDate(t: number, tz: string): string {
  return new Date(wall(t, tz)).toISOString().slice(0, 10);
}

export function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
}

export const weekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

// The moment a local date and time happens in a time zone. When clocks go back, a time that
// happens twice is the first one. When they go forward, a time that's skipped is moved on by
// the jump (02:30 becomes 03:30), so the reminder still comes that day.
export function toUTC(date: string, time: string, tz: string): number {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const local = Date.UTC(y, mo - 1, d, h, mi);
  // Clocks change at most once in a day either side, so the offsets a day before and a day
  // after are the only ones that can apply.
  const before = offsetAt(local - DAY, tz);
  const after = offsetAt(local + DAY, tz);
  const fits = [local - before, local - after].filter((t) => offsetAt(t, tz) === local - t).sort((a, b) => a - b);
  return fits.length ? fits[0] : local - before;
}

const ORDER: Record<'morning' | 'evening', number> = { morning: 0, evening: 1 };

// What was sent on the last day anything was: the date, and each kind sent that day.
export interface Sent {
  date: string;
  kinds: Kind[];
}
// As the server keeps it: 'date kind kind…' ('2026-10-09 morning recap').
export function parseSent(v: string | null | undefined): Sent | null {
  const [date, ...rest] = String(v || '').split(' ');
  const kinds = rest.filter((k): k is Kind => KINDS.includes(k as Kind));
  return DATE.test(date) && kinds.length ? { date, kinds } : null;
}
export function addSent(v: string | null | undefined, date: string, kind: Kind): string {
  const s = parseSent(v);
  const kinds = s && s.date === date ? [...new Set([...s.kinds, kind])] : [kind];
  return `${date} ${kinds.join(' ')}`;
}

// The first reminder after `now`. Never a quest reminder for a day marked done, and never one
// for a day before the last one anything was sent for, nor one already sent that day (and no
// morning reminder once that day's evening check was sent), so changing the times or the time
// zone can't send the same day's reminder twice. `sent`: { date, kinds }, or as before there were
// more kinds, { date, kind }.
export function nextDue(s: Schedule, now: number, { sent, done }: { sent?: Sent | { date: string; kind: Kind } | null; done?: string | null } = {}): Due | null {
  const journal = !!(s.recap || s.checkin);
  if (!(s.days & ALL_DAYS) && !journal) return null;
  const was: Sent | null = sent ? ('kinds' in sent ? sent : { date: sent.date, kinds: [sent.kind] }) : null;
  const already = (kind: Kind) => {
    if (kind === 'recap' || kind === 'checkin') return was!.kinds.includes(kind);
    return was!.kinds.some((k) => (k === 'morning' || k === 'evening') && ORDER[k] >= ORDER[kind]);
  };
  let first: Due | null = null;
  // From the day before: when clocks go back at midnight, the same date can start twice.
  let date = addDays(localDate(now, s.tz), -1);
  for (let i = 0; i < 10; i++, date = addDays(date, 1)) {
    // The earliest, not the first day's: when clocks skip past midnight, a day's evening check can
    // move after the next day's morning (Greenland), and that morning must not be lost. The day
    // after is as far as that can reach.
    if (first && date > addDays(first.date, 1)) break;
    const list: Due[] = [];
    if (s.days & (1 << weekday(date)) && date !== done) {
      const morning: Due = { at: toUTC(date, s.morning, s.tz), kind: 'morning', date };
      list.push(morning);
      if (s.evening) {
        const evening: Due = { at: toUTC(date, s.evening, s.tz), kind: 'evening', date };
        if (evening.at > morning.at) list.push(evening);
      }
    }
    if (s.recap) list.push({ at: toUTC(date, s.recap, s.tz), kind: 'recap', date });
    if (s.checkin) list.push({ at: toUTC(date, s.checkin, s.tz), kind: 'checkin', date });
    for (const due of list) {
      if (due.at <= now) continue;
      if (was && (date < was.date || (date === was.date && already(due.kind)))) continue;
      if (!first || due.at < first.at) first = due;
    }
  }
  return first;
}
