// Small copies of the databases macOS keeps, with the tables and columns the helper reads (and
// some it doesn't, like Messages' other nanosecond dates), for the tests.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const APPLE = 978307200;
export const apple = (iso: string) => Date.parse(iso) / 1000 - APPLE; // seconds since 2001
export const ns = (iso: string) => BigInt(Math.round(apple(iso))) * 1_000_000_000n; // Messages' dates

export function tempDir(prefix = 'arise-helper-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// A database in WAL mode whose newest rows are still in its -wal file, the way an app keeps it.
export function walDb(file: string, schema: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;');
  db.exec(schema);
  return db;
}

// ---------- binary plists

export function writeBplist(value: unknown): Uint8Array {
  const objects: Uint8Array[] = [];
  const add = (v: unknown): number => {
    const i = objects.length;
    objects.push(new Uint8Array(0));
    objects[i] = encode(v);
    return i;
  };
  const encode = (v: unknown): Uint8Array => {
    if (v === null || v === undefined) return Uint8Array.of(0x00);
    if (v === false) return Uint8Array.of(0x08);
    if (v === true) return Uint8Array.of(0x09);
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 2 ** 31) {
      const b = new Uint8Array(5);
      b[0] = 0x12;
      new DataView(b.buffer).setUint32(1, v);
      return b;
    }
    if (typeof v === 'number') {
      const b = new Uint8Array(9);
      b[0] = 0x23;
      new DataView(b.buffer).setFloat64(1, v);
      return b;
    }
    if (v instanceof Date) {
      const b = new Uint8Array(9);
      b[0] = 0x33;
      new DataView(b.buffer).setFloat64(1, v.getTime() / 1000 - APPLE);
      return b;
    }
    if (v instanceof Uint8Array) return concat(head(0x4, v.length), v);
    if (typeof v === 'string') {
      if (/^[\x00-\x7f]*$/.test(v)) return concat(head(0x5, v.length), Uint8Array.from(v, (c) => c.charCodeAt(0)));
      const b = new Uint8Array(v.length * 2);
      for (let k = 0; k < v.length; k++) new DataView(b.buffer).setUint16(k * 2, v.charCodeAt(k));
      return concat(head(0x6, v.length), b);
    }
    if (Array.isArray(v)) return concat(head(0xa, v.length), Uint8Array.from(v.map(add)));
    if (typeof v === 'object') {
      const keys = Object.keys(v as object);
      const k = keys.map(add);
      const o = keys.map((key) => add((v as Record<string, unknown>)[key]));
      return concat(head(0xd, keys.length), Uint8Array.from([...k, ...o]));
    }
    throw new Error(`Can't write ${typeof v}`);
  };
  const top = add(value);
  if (objects.length > 255) throw new Error('Too many objects for this small writer');
  const parts: Uint8Array[] = [Uint8Array.from('bplist00', (c) => c.charCodeAt(0))];
  const offsets: number[] = [];
  let at = 8;
  for (const o of objects) {
    offsets.push(at);
    parts.push(o);
    at += o.length;
  }
  const offSize = at < 256 ? 1 : 2;
  const table = new Uint8Array(offsets.length * offSize);
  offsets.forEach((o, k) => (offSize === 1 ? (table[k] = o) : new DataView(table.buffer).setUint16(k * 2, o)));
  parts.push(table);
  const trailer = new Uint8Array(32);
  const tv = new DataView(trailer.buffer);
  trailer[6] = offSize;
  trailer[7] = 1;
  tv.setBigUint64(8, BigInt(objects.length));
  tv.setBigUint64(16, BigInt(top));
  tv.setBigUint64(24, BigInt(at));
  parts.push(trailer);
  return concat(...parts);
}

function head(type: number, n: number) {
  if (n < 15) return Uint8Array.of((type << 4) | n);
  return n < 256 ? Uint8Array.of((type << 4) | 0x0f, 0x10, n) : Uint8Array.of((type << 4) | 0x0f, 0x11, n >> 8, n & 0xff);
}

export function concat(...parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// What usernoted keeps for one notification (its "data" column).
export const notificationData = (app: string, req: Record<string, unknown>) => writeBplist({ app, req: { iden: 'x', ...req }, date: 781000000, srce: 0 });

// ---------- Messages' attributedBody (typedstream)

const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

// An NSMutableAttributedString as Messages saves it, with the length in 1, 3 or 5 bytes.
export function attributedBody(text: string): Uint8Array {
  const bytes = new TextEncoder().encode(text);
  const n = bytes.length;
  const len = n < 0x80 ? [n] : n < 0x10000 ? [0x81, n & 0xff, n >> 8] : [0x82, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24];
  return Uint8Array.from([
    0x04, 0x0b, ...ascii('streamtyped'), 0x81, 0xe8, 0x03, 0x84, 0x01, 0x40, 0x84, 0x84, 0x84,
    0x19, ...ascii('NSMutableAttributedString'), 0x00, 0x84, 0x84, 0x12, ...ascii('NSAttributedString'), 0x00,
    0x84, 0x84, 0x08, ...ascii('NSObject'), 0x00, 0x85, 0x92, 0x84, 0x84, 0x84,
    0x0f, ...ascii('NSMutableString'), 0x01, 0x84, 0x84, 0x08, ...ascii('NSString'), 0x01, 0x95, 0x84, 0x01, 0x2b,
    ...len, ...bytes,
    0x86, 0x84, 0x02, 0x69, 0x49, 0x01, 0x05, 0x92, 0x84, 0x84, 0x84, 0x0c, ...ascii('NSDictionary'), 0x00, 0x95, 0x84, 0x01, 0x69, 0x01,
    0x92, 0x84, 0x98, 0x98, 0x1d, ...ascii('__kIMMessagePartAttributeName'), 0x86, 0x92, 0x84, 0x84, 0x84, 0x08, ...ascii('NSNumber'), 0x00,
    0x84, 0x84, 0x07, ...ascii('NSValue'), 0x00, 0x95, 0x84, 0x01, 0x2a, 0x84, 0x9b, 0x9b, 0x00, 0x86, 0x86, 0x86,
  ]);
}

// ---------- the databases

export const CALLS_SCHEMA = `CREATE TABLE ZCALLRECORD (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZANSWERED INTEGER,
  ZCALLTYPE INTEGER, ZDISCONNECTED_CAUSE INTEGER, ZFACE_TIME_DATA BLOB, ZNUMBER_AVAILABILITY INTEGER, ZORIGINATED INTEGER,
  ZREAD INTEGER, ZJUNKCONFIDENCE INTEGER, ZDATE TIMESTAMP, ZDURATION FLOAT, ZADDRESS BLOB, ZDEVICE_ID VARCHAR,
  ZISO_COUNTRY_CODE VARCHAR, ZLOCATION VARCHAR, ZNAME VARCHAR, ZSERVICE_PROVIDER VARCHAR, ZUNIQUE_ID VARCHAR);`;

export function addCall(db: DatabaseSync, c: { pk?: number; at: string; answered?: number; originated?: number; type?: number; duration?: number; address?: string | Uint8Array; name?: string | null; provider?: string; uid?: string }) {
  db.prepare(
    `INSERT INTO ZCALLRECORD (Z_PK, Z_ENT, Z_OPT, ZANSWERED, ZCALLTYPE, ZORIGINATED, ZREAD, ZDATE, ZDURATION, ZADDRESS, ZNAME, ZSERVICE_PROVIDER, ZUNIQUE_ID, ZISO_COUNTRY_CODE)
     VALUES (?, 2, 1, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 'uz')`,
  ).run(c.pk ?? null, c.answered ?? 0, c.type ?? 1, c.originated ?? 0, apple(c.at), c.duration ?? 0, c.address ?? '+998901234567', c.name ?? null, c.provider ?? 'com.apple.Telephony', c.uid ?? `UID-${Math.random().toString(36).slice(2)}`);
}

export const MESSAGES_SCHEMA = `
CREATE TABLE handle (ROWID INTEGER PRIMARY KEY AUTOINCREMENT UNIQUE, id TEXT NOT NULL, country TEXT, service TEXT NOT NULL, uncanonicalized_id TEXT, person_centric_id TEXT);
CREATE TABLE chat (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, style INTEGER, state INTEGER, account_id TEXT,
  chat_identifier TEXT, service_name TEXT, room_name TEXT, is_archived INTEGER DEFAULT 0, display_name TEXT, group_id TEXT);
CREATE TABLE message (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, text TEXT, handle_id INTEGER DEFAULT 0,
  subject TEXT, attributedBody BLOB, service TEXT, date INTEGER, date_read INTEGER, date_delivered INTEGER, is_from_me INTEGER DEFAULT 0,
  is_read INTEGER DEFAULT 0, item_type INTEGER DEFAULT 0, associated_message_guid TEXT, associated_message_type INTEGER DEFAULT 0,
  cache_roomnames TEXT);
CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER, message_date INTEGER DEFAULT 0, PRIMARY KEY (chat_id, message_id));
CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER, UNIQUE(chat_id, handle_id));`;

export function messagesDb(file: string) {
  const db = walDb(file, MESSAGES_SCHEMA);
  db.exec(`INSERT INTO handle (ROWID, id, service) VALUES (1, '+998901234567', 'iMessage'), (2, 'friend@example.com', 'iMessage'), (3, '+15550001111', 'SMS');
    INSERT INTO chat (ROWID, guid, style, chat_identifier, service_name, display_name) VALUES
      (1, 'iMessage;-;+998901234567', 45, '+998901234567', 'iMessage', ''),
      (2, 'iMessage;+;chat123456', 43, 'chat123456', 'iMessage', 'Gym crew'),
      (3, 'SMS;-;+15550001111', 45, '+15550001111', 'SMS', '');
    INSERT INTO chat_handle_join VALUES (1, 1), (2, 1), (2, 2), (3, 3);`);
  return db;
}

export function addMessage(db: DatabaseSync, m: { rowid?: number; guid: string; at: string; chat: number; handle?: number; fromMe?: boolean; text?: string | null; body?: Uint8Array | null; service?: string; assoc?: number; item?: number }) {
  const d = ns(m.at);
  db.prepare(
    `INSERT INTO message (ROWID, guid, text, handle_id, attributedBody, service, date, date_read, date_delivered, is_from_me, item_type, associated_message_type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(m.rowid ?? null, m.guid, m.text ?? null, m.handle ?? 0, m.body ?? null, m.service ?? 'iMessage', d, d + 5_000_000_000n, d + 1_000_000_000n, m.fromMe ? 1 : 0, m.item ?? 0, m.assoc ?? 0);
  const id = Number((db.prepare('SELECT ROWID AS id FROM message WHERE guid = ?').get(m.guid) as { id: number }).id);
  db.prepare('INSERT INTO chat_message_join (chat_id, message_id, message_date) VALUES (?, ?, ?)').run(m.chat, id, d);
}

export const NOTES_SCHEMA = `
CREATE TABLE app (app_id INTEGER PRIMARY KEY, identifier VARCHAR, badge INTEGER NULL);
CREATE TABLE record (rec_id INTEGER PRIMARY KEY, app_id INTEGER, uuid BLOB, data BLOB, request_date REAL, request_last_date REAL,
  delivered_date REAL, presented Bool, style INTEGER, snooze_fire_date REAL);`;

export function addNotification(db: DatabaseSync, n: { rec?: number; app: number; uuid: string; at: string; data?: Uint8Array | null }) {
  const uuid = Uint8Array.from(n.uuid.match(/../g)!.map((h) => parseInt(h, 16)));
  const t = apple(n.at);
  db.prepare('INSERT INTO record (rec_id, app_id, uuid, data, request_date, request_last_date, delivered_date, presented, style) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1)').run(n.rec ?? null, n.app, uuid, n.data ?? null, t - 1, t - 1, t);
}

export const SAFARI_SCHEMA = `
CREATE TABLE history_items (id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL UNIQUE, domain_expansion TEXT NULL, visit_count INTEGER NOT NULL,
  daily_visit_counts BLOB NOT NULL DEFAULT x'', weekly_visit_counts BLOB NULL, autocomplete_triggers BLOB NULL,
  should_recompute_derived_visit_counts INTEGER NOT NULL DEFAULT 0, visit_count_score INTEGER NOT NULL DEFAULT 0, status_code INTEGER NOT NULL DEFAULT 0);
CREATE TABLE history_visits (id INTEGER PRIMARY KEY AUTOINCREMENT, history_item INTEGER NOT NULL REFERENCES history_items(id) ON DELETE CASCADE,
  visit_time REAL NOT NULL, title TEXT NULL, load_successful BOOLEAN NOT NULL DEFAULT 1, http_non_get BOOLEAN NOT NULL DEFAULT 0,
  synthesized BOOLEAN NOT NULL DEFAULT 0, redirect_source INTEGER NULL UNIQUE, redirect_destination INTEGER NULL UNIQUE,
  origin INTEGER NOT NULL DEFAULT 0, generation INTEGER NOT NULL DEFAULT 0, attributes INTEGER NOT NULL DEFAULT 0, score INTEGER NOT NULL DEFAULT 0);`;

export function addVisit(db: DatabaseSync, v: { url: string; at: string; title?: string | null; origin?: number; ok?: number; redirect?: number | null }) {
  db.prepare('INSERT OR IGNORE INTO history_items (url, visit_count) VALUES (?, 1)').run(v.url);
  const item = Number((db.prepare('SELECT id FROM history_items WHERE url = ?').get(v.url) as { id: number }).id);
  const r = db.prepare('INSERT INTO history_visits (history_item, visit_time, title, origin, load_successful, redirect_destination) VALUES (?, ?, ?, ?, ?, ?)').run(item, apple(v.at), v.title ?? null, v.origin ?? 0, v.ok ?? 1, v.redirect ?? null);
  return Number(r.lastInsertRowid);
}

export const KNOWLEDGE_SCHEMA = `CREATE TABLE ZOBJECT (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, ZSTREAMNAME VARCHAR, ZVALUESTRING VARCHAR,
  ZSTARTDATE TIMESTAMP, ZENDDATE TIMESTAMP, ZCREATIONDATE TIMESTAMP, ZSECONDSFROMGMT INTEGER, ZSOURCE INTEGER);`;

export function addUsage(db: DatabaseSync, u: { bundle: string; from: string; to: string; stream?: string }) {
  db.prepare('INSERT INTO ZOBJECT (Z_ENT, ZSTREAMNAME, ZVALUESTRING, ZSTARTDATE, ZENDDATE, ZCREATIONDATE, ZSECONDSFROMGMT) VALUES (11, ?, ?, ?, ?, ?, 18000)').run(u.stream ?? '/app/usage', u.bundle, apple(u.from), apple(u.to), apple(u.to));
}

export const CONTACTS_SCHEMA = `
CREATE TABLE ZABCDRECORD (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, ZFIRSTNAME VARCHAR, ZLASTNAME VARCHAR, ZNICKNAME VARCHAR, ZORGANIZATION VARCHAR);
CREATE TABLE ZABCDPHONENUMBER (Z_PK INTEGER PRIMARY KEY, ZOWNER INTEGER, ZFULLNUMBER VARCHAR, ZLABEL VARCHAR);
CREATE TABLE ZABCDEMAILADDRESS (Z_PK INTEGER PRIMARY KEY, ZOWNER INTEGER, ZADDRESS VARCHAR, ZADDRESSNORMALIZED VARCHAR);`;

export function contactsDb(file: string) {
  const db = walDb(file, CONTACTS_SCHEMA);
  db.exec(`INSERT INTO ZABCDRECORD VALUES (1, 19, 'Mom', NULL, NULL, NULL), (2, 19, 'Aziz', 'Karimov', NULL, NULL), (3, 19, NULL, NULL, NULL, 'Dentist');
    INSERT INTO ZABCDPHONENUMBER VALUES (1, 1, '+998 90 123 45 67', '_$!<Mobile>!$_'), (2, 3, '(555) 000-1111', NULL);
    INSERT INTO ZABCDEMAILADDRESS VALUES (1, 2, 'Friend@Example.com', 'friend@example.com');`);
  return db;
}

// ---------- the other browsers

// Chromium (Chrome, Edge, Brave, Arc, Vivaldi, Opera): History. Not in WAL mode, the way Chrome
// keeps it.
export const CHROME_SCHEMA = `
CREATE TABLE meta (key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);
CREATE TABLE urls (id INTEGER PRIMARY KEY AUTOINCREMENT, url LONGVARCHAR, title LONGVARCHAR, visit_count INTEGER DEFAULT 0 NOT NULL,
  typed_count INTEGER DEFAULT 0 NOT NULL, last_visit_time INTEGER NOT NULL, hidden INTEGER DEFAULT 0 NOT NULL);
CREATE TABLE visits (id INTEGER PRIMARY KEY AUTOINCREMENT, url INTEGER NOT NULL, visit_time INTEGER NOT NULL, from_visit INTEGER,
  external_referrer_url TEXT, transition INTEGER DEFAULT 0 NOT NULL, segment_id INTEGER, visit_duration INTEGER DEFAULT 0 NOT NULL,
  incremented_omnibox_typed_score BOOLEAN DEFAULT FALSE NOT NULL, opener_visit INTEGER, originator_cache_guid TEXT, originator_visit_id INTEGER,
  originator_from_visit INTEGER, originator_opener_visit INTEGER, is_known_to_sync BOOLEAN DEFAULT FALSE NOT NULL,
  consider_for_ntp_most_visited BOOLEAN DEFAULT FALSE NOT NULL, visited_link_id INTEGER DEFAULT 0 NOT NULL, app_id TEXT);
CREATE INDEX visits_time_index ON visits (visit_time);
CREATE TABLE keyword_search_terms (keyword_id INTEGER NOT NULL, url_id INTEGER NOT NULL, term LONGVARCHAR NOT NULL, normalized_term LONGVARCHAR NOT NULL);`;

// Microseconds since 1601, as Chromium counts time.
export const chromeTime = (iso: string) => (BigInt(Date.parse(iso)) + 11644473600000n) * 1000n;
// A link followed: the start and the end of its chain of redirects.
export const LINK = 0x30000000;

export function chromeDb(file: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(CHROME_SCHEMA);
  return db;
}

export function addChromeVisit(db: DatabaseSync, v: { url: string; at: string; title?: string | null; transition?: number; hidden?: number; term?: string; origin?: string }) {
  db.prepare('INSERT INTO urls (url, title, visit_count, last_visit_time, hidden) SELECT ?, ?, 0, ?, ? WHERE NOT EXISTS (SELECT 1 FROM urls WHERE url = ?)').run(v.url, v.title ?? null, chromeTime(v.at), v.hidden ?? 0, v.url);
  const url = Number((db.prepare('SELECT id FROM urls WHERE url = ?').get(v.url) as { id: number }).id);
  if (v.term) db.prepare('INSERT INTO keyword_search_terms VALUES (2, ?, ?, ?)').run(url, v.term, v.term.toLowerCase());
  const r = db.prepare('INSERT INTO visits (url, visit_time, transition, originator_cache_guid) VALUES (?, ?, ?, ?)').run(url, chromeTime(v.at), v.transition ?? LINK, v.origin ?? '');
  return Number(r.lastInsertRowid);
}

// Firefox: places.sqlite, in WAL mode.
export const FIREFOX_SCHEMA = `
CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url LONGVARCHAR, title LONGVARCHAR, rev_host LONGVARCHAR, visit_count INTEGER DEFAULT 0,
  hidden INTEGER DEFAULT 0 NOT NULL, typed INTEGER DEFAULT 0 NOT NULL, frecency INTEGER DEFAULT -1 NOT NULL, last_visit_date INTEGER, guid TEXT,
  foreign_count INTEGER DEFAULT 0 NOT NULL, url_hash INTEGER DEFAULT 0 NOT NULL, description TEXT, preview_image_url TEXT, site_name TEXT,
  origin_id INTEGER, recalc_frecency INTEGER NOT NULL DEFAULT 0, alt_frecency INTEGER, recalc_alt_frecency INTEGER NOT NULL DEFAULT 0);
CREATE TABLE moz_historyvisits (id INTEGER PRIMARY KEY, from_visit INTEGER, place_id INTEGER, visit_date INTEGER, visit_type INTEGER,
  session INTEGER, source INTEGER DEFAULT 0 NOT NULL, triggeringPlaceId INTEGER);`;

export function addFirefoxVisit(db: DatabaseSync, v: { url: string; at: string; title?: string | null; type?: number; hidden?: number }) {
  db.prepare('INSERT INTO moz_places (url, title, hidden) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM moz_places WHERE url = ?)').run(v.url, v.title ?? null, v.hidden ?? 0, v.url);
  const place = Number((db.prepare('SELECT id FROM moz_places WHERE url = ?').get(v.url) as { id: number }).id);
  const r = db.prepare('INSERT INTO moz_historyvisits (place_id, visit_date, visit_type) VALUES (?, ?, ?)').run(place, Date.parse(v.at) * 1000, v.type ?? 1);
  return Number(r.lastInsertRowid);
}

// ---------- Mail: Envelope Index

export const MAIL_SCHEMA = `
CREATE TABLE mailboxes (ROWID INTEGER PRIMARY KEY, url TEXT UNIQUE, total_count INTEGER NOT NULL DEFAULT 0, unread_count INTEGER NOT NULL DEFAULT 0,
  deleted_count INTEGER NOT NULL DEFAULT 0, unseen_count INTEGER NOT NULL DEFAULT 0, unread_count_adjusted_for_duplicates INTEGER NOT NULL DEFAULT 0,
  change_identifier TEXT, source INTEGER, alleged_change_identifier TEXT);
CREATE TABLE addresses (ROWID INTEGER PRIMARY KEY, address TEXT COLLATE NOCASE, comment TEXT, UNIQUE (address, comment));
CREATE TABLE subjects (ROWID INTEGER PRIMARY KEY, subject TEXT COLLATE RTRIM, UNIQUE (subject));
CREATE TABLE message_global_data (ROWID INTEGER PRIMARY KEY, message_id INTEGER, message_id_header TEXT);
CREATE TABLE messages (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER NOT NULL DEFAULT 0, global_message_id INTEGER NOT NULL,
  remote_id INTEGER, document_id TEXT, sender INTEGER, subject_prefix TEXT, subject INTEGER NOT NULL, summary INTEGER, date_sent INTEGER,
  date_received INTEGER, mailbox INTEGER NOT NULL, remote_mailbox INTEGER, flags INTEGER NOT NULL DEFAULT 0, read INTEGER NOT NULL DEFAULT 0,
  flagged INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0, size INTEGER NOT NULL DEFAULT 0, conversation_id INTEGER NOT NULL DEFAULT 0,
  date_last_viewed INTEGER, list_id_hash INTEGER, unsubscribe_type INTEGER, searchable_message INTEGER, brand_indicator INTEGER,
  display_date INTEGER, color TEXT, type INTEGER, fuzzy_ancestor INTEGER, automated_conversation INTEGER DEFAULT 0, root_status INTEGER DEFAULT -1,
  flag_color INTEGER, is_urgent INTEGER NOT NULL DEFAULT 0);`;

// Mailboxes 1 to 6: Gmail's Inbox, All Mail and Sent, then iCloud's Inbox, Junk and Trash.
export function mailDb(file: string) {
  const db = walDb(file, MAIL_SCHEMA);
  db.exec(`INSERT INTO mailboxes (ROWID, url) VALUES
    (1, 'imap://6A1B2C3D-0000-4000-8000-000000000001/INBOX'),
    (2, 'imap://6A1B2C3D-0000-4000-8000-000000000001/%5BGmail%5D/All%20Mail'),
    (3, 'imap://6A1B2C3D-0000-4000-8000-000000000001/%5BGmail%5D/Sent%20Mail'),
    (4, 'imap://7B2C3D4E-0000-4000-8000-000000000002/INBOX'),
    (5, 'imap://7B2C3D4E-0000-4000-8000-000000000002/Junk'),
    (6, 'imap://7B2C3D4E-0000-4000-8000-000000000002/Deleted%20Messages')`);
  return db;
}

export function addMail(db: DatabaseSync, m: { at: string; from: string; name?: string | null; subject?: string; prefix?: string; mailbox: number; global?: bigint | number; messageId?: bigint | number; deleted?: number }) {
  db.prepare('INSERT OR IGNORE INTO addresses (address, comment) VALUES (?, ?)').run(m.from, m.name ?? '');
  const sender = Number((db.prepare('SELECT ROWID AS id FROM addresses WHERE address = ? AND comment = ?').get(m.from, m.name ?? '') as { id: number }).id);
  db.prepare('INSERT OR IGNORE INTO subjects (subject) VALUES (?)').run(m.subject ?? '');
  const subject = Number((db.prepare('SELECT ROWID AS id FROM subjects WHERE subject = ?').get(m.subject ?? '') as { id: number }).id);
  const t = Math.round(Date.parse(m.at) / 1000);
  const r = db
    .prepare('INSERT INTO messages (message_id, global_message_id, sender, subject_prefix, subject, date_sent, date_received, mailbox, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(m.messageId ?? 0, m.global ?? 0, sender, m.prefix ?? null, subject, t - 5, t, m.mailbox, m.deleted ?? 0);
  return Number(r.lastInsertRowid);
}

// ---------- Calendar: Calendar.sqlitedb (macOS 14 and later)

export const CALENDAR_SCHEMA = `
CREATE TABLE Store (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, type INTEGER, constraint_path TEXT, disabled INTEGER, external_id TEXT);
CREATE TABLE Calendar (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, store_id INTEGER, title TEXT, flags INTEGER, color TEXT, type TEXT,
  supported_entity_types INTEGER, external_id TEXT, UUID TEXT, shared_owner_name TEXT, published_URL TEXT, is_published INTEGER,
  invitation_status INTEGER, notes TEXT, subcal_url TEXT, refresh_interval INTEGER, symbolic_color_name TEXT);
CREATE TABLE Location (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, address TEXT, latitude REAL, longitude REAL, item_owner_id INTEGER);
CREATE TABLE CalendarItem (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, summary TEXT, location_id INTEGER, description TEXT, start_date REAL,
  start_tz TEXT, end_date REAL, all_day INTEGER, calendar_id INTEGER, orig_item_id INTEGER, orig_date REAL, organizer_id INTEGER,
  self_attendee_id INTEGER, status INTEGER, availability INTEGER, privacy_level INTEGER, url TEXT, last_modified REAL, sequence_num INTEGER,
  birthday_id INTEGER, modified_properties INTEGER, external_tracking_status INTEGER, external_id TEXT, external_mod_tag TEXT,
  unique_identifier TEXT, external_schedule_id TEXT, external_rep BLOB, response_comment TEXT, hidden INTEGER, has_recurrences INTEGER,
  has_attendees INTEGER, UUID TEXT, entity_type INTEGER, priority INTEGER, due_date REAL, due_tz TEXT, due_all_day INTEGER,
  completion_date REAL, creation_date REAL, conference TEXT, display_order INTEGER);
CREATE TABLE OccurrenceCache (day REAL, event_id INTEGER, calendar_id INTEGER, store_id INTEGER, occurrence_date REAL,
  occurrence_start_date REAL, occurrence_end_date REAL, next_reminder_date REAL);`;

// Calendars 1 to 5: Home (iCloud), Work (Google), a subscribed one, Birthdays, Holidays in United States.
export function calendarDb(file: string) {
  const db = walDb(file, CALENDAR_SCHEMA);
  db.exec(`INSERT INTO Store (ROWID, name, type) VALUES (1, 'iCloud', 2), (2, 'Google', 2), (3, 'Other', 4);
    INSERT INTO Calendar (ROWID, store_id, title, subcal_url) VALUES (1, 1, 'Home', NULL), (2, 2, 'Work', NULL),
      (3, 3, 'Football fixtures', 'webcal://example.com/fixtures.ics'), (4, 3, 'Birthdays', NULL), (5, 2, 'Holidays in United States', NULL);`);
  return db;
}

const DAY_S = 86400;

/**
 * One event, and its rows in OccurrenceCache: one per day it covers, for each time it happens.
 * `start` and `end` are UTC; for all-day events, the clock time of the day written as UTC.
 */
export function addCalEvent(
  db: DatabaseSync,
  e: { uuid: string; title: string; start: string; end: string; calendar?: number; allDay?: boolean; status?: number; birthday?: number; place?: string; repeats?: string[]; hidden?: number },
) {
  const start = apple(e.start);
  const end = apple(e.end);
  const location = e.place ? Number(db.prepare('INSERT INTO Location (title) VALUES (?)').run(e.place).lastInsertRowid) : null;
  const id = Number(
    db
      .prepare(
        `INSERT INTO CalendarItem (summary, location_id, start_date, start_tz, end_date, all_day, calendar_id, status, birthday_id, hidden, has_recurrences, UUID, unique_identifier, entity_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 2)`,
      )
      .run(e.title, location, start, e.allDay ? '_float' : 'Asia/Tashkent', end, e.allDay ? 1 : 0, e.calendar ?? 1, e.status ?? 0, e.birthday ?? 0, e.hidden ?? 0, e.repeats ? 1 : 0, e.uuid, `${e.uuid}@example.com`).lastInsertRowid,
  );
  addOccurrences(db, id, e.calendar ?? 1, [e.start, ...(e.repeats || [])].map(apple), end - start);
  return id;
}

// `due`: when each one was meant to be, if it was moved on its own.
export function addOccurrences(db: DatabaseSync, id: number, calendar: number, starts: number[], length: number, due?: number[]) {
  starts.forEach((s, k) => {
    for (let day = Math.floor(s / DAY_S) * DAY_S; day < s + Math.max(length, 1); day += DAY_S) {
      db.prepare('INSERT INTO OccurrenceCache (day, event_id, calendar_id, store_id, occurrence_date, occurrence_start_date, occurrence_end_date) VALUES (?, ?, ?, 1, ?, ?, ?)').run(day, id, calendar, due?.[k] ?? s, s, s + length);
    }
  });
}

// Before macOS 14: Calendar Cache, kept by Core Data.
export const CALENDAR_CACHE_SCHEMA = `
CREATE TABLE ZNODE (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZTITLE VARCHAR, ZUID VARCHAR);
CREATE TABLE ZCALENDARITEM (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZISALLDAY INTEGER, ZCALENDAR INTEGER, ZSTARTDATE TIMESTAMP,
  ZENDDATE TIMESTAMP, ZTITLE VARCHAR, ZSHAREDUID VARCHAR, ZLOCATION VARCHAR, ZNOTES VARCHAR);`;
