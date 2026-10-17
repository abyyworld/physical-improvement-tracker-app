// The native side of the phone apps that a build of the web app expects: one key for the iPhone
// app and one for the Android app. A downloaded update only goes to a phone app built with the
// same key (src/native-update.ts), since a new plugin or new native code needs a new Arise.ipa or
// Arise.apk.
//
// iPhone: Capacitor's iOS package and each plugin with iPhone code, down to the minor version.
//   This is exactly what it has always been, so the iPhone apps already out there keep updating.
// Android: the same for Capacitor's Android package and each plugin with Android code, plus a
//   fingerprint of Arise's own Android code (its Kotlin code and the manifest), which lives in the
//   app itself rather than in a package.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const minor = (v) => String(v).split('.').slice(0, 2).join('.');

// "name@major.minor" for Capacitor's own package for the platform and every plugin with code for it.
function packages(root, platform) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).sort();
  const parts = [];
  for (const name of names) {
    try {
      const p = JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8'));
      if (name === `@capacitor/${platform}` || p.capacitor?.[platform]) parts.push(`${name}@${minor(p.version)}`);
    } catch {}
  }
  return parts;
}

// Arise's own Android code. A change in here changes what the Android app can do.
export const ANDROID_OWN = ['android/app/src/main/java', 'android/app/src/main/AndroidManifest.xml'];

// A short fingerprint of that code, the same on every computer ('' when there's no Android project).
export function ownAndroidCode(root) {
  const hash = createHash('sha256');
  let any = false;
  const add = (path) => {
    if (!existsSync(path)) return;
    if (statSync(path).isDirectory()) {
      for (const name of readdirSync(path).sort()) add(join(path, name));
      return;
    }
    any = true;
    hash.update(`${relative(root, path).split('\\').join('/')}\0`);
    hash.update(`${readFileSync(path, 'utf8').replace(/\r\n/g, '\n')}\0`);
  };
  for (const p of ANDROID_OWN) add(join(root, p));
  return any ? hash.digest('hex').slice(0, 12) : '';
}

export function nativeKeys(root) {
  const own = ownAndroidCode(root);
  return {
    ios: packages(root, 'ios').join(','),
    android: [...packages(root, 'android'), ...(own ? [`arise-android@${own}`] : [])].join(','),
  };
}
