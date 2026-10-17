// The Arise Mac helper, run with Node.js while working on it: `node mac-helper/helper.mjs <command>`
// (the commands are in src/main.mjs). The installer doesn't use this file. It installs the signed
// program built from sea.mjs, which runs only the code built into it and ignores its environment.
// This one, for development and tests, still takes ARISE_HELPER_HOME (where it keeps its things)
// and ARISE_ORIGINS (more websites that may talk to it, like http://localhost:5173).

import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { home, origins } from './src/config.mjs';
import { run } from './src/main.mjs';

export { plist } from './src/main.mjs';

// Run as a program, not when a test imports it.
const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};
if (process.argv[1] && real(fileURLToPath(import.meta.url)) === real(process.argv[1])) {
  run(process.argv.slice(2), { base: home(), userHome: os.homedir(), origins: origins(), program: process.execPath }).then(
    (code) => {
      if (code) process.exitCode = code;
    },
    (e) => {
      console.error(e?.message || e);
      process.exit(1);
    },
  );
}
