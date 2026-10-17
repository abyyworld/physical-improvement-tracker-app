// Mail: ~/Library/Mail/V10/MailData/Envelope Index (the newest V folder), Apple Mail's list of the
// messages in every account it has, Gmail, Outlook and iCloud alike. Only mail that came in: not
// what's in Junk, Trash, Drafts or Sent, and not what the Player sent themselves (told by the
// senders of what's in Sent, since Gmail keeps sent mail in All Mail too).
//
// Who and when only; the subject is read only when the Player turned on message text, like the
// words of messages. Never the message itself (Mail keeps that in other files).

import fs from 'node:fs';
import path from 'node:path';
import { columns, hasTable } from './snapshot.mjs';
import { APPLE_EPOCH } from './time.mjs';
import { clip, col, page, str } from './sources.mjs';

/** @param {string} userHome */
export function mailFile(userHome) {
  const root = path.join(userHome, 'Library', 'Mail');
  let v = 0;
  try {
    for (const d of fs.readdirSync(root)) {
      const m = /^V(\d+)$/.exec(d);
      if (m) v = Math.max(v, Number(m[1]));
    }
  } catch {}
  // (Without Full Disk Access the folder can't be listed: the usual one, so the read says why.)
  return path.join(root, `V${v || 10}`, 'MailData', 'Envelope Index');
}

const SENT = /^sent( mail| items| messages)?$/i;
const SKIP = /^(junk( ?e-?mail)?|spam|bulk( mail)?|trash|bin|deleted( messages| items)?|drafts?|outbox|notes)$/i;

// What a mailbox holds, by the last part of its address ("imap://…/%5BGmail%5D/Sent%20Mail" is
// Sent): 'sent', 'skip' (junk, trash, drafts) or 'keep'.
/** @returns {'sent' | 'skip' | 'keep'} */
export function mailboxKind(url) {
  let name = '';
  try {
    name = decodeURIComponent(str(url).split('?')[0].replace(/\/+$/, '').split('/').pop() || '').trim();
  } catch {}
  if (SENT.test(name)) return 'sent';
  if (SKIP.test(name)) return 'skip';
  return 'keep';
}

/** @param {import('node:sqlite').DatabaseSync} db */
export function readMail(db, { after = 0, since = 0, text = false } = {}) {
  if (!hasTable(db, 'messages')) return { rows: [], cursor: after, more: false, unknown: true };
  const m = columns(db, 'messages');
  if (!m.has('date_received')) return { rows: [], cursor: after, more: false, unknown: true };
  /** @type {{ id: number, url: string }[]} */
  const boxes = hasTable(db, 'mailboxes') && m.has('mailbox') ? /** @type {any[]} */ (db.prepare('SELECT ROWID AS id, url FROM mailboxes').all()) : [];
  const ids = (kind) => boxes.filter((b) => (kind === 'sent' ? mailboxKind(b.url) === 'sent' : mailboxKind(b.url) !== 'keep')).map((b) => Number(b.id)).filter(Number.isInteger);
  const skip = ids('skip');
  const sent = ids('sent');
  const senders = hasTable(db, 'addresses') && m.has('sender');
  // The subject is only read when the Player turned on message text.
  const subjects = text && hasTable(db, 'subjects') && m.has('subject');
  const where = ['m.ROWID > ?', 'm.date_received >= ?'];
  if (m.has('deleted')) where.push('COALESCE(m.deleted, 0) = 0');
  if (skip.length) where.push(`(m.mailbox IS NULL OR m.mailbox NOT IN (${skip.join(', ')}))`);
  if (sent.length && m.has('sender')) where.push(`(m.sender IS NULL OR m.sender NOT IN (SELECT sender FROM messages WHERE mailbox IN (${sent.join(', ')}) AND sender IS NOT NULL))`);
  // Message ids are 64-bit numbers, too big for JavaScript: read as text.
  const sql = `SELECT m.ROWID AS rowid, m.date_received AS date, ${col(m, 'global_message_id', 'CAST(m.global_message_id AS TEXT)')} AS gid,
      ${col(m, 'message_id', 'CAST(m.message_id AS TEXT)')} AS mid, ${senders ? 'a.address' : 'NULL'} AS address, ${senders ? 'a.comment' : 'NULL'} AS name,
      ${subjects ? 's.subject' : 'NULL'} AS subject, ${subjects ? col(m, 'subject_prefix', 'm.subject_prefix') : 'NULL'} AS prefix
    FROM messages m
    ${senders ? 'LEFT JOIN addresses a ON a.ROWID = m.sender' : ''}
    ${subjects ? 'LEFT JOIN subjects s ON s.ROWID = m.subject' : ''}
    WHERE ${where.join(' AND ')} ORDER BY m.ROWID LIMIT ?`;
  return page(db, 'messages', 'ROWID', 'rowid', after, sql, [Math.floor(Math.max(0, since) / 1000)]);
}

const number = (v) => (/^-?\d{1,20}$/.test(str(v)) && !/^-?0+$/.test(str(v)) ? str(v) : '');

/** @param {any} row @param {{ lookup(a: string): string }} names @param {boolean} withText */
export function mailEvent(row, names, withText) {
  // Seconds since 1970.
  const sec = Number(row.date);
  if (!Number.isFinite(sec) || sec <= APPLE_EPOCH || sec >= 4102444800) return null;
  const address = clip(str(row.address), 120);
  const who = clip(names.lookup(address) || str(row.name) || address || 'someone', 80);
  // The same email in two mailboxes (Gmail's Inbox and All Mail) has one global id: it counts once.
  const gid = number(row.gid);
  const mid = number(row.mid);
  const key = gid ? `g${gid}` : mid ? `m${mid}` : `r${Number(row.rowid)}`;
  const subject = withText ? clip(`${str(row.prefix)}${str(row.subject)}`, 300) : '';
  /** @type {Record<string, string | number | boolean>} */
  const meta = { channel: 'email', direction: 'in' };
  if (address) meta.with = address;
  return { id: `mac:mail:${key}`, source: 'mac', kind: 'message', at: Math.round(sec * 1000), title: `Email from ${who}`, ...(subject ? { detail: subject } : {}), tier: 3, meta };
}
