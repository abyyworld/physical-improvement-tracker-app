// What the helper reads, each from its database opened read-only (snapshot.mjs), as rows and then
// as life events for Arise (the LifeEvent shape in src/life/types.ts).
//
// Each reader takes a cursor and gives back the rows after it plus the next cursor, so every read
// only looks at what's new. `since` (ms) is when the Player turned the source on, less a few days
// of history; older rows are never read.

import { columns, hasTable } from './snapshot.mjs';
import { APPLE_EPOCH, appleToMs, duration, messagesMsSql, msToApple } from './time.mjs';
import { parseBplist } from './bplist.mjs';
import { attributedText } from './typedstream.mjs';
import { appName } from './apps.mjs';

export const SOURCES = ['calls', 'notifications', 'messages', 'safari', 'apps'];

const LIMIT = 500;

// Short, single-line text, cut at `n` characters.
export function clip(s, n) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

// Text that may be stored as bytes.
const str = (v) => (v instanceof Uint8Array ? new TextDecoder().decode(v) : v == null ? '' : String(v));
const hex = (v) => (v instanceof Uint8Array ? Array.from(v, (b) => b.toString(16).padStart(2, '0')).join('') : str(v).replace(/[^\w-]/g, ''));

// Picks a column if this macOS version has it, or NULL.
const col = (have, name, expr = name) => (have.has(name) ? expr : 'NULL');

// The highest key a table has ever handed out. Keys are never used twice: Messages and Safari
// count them in sqlite_sequence (AUTOINCREMENT), Core Data in Z_PRIMARYKEY. Deleting the newest
// rows doesn't lower that count; only a table made anew starts it again. Without either, it's the
// newest key there is.
function highWater(db, table, max) {
  let top = max;
  try {
    if (hasTable(db, 'sqlite_sequence')) top = Math.max(top, Number(/** @type {any} */ (db.prepare('SELECT seq FROM sqlite_sequence WHERE name = ?').get(table))?.seq) || 0);
    if (hasTable(db, 'Z_PRIMARYKEY')) top = Math.max(top, Number(/** @type {any} */ (db.prepare("SELECT Z_MAX AS m FROM Z_PRIMARYKEY WHERE 'Z' || UPPER(Z_NAME) = ?").get(table))?.m) || 0);
  } catch {}
  return top;
}

// Rows after the cursor, oldest first. When fewer than a page come back, the cursor jumps to the
// newest row the table has, so rows from before `since` are never looked at again. A table that
// was made anew (its count of keys is below the cursor) is read from the start; one whose newest
// rows were deleted is not.
function page(db, table, key, alias, after, sql, params) {
  const max = Number(/** @type {any} */ (db.prepare(`SELECT MAX(${key}) AS m FROM ${table}`).get())?.m) || 0;
  if (highWater(db, table, max) < after) after = 0;
  const rows = /** @type {any[]} */ (db.prepare(sql).all(after, ...params, LIMIT));
  const last = rows.length ? Number(rows[rows.length - 1][alias]) : after;
  return { rows, cursor: rows.length < LIMIT ? Math.max(last, max) : last, more: rows.length === LIMIT };
}

// ---------- calls: ~/Library/Application Support/CallHistoryDB/CallHistory.storedata

/** @param {import('node:sqlite').DatabaseSync} db */
export function readCalls(db, { after = 0, since = 0 } = {}) {
  if (!hasTable(db, 'ZCALLRECORD')) return { rows: [], cursor: after, more: false };
  const c = columns(db, 'ZCALLRECORD');
  const sql = `SELECT Z_PK AS pk, ${col(c, 'ZUNIQUE_ID')} AS uid, ZDATE AS date, ${col(c, 'ZDURATION')} AS duration,
      ${col(c, 'ZADDRESS')} AS address, ${col(c, 'ZNAME')} AS name, ${col(c, 'ZANSWERED')} AS answered,
      ${col(c, 'ZORIGINATED')} AS originated, ${col(c, 'ZCALLTYPE')} AS type, ${col(c, 'ZSERVICE_PROVIDER')} AS provider
    FROM ZCALLRECORD WHERE Z_PK > ? AND ZDATE >= ? ORDER BY Z_PK LIMIT ?`;
  return page(db, 'ZCALLRECORD', 'Z_PK', 'pk', after, sql, [msToApple(since)]);
}

// ZCALLTYPE: 1 phone, 8 FaceTime video, 16 FaceTime audio, 0 another app (WhatsApp and the like,
// named by ZSERVICE_PROVIDER).
function callWay(type, provider) {
  const t = Number(type);
  if (t === 8) return { type: 'facetime-video', via: 'FaceTime video' };
  if (t === 16) return { type: 'facetime-audio', via: 'FaceTime audio' };
  const p = str(provider);
  if (t === 0 && p && !p.startsWith('com.apple.')) return { type: 'app', via: appName(p), app: p };
  return { type: 'phone', via: '' };
}

// Missed: someone called and it wasn't answered (not one this Mac or the iPhone made).
export const isMissed = (row) => !Number(row.originated) && !Number(row.answered);

/** @param {any} row @param {{ lookup(a: string): string }} names */
export function callEvent(row, names) {
  const at = appleToMs(row.date);
  if (!at) return null;
  const sec = Math.max(0, Number(row.duration) || 0);
  const out = !!Number(row.originated);
  const missed = isMissed(row);
  const address = clip(str(row.address), 80);
  const who = clip(str(row.name) || names.lookup(address) || address || 'an unknown number', 80);
  const way = callWay(row.type, row.provider);
  const call = way.via ? `${way.via} call` : 'Call';
  const title = missed
    ? `Missed ${way.via ? `${way.via} ` : ''}call from ${who}`
    : out
      ? `${call} to ${who}, ${sec > 0 ? duration(sec) : 'no answer'}`
      : `${call} from ${who}, ${duration(sec)}`;
  /** @type {Record<string, string | number | boolean>} */
  const meta = { direction: out ? 'out' : 'in', missed, type: way.type };
  if (address) meta.with = address;
  if (way.app) meta.app = way.app;
  return {
    id: `mac:call:${hex(row.uid) || `pk${row.pk}`}`,
    source: 'mac',
    kind: 'call',
    at,
    ...(sec > 0 ? { end: at + Math.round(sec * 1000), value: Math.round(sec / 6) / 10, unit: 'min' } : {}),
    title,
    tier: 3,
    meta,
  };
}

// ---------- messages: ~/Library/Messages/chat.db

/** @param {import('node:sqlite').DatabaseSync} db */
export function readMessages(db, { after = 0, since = 0, text = false } = {}) {
  if (!hasTable(db, 'message')) return { rows: [], cursor: after, more: false };
  const m = columns(db, 'message');
  const chats = hasTable(db, 'chat') && hasTable(db, 'chat_message_join');
  const ch = chats ? columns(db, 'chat') : new Set();
  const handles = hasTable(db, 'handle');
  // The words are only read when the Player turned on message text.
  const words = text ? `, ${col(m, 'text', 'm.text')} AS text, ${col(m, 'attributedBody', 'm.attributedBody')} AS body` : '';
  const sql = `SELECT m.ROWID AS rowid, m.guid AS guid, ${messagesMsSql('m.date')} AS ms, ${col(m, 'is_from_me', 'm.is_from_me')} AS fromMe,
      ${col(m, 'service', 'm.service')} AS service, ${col(m, 'associated_message_type', 'm.associated_message_type')} AS assoc,
      ${col(m, 'item_type', 'm.item_type')} AS item, ${handles ? 'h.id' : 'NULL'} AS handle,
      ${chats ? `${col(ch, 'display_name', 'c.display_name')}` : 'NULL'} AS chatName, ${chats ? `${col(ch, 'chat_identifier', 'c.chat_identifier')}` : 'NULL'} AS chatId,
      ${chats ? `${col(ch, 'style', 'c.style')}` : 'NULL'} AS style${words}
    FROM message m
    ${handles ? 'LEFT JOIN handle h ON h.ROWID = m.handle_id' : ''}
    ${chats ? 'LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID LEFT JOIN chat c ON c.ROWID = cmj.chat_id' : ''}
    WHERE m.ROWID > ? AND ${messagesMsSql('m.date')} >= ? ORDER BY m.ROWID LIMIT ?`;
  const r = page(db, 'message', 'ROWID', 'rowid', after, sql, [Math.max(0, since - APPLE_EPOCH * 1000)]);
  // A message in two chats comes back twice: once is enough.
  const seen = new Set();
  r.rows = r.rows.filter((x) => !seen.has(x.guid) && seen.add(x.guid));
  return r;
}

/** @param {any} row @param {{ lookup(a: string): string }} names @param {boolean} withText */
export function messageEvent(row, names, withText) {
  // Reactions (tapbacks) and group changes (renames, people added) aren't messages.
  if (Number(row.assoc) || Number(row.item)) return null;
  const ms = Number(row.ms);
  const at = ms > 0 ? appleToMs(ms / 1000) : null;
  if (!at || !row.guid) return null;
  const fromMe = !!Number(row.fromMe);
  const chatId = str(row.chatId);
  const group = Number(row.style) === 43 || /^chat\d/.test(chatId);
  const handle = clip(str(row.handle) || (group ? '' : chatId), 80);
  const who = clip(names.lookup(handle) || handle || 'someone', 80);
  const groupName = clip(str(row.chatName), 80) || 'a group chat';
  const title = group ? (fromMe ? `Message to ${groupName}` : `Message from ${who} in ${groupName}`) : fromMe ? `Message to ${who}` : `Message from ${who}`;
  /** @type {Record<string, string | number | boolean>} */
  const meta = { direction: fromMe ? 'out' : 'in', group };
  if (handle) meta.with = handle;
  if (row.service) meta.service = clip(str(row.service), 20);
  const words = withText ? clip(str(row.text) || attributedText(row.body), 1000) : '';
  return { id: `mac:msg:${clip(str(row.guid), 80)}`, source: 'mac', kind: 'message', at, title, ...(words ? { detail: words } : {}), tier: 3, meta };
}

// ---------- notifications: ~/Library/Group Containers/group.com.apple.usernoted/db2/db (macOS 15
// and later; macOS 14 and earlier: $(getconf DARWIN_USER_DIR)/com.apple.notificationcenter/db2/db)
//
// A row goes as soon as the notification is cleared, so this is read every 15 seconds. Row ids are
// reused, so the cursor is the delivery time, read again a minute back (usernoted writes rows a
// few seconds late), and each notification is known by its own uuid.
//
// Within one read, page after page, each page goes on from the last row of the one before (`from`:
// its time, then its row id), so a burst of more than a page within a minute is still read through.

const OVERLAP = 60; // seconds

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ after?: number, since?: number, from?: { date: number, id: number } | null }} [opts]
 */
export function readNotifications(db, { after = 0, since = 0, from = null } = {}) {
  if (!hasTable(db, 'record')) return { rows: [], cursor: after, more: false, next: from };
  const c = columns(db, 'record');
  const dates = ['delivered_date', 'request_date', 'date'].filter((d) => c.has(d)).map((d) => `r.${d}`);
  if (!dates.length) return { rows: [], cursor: after, more: false, next: from };
  const when = dates.length > 1 ? `COALESCE(${dates.join(', ')})` : dates[0];
  const apps = hasTable(db, 'app') && c.has('app_id');
  const where = from ? `(${when} > ? OR (${when} = ? AND r.rowid > ?))` : `${when} > ?`;
  const params = from ? [from.date, from.date, from.id] : [Math.max(after - OVERLAP, msToApple(since))];
  const sql = `SELECT r.rowid AS rid, ${col(c, 'uuid', 'r.uuid')} AS uuid, ${col(c, 'data', 'r.data')} AS data, ${when} AS date, ${apps ? 'a.identifier' : 'NULL'} AS app
    FROM record r ${apps ? 'LEFT JOIN app a ON a.app_id = r.app_id' : ''}
    WHERE ${where} ORDER BY ${when}, r.rowid LIMIT ?`;
  const rows = /** @type {any[]} */ (db.prepare(sql).all(...params, LIMIT));
  const last = rows.reduce((m, r) => Math.max(m, Number(r.date) || 0), after);
  const end = rows[rows.length - 1];
  return { rows, cursor: last, more: rows.length === LIMIT, next: end ? { date: Number(end.date), id: Number(end.rid) } : from };
}

// "_system_center_:com.apple.foo" and the like: the app is the part after the scope.
export const cleanBundle = (id) => clip(str(id).split(':').pop(), 120);

/** @param {any} row @param {{ text: boolean, appName?: (id: string) => string }} opts */
export function notificationEvent(row, { text, appName: name = appName }) {
  const at = appleToMs(row.date);
  if (!at) return null;
  /** @type {any} */
  let plist = null;
  try {
    plist = row.data ? parseBplist(row.data) : null;
  } catch {}
  const bundle = cleanBundle(row.app || (plist && typeof plist.app === 'string' ? plist.app : ''));
  const req = plist && typeof plist.req === 'object' && plist.req ? plist.req : {};
  const words = text
    ? clip(
        ['titl', 'subt', 'body']
          .map((k) => req[k])
          .filter((v) => typeof v === 'string' && v.trim())
          .join(' · '),
        1000,
      )
    : '';
  const id = hex(row.uuid) || `${bundle}-${Math.round(Number(row.date) * 1000)}`;
  /** @type {Record<string, string | number | boolean>} */
  const meta = {};
  if (bundle) meta.app = bundle;
  return { id: `mac:note:${clip(id, 100)}`, source: 'mac', kind: 'notification', at, title: `Notification from ${bundle ? name(bundle) : 'an app'}`, ...(words ? { detail: words } : {}), tier: 3, meta };
}

// ---------- Safari: ~/Library/Safari/History.db
//
// With Safari on in iCloud, visits from the iPhone and other devices sync into the same file;
// history_visits.origin is 1 for those and 0 for this Mac.

/** @param {import('node:sqlite').DatabaseSync} db */
export function readSafari(db, { after = 0, since = 0 } = {}) {
  if (!hasTable(db, 'history_visits') || !hasTable(db, 'history_items')) return { rows: [], cursor: after, more: false };
  const v = columns(db, 'history_visits');
  const sql = `SELECT v.id AS id, v.visit_time AS time, ${col(v, 'title', 'v.title')} AS title, ${col(v, 'origin', 'v.origin')} AS origin,
      ${col(v, 'load_successful', 'v.load_successful')} AS ok, ${col(v, 'redirect_destination', 'v.redirect_destination')} AS redirect, i.url AS url
    FROM history_visits v JOIN history_items i ON i.id = v.history_item
    WHERE v.id > ? AND v.visit_time >= ? ORDER BY v.id LIMIT ?`;
  return page(db, 'history_visits', 'id', 'id', after, sql, [msToApple(since)]);
}

/** @param {any} row @param {string} [profile] */
export function visitEvent(row, profile = '') {
  const at = appleToMs(row.time);
  if (!at) return null;
  // Failed loads and redirects (the page it went on to is its own visit) are left out.
  if (row.ok === 0 || row.redirect != null) return null;
  let url;
  try {
    url = new URL(str(row.url));
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.replace(/^www\./, '');
  const elsewhere = Number(row.origin) === 1;
  return {
    id: `mac:safari:${profile ? `${profile}:` : ''}${Number(row.id)}`,
    source: 'mac',
    kind: 'visit',
    at,
    title: `Visited ${clip(str(row.title), 120) || host}`,
    ...(elsewhere ? { detail: 'On your iPhone or another device' } : {}),
    url: url.href.length > 2000 ? `${url.origin}${url.pathname}`.slice(0, 2000) : url.href,
    tier: 3,
    meta: { browser: 'safari', device: elsewhere ? 'other' : 'mac', site: clip(host, 100) },
  };
}
