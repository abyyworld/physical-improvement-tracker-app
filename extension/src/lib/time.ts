// Time on each site, added up per site per hour (the hours of the clock where the browser is).
// Time counts while the site is the tab in front, in the focused window, and the person is at
// the computer (or the tab is playing sound, like a video).

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
// Between two looks the browser can't have been in use longer than this: a gap that's longer
// means the computer slept, and that time doesn't count.
export const MAX_STEP = 3 * MINUTE;
// Less than this in an hour isn't worth a line.
export const MIN_SECONDS = 30;

// hour start (ms) → site → seconds
export type Rollup = Record<string, Record<string, number>>;

export function hourStart(t: number): number {
  const d = new Date(t);
  d.setMinutes(0, 0, 0);
  return d.getTime();
}

// The next hour's start: an hour later, or more or less on the night the clocks change.
export function hourEnd(start: number): number {
  return hourStart(start + HOUR + 1);
}

// Adds [from, to) on `site`, split over the hours it covers. Returns a new roll-up.
export function addSpan(r: Rollup, site: string, from: number, to: number): Rollup {
  const out: Rollup = { ...r };
  if (!site || !(to > from)) return out;
  let t = from;
  while (t < to) {
    const h = hourStart(t);
    const end = Math.min(to, hourEnd(h));
    const key = String(h);
    const hour = { ...(out[key] || {}) };
    hour[site] = Math.round(((hour[site] || 0) + (end - t) / 1000) * 10) / 10;
    out[key] = hour;
    t = end;
  }
  return out;
}

export interface SiteHour {
  hour: number; // its start
  end: number;
  site: string;
  seconds: number;
}

// The hours that are over (or all of them, with `all`), and the roll-up that's left.
export function takeHours(r: Rollup, now: number, { all = false } = {}): { done: SiteHour[]; open: Rollup } {
  const done: SiteHour[] = [];
  const open: Rollup = {};
  for (const [key, sites] of Object.entries(r)) {
    const hour = Number(key);
    const end = hourEnd(hour);
    if (!all && end > now) {
      open[key] = sites;
      continue;
    }
    for (const [site, seconds] of Object.entries(sites)) {
      if (seconds >= MIN_SECONDS) done.push({ hour, end: Math.min(end, Math.max(now, hour)), site, seconds: Math.round(seconds) });
    }
  }
  done.sort((a, b) => a.hour - b.hour || b.seconds - a.seconds);
  return { done, open };
}

// What's being looked at, and since when.
export interface Focus {
  site: string;
  since: number;
}

// Moves the focus to `site` (or nothing) at `now`, counting the time on the one before.
export function step(r: Rollup, focus: Focus | null, site: string | null, now: number): { rollup: Rollup; focus: Focus | null } {
  let rollup = r;
  if (focus && now > focus.since) rollup = addSpan(r, focus.site, focus.since, Math.min(now, focus.since + MAX_STEP));
  return { rollup, focus: site ? { site, since: now } : null };
}

// Forgets everything from `from` on (forget the last hour): those hours are dropped whole.
export function dropFrom(r: Rollup, from: number): Rollup {
  const out: Rollup = {};
  for (const [key, sites] of Object.entries(r)) if (hourEnd(Number(key)) <= from) out[key] = sites;
  return out;
}
