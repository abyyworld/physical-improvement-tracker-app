// Apple's databases count time from 2001-01-01 UTC ("Core Data" or "Mac absolute" time): call
// history, notifications, Safari and Screen Time in seconds (often with a fraction), Messages in
// nanoseconds since macOS 10.13 (seconds before that).

export const APPLE_EPOCH = 978307200; // seconds from 1970-01-01 to 2001-01-01

// Seconds since 2001 to ms since 1970, or null for an empty or impossible value.
export function appleToMs(sec) {
  if (typeof sec === 'bigint') sec = Number(sec);
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec <= 0) return null;
  const ms = Math.round((sec + APPLE_EPOCH) * 1000);
  // Before 2001 or after 2100 isn't a real event.
  return ms > APPLE_EPOCH * 1000 && ms < 4102444800000 ? ms : null;
}

export const msToApple = (ms) => ms / 1000 - APPLE_EPOCH;

// Messages: nanoseconds since 2001 now, seconds on old Macs.
export function messagesToMs(v) {
  if (typeof v === 'bigint') v = Number(v);
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null;
  return appleToMs(v > 1e12 ? v / 1e9 : v);
}

// The same, done by SQLite: a nanosecond count doesn't fit in a JavaScript number, and node:sqlite
// refuses to read one, so queries turn the column into ms since 2001 first.
export const messagesMsSql = (col) => `CASE WHEN ${col} > 1000000000000 THEN ${col} / 1000000 ELSE ${col} * 1000 END`;

// How long, in plain words: "40 sec", "12 min", "1 h 5 min".
export function duration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  if (s < 60) return `${s} sec`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

export const HOUR = 3600000;
export const hourStart = (ms) => Math.floor(ms / HOUR) * HOUR;
