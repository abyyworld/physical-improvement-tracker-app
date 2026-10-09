// Packs the built web app for the iPhone app's own updates. Run after `npm run build` (the Deploy
// workflow does). It adds to dist/:
//   native/latest.json   which version is the newest, and how to check the download
//   native/<commit>.zip  that version's files
// GitHub Pages serves both next to the website, and the iPhone app checks them (src/native-update.ts).

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

export function makeBundle(dist) {
  const files = {};
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const rel = relative(dist, path).split('\\').join('/');
      if (rel === 'native' || rel.endsWith('.map')) continue;
      if (statSync(path).isDirectory()) walk(path);
      else files[rel] = new Uint8Array(readFileSync(path)); // (a plain byte array, whatever Node gives)
    }
  };
  walk(dist);
  if (!files['index.html']) throw new Error('dist has no index.html: build the app first.');
  // `native`: the iPhone app this version needs (see vite.config.ts). The app compares it with its own.
  const { version, commit, built, native } = JSON.parse(readFileSync(join(dist, 'version.json'), 'utf8'));
  // Fixed dates inside the zip, so the same files always give the same checksum.
  const zip = zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, [v, { mtime: new Date('2020-01-01T00:00:00Z') }]])), { level: 9 });
  const file = `${commit}.zip`;
  const sha256 = createHash('sha256').update(zip).digest('hex');
  return { zip, file, latest: { version, commit, built, native, file, size: zip.length, sha256 } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const dist = join(root, 'dist');
  const { zip, file, latest } = makeBundle(dist);
  mkdirSync(join(dist, 'native'), { recursive: true });
  writeFileSync(join(dist, 'native', file), zip);
  writeFileSync(join(dist, 'native', 'latest.json'), JSON.stringify(latest, null, 2));
  console.log(`native/${file}: ${(zip.length / 1024).toFixed(0)} KB, ${latest.version} (${latest.commit}), for an iPhone app with ${latest.native || 'no native parts'}`);
}
