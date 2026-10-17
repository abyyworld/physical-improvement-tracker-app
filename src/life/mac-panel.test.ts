// @vitest-environment jsdom
// Settings, Your life, Mac: only on a Mac; the install command, pairing, the switches, and the
// Full Disk Access steps when the helper needs them.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { helperFetch, type Asked } from '../test/fake-mac-helper';

const CODE = 'ABCDE12345FGHJK67890';
const UA = {
  chrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  safari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36',
};

function browser(ua: string) {
  Object.defineProperty(window.navigator, 'userAgent', { value: ua, configurable: true });
  Object.defineProperty(window.navigator, 'maxTouchPoints', { value: 0, configurable: true });
}

let settings: Record<string, boolean>;
let fda: boolean;
let olderNode: boolean | undefined;
// The program that needs Full Disk Access, as the helper says.
let program: string;
const sent: Asked[] = [];

async function load() {
  vi.resetModules();
  const mac = await import('./mac-link');
  const panel = await import('./mac-panel.js');
  mac.useHelper(
    helperFetch(
      CODE,
      ({ path, body }) => {
        if (path === '/v1/settings') Object.assign(settings, body);
        const sources = Object.fromEntries(['calls', 'notifications', 'messages', 'safari', 'apps'].map((k) => [k, { state: settings[k] ? (fda ? 'ok' : 'no-access') : 'off', found: 0, last: null, waiting: 0 }]));
        return { body: { version: 1, node: program, fullDiskAccess: fda, olderNodeAccess: olderNode, settings, sources, waiting: 0 } };
      },
      sent,
    ) as typeof fetch,
  );
  return { mac, panel };
}

function show(html: string) {
  document.querySelector('#app')!.innerHTML = html;
}

const button = (sel: string) => document.querySelector(sel) as HTMLButtonElement;

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '<div id="toast"></div><div id="app"></div>';
  settings = { calls: false, notifications: false, messages: false, text: false, safari: false, apps: false };
  fda = true;
  olderNode = undefined;
  program = '/Users/me/.arise-helper/bin/arise-helper';
  sent.length = 0;
});

describe('the Mac panel', () => {
  it('only shows on a Mac', async () => {
    browser(UA.windows);
    const { panel } = await load();
    expect(panel.settingsPanel()).toBe('');
  });

  it('shows how to install, and asks for the pairing code', async () => {
    browser(UA.chrome);
    const { panel, mac } = await load();
    show(panel.settingsPanel());
    expect(document.querySelector('#macCmd')!.textContent).toBe(mac.INSTALL_COMMAND);
    expect(document.querySelector('#macPanel')!.textContent).toMatch(/Full Disk Access/);
    expect(document.querySelector('#macPanel')!.textContent).toMatch(/Choose Allow/);
    expect(document.querySelector('#macPanel')!.textContent).not.toMatch(/Safari doesn't/);
    expect(button('[data-act="mac-link"]')).toBeTruthy();
  });

  it('tells Safari users to use Chrome or Edge', async () => {
    browser(UA.safari);
    const { panel } = await load();
    show(panel.settingsPanel());
    expect(document.querySelector('#macPanel .error')!.textContent).toMatch(/Chrome or Edge/);
  });

  it('links with the code, then shows the switches, all off', async () => {
    browser(UA.chrome);
    const { panel, mac } = await load();
    show(panel.settingsPanel());
    (document.querySelector('#macCodeIn') as HTMLInputElement).value = 'wrong';
    await panel.handleAction('mac-link', button('[data-act="mac-link"]'));
    expect(document.querySelector('#macErr')!.textContent).toMatch(/doesn't match/);
    (document.querySelector('#macCodeIn') as HTMLInputElement).value = 'abcde-12345-fghjk-67890';
    await panel.handleAction('mac-link', button('[data-act="mac-link"]'));
    expect(mac.linked()).toBe(true);
    const rows = [...document.querySelectorAll('[data-act="mac-switch"]')] as HTMLButtonElement[];
    expect(rows.map((r) => r.dataset.k)).toEqual(['calls', 'notifications', 'messages', 'text', 'safari', 'apps']);
    expect(rows.every((r) => r.getAttribute('aria-pressed') === 'false')).toBe(true);
    expect(document.querySelector('#macPanel')!.textContent).toMatch(/Everything starts off/);
  });

  it('turns a source on in the helper, and shows the Full Disk Access steps when it needs them', async () => {
    browser(UA.chrome);
    fda = false;
    const { panel, mac } = await load();
    await mac.link(CODE);
    show(panel.settingsPanel());
    await panel.handleAction('mac-switch', button('[data-k="calls"]'));
    expect(sent.find((s) => s.path === '/v1/settings')?.body).toEqual({ calls: true });
    expect(button('[data-k="calls"]').getAttribute('aria-pressed')).toBe('true');
    const text = document.querySelector('#macPanel')!.textContent!;
    expect(text).toMatch(/needs Full Disk Access/);
    // Back to the installer, which checks the helper before showing where to give it.
    expect(text).toMatch(/Run the install command again \(Copy install command, below\)\. It checks that the helper is Arise's own/);
    expect(text).toMatch(/each update needs it again/);
    expect(button('[data-act="mac-copy"]')).toBeTruthy();
    expect(text).not.toMatch(/older helper/);
  });

  it('shows where to give Full Disk Access while installing: the signed program', async () => {
    browser(UA.chrome);
    const { panel } = await load();
    show(panel.settingsPanel());
    const text = document.querySelector('#macPanel')!.textContent!;
    expect(text).toContain('~/.arise-helper/bin/arise-helper');
    expect(text).not.toContain('node/bin/node');
  });

  it('asks to update the older helper, whose Full Disk Access goes to Node.js, instead of giving Node.js more', async () => {
    browser(UA.chrome);
    fda = false;
    program = '/Users/me/.arise-helper/node/bin/node';
    settings.calls = true;
    const { panel, mac } = await load();
    await mac.link(CODE);
    show(panel.settingsPanel());
    const text = document.querySelector('#macPanel')!.textContent!;
    expect(text).toMatch(/This is the older helper: its Full Disk Access goes to Node\.js, which any app on this Mac could use\. Run the install command again/);
    expect(text).not.toContain('node/bin/node');
    expect(text).not.toMatch(/needs Full Disk Access/);
  });

  it("warns while the older helper's Node.js still has Full Disk Access, after the update", async () => {
    browser(UA.chrome);
    olderNode = true;
    const { panel, mac } = await load();
    await mac.link(CODE);
    show(panel.settingsPanel());
    expect(document.querySelector('#macPanel .error')!.textContent).toBe('"node", from the older helper, still has Full Disk Access, and any app on this Mac could use it. In System Settings, Privacy & Security, Full Disk Access, select "node" and click the minus button.');
    olderNode = false;
    await mac.link(CODE);
    show(panel.settingsPanel());
    expect(document.querySelector('#macPanel')!.textContent).not.toMatch(/still has Full Disk Access/);
  });

  it('unlinks', async () => {
    browser(UA.chrome);
    const { panel, mac } = await load();
    await mac.link(CODE);
    show(panel.settingsPanel());
    await panel.handleAction('mac-unlink', button('[data-act="mac-unlink"]'));
    expect(mac.linked()).toBe(false);
    expect(document.querySelector('#macCodeIn')).toBeTruthy();
    expect(await panel.handleAction('something-else', button('#macPanel button'))).toBe(false);
  });
});
