// Reading Apple's databases without ever touching them: each read works on a private copy.
//
// The database and its write-ahead log ("-wal", where the newest changes wait) are copied into a
// folder only this user can open, and the copy is opened. On the Mac's own disk (APFS) the copy is
// a clone: instant, and it takes no space. The originals are only ever read as files, so the
// helper never holds a lock on them, and nothing it does can change or break them. The shared-
// memory file ("-shm") isn't copied: SQLite rebuilds it from the log, which is safer than a copy
// of memory another program is changing.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Runs `fn` on a private copy of the database at `file`, then deletes the copy.
 * @template T
 * @param {string} file
 * @param {string} tmpRoot a folder of the helper's own
 * @param {(db: DatabaseSync) => T} fn
 * @returns {T}
 */
export function withSnapshot(file, tmpRoot, fn) {
  fs.mkdirSync(tmpRoot, { recursive: true, mode: 0o700 });
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'read-'));
  try {
    const copy = path.join(dir, 'db');
    fs.copyFileSync(file, copy, fs.constants.COPYFILE_FICLONE);
    try {
      fs.copyFileSync(`${file}-wal`, `${copy}-wal`, fs.constants.COPYFILE_FICLONE);
    } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'ENOENT') throw e;
    }
    const db = new DatabaseSync(copy);
    try {
      return fn(db);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// A cheap fingerprint of a database and its log, to skip reading when nothing changed.
export function stamp(file) {
  const part = (f) => {
    try {
      const s = fs.statSync(f);
      return `${s.size}:${s.mtimeMs}`;
    } catch {
      return '-';
    }
  };
  return `${part(file)}|${part(`${file}-wal`)}`;
}

// The columns a table has, so queries only ask for what this macOS version keeps.
/** @param {DatabaseSync} db @param {string} table */
export function columns(db, table) {
  const rows = /** @type {{ name: string }[]} */ (db.prepare('SELECT name FROM pragma_table_info(?)').all(table));
  return new Set(rows.map((r) => r.name));
}

/** @param {DatabaseSync} db @param {string} table */
export function hasTable(db, table) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}

// Why reading failed, in the helper's words: no Full Disk Access, not there, or something else.
export function failure(e) {
  const err = /** @type {NodeJS.ErrnoException} */ (e);
  if (err?.code === 'EPERM' || err?.code === 'EACCES') return 'no-access';
  if (err?.code === 'ENOENT') return 'missing';
  return 'error';
}
