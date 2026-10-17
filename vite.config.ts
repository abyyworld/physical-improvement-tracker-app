import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { VitePWA } from 'vite-plugin-pwa';
import { OWN_PAGE_FILES } from './src/lib/pages';
import { nativeKeys } from './scripts/native-key.mjs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const commit = (() => {
  try {
    return execSync('git rev-parse --short HEAD').toString().trim();
  } catch {
    return 'dev';
  }
})();
const built = new Date().toISOString();

// Where the phone apps look for their updates: the GitHub Pages site of the repo GitHub is
// building. Builds made anywhere else (in Xcode or Android Studio, say) don't update themselves.
const repoName = process.env.GITHUB_ACTIONS ? process.env.GITHUB_REPOSITORY || '' : '';
const site = (() => {
  const [owner, repo] = repoName.split('/');
  if (!owner || !repo) return '';
  const host = `${owner.toLowerCase()}.github.io`;
  return repo.toLowerCase() === host ? `https://${host}/` : `https://${host}/${repo}/`;
})();
// Where the newest Android app is (.github/workflows/android.yml), for when an update needs it.
const apk = site ? `https://github.com/${repoName}/releases/download/android-latest/Arise.apk` : '';

// The native side of the phone apps this web app expects, one key per platform (see
// scripts/native-key.mjs). A downloaded update only goes to a phone app built with the same, since
// a new plugin or a new native feature needs a new Arise.ipa or Arise.apk. `native` is the
// iPhone app's, worked out the same way as always.
const { ios: native, android: nativeAndroid } = nativeKeys(fileURLToPath(new URL('.', import.meta.url)));

export default defineConfig({
  // Relative paths, so the same build works on GitHub Pages (under /physical-improvement-tracker-app/)
  // and inside the phone apps.
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_COMMIT__: JSON.stringify(commit),
    __APP_BUILT__: JSON.stringify(built),
    __APP_UPDATE_SITE__: JSON.stringify(site),
    __APP_NATIVE__: JSON.stringify(native),
    __APP_NATIVE_ANDROID__: JSON.stringify(nativeAndroid),
    __APP_APK_URL__: JSON.stringify(apk),
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  // The importers' worker (src/life/import/worker.ts) is a module worker.
  worker: {
    format: 'es',
  },
  plugins: [
    // Which version this build is, for the phone apps' own updates (scripts/native-bundle.mjs).
    {
      name: 'arise-version',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ version: pkg.version, commit, built, native, nativeAndroid }) });
      },
    },
    VitePWA({
      // Our own service worker (src/sw.ts), so updates go in only when it's safe (see src/update.ts).
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'prompt',
      injectRegister: false,
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,woff2,png,svg}'],
        // The manifest and its icons are added by the plugin itself. The site's own pages (the
        // privacy policy) aren't kept offline, so nobody reads an old copy.
        globIgnores: ['icons/**', ...OWN_PAGE_FILES],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
      },
      manifest: {
        name: 'Arise',
        short_name: 'Arise',
        description: 'Daily quests toward any goal, with an AI coach that keeps your data private.',
        id: './',
        start_url: './',
        scope: './',
        display: 'standalone',
        orientation: 'any',
        background_color: '#040507',
        theme_color: '#040507',
        categories: ['health', 'fitness', 'lifestyle', 'productivity'],
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  test: {
    include: ['src/**/*.test.{ts,js}', 'worker/**/*.test.ts', 'mac-helper/**/*.test.ts', 'extension/**/*.test.ts'],
    environment: 'node',
  },
});
