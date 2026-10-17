// The helper at work: every 15 seconds it reads what's new in each source the Player turned on
// and queues it for Arise, which pulls it through the local server (server.mjs).

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BACKFILL, BUILD, ORIGIN, PORT, VERSION, cleanSettings, dirs, loadCode, loadConfig, saveConfig } from './config.mjs';
import { Outbox, readJson, writeJson } from './outbox.mjs';
import { createServer } from './server.mjs';
import { columns, failure, stamp, withSnapshot } from './snapshot.mjs';
import { SOURCES, callEvent, cleanBundle, messageEvent, notificationEvent, readCalls, readMessages, readNotifications, readSafari, visitEvent } from './sources.mjs';
import { AppTracker, appName, findAppName, hasAppName, learnedNames, parseAppInfo, parseFront, parseIdle, readKnowledgeApps, rememberAppName } from './apps.mjs';
import { Names, contactFiles, readContacts } from './contacts.mjs';
import { safeEnv } from './env.mjs';
import { readOwn, trimOwn } from './files.mjs';

/** @type {Record<string, string>} */
export const KIND = { calls: 'call', notifications: 'notification', messages: 'message', safari: 'visit', apps: 'app' };
const TICK = 15000;
const SLOW = 4; // calls, messages and Safari: every 4th tick, so once a minute
const PAGES = 20; // at most 20 pages of 500 rows per source per read
const NAMES_EVERY = 30 * 60000;
const TRIM_EVERY = 60 * 60000;

// The files each source is read from. Notifications moved in macOS 15: the new place first.
export function sourceFiles(userHome, darwinUserDir = '') {
  const lib = path.join(userHome, 'Library');
  const safari = path.join(lib, 'Safari');
  const profiles = [];
  try {
    for (const d of fs.readdirSync(path.join(safari, 'Profiles'))) {
      const f = path.join(safari, 'Profiles', d, 'History.db');
      if (fs.existsSync(f)) profiles.push({ key: d.replace(/[^\w-]/g, '').slice(0, 40), file: f });
    }
  } catch {}
  return {
    calls: [path.join(lib, 'Application Support', 'CallHistoryDB', 'CallHistory.storedata')],
    notifications: [path.join(lib, 'Group Containers', 'group.com.apple.usernoted', 'db2', 'db'), ...(darwinUserDir ? [path.join(darwinUserDir, 'com.apple.notificationcenter', 'db2', 'db')] : [])],
    messages: [path.join(lib, 'Messages', 'chat.db')],
    safari: [{ key: '', file: path.join(safari, 'History.db') }, ...profiles],
    knowledge: path.join(lib, 'Application Support', 'Knowledge', 'knowledgeC.db'),
    // Only a program with Full Disk Access can open this one, so it tells whether the helper has it.
    tcc: path.join(lib, 'Application Support', 'com.apple.TCC', 'TCC.db'),
  };
}

// Where macOS keeps which programs have Full Disk Access. Only a program with it can read this.
export const SYSTEM_TCC = '/Library/Application Support/com.apple.TCC/TCC.db';

/**
 * Whether Full Disk Access is still on for the older helper's Node.js, at one of `paths`. macOS ties
 * that permission to Node.js's own signature, not to one copy of it, so any Node.js put back at that
 * path would have it again, and Node.js runs any script it's given. It stays until the person
 * removes "node" from the list. null when the helper can't tell (it needs Full Disk Access for it).
 * @param {string} tcc the system's TCC.db
 * @param {string[]} paths
 * @returns {boolean | null}
 */
export function olderNodeAccess(tcc, paths) {
  try {
    return withSnapshot(tcc, (db) => {
      const cols = columns(db, 'access');
      const on = cols.has('auth_value') ? 'auth_value = 2' : cols.has('allowed') ? 'allowed = 1' : '';
      if (!on || !cols.has('service') || !cols.has('client')) return null;
      const row = db.prepare(`SELECT 1 FROM access WHERE service = 'kTCCServiceSystemPolicyAllFiles' AND ${on} AND client IN (${paths.map(() => '?').join(', ')}) LIMIT 1`).get(...paths);
      return !!row;
    });
  } catch {
    return null;
  }
}

/** @returns {boolean | null} */
export function hasFullDiskAccess(tcc) {
  try {
    fs.closeSync(fs.openSync(tcc, 'r'));
    return true;
  } catch (e) {
    const s = failure(e);
    return s === 'no-access' ? false : null;
  }
}

// Runs one of macOS's own programs, by its full path. macOS counts what such a program reads as
// read by the helper (it has the helper's Full Disk Access), so it gets only the helper's few safe
// names (src/env.mjs), never what the helper was started with.
/** @param {string} cmd @param {string[]} args @param {Record<string, string>} [env] @returns {Promise<string>} */
export function runCommand(cmd, args, env = safeEnv()) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 5000, maxBuffer: 2 * 1024 * 1024, env }, (err, out) => (err ? reject(err) : resolve(String(out))));
  });
}

/**
 * @typedef {{ state: string, found: number, last: number | null }} SourceStatus
 */

export class Service {
  /**
   * @param {{
   *   base: string,
   *   userHome?: string,
   *   now?: () => number,
   *   run?: (cmd: string, args: string[]) => Promise<string>,
   *   log?: (s: string) => void,
   *   origins?: string[],
   *   darwinUserDir?: string,
   *   systemTcc?: string,
   * }} opts
   */
  constructor({ base, userHome = os.homedir(), now = Date.now, run = runCommand, log = (s) => console.log(`${new Date().toISOString()} ${s}`), origins = [ORIGIN], darwinUserDir = '', systemTcc = SYSTEM_TCC }) {
    this.base = base;
    this.dirs = dirs(base);
    this.userHome = userHome;
    this.now = now;
    this.run = run;
    this.log = log;
    this.origins = origins;
    this.darwinUserDir = darwinUserDir;
    this.systemTcc = systemTcc;
    this.ticks = 0;
    this.busy = false;
    this.dirty = false;
    this.savedAt = 0;
    this.trimmedAt = 0;
    this.appsDirty = false;
    /** @type {boolean | null} */
    this.fda = null;
    // Whether the older helper's Node.js still has Full Disk Access (olderNodeAccess).
    /** @type {boolean | null} */
    this.olderNode = null;
    /** @type {Record<string, SourceStatus>} */
    this.status = {};
    /** @type {Record<string, string>} */
    this.stamps = {};
    this.names = new Names();
    this.namesAt = 0;
    /** @type {import('node:http').Server | null} */
    this.server = null;
    /** @type {NodeJS.Timeout | null} */
    this.timer = null;
    this.codeFile = { mtime: -1, code: '' };
    // What it had when it stopped: the switches, where each source was up to, what's waiting.
    this.cfg = loadConfig(base);
    loadCode(base);
    // Older versions read through copies in tmp/: any left behind by a crash go.
    fs.rmSync(this.dirs.tmp, { recursive: true, force: true });
    const st = readJson(path.join(this.dirs.data, 'state.json'), {}) || {};
    /** @type {Record<string, any>} */
    this.cursors = st.cursors && typeof st.cursors === 'object' ? st.cursors : {};
    this.outbox = new Outbox({}, st.outbox);
    for (const [b, n] of Object.entries(st.names || {})) rememberAppName(b, n);
    this.tracker = new AppTracker({}, readJson(path.join(this.dirs.data, 'apps.json'), null));
    for (const k of SOURCES) this.status[k] = { state: this.cfg.settings[k] ? 'waiting' : 'off', found: 0, last: null };
  }

  // The pairing code, read again whenever its file changes (`new-code`).
  code() {
    const file = path.join(this.dirs.data, 'code');
    try {
      const m = fs.lstatSync(file).mtimeMs;
      if (m !== this.codeFile.mtime) this.codeFile = { mtime: m, code: readOwn(file).trim() };
    } catch {
      this.codeFile = { mtime: -1, code: loadCode(this.base) };
    }
    return this.codeFile.code;
  }

  async start(port = PORT) {
    if (!this.darwinUserDir) this.darwinUserDir = await this.run('/usr/bin/getconf', ['DARWIN_USER_DIR']).then((s) => s.trim(), () => '');
    this.server = createServer({
      origins: this.origins,
      code: () => this.code(),
      now: this.now,
      log: this.log,
      handlers: {
        status: () => this.info(),
        settings: (body) => this.setSettings(body),
        events: (after, limit) => this.outbox.page(after, limit),
        ack: (upTo) => this.ack(upTo),
      },
    });
    const server = this.server;
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolve(undefined));
    });
    this.log(`Arise helper ${VERSION} listening on 127.0.0.1:${port}`);
    this.timer = setInterval(() => void this.tick(), TICK);
    void this.tick();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const server = this.server;
    await new Promise((resolve) => {
      if (!server) return resolve(undefined);
      server.close(() => resolve(undefined));
      // Browsers keep connections open: close them, so stopping doesn't wait for them.
      server.closeAllConnections();
    });
    this.server = null;
    this.save(true);
  }

  // ---------- what Arise asks for

  info() {
    const s = this.cfg.settings;
    return {
      app: 'arise-helper',
      version: VERSION,
      build: BUILD,
      // The program that needs Full Disk Access: the signed helper (`node` from when it was Node.js).
      node: process.execPath,
      fullDiskAccess: this.fda,
      olderNodeAccess: this.olderNode,
      settings: s,
      sources: Object.fromEntries(SOURCES.map((k) => [k, { ...this.status[k], state: s[k] ? this.status[k]?.state || 'waiting' : 'off', waiting: this.outbox.waiting()[KIND[k]] || 0 }])),
      waiting: this.outbox.items.length,
      dropped: this.outbox.dropped,
    };
  }

  setSettings(body) {
    const before = this.cfg.settings;
    const next = cleanSettings(body, before);
    const t = this.now();
    for (const k of SOURCES) {
      if (next[k] === before[k]) continue;
      delete this.cursors[k];
      if (k === 'apps') {
        this.tracker = new AppTracker();
        this.appsDirty = true;
      }
      if (next[k]) {
        // Turned on: starts a few days back.
        this.cfg.since[k] = t - BACKFILL[k];
        this.status[k] = { state: 'waiting', found: 0, last: null };
      } else {
        // Turned off: what's waiting from it goes too.
        delete this.cfg.since[k];
        this.outbox.drop((ev) => ev.kind === KIND[k]);
        this.status[k] = { state: 'off', found: 0, last: null };
      }
      this.log(`${k} turned ${next[k] ? 'on' : 'off'}`);
    }
    if (before.text && !next.text) {
      // Text turned off: waiting messages and notifications lose their words.
      this.outbox.update((ev) => {
        if (ev.kind !== 'message' && ev.kind !== 'notification') return ev;
        const { detail: _gone, ...rest } = ev;
        return rest;
      });
    }
    this.cfg.settings = next;
    saveConfig(this.base, this.cfg);
    this.stamps = {};
    this.dirty = true;
    this.save();
    if (this.timer) setTimeout(() => void this.tick(true), 0);
    return this.info();
  }

  ack(upTo) {
    if (this.outbox.ack(upTo)) {
      this.dirty = true;
      this.save();
    }
    return { waiting: this.outbox.items.length };
  }

  // ---------- reading

  // `all`: read every source now, not only the quick ones.
  async tick(all = false) {
    if (this.busy) return;
    this.busy = true;
    try {
      const n = this.ticks++;
      const slow = all || n % SLOW === 0;
      // It runs for weeks at a time: the log is kept short every hour, not only at the start.
      if (this.now() - this.trimmedAt >= TRIM_EVERY || this.now() < this.trimmedAt) {
        trimLog(path.join(this.dirs.logs, 'helper.log'));
        this.trimmedAt = this.now();
      }
      const files = sourceFiles(this.userHome, this.darwinUserDir);
      if (slow) {
        this.fda = hasFullDiskAccess(files.tcc);
        const older = this.fda ? olderNodeAccess(this.systemTcc, [...new Set([path.join(this.base, 'node', 'bin', 'node'), path.join(this.userHome, '.arise-helper', 'node', 'bin', 'node')])]) : null;
        if (older && !this.olderNode) this.log('Full Disk Access is still on for the older helper\'s "node": remove it from the list.');
        this.olderNode = older;
      }
      if ((this.cfg.settings.calls || this.cfg.settings.messages) && this.now() - this.namesAt > NAMES_EVERY) this.loadNames();
      if (this.cfg.settings.notifications) await this.readNotifications(files.notifications);
      // The switches may have changed while that waited: what's off now isn't read.
      const s = this.cfg.settings;
      if (slow && s.calls) this.readCalls(files.calls[0]);
      if (slow && s.messages) this.readMessages(files.messages[0]);
      if (slow && s.safari) this.readSafari(files.safari);
      if (slow && s.apps) this.backfillApps(files.knowledge);
      if (s.apps) await this.pollApps();
      this.save(false, true);
    } catch (e) {
      this.log(`Tick failed: ${/** @type {Error} */ (e)?.message || e}`);
    } finally {
      this.busy = false;
    }
  }

  setState(key, state) {
    const st = this.status[key];
    if (st.state !== state) this.log(`${key}: ${state}`);
    st.state = state;
  }

  found(key, n) {
    const st = this.status[key];
    st.found += n;
    st.last = this.now();
    if (n) this.dirty = true;
  }

  // Moves a cursor on. Only a move (or new events) needs saving.
  move(cur, key, to) {
    if (cur[key] === to) return;
    cur[key] = to;
    this.dirty = true;
  }

  sinceFor(key) {
    return this.cfg.since[key] ?? (this.cfg.since[key] = this.now() - BACKFILL[key]);
  }

  // Reads `file` (read-only, where it is), unless it hasn't changed since the last full read.
  // `fn` returns true once it has read everything new. Returns 'ok' or why it failed.
  /** @param {string} file @param {(db: import('node:sqlite').DatabaseSync) => boolean} fn */
  readDb(file, fn) {
    const mark = stamp(file);
    if (this.stamps[file] === mark) return 'ok';
    try {
      if (withSnapshot(file, fn)) this.stamps[file] = mark;
      return 'ok';
    } catch (e) {
      const why = failure(e);
      if (why === 'error') this.log(`Reading ${path.basename(file)} failed: ${/** @type {Error} */ (e)?.message || e}`);
      return why;
    }
  }

  loadNames() {
    const names = new Names();
    for (const f of contactFiles(this.userHome)) {
      try {
        withSnapshot(f, (db) => readContacts(db, names));
      } catch {}
    }
    this.names = names;
    this.namesAt = this.now();
  }

  readCalls(file) {
    const cur = (this.cursors.calls ||= { after: 0 });
    const since = this.sinceFor('calls');
    this.setState(
      'calls',
      this.readDb(file, (db) => {
        for (let i = 0; i < PAGES; i++) {
          const r = readCalls(db, { after: cur.after, since });
          this.found('calls', this.outbox.add(r.rows.map((row) => callEvent(row, this.names))));
          this.move(cur, 'after', r.cursor);
          if (!r.more) return true;
        }
        return false;
      }),
    );
  }

  readMessages(file) {
    const cur = (this.cursors.messages ||= { after: 0 });
    const since = this.sinceFor('messages');
    const text = !!this.cfg.settings.text;
    this.setState(
      'messages',
      this.readDb(file, (db) => {
        for (let i = 0; i < PAGES; i++) {
          const r = readMessages(db, { after: cur.after, since, text });
          this.found('messages', this.outbox.add(r.rows.map((row) => messageEvent(row, this.names, text))));
          this.move(cur, 'after', r.cursor);
          if (!r.more) return true;
        }
        return false;
      }),
    );
  }

  /** @param {{ key: string, file: string }[]} list */
  readSafari(list) {
    const cur = (this.cursors.safari ||= {});
    const since = this.sinceFor('safari');
    let state = 'missing';
    for (const { key, file } of list) {
      const got = this.readDb(file, (db) => {
        for (let i = 0; i < PAGES; i++) {
          const r = readSafari(db, { after: cur[key] || 0, since });
          this.found('safari', this.outbox.add(r.rows.map((row) => visitEvent(row, key))));
          this.move(cur, key, r.cursor);
          if (!r.more) return true;
        }
        return false;
      });
      // The main History.db decides; a profile that can't be read doesn't hide it.
      if (!key) state = got;
    }
    this.setState('safari', state);
  }

  // Notifications: the macOS 15 place, else the older one. Rows are read first, then names are
  // looked up for apps the helper doesn't know yet, then they're queued.
  /** @param {string[]} list */
  async readNotifications(list) {
    const cur = (this.cursors.notifications ||= { after: 0 });
    const since = this.sinceFor('notifications');
    let state = 'missing';
    /** @type {any[]} */
    let rows = [];
    let cursor = cur.after;
    for (const file of list) {
      state = this.readDb(file, (db) => {
        /** @type {{ date: number, id: number } | null} */
        let from = null;
        for (let i = 0; i < PAGES; i++) {
          const r = readNotifications(db, { after: cursor, since, from });
          rows = rows.concat(r.rows);
          cursor = r.cursor;
          from = r.next;
          if (!r.more) return true;
        }
        return false;
      });
      if (state !== 'missing') break;
    }
    this.setState('notifications', state);
    if (!rows.length) {
      cur.after = cursor;
      return;
    }
    const unknown = [...new Set(rows.map((r) => cleanBundle(r.app)).filter((b) => b && !hasAppName(b)))].slice(0, 5);
    for (const b of unknown) rememberAppName(b, (await findAppName(b, this.run)) || appName(b));
    // Turned off (or off and on again) while the names were looked up: these rows don't count.
    if (!this.cfg.settings.notifications || this.cursors.notifications !== cur) return;
    const text = !!this.cfg.settings.text;
    this.found('notifications', this.outbox.add(rows.map((row) => notificationEvent(row, { text }))));
    this.move(cur, 'after', cursor);
  }

  // The week before app use was turned on, once, from Screen Time's records where they're kept.
  backfillApps(file) {
    const cur = (this.cursors.apps ||= {});
    if (cur.backfilled) return;
    const since = this.sinceFor('apps');
    const got = this.readDb(file, (db) => {
      this.found('apps', this.outbox.add(readKnowledgeApps(db, { since, until: since + BACKFILL.apps })));
      return true;
    });
    if (got === 'ok' || got === 'missing') {
      cur.backfilled = true;
      this.dirty = true;
    }
  }

  // The app in front, from `lsappinfo`. (Not through AppleScript: it can load add-ons from the user's
  // folders, and whatever the helper runs runs with its Full Disk Access.)
  async front() {
    try {
      const asn = parseFront(await this.run('/usr/bin/lsappinfo', ['front']));
      if (asn) return parseAppInfo(await this.run('/usr/bin/lsappinfo', ['info', '-only', 'bundleid', '-only', 'name', asn]));
    } catch {}
    return null;
  }

  async pollApps() {
    const tracker = this.tracker;
    const front = await this.front();
    const idle = await this.run('/usr/sbin/ioreg', ['-c', 'IOHIDSystem']).then(parseIdle, () => null);
    // Turned off (or off and on again) while it looked.
    if (!this.cfg.settings.apps || this.tracker !== tracker) return;
    if (front?.name) rememberAppName(front.bundle, front.name);
    this.found('apps', this.outbox.add(this.tracker.tick(this.now(), front, idle)));
    this.setState('apps', front ? 'ok' : 'error');
    this.appsDirty = true;
  }

  // ---------- saving

  // state.json holds the whole queue, so it's written only when something changed: at once after
  // the Player's own changes (switches, what Arise has) and when stopping, and after the regular
  // reads (`soon`) at most once a minute, less often the more events wait (every 10 minutes from
  // 18,000). If the helper stops without saving, it reads those minutes again when it starts.
  save(force = false, soon = false) {
    try {
      const every = Math.min(10, 1 + Math.floor(this.outbox.items.length / 2000)) * 60000;
      const ago = this.now() - this.savedAt;
      if (force || (this.dirty && !(soon && ago >= 0 && ago < every))) {
        writeJson(path.join(this.dirs.data, 'state.json'), { cursors: this.cursors, outbox: this.outbox.toJSON(), names: learnedNames() });
        this.dirty = false;
        this.savedAt = this.now();
      }
      if (this.appsDirty || force) {
        writeJson(path.join(this.dirs.data, 'apps.json'), this.tracker.toJSON());
        this.appsDirty = false;
      }
    } catch (e) {
      this.log(`Saving failed: ${/** @type {Error} */ (e)?.message || e}`);
    }
  }
}

// launchd keeps adding to the log: past 1 MB, only the last 256 KB stay. Only its own log, never
// a file a link points to (src/files.mjs).
export function trimLog(file) {
  try {
    trimOwn(file, 1024 * 1024, 256 * 1024);
  } catch {}
}
