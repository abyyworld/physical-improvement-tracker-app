// Names for phone numbers and email addresses, from the Mac's Contacts (its own "On My Mac" list
// and each synced account, like iCloud, under Sources/). Used for calls and messages only, and
// kept in memory: names are never saved by the helper.

import fs from 'node:fs';
import path from 'node:path';
import { columns, hasTable } from './snapshot.mjs';

// Digits only. Numbers are matched in full, or by their last 9 digits (the number without its
// country code) when only one contact has those.
const digits = (s) => String(s ?? '').replace(/\D/g, '');

export class Names {
  constructor() {
    /** @type {Map<string, string>} */ this.full = new Map();
    /** @type {Map<string, string | null>} */ this.tail = new Map(); // null: more than one person
    /** @type {Map<string, string>} */ this.email = new Map();
  }

  addPhone(number, name) {
    const d = digits(number);
    if (d.length < 3 || !name) return;
    this.full.set(d, name);
    if (d.length >= 9) {
      const t = d.slice(-9);
      const had = this.tail.get(t);
      this.tail.set(t, had === undefined || had === name ? name : null);
    }
  }

  addEmail(address, name) {
    const a = String(address ?? '').trim().toLowerCase();
    if (a.includes('@') && name) this.email.set(a, name);
  }

  // The name for a number or address from Messages or call history, or ''.
  lookup(address) {
    const a = String(address ?? '').trim();
    if (!a) return '';
    if (a.includes('@')) return this.email.get(a.toLowerCase()) || '';
    const d = digits(a);
    if (!d) return '';
    return this.full.get(d) || (d.length >= 9 && this.tail.get(d.slice(-9))) || '';
  }

  get size() {
    return this.full.size + this.email.size;
  }
}

/** @param {import('node:sqlite').DatabaseSync} db @param {Names} names */
export function readContacts(db, names) {
  if (!hasTable(db, 'ZABCDRECORD')) return names;
  const rc = columns(db, 'ZABCDRECORD');
  const pick = (c) => (rc.has(c) ? c : 'NULL');
  const people = new Map();
  const rows = db.prepare(`SELECT Z_PK AS id, ${pick('ZFIRSTNAME')} AS first, ${pick('ZLASTNAME')} AS last, ${pick('ZNICKNAME')} AS nick, ${pick('ZORGANIZATION')} AS org FROM ZABCDRECORD`).all();
  for (const r of /** @type {any[]} */ (rows)) {
    const name = [r.first, r.last].filter((x) => typeof x === 'string' && x.trim()).join(' ').trim() || r.nick || r.org || '';
    if (name) people.set(r.id, String(name).slice(0, 80));
  }
  if (hasTable(db, 'ZABCDPHONENUMBER')) {
    for (const r of /** @type {any[]} */ (db.prepare('SELECT ZOWNER AS owner, ZFULLNUMBER AS number FROM ZABCDPHONENUMBER').all())) names.addPhone(r.number, people.get(r.owner));
  }
  if (hasTable(db, 'ZABCDEMAILADDRESS')) {
    const ec = columns(db, 'ZABCDEMAILADDRESS');
    const col = ec.has('ZADDRESS') ? 'ZADDRESS' : ec.has('ZADDRESSNORMALIZED') ? 'ZADDRESSNORMALIZED' : '';
    if (col) for (const r of /** @type {any[]} */ (db.prepare(`SELECT ZOWNER AS owner, ${col} AS address FROM ZABCDEMAILADDRESS`).all())) names.addEmail(r.address, people.get(r.owner));
  }
  return names;
}

// Every Contacts database of this user: ~/Library/Application Support/AddressBook and its Sources.
export function contactFiles(home) {
  const root = path.join(home, 'Library', 'Application Support', 'AddressBook');
  const out = [];
  const db = 'AddressBook-v22.abcddb';
  if (fs.existsSync(path.join(root, db))) out.push(path.join(root, db));
  try {
    for (const d of fs.readdirSync(path.join(root, 'Sources'))) {
      const f = path.join(root, 'Sources', d, db);
      if (fs.existsSync(f)) out.push(f);
    }
  } catch {}
  return out;
}
