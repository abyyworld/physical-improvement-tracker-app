// Builds the browser extension (extension/) for each browser, into dist-extension/:
//   chrome/ edge/ firefox/     the extension, unpacked ("Load unpacked", or web-ext for Firefox)
//   arise-chrome.zip …         the same, zipped, to upload to each store
//   dev/                       a Chrome build that also works with Arise on localhost (npm run dev)
// With `--site <dir>` it also puts what the website offers into <dir> (the Deploy workflow uses
// dist/extension): the Chrome zip for "Load unpacked", and the Firefox copy Mozilla signed with the
// file Firefox checks for updates, when dist-extension/signed/arise-firefox.xpi is there.

import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import { build } from 'vite';
import { TARGETS, ariseUrls, manifestFor, updatesJson } from './extension-manifest.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const src = join(root, 'extension');
const out = join(root, 'dist-extension');
const ENTRIES = ['background', 'content', 'popup'];
const STATIC = ['popup.html', 'popup.css', 'icons'];

// Each script is one self-contained file: content scripts can't load modules.
async function bundle(dir, { dev }) {
  for (const name of ENTRIES) {
    await build({
      configFile: false,
      logLevel: 'warn',
      root,
      publicDir: false,
      define: { __EXT_ARISE__: JSON.stringify(ariseUrls({ dev })) },
      build: {
        outDir: dir,
        emptyOutDir: false,
        minify: false, // readable, for the stores' reviewers and anyone curious
        sourcemap: false,
        target: 'es2022',
        lib: { entry: join(src, 'src', `${name}.ts`), formats: ['iife'], name: `arise_${name}`, fileName: () => `${name}.js` },
      },
    });
  }
}

function files(dir) {
  const all = {};
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const path = join(d, name);
      if (statSync(path).isDirectory()) walk(path);
      else all[relative(dir, path).split('\\').join('/')] = [new Uint8Array(readFileSync(path)), { mtime: new Date('2020-01-01T00:00:00Z') }];
    }
  };
  walk(dir);
  return all;
}

async function make(target, { dev = false } = {}) {
  const dir = join(out, dev ? 'dev' : target);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  await bundle(dir, { dev });
  for (const f of STATIC) cpSync(join(src, f), join(dir, f), { recursive: true });
  const base = JSON.parse(readFileSync(join(src, 'manifest.json'), 'utf8'));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifestFor(base, target, { dev }), null, 2) + '\n');
  if (dev) return null;
  const zip = zipSync(files(dir), { level: 9 });
  writeFileSync(join(out, `arise-${target}.zip`), zip);
  return zip.length;
}

const args = process.argv.slice(2);
const site = args.includes('--site') ? args[args.indexOf('--site') + 1] : '';

mkdirSync(out, { recursive: true });
for (const t of TARGETS) {
  const size = await make(t);
  console.log(`dist-extension/arise-${t}.zip: ${(size / 1024).toFixed(0)} KB`);
}
await make('chrome', { dev: true });
console.log('dist-extension/dev/: for Arise on localhost (Load unpacked)');

if (site) {
  const dir = join(root, site);
  mkdirSync(dir, { recursive: true });
  cpSync(join(out, 'arise-chrome.zip'), join(dir, 'arise-chrome.zip'));
  const xpi = join(out, 'signed', 'arise-firefox.xpi');
  if (existsSync(xpi)) {
    const bytes = readFileSync(xpi);
    const { version } = JSON.parse(readFileSync(join(src, 'manifest.json'), 'utf8'));
    cpSync(xpi, join(dir, 'arise-firefox.xpi'));
    writeFileSync(join(dir, 'updates.json'), JSON.stringify(updatesJson(version, createHash('sha256').update(bytes).digest('hex')), null, 2));
    console.log(`${site}: Chrome zip, and Firefox ${version} signed by Mozilla`);
  } else {
    console.log(`${site}: Chrome zip (no Firefox copy signed by Mozilla yet)`);
  }
}
