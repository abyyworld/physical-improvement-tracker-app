// The environment the helper runs with.
//
// The signed program (sea.mjs) is what holds Full Disk Access, and anything running as the same
// user can start it with an environment of its own: in a LaunchAgent of its own, or for every
// program with `launchctl setenv`. So it takes nothing from its environment. Where things are comes
// from the user database (not $HOME), and everything else is thrown away as it starts. The programs
// it runs (lsappinfo, ioreg, mdfind, getconf, by full path) get only the few names below too, since
// macOS counts what they read as read by the helper.
//
// What Node.js itself reads from the environment before any of this runs is closed off when the
// program is built (scripts/build-mac-helper.mjs): NODE_OPTIONS is ignored, the compile cache is
// never used, OpenSSL's and ICU's files can't be swapped, and no warning is ever written (so
// NODE_REDIRECT_WARNINGS names no file). The rest is handled as it starts (sea.mjs): no coverage
// files (NODE_V8_COVERAGE), and it won't run with what setUpFromOutside() finds.

import os from 'node:os';

// The only places it runs programs from: macOS's own, which only the system can change.
export const SAFE_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

/**
 * The whole environment for the helper and the programs it runs, from who the user is.
 * @param {Record<string, string | undefined>} env what it was started with
 * @param {{ homedir: string, username: string }} [user] from the user database
 * @returns {Record<string, string>}
 */
export function safeEnv(env = process.env, user = os.userInfo()) {
  /** @type {Record<string, string>} */
  const out = { HOME: user.homedir, USER: user.username, LOGNAME: user.username, PATH: SAFE_PATH };
  // How Core Foundation reads and writes text, set by macOS for every program: three numbers.
  const cf = env.__CF_USER_TEXT_ENCODING;
  if (typeof cf === 'string' && /^0x[0-9A-F]+:0x[0-9A-F]+:0x[0-9A-F]+$/i.test(cf)) out.__CF_USER_TEXT_ENCODING = cf;
  return out;
}

/**
 * Leaves only safeEnv() in `env` (process.env: the programs it runs then get only that too).
 * @param {Record<string, string | undefined>} env
 * @param {{ homedir: string, username: string }} [user]
 */
export function scrubEnv(env = process.env, user = os.userInfo()) {
  const keep = safeEnv(env, user);
  for (const k of Object.keys(env)) if (!(k in keep)) delete env[k];
  Object.assign(env, keep);
  return env;
}

/**
 * What Node.js itself set up from the environment before the helper's code ran, which no option
 * turns off: a channel to whoever started it (NODE_CHANNEL_FD), or a cluster worker's set-up, which
 * asks that one for its server (NODE_UNIQUE_ID). The signed helper won't run with either.
 * @param {{ channel?: unknown }} proc process
 * @param {{ isWorker?: boolean }} cluster node:cluster
 * @returns {string[]} what it found, [] when there's nothing
 */
export function setUpFromOutside(proc, cluster) {
  const found = [];
  if (proc.channel) found.push('a channel to the program that started it (NODE_CHANNEL_FD)');
  if (cluster.isWorker) found.push("a cluster worker's set-up (NODE_UNIQUE_ID)");
  return found;
}
