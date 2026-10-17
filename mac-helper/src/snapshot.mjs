// Reading Apple's databases without changing them, and without copying them.
//
// Each database is opened where it is, read-only: SQLite refuses any write, so the database and its
// write-ahead log ("-wal", where the newest changes wait) stay as they were, and each query sees
// one consistent moment of both, even while the app writes. Each query takes only a moment, so the
// app writing them is never held up. (If no app has the database open, SQLite may add its empty
// "-wal" and "-shm" files beside it, as every program reading it does.)
//
// No copy is ever made. A copy in the helper's own folder could be read by any program, without
// the Full Disk Access the originals need, and it would hold everything in them (every message
// ever, with its words), not only what the Player turned on.

import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

/**
 * Runs `fn` on the database at `file`, opened read-only.
 * @template T
 * @param {string} file
 * @param {(db: DatabaseSync) => T} fn
 * @returns {T}
 */
export function withSnapshot(file, fn) {
  // Opened as a file first: that says why it can't be read (no Full Disk Access, not there) in the
  // system's words, which SQLite doesn't.
  fs.closeSync(fs.openSync(file, 'r'));
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return fn(db);
  } finally {
    db.close();
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
