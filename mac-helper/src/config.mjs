// Where the helper keeps its things, what it may read, and its pairing code.
//
// Everything lives in ~/.arise-helper (only this user can open it):
//   bin/arise-helper   the signed helper, the one program that gets Full Disk Access
//   data/      code (the pairing code), config.json (the switches), state.json (where each source
//              is up to, and the events waiting for Arise), apps.json (this hour's app use)
//   logs/      what launchd saves of its output (no message or notification text is ever logged)
// (Before, node/ held its own Node.js and app/ the helper's scripts. The installer removes them.)

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson } from './outbox.mjs';

export const VERSION = 1;
export const PORT = 47613;
export const LABEL = 'io.github.abyyworld.arise-helper';
// Which build of the signed helper this is, set when it's built (scripts/build-mac-helper.mjs).
export const BUILD = typeof __ARISE_HELPER_BUILD__ === 'string' ? __ARISE_HELPER_BUILD__ : 'dev';
// The only website that may talk to the helper. Every GitHub Pages site of the abyyworld account
// has this same origin (and can read Arise's saved pairing link), so no other may be published
// there; see docs/LAUNCH.md, Known limits. The signed helper allows only this one. (Run with
// Node.js while working on it, helper.mjs can add more, for a copy of Arise run on this Mac.)
export const ORIGIN = 'https://abyyworld.github.io';

export function dirs(base) {
  return { base, data: path.join(base, 'data'), tmp: path.join(base, 'tmp'), logs: path.join(base, 'logs'), program: path.join(base, 'bin', 'arise-helper') };
}

// What the helper reads. Everything starts off; the Player turns on what they want in Arise.
// `text` adds the words of messages and notifications; without it, only who and when.
export const SWITCHES = ['calls', 'notifications', 'messages', 'text', 'safari', 'apps'];
/** @returns {Record<string, boolean>} */
export const defaultSettings = () => Object.fromEntries(SWITCHES.map((k) => [k, false]));
export function cleanSettings(x, base = defaultSettings()) {
  const out = { ...base };
  if (x && typeof x === 'object') for (const k of SWITCHES) if (typeof x[k] === 'boolean') out[k] = x[k];
  return out;
}

// How far back a source starts when it's turned on.
const DAY = 86400000;
export const BACKFILL = { calls: 30 * DAY, notifications: 7 * DAY, messages: 7 * DAY, safari: 7 * DAY, apps: 7 * DAY };

// ---------- the pairing code

// 20 letters and digits (100 random bits), without I, L, O or U so none can be misread.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CODE = /^[0-9A-HJKMNP-TV-Z]{20}$/;
export const newCode = () => Array.from({ length: 20 }, () => ALPHABET[crypto.randomInt(32)]).join('');
export const formatCode = (c) => (c.match(/.{1,5}/g) || []).join('-');
// As typed: any case, with or without dashes or spaces, O for 0 and I or L for 1.
export const normalizeCode = (s) =>
  String(s ?? '')
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');

// The code lives in data/code on its own, so `new-code` can change it while the helper runs (the
// server reads it again when the file changes).
export function loadCode(base) {
  const file = path.join(dirs(base).data, 'code');
  try {
    const c = fs.readFileSync(file, 'utf8').trim();
    if (CODE.test(c)) return c;
  } catch {}
  return saveCode(base, newCode());
}

export function saveCode(base, code) {
  ensureDirs(base);
  const file = path.join(dirs(base).data, 'code');
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, code, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return code;
}

export function ensureDirs(base) {
  const d = dirs(base);
  for (const dir of [d.base, d.data, d.logs]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

// ---------- config.json: the switches, and when each source was turned on

/**
 * @typedef {{ settings: Record<string, boolean>, since: Record<string, number> }} Config
 */

/** @returns {Config} */
export function loadConfig(base) {
  ensureDirs(base);
  const raw = readJson(path.join(dirs(base).data, 'config.json'), {}) || {};
  /** @type {Record<string, number>} */
  const since = {};
  for (const k of Object.keys(BACKFILL)) if (Number.isFinite(raw.since?.[k])) since[k] = raw.since[k];
  return { settings: cleanSettings(raw.settings), since };
}

export function saveConfig(base, cfg) {
  ensureDirs(base);
  writeJson(path.join(dirs(base).data, 'config.json'), cfg);
}
