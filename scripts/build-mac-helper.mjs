// Makes the Mac helper's one script, the code of the signed program.
//
//   node scripts/build-mac-helper.mjs [--out <dir>] [--build <name>]
//
// Writes arise-helper.cjs into dist-mac-helper/ (or <dir>): mac-helper/sea.mjs and every file it
// imports, in one script that loads nothing but Node.js's own modules and never turns text into
// code (checked below). Next to it, a copy of mac-helper/sea-config.json.
//
// It needs nothing but Node.js: no npm package (no bundler, nothing from node_modules) takes part
// in making the code that gets Full Disk Access. .github/workflows/mac-helper.yml runs it on a Mac
// of each kind, with the exact Node.js it names (its SHA-256 checked), in a job that never runs npm.
// It then makes the program from that script and the sea-config.json in the repo, and signs it:
//   node scripts/build-mac-helper.mjs --out build --build <name>
//   node <the execArgv in sea-config.json> --build-sea sea-config.json
//   codesign --sign - --options runtime --entitlements mac-helper/entitlements.plist ...
// The same files always make the same script, so anyone can make it again and compare.
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
//     --no-warnings            no warning is ever written, so NODE_REDIRECT_WARNINGS can't name a
//                              file for it to add to (NODE_PENDING_DEPRECATION adds none either)
// - execArgvExtension "none": NODE_OPTIONS and --node-options can't add any.
// - useCodeCache: not only faster. A program with a code cache never compiles its script through
//   the compile cache NODE_COMPILE_CACHE turns on, which would take compiled code from a folder
//   anyone can write to. The cache is only used by a program started with the V8 options it was
//   made with, so the workflow makes it with execArgv too. (It also differs a little each time, so
//   the program can't be rebuilt bit for bit: see the checksums in mac-helper/install.sh.)

import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

// ---------- the bundler
//
// The helper's files are ES modules written in a small, fixed way, and this turns them into one
// CommonJS script without changing a line of their code:
//   import x from 'node:x';  import * as x from '...';  import { a, b as c } from '...';
//   export function / export async function / export class / export const <name>
//   await import('./file.mjs')   (loaded when it's reached, as before)
// Anything else (export default, export let, export { }, import.meta, a cycle of imports) stops it
// with an error, so it never makes a script that behaves differently from the files.
// Each file becomes a function, run the first time it's imported, that returns what it exports.

const IMPORT_DEFAULT = /^import (\w+) from '([^']+)';$/;
const IMPORT_ALL = /^import \* as (\w+) from '([^']+)';$/;
const IMPORT_NAMED = /^import \{([^}]*)\} from '([^']+)';$/;
const EXPORT = /^export (?:async function\*? |function\*? |class |const )(\w+)\b/;
const DYNAMIC = /\bimport\(\s*(['"])(\.{1,2}\/[^'"]+)\1\s*\)/g;

/**
 * Joins `entry` and every file it imports into one CommonJS script.
 * @param {string} entry the first file (its folder is where the names in the script start)
 * @param {{ define?: Record<string, string> }} [opts] names replaced by a string, like __ARISE_HELPER_BUILD__
 * @returns {string}
 */
export function bundle(entry, { define = {} } = {}) {
  const base = resolve(entry, '..');
  /** @type {Map<string, { body: string, exports: string[], deps: string[], needs: { from: string, names: string[] }[] }>} */
  const files = new Map();
  /** @param {string} from @param {string} spec */
  const target = (from, spec) => {
    const id = posix.normalize(posix.join(posix.dirname(from), spec));
    if (!spec.startsWith('./') && !spec.startsWith('../')) throw new Error(`${from}: "${spec}" is neither Node.js's own nor a file of the helper`);
    if (id.startsWith('../') || !id.endsWith('.mjs')) throw new Error(`${from}: "${spec}" is outside the helper, or not an .mjs file`);
    return id;
  };
  /** @param {string} id */
  const read = (id) => {
    if (files.has(id)) return;
    let src = readFileSync(join(base, ...id.split('/')), 'utf8').replace(/\r\n/g, '\n');
    for (const [name, value] of Object.entries(define)) src = src.replace(new RegExp(`\\b${name}\\b`, 'g'), JSON.stringify(value));
    if (/\bimport\.meta\b/.test(src)) throw new Error(`${id}: import.meta can't be in the helper's script`);
    /** @type {string[]} */
    const head = [];
    /** @type {string[]} */
    const exports = [];
    /** @type {string[]} */
    const deps = [];
    const needs = [];
    const lines = src.split('\n').map((line) => {
      if (/^import\b/.test(line)) {
        let m;
        if ((m = IMPORT_DEFAULT.exec(line))) {
          if (!isBuiltin(m[2])) throw new Error(`${id}: the helper's files have no default export (${line})`);
          head.push(`const ${m[1]} = require(${JSON.stringify(m[2])});`);
        } else if ((m = IMPORT_ALL.exec(line))) {
          if (isBuiltin(m[2])) head.push(`const ${m[1]} = require(${JSON.stringify(m[2])});`);
          else {
            const dep = target(id, m[2]);
            deps.push(dep);
            head.push(`const ${m[1]} = __load(${JSON.stringify(dep)});`);
          }
        } else if ((m = IMPORT_NAMED.exec(line))) {
          const parts = m[1].split(',').map((s) => s.trim()).filter(Boolean);
          const names = parts.map((p) => {
            const n = /^(\w+)(?: as (\w+))?$/.exec(p);
            if (!n) throw new Error(`${id}: can't read "${p}" in ${line}`);
            return { name: n[1], as: n[2] || n[1] };
          });
          const pattern = `{ ${names.map((n) => (n.as === n.name ? n.name : `${n.name}: ${n.as}`)).join(', ')} }`;
          if (isBuiltin(m[2])) head.push(`const ${pattern} = require(${JSON.stringify(m[2])});`);
          else {
            const dep = target(id, m[2]);
            deps.push(dep);
            needs.push({ from: dep, names: names.map((n) => n.name) });
            head.push(`const ${pattern} = __load(${JSON.stringify(dep)});`);
          }
        } else throw new Error(`${id}: an import the bundler doesn't know: ${line}`);
        return null;
      }
      if (/^export\b/.test(line)) {
        const m = EXPORT.exec(line);
        if (!m) throw new Error(`${id}: an export the bundler doesn't know: ${line}`);
        exports.push(m[1]);
        return line.slice('export '.length);
      }
      return line;
    });
    // Loaded when it's reached, like import() was.
    const body = lines.filter((l) => l !== null).join('\n').replace(DYNAMIC, (_, _q, spec) => `Promise.resolve().then(() => __load(${JSON.stringify(target(id, spec))}))`);
    files.set(id, { body: [...head, body.replace(/^\n+/, '').replace(/\n+$/, '')].join('\n'), exports, deps, needs });
    for (const m of src.matchAll(DYNAMIC)) read(target(id, m[2]));
    for (const dep of deps) read(dep);
  };
  const first = posix.basename(entry);
  read(first);

  // Every name imported is exported by its file, and no file imports itself, even through others.
  for (const [id, f] of files) {
    for (const need of f.needs) for (const n of need.names) if (!files.get(need.from)?.exports.includes(n)) throw new Error(`${id}: ${need.from} doesn't export ${n}`);
  }
  /** @type {Set<string>} */
  const done = new Set();
  /** @param {string} id @param {string[]} path */
  const walk = (id, path) => {
    if (path.includes(id)) throw new Error(`The helper's files import each other in a circle: ${[...path, id].join(' -> ')}`);
    if (done.has(id)) return;
    for (const dep of files.get(id)?.deps || []) walk(dep, [...path, id]);
    done.add(id);
  };
  for (const id of files.keys()) walk(id, []);

  const out = [
    "'use strict';",
    '// The Arise Mac helper in one script, made by scripts/build-mac-helper.mjs from mac-helper/sea.mjs',
    '// and the files it imports. Each file is below as it is in the repo, but for its import and export',
    '// lines: each one is a function, run the first time it is imported, that returns what it exports.',
    'const __files = Object.create(null);',
    'const __loaded = Object.create(null);',
    '/** @param {string} id */',
    'function __load(id) {',
    '  let m = __loaded[id];',
    '  if (m === undefined) {',
    '    __loaded[id] = null;',
    '    try {',
    '      m = __loaded[id] = __files[id]();',
    '    } catch (e) {',
    '      delete __loaded[id];',
    '      throw e;',
    '    }',
    '  }',
    "  if (m === null) throw new Error(`${id} needs itself while it loads`);",
    '  return m;',
    '}',
  ];
  for (const [id, f] of files) {
    out.push('', `// ---------- mac-helper/${id}`, '', `__files[${JSON.stringify(id)}] = () => {`, f.body, `return Object.freeze({ __proto__: null${f.exports.map((n) => `, ${n}`).join('')} });`, '};');
  }
  out.push('', `__load(${JSON.stringify(first)});`, '');
  return out.join('\n');
}

/**
 * @param {{ out?: string, buildName?: string }} [opts]
 * @returns {Promise<{ out: string, script: string }>}
 */
export async function buildHelper({ out = join(root, 'dist-mac-helper'), buildName = 'dev' } = {}) {
  if (!/^[\w.-]{1,40}$/.test(buildName)) throw new Error(`Not a build name: ${buildName}`);
  const code = bundle(join(root, 'mac-helper', 'sea.mjs'), { define: { __ARISE_HELPER_BUILD__: buildName } });
  const unsafe = unsafeParts(code);
  if (unsafe.length) throw new Error(`The helper's script must not have: ${unsafe.join(', ')}`);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const script = join(out, SCRIPT);
  writeFileSync(script, code);
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
