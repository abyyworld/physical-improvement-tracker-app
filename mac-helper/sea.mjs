// The signed Arise helper: the one program that gets Full Disk Access. scripts/build-mac-helper.mjs
// bundles this file and everything it uses into one script, Node.js builds that into a single
// program (a "single executable application"), and GitHub signs it (.github/workflows/mac-helper.yml).
// macOS ties Full Disk Access to that signature, so a changed program loses it.
//
// It runs only the code built into it:
// - Node.js options never come from outside. The ones it needs are built in (NODE_OPTIONS and
//   --node-options are ignored), and arguments are only ever words for src/main.mjs.
// - It can't load code from disk (require and import only reach Node.js's own modules), can't turn
//   text into code (no eval, no new Function), can't load native add-ons, and doesn't open a
//   debugger when sent SIGUSR1.
// - Its environment is thrown away as it starts (src/env.mjs). Where its things are comes from the
//   user database, and only Arise's own website may talk to it.
// - What Node.js itself acted on from the environment before this runs can't make it write
//   anywhere: no warnings (built in), no coverage files (stopped here), and it won't run with a
//   channel to whoever started it, or as a cluster worker.

import cluster from 'node:cluster';
import os from 'node:os';
import path from 'node:path';
import v8 from 'node:v8';
import { ORIGIN } from './src/config.mjs';
import { scrubEnv, setUpFromOutside } from './src/env.mjs';
import { run } from './src/main.mjs';

// NODE_V8_COVERAGE would have it write coverage files at exit, in a folder of its naming.
v8.stopCoverage();
const outside = setUpFromOutside(process, cluster);
if (outside.length) {
  console.error(`The Arise helper won't run with ${outside.join(' or ')}.`);
  process.exit(1);
}

const user = os.userInfo();
scrubEnv(process.env, user);
const base = path.join(user.homedir, '.arise-helper');

run(process.argv.slice(2), { base, userHome: user.homedir, origins: [ORIGIN], program: process.execPath, signed: true }).then(
  (code) => {
    if (code) process.exitCode = code;
  },
  (e) => {
    console.error(e?.message || e);
    process.exit(1);
  },
);
