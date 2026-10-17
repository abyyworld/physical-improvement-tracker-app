// Makes the Mac helper's one script, the code of the signed program.
//
//   node scripts/build-mac-helper.mjs [--out <dir>] [--build <name>]
//
// Writes arise-helper.cjs into dist-mac-helper/ (or <dir>): mac-helper/sea.mjs and everything it
// uses, in one script that loads nothing but Node.js's own modules and never turns text into code
// (checked below). Next to it, a copy of mac-helper/sea-config.json.
//
// .github/workflows/mac-helper.yml then makes the program on a Mac of each kind, with the exact
// Node.js it names, from that script and the sea-config.json in the repo (not the copy: this job
// ran npm packages), and signs it:
//   node <the execArgv in sea-config.json> --build-sea sea-config.json
//   codesign --sign - --options runtime --entitlements mac-helper/entitlements.plist ...
//
// What sea-config.json sets, and why:
// - execArgv, the Node.js options built into the program:
//     --disable-sigusr1        SIGUSR1 would open a debugger, through which any program of the
//                              user could run code in the helper
//     --disallow-code-generation-from-strings   no eval or new Function
//     --no-addons              no native add-ons (process.dlopen)
//     --openssl-config=/dev/null, --icu-data-dir=/dev/null   never the files named in OPENSSL_CONF
//                              or NODE_ICU_DATA (an OpenSSL file can load a library)
//     --disable-warning=ExperimentalWarning   node:sqlite still says it's experimental
// - execArgvExtension "none": NODE_OPTIONS and --node-options can't add any.
// - useCodeCache: not only faster. A program with a code cache never compiles its script through
//   the compile cache NODE_COMPILE_CACHE turns on, which would take compiled code from a folder
//   anyone can write to. The cache is only used by a program started with the V8 options it was
//   made with, so the workflow makes it with execArgv too. (It also differs a little each time, so
//   the program can't be rebuilt bit for bit: see the checksums in mac-helper/install.sh.)

import { copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
export const SEA_CONFIG = join(root, 'mac-helper', 'sea-config.json');
export const SCRIPT = 'arise-helper.cjs';

// What the script may never do: load code from anywhere but itself and Node.js's own modules, turn
// text into code, or run programs any way but execFile (a full path and its own arguments, no
// shell). Returns what it found, [] when it's fine. A check for mistakes: the program enforces the
// same with its built-in options.
/** @param {string} code */
export function unsafeParts(code) {
  const found = [];
  for (const m of code.matchAll(/\brequire\(\s*(['"`])([^'"`]*)\1\s*\)/g)) if (!isBuiltin(m[2])) found.push(`require(${m[2]})`);
  for (const m of code.matchAll(/\brequire\(\s*[^'"`\s)]/g)) found.push(`require with a computed name: ${m[0]}`);
  for (const m of code.matchAll(/\bimport\(\s*(['"`]?)([^'"`)]*)\1\s*\)/g)) if (!isBuiltin(m[2])) found.push(`import(${m[2]})`);
  for (const m of code.matchAll(/child_process\w*\.(\w+)/g)) if (m[1] !== 'execFile') found.push(`child_process.${m[1]}`);
  const banned = [
    [/\beval\s*\(/, 'eval'],
    [/\bnew\s+Function\s*\(/, 'new Function'],
    [/\bFunction\s*\(\s*['"`]/, 'Function()'],
    [/['"](node:)?vm['"]/, 'node:vm'],
    [/\bcreateRequire\b/, 'createRequire'],
    [/\bdlopen\b/, 'dlopen'],
    [/\bregisterHooks\b|\bmodule\.register\b/, 'module hooks'],
    [/\bWebAssembly\b/, 'WebAssembly'],
    [/['"](node:)?worker_threads['"]|\bnew\s+Worker\s*\(/, 'worker threads'],
    [/['"](node:)?inspector(\/promises)?['"]/, 'the inspector'],
    [/\bsetFlagsFromString\b/, 'V8 flags'],
    [/\b(execFileSync|execSync|spawnSync|fork)\b|\bspawn\s*\(|[^.\w]exec\s*\(/, 'running programs other than through execFile'],
  ];
  for (const [re, what] of banned) if (/** @type {RegExp} */ (re).test(code)) found.push(/** @type {string} */ (what));
  return found;
}

/**
 * @param {{ out?: string, buildName?: string }} [opts]
 * @returns {Promise<{ out: string, script: string }>}
 */
export async function buildHelper({ out = join(root, 'dist-mac-helper'), buildName = 'dev' } = {}) {
  if (!/^[\w.-]{1,40}$/.test(buildName)) throw new Error(`Not a build name: ${buildName}`);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  await build({
    configFile: false,
    logLevel: 'warn',
    root,
    publicDir: false,
    define: { __ARISE_HELPER_BUILD__: JSON.stringify(buildName) },
    ssr: { target: 'node', noExternal: true },
    build: {
      ssr: join(root, 'mac-helper', 'sea.mjs'),
      outDir: out,
      emptyOutDir: false,
      minify: false, // readable, for anyone who wants to check what the program runs
      sourcemap: false,
      target: 'node22',
      rolldownOptions: { output: { format: 'cjs', entryFileNames: SCRIPT, codeSplitting: false } },
    },
  });
  const script = join(out, SCRIPT);
  const unsafe = unsafeParts(readFileSync(script, 'utf8'));
  if (unsafe.length) throw new Error(`The helper's script must not have: ${unsafe.join(', ')}`);
  copyFileSync(SEA_CONFIG, join(out, 'sea-config.json'));
  return { out, script };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (/** @type {string} */ name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const out = opt('--out');
  const { script } = await buildHelper({ out: out ? resolve(out) : undefined, buildName: opt('--build') || 'dev' });
  console.log(script);
}
