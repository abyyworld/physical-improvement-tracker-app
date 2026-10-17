// Calendar: the events of every calendar the Mac's Calendar app has (iCloud, Google, Outlook and
// the rest it syncs), from its own database: ~/Library/Group Containers/group.com.apple.calendar/
// Calendar.sqlitedb since macOS 14, ~/Library/Calendars/Calendar Cache before.
//
// Events change where they are: one moves, gets a new name, or is cancelled. So, unlike the other
// sources, each read looks at a window of time, from where the last read settled (a day back, or
// when the Player turned it on) to two weeks ahead, and hands over what's new or changed there,
// under the event's own id, so a moved event takes its old place in the life log. One that's gone
// from the window (cancelled, deleted, or moved further out) is handed over as gone, and Arise
// takes it out. Birthdays and subscribed calendars (holidays) aren't the Player's own life and are
// left out, like on the iPhone.

import path from 'node:path';
import { columns, hasTable } from './snapshot.mjs';
import { appleToMs, msToApple } from './time.mjs';
import { clip, col, str } from './sources.mjs';

export const AHEAD = 14 * 86400000;
// At most this many in one read. A window with more is read in part: nothing counts as gone then.
export const MAX = 5000;

/** @param {string} userHome */
export function calendarFiles(userHome) {
  const lib = path.join(userHome, 'Library');
  return [path.join(lib, 'Group Containers', 'group.com.apple.calendar', 'Calendar.sqlitedb'), path.join(lib, 'Calendars', 'Calendar Cache')];
}

// All-day events are kept as clock time (see when(), below), so the database is asked for a day
// more on each side, and inWindow() then keeps exactly what overlaps the window.
const MARGIN = 86400; // seconds

/** @param {{ at: number, end?: number }} ev @param {number} from @param {number} until */
export const inWindow = (ev, from, until) => (ev.end ?? ev.at) >= from && ev.at < until;

/**
 * The events (each repeat of a repeating one too) that overlap from..until (ms), and some just
 * outside it (inWindow() tells them apart).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ from: number, until: number }} window
 * @returns {{ rows: any[], more: boolean, unknown?: boolean }}
 */
export function readCalendar(db, { from, until }) {
  if (hasTable(db, 'CalendarItem')) return readItems(db, from, until);
  if (hasTable(db, 'ZCALENDARITEM')) return readOlder(db, from, until);
  return { rows: [], more: false, unknown: true };
}

// macOS 14 and later (the iPhone's layout too): CalendarItem, its Calendar, and OccurrenceCache,
// where Calendar lists each repeat of a repeating event (one row per day it covers).
function readItems(db, from, until) {
  const i = columns(db, 'CalendarItem');
  if (!i.has('start_date')) return { rows: [], more: false, unknown: true };
  const c = hasTable(db, 'Calendar') && i.has('calendar_id') ? columns(db, 'Calendar') : new Set();
  const l = hasTable(db, 'Location') && i.has('location_id') ? columns(db, 'Location') : new Set();
  const o = hasTable(db, 'OccurrenceCache') ? columns(db, 'OccurrenceCache') : new Set();
  const repeats = o.has('event_id') && (o.has('occurrence_start_date') || o.has('occurrence_date'));
  const uid = i.has('UUID') ? 'i.UUID' : i.has('unique_identifier') ? 'i.unique_identifier' : 'NULL';
  const length = i.has('end_date') ? '(i.end_date - i.start_date)' : '0';
  const start = repeats ? (o.has('occurrence_start_date') ? 'o.occurrence_start_date' : 'o.occurrence_date') : 'i.start_date';
  const end = repeats ? (o.has('occurrence_end_date') ? `COALESCE(o.occurrence_end_date, ${start} + ${length})` : `${start} + ${length}`) : col(i, 'end_date', 'i.end_date');
  const sql = `SELECT i.ROWID AS rowid, ${uid} AS uid, ${col(i, 'summary', 'i.summary')} AS title, ${start} AS start, ${end} AS end,
      ${repeats ? col(o, 'occurrence_date', 'o.occurrence_date') : 'NULL'} AS occ, i.start_date AS itemStart,
      ${col(i, 'all_day', 'i.all_day')} AS allDay, ${col(i, 'start_tz', 'i.start_tz')} AS tz, ${col(i, 'status', 'i.status')} AS status,
      ${col(i, 'hidden', 'i.hidden')} AS hidden, ${col(i, 'entity_type', 'i.entity_type')} AS entity, ${col(i, 'birthday_id', 'i.birthday_id')} AS birthday,
      ${col(c, 'title', 'c.title')} AS calendar, ${col(c, 'subcal_url', 'c.subcal_url')} AS subscribed, ${col(l, 'title', 'l.title')} AS place
    FROM ${repeats ? 'OccurrenceCache o JOIN CalendarItem i ON i.ROWID = o.event_id' : 'CalendarItem i'}
    ${c.size ? 'LEFT JOIN Calendar c ON c.ROWID = i.calendar_id' : ''}
    ${l.size ? 'LEFT JOIN Location l ON l.ROWID = i.location_id' : ''}
    WHERE ${start} < ? AND COALESCE(${end}, ${start}) >= ?
    ${repeats ? `GROUP BY i.ROWID, ${start}` : ''}
    ORDER BY ${start}, i.ROWID LIMIT ?`;
  const rows = /** @type {any[]} */ (db.prepare(sql).all(msToApple(until) + MARGIN, msToApple(from) - MARGIN, MAX));
  return { rows, more: rows.length === MAX };
}

// macOS 13 and earlier: Core Data's ZCALENDARITEM, with its calendar in ZNODE. Repeats aren't
// listed there: a repeating event comes once, when it started.
function readOlder(db, from, until) {
  const i = columns(db, 'ZCALENDARITEM');
  if (!i.has('ZSTARTDATE')) return { rows: [], more: false, unknown: true };
  const n = hasTable(db, 'ZNODE') && i.has('ZCALENDAR') ? columns(db, 'ZNODE') : new Set();
  const uid = ['ZSHAREDUID', 'ZUID', 'ZUUID'].find((k) => i.has(k));
  const title = ['ZTITLE', 'ZSUMMARY'].find((k) => i.has(k));
  const sql = `SELECT i.Z_PK AS rowid, ${uid ? `i.${uid}` : 'NULL'} AS uid, ${title ? `i.${title}` : 'NULL'} AS title, i.ZSTARTDATE AS start,
      ${col(i, 'ZENDDATE', 'i.ZENDDATE')} AS end, NULL AS occ, i.ZSTARTDATE AS itemStart, ${col(i, 'ZISALLDAY', 'i.ZISALLDAY')} AS allDay,
      NULL AS tz, NULL AS status, NULL AS hidden, NULL AS entity, NULL AS birthday, ${col(n, 'ZTITLE', 'n.ZTITLE')} AS calendar, NULL AS subscribed, NULL AS place
    FROM ZCALENDARITEM i ${n.size ? 'LEFT JOIN ZNODE n ON n.Z_PK = i.ZCALENDAR' : ''}
    WHERE i.ZSTARTDATE < ? AND COALESCE(${col(i, 'ZENDDATE', 'i.ZENDDATE')}, i.ZSTARTDATE) >= ?
    ORDER BY i.ZSTARTDATE, i.Z_PK LIMIT ?`;
  const rows = /** @type {any[]} */ (db.prepare(sql).all(msToApple(until) + MARGIN, msToApple(from) - MARGIN, MAX));
  return { rows, more: rows.length === MAX };
}

// All-day events (and others set to "floating" time) are kept as the clock time of the day,
// written as if it were UTC: this Mac's own clock decides when that is.
function when(sec, floating) {
  const ms = appleToMs(Number(sec));
  if (ms == null || !floating) return ms;
  const d = new Date(ms);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()).getTime();
}

// Calendars that aren't the Player's own life, by name ("Birthdays", "US Holidays", "Holidays in
// United Kingdom"; the subscribed ones are known by their address), and what Arise put in the
// calendar itself (the iPhone app adds workouts as "Arise: …").
const NOT_MINE = /^(birthdays?|holidays?|[a-z]{2,3} holidays|holidays in .+)$/i;
const OWN = /^Arise: /;

/** @param {any} row */
export function calendarEvent(row) {
  // Hidden, cancelled (status 3), a contact's birthday, or a reminder (entity type 3).
  if (Number(row.hidden) === 1 || Number(row.status) === 3 || Number(row.birthday) > 0 || Number(row.entity) === 3) return null;
  if (str(row.subscribed).trim() || NOT_MINE.test(str(row.calendar).trim())) return null;
  const title = clip(str(row.title), 200);
  if (OWN.test(title)) return null;
  const floating = !!Number(row.allDay) || str(row.tz) === '_float';
  const at = when(row.start, floating);
  if (!at) return null;
  const end = when(row.end, floating);
  const uid = str(row.uid).replace(/[^\w.@-]/g, '').slice(0, 100) || `r${Number(row.rowid)}`;
  // Each repeat of a repeating event has its own id: the event's, and when that repeat was due.
  // (The first, and an event that doesn't repeat, have the event's id alone, so moving it keeps it.)
  const due = Number(row.occ ?? row.start);
  const part = Number.isFinite(due) && due !== Number(row.itemStart) ? `:${Math.round(due)}` : '';
  /** @type {Record<string, string | number | boolean>} */
  const meta = {};
  const calendar = clip(str(row.calendar), 80);
  if (calendar) meta.calendar = calendar;
  if (Number(row.allDay)) meta.allDay = true;
  const place = clip(str(row.place), 200);
  return {
    id: `mac:cal:${uid}${part}`,
    source: 'mac',
    kind: 'event',
    at,
    ...(end != null && end >= at ? { end } : {}),
    title: title || 'Busy',
    ...(place ? { detail: `At ${place}` } : {}),
    tier: 2,
    meta,
  };
}

// A short fingerprint of an event, to tell when it changed. (Two FNV-1a passes, 64 bits.)
export function fingerprint(ev) {
  const s = JSON.stringify(ev);
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let k = 0; k < s.length; k++) {
    const c = s.charCodeAt(k);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995) ^ (b >>> 13);
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

/**
 * What changed since the last read: `put` the events that are new or changed, `gone` the ids of
 * those no longer there, and `seen` what to compare the next read with.
 * @param {Record<string, { h: string, end: number }>} seen what the last read found, by id
 * @param {any[]} events what's in the window now
 * @param {{ from: number, complete: boolean }} opts `complete`: the whole window was read
 */
export function calendarChanges(seen, events, { from, complete }) {
  /** @type {Record<string, { h: string, end: number }>} */
  const next = {};
  const put = [];
  for (const ev of events) {
    if (next[ev.id]) continue;
    const h = fingerprint(ev);
    next[ev.id] = { h, end: ev.end ?? ev.at };
    if (seen?.[ev.id]?.h !== h) put.push(ev);
  }
  const gone = [];
  for (const [id, s] of Object.entries(seen && typeof seen === 'object' ? seen : {})) {
    if (next[id] || !s || typeof s !== 'object') continue;
    // Over before the window starts: it's behind, not gone.
    if (!(Number(s.end) >= from)) continue;
    if (complete) gone.push(id);
    else next[id] = s;
  }
  return { put, gone, seen: next };
}
