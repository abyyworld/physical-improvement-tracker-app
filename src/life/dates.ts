// Days in local time, and the dates in a question: "yesterday", "last Tuesday", "in March",
// "two weeks ago", "this morning"… No app imports, so a worker can use it too.

const pad = (n: number) => String(n).padStart(2, '0');

export const dayKey = (t: number | Date) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
export function parseDay(k: string) {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d);
}
export const dayStart = (k: string) => parseDay(k).getTime();
export function addDays(k: string, n: number) {
  const d = parseDay(k);
  d.setDate(d.getDate() + n);
  return dayKey(d);
}
// The first moment of the next day: ranges are [from, to).
export const dayEnd = (k: string) => dayStart(addDays(k, 1));
export const mondayOf = (k: string) => addDays(k, -((parseDay(k).getDay() + 6) % 7));
export const monthStart = (y: number, m: number) => new Date(y, m, 1).getTime(); // m: 0-11, may overflow

export interface When {
  from: number;
  to: number; // exclusive
  label: string; // "yesterday (Fri 16 Oct)", "the week of 5 Oct", "March 2026"…
  match: string; // the words that said it
}

const NUM: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, couple: 2, 'a couple': 2, 'a couple of': 2, few: 3, 'a few': 3 };
const NUM_RE = '(\\d{1,3}|a couple of|a couple|a few|an|a|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|couple|few)';
const num = (s: string) => (/^\d+$/.test(s) ? Number(s) : NUM[s] || 1);

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
// "mar" and "may" are left out on their own: they're everyday words ("may I…"). "May" counts
// with "in" or a number next to it.
const MONTHS: [RegExp, number][] = [
  [/^jan(uary)?$/, 0],
  [/^feb(ruary)?$/, 1],
  [/^march$/, 2],
  [/^apr(il)?$/, 3],
  [/^may$/, 4],
  [/^june?$/, 5],
  [/^july?$/, 6],
  [/^aug(ust)?$/, 7],
  [/^sept?(ember)?$/, 8],
  [/^oct(ober)?$/, 9],
  [/^nov(ember)?$/, 10],
  [/^dec(ember)?$/, 11],
];
const MONTH_RE = '(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|apr|jun|jul|aug|sept|sep|oct|nov|dec)';
const monthOf = (s: string) => MONTHS.find(([re]) => re.test(s))?.[1] ?? -1;

const short = (t: number, o: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short' }) => new Date(t).toLocaleDateString('en-GB', o);

// The date range a question is about, or null when it names none.
export function parseWhen(text: string, now: Date = new Date()): When | null {
  const s = ` ${String(text || '').toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9'\- ]+/g, ' ').replace(/\s+/g, ' ')} `;
  const today = dayKey(now);
  const at =(k: string, h: number) => {
    const d = parseDay(k);
    d.setHours(h);
    return d.getTime();
  };
  const day = (k: string, label: string, match: string): When => ({ from: dayStart(k), to: dayEnd(k), label: `${label} (${short(dayStart(k))})`, match });
  const week = (mon: string, label: string, match: string): When => ({ from: dayStart(mon), to: dayStart(addDays(mon, 7)), label, match });
  const month = (y: number, m: number, match: string, label?: string): When => ({
    from: monthStart(y, m),
    to: monthStart(y, m + 1),
    label: label || new Date(y, m, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }),
    match,
  });
  const y = now.getFullYear();
  const mo = now.getMonth();
  const m = (re: RegExp) => s.match(re);
  let r: RegExpMatchArray | null;
  let found: When | null = null;

  // A date written out: 2026-10-03.
  if ((r = m(/ (\d{4})-(\d{2})-(\d{2}) /))) {
    const k = `${r[1]}-${r[2]}-${r[3]}`;
    if (!Number.isNaN(parseDay(k).getTime())) found = day(k, 'that day', r[0].trim());
  }
  // Parts of a day.
  if (!found && (r = m(/ (this|yesterday|last) (morning|afternoon|evening|night) | (tonight) /))) {
    const which = r[1] || 'this';
    const part = r[2] || 'evening';
    // "last night" runs from yesterday evening into the small hours of today.
    const span: Record<string, [number, number]> = { morning: [0, 12], afternoon: [12, 18], evening: [17, 24], night: [18, 30] };
    const base = which === 'this' ? today : addDays(today, -1);
    const label = r[3] ? 'tonight' : which === 'this' ? `this ${part}` : which === 'last' ? `last ${part}` : `yesterday ${part}`;
    found = { from: at(base, span[part][0]), to: at(base, span[part][1]), label, match: r[0].trim() };
  }
  if (!found && (r = m(/ (the )?day before yesterday /))) found = day(addDays(today, -2), 'the day before yesterday', r[0].trim());
  if (!found && (r = m(/ today /))) found = day(today, 'today', r[0].trim());
  if (!found && (r = m(/ yesterday /))) found = day(addDays(today, -1), 'yesterday', r[0].trim());
  // "two weeks ago", "3 days ago", "a month ago", "a year ago".
  if (!found && (r = m(new RegExp(` ${NUM_RE} (days?|weeks?|months?|years?) ago `)))) {
    const n = num(r[1]);
    const unit = r[2].replace(/s$/, '');
    const text = r[0].trim();
    const vague = /few|couple/.test(r[1]);
    if (unit === 'day' && vague) found = { from: dayStart(addDays(today, -n - 1)), to: dayEnd(addDays(today, -n + 1)), label: text, match: text };
    else if (unit === 'day') found = day(addDays(today, -n), text, text);
    else if (unit === 'week') {
      const mon = mondayOf(addDays(today, -7 * n));
      found = week(mon, `${text}, the week of ${short(dayStart(mon), { day: 'numeric', month: 'short' })}`, text);
    } else if (unit === 'month') {
      const d = new Date(y, mo - n, 1);
      found = month(d.getFullYear(), d.getMonth(), text, `${text} (${d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })})`);
    } else {
      const k = dayKey(new Date(y - n, mo, now.getDate()));
      found = { from: dayStart(addDays(k, -3)), to: dayEnd(addDays(k, 3)), label: `${text}, around ${short(dayStart(k), { day: 'numeric', month: 'short', year: 'numeric' })}`, match: text };
    }
  }
  // "the last 3 days", "past two weeks", "in the past month".
  if (!found && (r = m(new RegExp(` (?:the )?(?:last|past) ${NUM_RE} (days|weeks|months) | (?:the )?past (day|week|month|year) `)))) {
    const n = r[1] ? num(r[1]) : 1;
    const unit = (r[2] || r[3]).replace(/s$/, '');
    const days = unit === 'day' ? n : unit === 'week' ? 7 * n : unit === 'month' ? 30 * n : 365 * n;
    found = { from: dayStart(addDays(today, -days)), to: dayEnd(today), label: r[0].trim(), match: r[0].trim() };
  }
  if (!found && (r = m(/ (recently|lately|these days) /))) found = { from: dayStart(addDays(today, -14)), to: dayEnd(today), label: 'the last two weeks', match: r[0].trim() };
  // Weekends and weeks (Monday to Sunday).
  if (!found && (r = m(/ (last|this|past) weekend /))) {
    const mon = mondayOf(today);
    const sat = r[1] === 'this' ? addDays(mon, 5) : addDays(mon, -2);
    found = { from: dayStart(sat), to: dayEnd(addDays(sat, 1)), label: `${r[1]} weekend (${short(dayStart(sat), { day: 'numeric', month: 'short' })})`, match: r[0].trim() };
  }
  if (!found && (r = m(/ (last|this|previous) week /))) {
    const mon = r[1] === 'this' ? mondayOf(today) : addDays(mondayOf(today), -7);
    found = week(mon, `${r[1] === 'this' ? 'this week' : 'last week'} (from ${short(dayStart(mon), { day: 'numeric', month: 'short' })})`, r[0].trim());
  }
  if (!found && (r = m(/ (last|this|previous) month /))) {
    const d = r[1] === 'this' ? new Date(y, mo, 1) : new Date(y, mo - 1, 1);
    found = month(d.getFullYear(), d.getMonth(), r[0].trim());
  }
  if (!found && (r = m(/ (last|this|previous) year /))) {
    const yy = r[1] === 'this' ? y : y - 1;
    found = { from: new Date(yy, 0, 1).getTime(), to: new Date(yy + 1, 0, 1).getTime(), label: String(yy), match: r[0].trim() };
  }
  // A weekday: "last Tuesday" is the latest one before today; "on Tuesday" may be today.
  if (!found && (r = m(/ (last |on |this past |past )?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)s? /))) {
    const want = WEEKDAYS.indexOf(r[2]);
    const strict = !!r[1] && r[1].trim() !== 'on';
    let k = strict ? addDays(today, -1) : today;
    while (parseDay(k).getDay() !== want) k = addDays(k, -1);
    found = day(k, `${r[1] ? r[1].trim() + ' ' : ''}${r[2][0].toUpperCase()}${r[2].slice(1)}`, r[0].trim());
  }
  // A day of a month: "3 October", "3rd of Oct", "October 3", with or without the year.
  if (!found) {
    const a = m(new RegExp(` (\\d{1,2})(?:st|nd|rd|th)? (?:of )?${MONTH_RE}(?: (\\d{4}))? `));
    const b = a ? null : m(new RegExp(` ${MONTH_RE} (\\d{1,2})(?:st|nd|rd|th)?(?:,? (\\d{4}))? `));
    const hit = a ? { d: Number(a[1]), mon: monthOf(a[2]), year: a[3], text: a[0] } : b ? { d: Number(b[2]), mon: monthOf(b[1]), year: b[3], text: b[0] } : null;
    if (hit && hit.mon >= 0 && hit.d >= 1 && hit.d <= 31) {
      let yy = hit.year ? Number(hit.year) : y;
      let date = new Date(yy, hit.mon, hit.d);
      if (!hit.year && date.getTime() > dayEnd(today)) date = new Date(--yy, hit.mon, hit.d);
      if (date.getMonth() === hit.mon) found = day(dayKey(date), 'that day', hit.text.trim());
    }
  }
  // A month: "in March", "last April", "May 2025". (May only with "in" or a year.)
  if (!found && (r = m(new RegExp(` (in |during |last |this )?${MONTH_RE}(?: (\\d{4}))? `)))) {
    const mon = monthOf(r[2]);
    const lead = (r[1] || '').trim();
    const okMay = mon !== 4 || !!lead || !!r[3];
    if (mon >= 0 && okMay) {
      let yy = r[3] ? Number(r[3]) : mon > mo || (lead === 'last' && mon === mo) ? y - 1 : y;
      if (lead === 'last' && !r[3] && mon < mo) yy = y;
      found = month(yy, mon, r[0].trim());
    }
  }
  if (!found) return null;
  // "since Monday", "since March": from then until now.
  if (s.includes(` since ${found.match} `) || s.includes(` since the ${found.match} `)) {
    found = { ...found, to: Math.max(found.to, dayEnd(today)), label: `since ${found.label}`, match: `since ${found.match}` };
  }
  // Nothing after today has happened yet.
  if (found.to > dayEnd(today) && found.from < dayEnd(today)) found = { ...found, to: dayEnd(today) };
  return found;
}
