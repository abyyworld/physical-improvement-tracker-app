// The native side of the phone apps that a build of the web app expects: one key for the iPhone
// app and one for the Android app. A downloaded update only goes to a phone app built with the
// same key (src/native-update.ts), since a new plugin or new native code needs a new Arise.ipa or
// Arise.apk.
//
// iPhone: Capacitor's iOS package and each plugin with iPhone code, down to the minor version, plus
//   IOS_OWN for Arise's own Swift code. This is exactly what it has been since 1.6, so the iPhone
//   apps already out there keep updating.
// Android: the same for Capacitor's Android package and each plugin with Android code, plus a
//   fingerprint of Arise's own Android parts (its Kotlin code, the manifest, its resources such as
//   the notification icon, and the Gradle files that choose library versions), which live in the
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

// Arise's own Android parts. A change in here changes what the Android app can do or has: its
// code, its manifest, its resources (the web app uses some by name, like the notification icon
// 'ic_stat_arise', and the Share plugin needs the folders in xml/file_paths.xml), and the Gradle
// files that choose the libraries it's built with.
export const ANDROID_OWN = [
  'android/app/src/main/java',
  'android/app/src/main/AndroidManifest.xml',
  'android/app/src/main/res',
  'android/app/build.gradle',
  'android/variables.gradle',
];

// Made by `npx cap sync` (and ignored by git), so not part of the app's own parts. Hidden files
// (a Mac's .DS_Store) aren't either.
const GENERATED = new Set(['android/app/src/main/res/xml/config.xml']);

// A short fingerprint of those, the same on every computer ('' when there's no Android project).
// Text counts with Unix line endings (git may check it out with Windows ones); images and other
// binary files (a zero byte near the start, the way git tells them apart) count byte for byte.
export function ownAndroidCode(root) {
  const hash = createHash('sha256');
  let any = false;
  const add = (path) => {
    if (!existsSync(path)) return;
    const name = relative(root, path).split('\\').join('/');
    if (GENERATED.has(name)) return;
    if (statSync(path).isDirectory()) {
      for (const child of readdirSync(path).sort()) if (!child.startsWith('.')) add(join(path, child));
      return;
    }
    any = true;
    hash.update(`${name}\0`);
    const bytes = readFileSync(path);
    if (bytes.subarray(0, 8000).includes(0)) hash.update(bytes);
    else hash.update(bytes.toString('utf8').replace(/\r\n/g, '\n'));
    hash.update('\0');
  };
  for (const p of ANDROID_OWN) add(join(root, p));
  return any ? hash.digest('hex').slice(0, 12) : '';
}

// Arise's own native code in the iPhone app (the Swift files, Info.plist and App.entitlements in
// ios/App/App) isn't a plugin, so it can't be found like one. Raise this number whenever that code
// changes in a way the web app relies on (a new method it calls, a new permission it asks for).
export const IOS_OWN = 'arise-ios@1';

export function nativeKeys(root) {
  const own = ownAndroidCode(root);
  return {
    ios: [...packages(root, 'ios'), IOS_OWN].join(','),
    android: [...packages(root, 'android'), ...(own ? [`arise-android@${own}`] : [])].join(','),
  };
}
