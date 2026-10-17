// What the extension asks the browser for, in every browser's build: only what it needs, never
// private windows, and it talks only to Arise's own pages.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ARISE_URL, DEV_URLS, GECKO_ID, TARGETS, UPDATES_URL, ariseUrls, manifestFor, updatesJson } from '../../scripts/extension-manifest.mjs';

const base = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

describe('the manifest', () => {
  it('asks for exactly these permissions, and no access to other sites', () => {
    for (const t of TARGETS) {
      const m = manifestFor(base, t);
      expect(m.manifest_version).toBe(3);
      expect([...m.permissions].sort()).toEqual(['alarms', 'history', 'idle', 'storage', 'tabs', 'unlimitedStorage']);
      expect(m.host_permissions).toBeUndefined();
      expect(m.optional_permissions).toBeUndefined();
      expect(m.web_accessible_resources).toBeUndefined();
      expect(m.externally_connectable).toBeUndefined();
      expect(JSON.stringify(m)).not.toContain('<all_urls>');
    }
  });

  it('never runs in private windows', () => {
    for (const t of TARGETS) expect(manifestFor(base, t).incognito).toBe('not_allowed');
  });

  it("runs its content script on Arise's pages only (and localhost in a development build)", () => {
    for (const t of TARGETS) {
      const m = manifestFor(base, t);
      expect(m.content_scripts).toEqual([{ matches: [`${ARISE_URL}*`], js: ['content.js'], run_at: 'document_start', all_frames: false }]);
    }
    const dev = manifestFor(base, 'chrome', { dev: true });
    expect(dev.content_scripts[0].matches).toEqual([`${ARISE_URL}*`, ...DEV_URLS.map((u) => `${u}*`)]);
    expect(dev.name).toContain('development');
    expect(ariseUrls()).toEqual([ARISE_URL]);
    expect(ariseUrls({ dev: true })).toEqual([ARISE_URL, ...DEV_URLS]);
  });

  it('fits each browser', () => {
    const chrome = manifestFor(base, 'chrome');
    expect(chrome.background).toEqual({ service_worker: 'background.js' });
    expect(chrome.browser_specific_settings).toBeUndefined();
    expect(manifestFor(base, 'edge')).toEqual(chrome);
    const ff = manifestFor(base, 'firefox');
    expect(ff.background).toEqual({ scripts: ['background.js'] });
    expect(ff.minimum_chrome_version).toBeUndefined();
    expect(ff.browser_specific_settings.gecko).toMatchObject({ id: GECKO_ID, update_url: UPDATES_URL, data_collection_permissions: { required: ['browsingActivity', 'searchTerms'] } });
    expect(UPDATES_URL.startsWith(ARISE_URL)).toBe(true);
  });

  it('allows only its own scripts on its pages', () => {
    expect(base.content_security_policy.extension_pages).toBe("script-src 'self'; object-src 'none'; base-uri 'none'");
    const html = readFileSync(new URL('../popup.html', import.meta.url), 'utf8');
    expect(html).not.toMatch(/<script>(?!<)/); // no inline script
    expect(html).not.toMatch(/https?:\/\//);
  });

  it("has a version of its own (the app's isn't touched)", () => {
    expect(base.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('writes the file Firefox checks for updates', () => {
    expect(updatesJson('1.2.3', 'ab')).toEqual({ addons: { [GECKO_ID]: { updates: [{ version: '1.2.3', update_link: `${ARISE_URL}extension/arise-firefox.xpi`, update_hash: 'sha256:ab' }] } } });
  });
});
