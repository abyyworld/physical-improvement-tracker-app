// The native parts each phone app is built with (scripts/native-key.mjs, used by vite.config.ts):
// an update only goes to a phone app with the same. The iPhone app's must stay exactly what it
// always was, or every iPhone out there would wait for a new Arise.ipa.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IOS_OWN, nativeKeys, ownAndroidCode } from '../scripts/native-key.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function write(root: string, path: string, text: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

// A project with Capacitor for both phones, and plugins for one or both.
function project() {
  const root = mkdtempSync(join(tmpdir(), 'arise-key-'));
  const deps = {
    '@capacitor/core': '^8.5.2',
    '@capacitor/ios': '^8.5.2',
    '@capacitor/android': '^8.5.2',
    '@capacitor/filesystem': '^8.1.3',
    'android-only-plugin': '^2.0.0',
    'ios-only-plugin': '^1.4.0',
    fflate: '0.8.2',
  };
  write(root, 'package.json', JSON.stringify({ dependencies: deps }));
  const pkg = (name: string, version: string, capacitor?: object) => write(root, `node_modules/${name}/package.json`, JSON.stringify({ name, version, ...(capacitor ? { capacitor } : {}) }));
  pkg('@capacitor/core', '8.5.2');
  pkg('@capacitor/ios', '8.5.2');
  pkg('@capacitor/android', '8.5.2');
  pkg('@capacitor/filesystem', '8.1.3', { ios: { src: 'ios' }, android: { src: 'android' } });
  pkg('android-only-plugin', '2.0.7', { android: { src: 'android' } });
  pkg('ios-only-plugin', '1.4.1', { ios: { src: 'ios' } });
  pkg('fflate', '0.8.2');
  write(root, 'android/app/src/main/java/com/abyyworld/arise/MainActivity.kt', 'class MainActivity\n');
  write(root, 'android/app/src/main/AndroidManifest.xml', '<manifest/>\n');
  return root;
}

// How vite.config.ts worked out the iPhone app's key before there was an Android app (1.6: the
// plugins, then Arise's own Swift code).
function iosKeyAsBefore(root: string) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).sort();
  const parts: string[] = [];
  for (const name of names) {
    try {
      const p = JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8'));
      if (name === '@capacitor/ios' || p.capacitor?.ios) parts.push(`${name}@${String(p.version).split('.').slice(0, 2).join('.')}`);
    } catch {}
  }
  return [...parts, 'arise-ios@1'].join(',');
}

describe('the native parts of each phone app', () => {
  it("lists Capacitor and each plugin with code for that phone, and the Android app's own code", () => {
    const root = project();
    const keys = nativeKeys(root);
    expect(keys.ios).toBe(`@capacitor/filesystem@8.1,@capacitor/ios@8.5,ios-only-plugin@1.4,${IOS_OWN}`);
    expect(keys.android).toMatch(/^@capacitor\/android@8\.5,@capacitor\/filesystem@8\.1,android-only-plugin@2\.0,arise-android@[0-9a-f]{12}$/);
  });

  it("leaves out plugins capacitor.config.json keeps out of the Android app, and only there", () => {
    const root = project();
    const ios = nativeKeys(root).ios;
    write(root, 'capacitor.config.json', JSON.stringify({ android: { includePlugins: ['@capacitor/filesystem'] } }));
    const keys = nativeKeys(root);
    expect(keys.android).toMatch(/^@capacitor\/android@8\.5,@capacitor\/filesystem@8\.1,arise-android@[0-9a-f]{12}$/);
    expect(keys.ios).toBe(ios);
  });

  it("changes the Android app's key when its own code changes, and never the iPhone app's", () => {
    const root = project();
    const before = nativeKeys(root);
    write(root, 'android/app/src/main/java/com/abyyworld/arise/life/LifePlugin.kt', 'class LifePlugin\n');
    const after = nativeKeys(root);
    expect(after.android).not.toBe(before.android);
    expect(after.ios).toBe(before.ios);
    write(root, 'android/app/src/main/AndroidManifest.xml', '<manifest><uses-permission/></manifest>\n');
    expect(nativeKeys(root).android).not.toBe(after.android);
  });

  it("changes the Android app's key when its resources or Gradle files change, images byte for byte", () => {
    const root = project();
    const keys = [nativeKeys(root).android];
    const changes: [string, string | Uint8Array][] = [
      // A new sound or icon the web app would ask for by name.
      ['android/app/src/main/res/drawable/ic_stat_new.xml', '<vector/>\n'],
      // A folder the Share plugin may share files from.
      ['android/app/src/main/res/xml/file_paths.xml', '<paths><files-path name="files" path="."/></paths>\n'],
      // Two images that only differ in bytes that aren't text: the same if read as text.
      ['android/app/src/main/res/mipmap-hdpi/ic_launcher.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0x0d, 0xff])],
      ['android/app/src/main/res/mipmap-hdpi/ic_launcher.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0x0d, 0xfe])],
      // A library version (Health Connect, say).
      ['android/app/build.gradle', 'dependencies { implementation "androidx.health.connect:connect-client:1.1.0" }\n'],
      ['android/variables.gradle', 'ext { minSdkVersion = 26 }\n'],
    ];
    for (const [path, content] of changes) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
      keys.push(nativeKeys(root).android);
    }
    expect(new Set(keys).size).toBe(keys.length);
    expect(nativeKeys(root).ios).toBe(nativeKeys(project()).ios);
  });

  it("leaves out what `npx cap sync` makes and the computer's hidden files", () => {
    const root = project();
    const before = ownAndroidCode(root);
    write(root, 'android/app/src/main/res/xml/config.xml', '<widget/>\n');
    write(root, 'android/app/src/main/res/.DS_Store', 'Finder\n');
    write(root, 'android/app/src/main/java/.DS_Store', 'Finder\n');
    expect(ownAndroidCode(root)).toBe(before);
  });

  it('gives the same fingerprint on every computer, whatever its line endings', () => {
    const a = project();
    const b = project();
    write(b, 'android/app/src/main/java/com/abyyworld/arise/MainActivity.kt', 'class MainActivity\r\n');
    expect(ownAndroidCode(a)).toBe(ownAndroidCode(b));
    write(a, 'android/app/src/main/res/values/strings.xml', '<resources>\n</resources>\n');
    write(b, 'android/app/src/main/res/values/strings.xml', '<resources>\r\n</resources>\r\n');
    expect(ownAndroidCode(a)).toBe(ownAndroidCode(b));
    expect(ownAndroidCode(mkdtempSync(join(tmpdir(), 'arise-empty-')))).toBe('');
  });

  it("keeps the iPhone app's key for this project exactly as it was, so iPhones keep updating", () => {
    const keys = nativeKeys(ROOT);
    expect(keys.ios).toBe(iosKeyAsBefore(ROOT));
    expect(keys.ios).not.toContain('android');
    expect(keys.android).toContain('@capacitor/android@');
    expect(keys.android).toMatch(/arise-android@[0-9a-f]{12}$/);
  });

  it('is what this build of the app was made with', () => {
    const keys = nativeKeys(ROOT);
    expect(__APP_NATIVE__).toBe(keys.ios);
    expect(__APP_NATIVE_ANDROID__).toBe(keys.android);
  });
});
