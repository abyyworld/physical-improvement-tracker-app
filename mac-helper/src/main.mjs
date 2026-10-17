// The helper's commands. The signed program the installer puts in ~/.arise-helper/bin/arise-helper
// (sea.mjs) runs these, and so does `node mac-helper/helper.mjs` while working on it.
//   serve      what launchd runs at login and keeps running: read, and serve Arise
//   code       show the pairing code
//   new-code   make a new pairing code (Arise then needs the new one)
//   status     is it running, does it have Full Disk Access, what does it read
//   plist      the LaunchAgent file (the installer uses it)
//   version    which helper this is
// Only the first argument counts, and only as one of these words. Anything after it is ignored,
// and nothing is ever taken as an option for Node.js or as code to run.

import path from 'node:path';
import { ask } from './auth.mjs';
import { BUILD, LABEL, PORT, VERSION, dirs, formatCode, loadCode, newCode, saveCode } from './config.mjs';

export const COMMANDS = ['serve', 'code', 'new-code', 'status', 'plist', 'version', 'help'];

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// The LaunchAgent: start at login, start again if it stops, low priority, output to the log. It
// runs the program itself, with no interpreter, no script and no environment of its own.
/** @param {string} program @param {string} dir */
export function plist(program, dir) {
  const args = [program, 'serve'];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>Nice</key>
  <integer>5</integer>
  <key>LowPriorityIO</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(`${dir}/logs/helper.log`)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(`${dir}/logs/helper.log`)}</string>
</dict>
</plist>
`;
}

// What `status` says while Full Disk Access is still on for the older helper's Node.js (the
// installer shows it too).
export const OLDER_NODE =
  'Warning: "node", from the older helper, still has Full Disk Access, and any app on this Mac could use it. In System Settings, Privacy & Security, Full Disk Access, select "node" and click the minus button.';

const NAMES = { calls: 'Calls', notifications: 'Notifications', messages: 'Messages', safari: 'Safari history', apps: 'App use' };
const STATES = { off: 'off', waiting: 'on, starting', ok: 'on, reading', 'no-access': 'on, needs Full Disk Access', missing: 'on, nothing to read on this Mac', error: 'on, but reading failed (see the log)' };

/**
 * @typedef {{
 *   base: string,
 *   userHome: string,
 *   origins: string[],
 *   program: string,
 *   signed?: boolean,
 *   out?: (s: string) => void,
 *   err?: (s: string) => void,
 * }} Context
 * `signed`: run as the signed program (sea.mjs), not with Node.js (helper.mjs).
 */

/** @param {Context} ctx @param {(s: string) => void} out */
async function status(ctx, out) {
  let info;
  try {
    // Proves the code without sending it, and checks the answer came from the helper with it.
    info = await ask(`http://127.0.0.1:${PORT}`, loadCode(ctx.base), '/v1/status');
  } catch {
    out("The helper isn't running.");
    return 1;
  }
  out('The helper is running.');
  out(`Full Disk Access: ${info.fullDiskAccess === true ? 'yes' : info.fullDiskAccess === false ? 'not yet' : "can't tell"}`);
  if (info.olderNodeAccess === true) out(OLDER_NODE);
  for (const [k, label] of Object.entries(NAMES)) out(`${label}: ${STATES[info.sources?.[k]?.state] || 'off'}`);
  out(`Message and notification text: ${info.settings?.text ? 'on' : 'off'}`);
  out(`Waiting for Arise: ${info.waiting}`);
  return 0;
}

/**
 * Runs one command. Resolves with the exit code; `serve` resolves once it's serving.
 * @param {readonly string[]} argv the arguments after the program's name
 * @param {Context} ctx
 */
export async function run(argv, ctx) {
  const out = ctx.out || ((s) => console.log(s));
  const cmd = typeof argv[0] === 'string' ? argv[0] : 'help';
  switch (cmd) {
    case 'serve': {
      // Loaded only here, so the other commands start fast and quiet.
      const { Service, trimLog } = await import('./service.mjs');
      // First, so a helper that can't start (and is started again every 30 seconds) can't fill it.
      trimLog(path.join(dirs(ctx.base).logs, 'helper.log'));
      const service = new Service({ base: ctx.base, userHome: ctx.userHome, origins: ctx.origins });
      const quit = () => service.stop().finally(() => process.exit(0));
      process.on('SIGTERM', quit);
      process.on('SIGINT', quit);
      await service.start();
      return 0;
    }
    case 'code':
      out(formatCode(loadCode(ctx.base)));
      return 0;
    case 'new-code':
      out(formatCode(saveCode(ctx.base, newCode())));
      return 0;
    case 'status':
      return status(ctx, out);
    case 'plist':
      // Only the signed program goes in a LaunchAgent. (An installer from before it asks Node.js
      // for one: it stops here, and the person is told what to do.)
      if (!ctx.signed) {
        (ctx.err || ((s) => console.error(s)))('The Arise helper is now one signed program. To update it, run the install command again (in Arise: Settings, Your life, Mac).');
        return 1;
      }
      out(plist(ctx.program, ctx.base).trimEnd());
      return 0;
    case 'version':
      out(`Arise helper ${VERSION}, build ${BUILD}, Node.js ${process.versions.node}`);
      return 0;
    default:
      out(`Usage: arise-helper ${COMMANDS.join(' | ')}`);
      return cmd === 'help' ? 0 : 1;
  }
}
