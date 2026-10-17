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
