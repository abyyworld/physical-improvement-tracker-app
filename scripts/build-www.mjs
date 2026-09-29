// Copies the web app into www/, which Capacitor bundles into the iOS app.
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const OUT = 'www';
const FILES = ['index.html', 'manifest.webmanifest', 'sw.js'];
const DIRS = ['css', 'js', 'fonts', 'icons', 'vendor'];

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT);
for (const f of FILES) cpSync(f, `${OUT}/${f}`);
for (const d of DIRS) cpSync(d, `${OUT}/${d}`, { recursive: true });
console.log(`Copied the web app to ${OUT}/`);
