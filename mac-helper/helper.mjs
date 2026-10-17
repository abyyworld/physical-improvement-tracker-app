// The Arise Mac helper. launchd starts `node helper.mjs serve` at login and keeps it running.
// The other commands are for the person, through ~/.arise-helper/arise-helper.sh:
//   code       show the pairing code
//   new-code   make a new pairing code (Arise then needs the new one)
//   status     is it running, does it have Full Disk Access, what does it read
//   plist      the LaunchAgent file (used by the installer)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LABEL, PORT, dirs, formatCode, home, loadCode, newCode, saveCode } from './src/config.mjs';

const base = home();
const cmd = process.argv[2] || 'help';

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// The LaunchAgent: start at login, start again if it stops, low priority, output to the log.
export function plist(node, helper, dir) {
  const args = [node, '--disable-warning=ExperimentalWarning', helper, 'serve'];
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
  <key>EnvironmentVariables</key>
  <dict>
    <key>ARISE_HELPER_HOME</key>
    <string>${xml(dir)}</string>
  </dict>
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

const NAMES = { calls: 'Calls', notifications: 'Notifications', messages: 'Messages', safari: 'Safari history', apps: 'App use' };
const STATES = { off: 'off', waiting: 'on, starting', ok: 'on, reading', 'no-access': 'on, needs Full Disk Access', missing: 'on, nothing to read on this Mac', error: 'on, but reading failed (see the log)' };

async function status() {
  let info;
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/v1/status`, { headers: { Authorization: `Bearer ${loadCode(base)}` } });
    if (!r.ok) throw new Error(String(r.status));
    info = await r.json();
  } catch {
    console.log("The helper isn't running.");
    process.exitCode = 1;
    return;
  }
  console.log('The helper is running.');
  console.log(`Full Disk Access: ${info.fullDiskAccess === true ? 'yes' : info.fullDiskAccess === false ? 'not yet' : "can't tell"}`);
  for (const [k, label] of Object.entries(NAMES)) console.log(`${label}: ${STATES[info.sources?.[k]?.state] || 'off'}`);
  console.log(`Message and notification text: ${info.settings?.text ? 'on' : 'off'}`);
  console.log(`Waiting for Arise: ${info.waiting}`);
}

async function main() {
  switch (cmd) {
    case 'serve': {
      // Loaded only here, so the other commands start fast and quiet.
      const { Service, trimLog } = await import('./src/service.mjs');
      // First, so a helper that can't start (and is started again every 30 seconds) can't fill it.
      trimLog(path.join(dirs(base).logs, 'helper.log'));
      const service = new Service({ base });
      const quit = () => service.stop().finally(() => process.exit(0));
      process.on('SIGTERM', quit);
      process.on('SIGINT', quit);
      await service.start();
      return;
    }
    case 'code':
      console.log(formatCode(loadCode(base)));
      return;
    case 'new-code':
      console.log(formatCode(saveCode(base, newCode())));
      return;
    case 'status':
      return status();
    case 'plist':
      process.stdout.write(plist(process.execPath, fileURLToPath(import.meta.url), base));
      return;
    default:
      console.log('Usage: helper.mjs serve | code | new-code | status | plist');
      process.exitCode = cmd === 'help' ? 0 : 1;
  }
}

// Run as a program, not when a test imports it.
const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};
if (process.argv[1] && real(fileURLToPath(import.meta.url)) === real(process.argv[1])) {
  main().catch((e) => {
    console.error(e?.message || e);
    process.exit(1);
  });
}
