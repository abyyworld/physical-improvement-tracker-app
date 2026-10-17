// The helper's own files, in the folders of ~/.arise-helper (data/ and logs/).
//
// The helper has Full Disk Access, and any program running as the same user can change that
// folder. If it put a link where the helper writes, pointing to a file only Full Disk Access can
// reach, the helper would change or empty that file for it. So the helper only reads and writes in
// folders that are its own (real folders, not links, that belong to this user), never through a
// link (on macOS, not one anywhere in the path), and it writes each file whole to a new file with a
// name nobody can guess, which then takes the old one's place.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const { O_RDONLY, O_RDWR, O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants;
// macOS 11 and newer: no link anywhere in the path (O_NOFOLLOW_ANY), not only at its end.
const NOFOLLOW_ANY = process.platform === 'darwin' ? 0x20000000 : 0;
const NO_LINKS = O_NOFOLLOW | NOFOLLOW_ANY;
const uid = typeof process.getuid === 'function' ? process.getuid() : -1;

/**
 * Throws unless `dir` is a real folder (not a link) that belongs to this user.
 * @param {string} dir
 */
export function ownDir(dir) {
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || (uid >= 0 && st.uid !== uid)) throw new Error(`${dir} isn't the helper's own folder (it's a link, or someone else's), so the helper won't use it.`);
}

// `file` is in a folder of ~/.arise-helper: that folder and ~/.arise-helper must be the helper's
// own. The path that comes back has no link in it at all (the folder above ~/.arise-helper, the
// home folder, is taken as the system has it), so on macOS opening it refuses any link.
/** @param {string} file */
function checked(file) {
  const dir = path.dirname(file);
  const base = path.dirname(dir);
  ownDir(base);
  ownDir(dir);
  return path.join(fs.realpathSync(path.dirname(base)), path.basename(base), path.basename(dir), path.basename(file));
}

/**
 * Reads one of the helper's files, never through a link.
 * @param {string} file
 */
export function readOwn(file) {
  const fd = fs.openSync(checked(file), O_RDONLY | NO_LINKS);
  try {
    return fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Writes one of the helper's files whole: first to a new file nobody can guess the name of (never
 * one that's already there, never through a link), then in place of the old one, so a crash never
 * leaves half a file. Only this user can read it.
 * @param {string} file
 * @param {string} text
 */
export function writeOwn(file, text) {
  const target = checked(file);
  const tmp = `${target}.${crypto.randomBytes(12).toString('hex')}.tmp`;
  // (Node.js takes the flags as a number too, though its types only say text.)
  const flag = /** @type {any} */ (O_WRONLY | O_CREAT | O_EXCL | NO_LINKS);
  try {
    fs.writeFileSync(tmp, text, { flag, mode: 0o600 });
    fs.renameSync(tmp, target);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw e;
  }
}

/**
 * Keeps a log short: past `max` bytes, only its last `keep` stay. Only a plain file of this user's
 * with no other name (not a link, not a hard link to another file), in a folder of its own.
 * @param {string} file
 * @param {number} max
 * @param {number} keep
 */
export function trimOwn(file, max, keep) {
  const fd = fs.openSync(checked(file), O_RDWR | NO_LINKS);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || (uid >= 0 && st.uid !== uid)) throw new Error(`${file} isn't the helper's own log, so it's left as it is.`);
    if (st.size < max) return false;
    const buf = Buffer.alloc(keep);
    const n = fs.readSync(fd, buf, 0, keep, st.size - keep);
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, buf, 0, n, 0);
    return true;
  } finally {
    fs.closeSync(fd);
  }
}
