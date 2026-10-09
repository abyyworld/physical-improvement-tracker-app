import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';
import { VitePWA } from 'vite-plugin-pwa';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const commit = (() => {
  try {
    return execSync('git rev-parse --short HEAD').toString().trim();
  } catch {
    return 'dev';
  }
})();
const built = new Date().toISOString();

// Where the iPhone app looks for its updates: the GitHub Pages site of the repo GitHub is building.
// Builds made anywhere else (in Xcode on a Mac, say) don't update themselves.
const site = (() => {
  const [owner, repo] = (process.env.GITHUB_ACTIONS ? process.env.GITHUB_REPOSITORY || '' : '').split('/');
  if (!owner || !repo) return '';
  const host = `${owner.toLowerCase()}.github.io`;
  return repo.toLowerCase() === host ? `https://${host}/` : `https://${host}/${repo}/`;
})();

// The native side of the iPhone app this web app expects: Capacitor and each plugin with iPhone
// code, down to the minor version. A downloaded update only goes to an iPhone app built with the
// same, since a new plugin or a new native feature needs a new Arise.ipa.
const native = (() => {
  const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).sort();
  const parts: string[] = [];
  for (const name of names) {
    try {
      const p = JSON.parse(readFileSync(new URL(`./node_modules/${name}/package.json`, import.meta.url), 'utf8'));
      if (name === '@capacitor/ios' || p.capacitor?.ios) parts.push(`${name}@${String(p.version).split('.').slice(0, 2).join('.')}`);
    } catch {}
  }
  return parts.join(',');
})();

export default defineConfig({
  // Relative paths, so the same build works on GitHub Pages (under /physical-improvement-tracker-app/)
  // and inside the iPhone app.
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_COMMIT__: JSON.stringify(commit),
    __APP_BUILT__: JSON.stringify(built),
    __APP_UPDATE_SITE__: JSON.stringify(site),
    __APP_NATIVE__: JSON.stringify(native),
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  plugins: [
    // Which version this build is, for the iPhone app's own updates (scripts/native-bundle.mjs).
    {
      name: 'arise-version',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ version: pkg.version, commit, built, native }) });
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
        // The manifest and its icons are added by the plugin itself.
        globIgnores: ['icons/**'],
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
    include: ['src/**/*.test.{ts,js}', 'worker/**/*.test.ts'],
    environment: 'node',
  },
});
