// @vitest-environment jsdom
// "What's new" after an update, including the move from 2.x to 1.0.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('virtual:pwa-register', () => ({ registerSW: () => () => {} }));

async function start(seen: string | null) {
  localStorage.clear();
  if (seen) localStorage.setItem('arise-version-seen', seen);
  vi.resetModules();
  const U = await import('./update');
  const shown: string[] = [];
  U.initUpdates({ busy: () => [], whatsNew: (html) => shown.push(html) });
  return { U, shown };
}

beforeEach(() => vi.unstubAllGlobals());

describe("what's new", () => {
  it('shows the newest notes once to a device that ran 2.x, since the app went back to 1.x', async () => {
    const { U, shown } = await start('2.2.0');
    const { CHANGES } = await import('./changelog');
    expect(U.newer('2.2.0', U.VERSION)).toBe(true);
    expect(shown).toHaveLength(1);
    expect(shown[0]).toContain(CHANGES[0].version);
    expect(shown[0]).not.toContain(`>${CHANGES[1].version}<`);
    expect(localStorage.getItem('arise-version-seen')).toBe(U.VERSION);
    expect((await start(U.VERSION)).shown).toEqual([]);
  });

  it('says nothing on a first install', async () => {
    expect((await start(null)).shown).toEqual([]);
  });

  it('compares versions number by number', async () => {
    const { U } = await start(null);
    expect(U.newer('1.0.1', '1.0.0')).toBe(true);
    expect(U.newer('2.2.0', '1.0.0')).toBe(true);
    expect(U.newer('1.0.0', '1.0')).toBe(false);
    expect(U.newer('1.10.0', '1.9.0')).toBe(true);
  });
});
