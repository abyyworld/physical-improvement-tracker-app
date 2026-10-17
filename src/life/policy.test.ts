// @vitest-environment jsdom
// Which AI may read which tier of the life log.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/on-device', () => ({ lastKnown: () => 'available', availability: async () => 'available', ask: vi.fn(), download: vi.fn() }));
vi.mock('../ai-config', () => ({ PRIVATE_AI: { proxy: 'https://ai.example.workers.dev/v1/', model: 'gpt-oss-120b', name: 'Private AI' } }));

async function load({ signedIn = true } = {}) {
  vi.resetModules();
  const S = await import('../store');
  const AI = await import('../ai.js');
  const P = await import('./policy');
  AI.connectAccount({ signedIn: () => signedIn, idToken: async () => (signedIn ? 'token' : null) });
  return { S, AI, P };
}

beforeEach(() => localStorage.clear());

describe('what each AI may read', () => {
  it('lets the private AI and the AI on the device read every tier', async () => {
    const { P } = await load();
    expect(P.capFor('private')).toBe(3);
    expect(P.capFor('device')).toBe(3);
  });

  it('gives the free AI and your own service tier 1 only, unless you allow more', async () => {
    const { P } = await load();
    expect(P.capFor('free')).toBe(1);
    expect(P.capFor('own')).toBe(1);
    expect(P.prefs().lessPrivate).toBe(false); // off by default
    P.setPrefs({ lessPrivate: true });
    expect(P.capFor('free')).toBe(3);
    expect(P.capFor('own')).toBe(3);
    expect(P.capFor(null)).toBe(0);
  });

  it('follows the AI in use right now', async () => {
    const { S, AI, P } = await load();
    expect(AI.engine()).toBe('private');
    expect(P.cap()).toBe(3);
    S.state.settings.aiEngine = 'free';
    AI.agreeFree();
    expect(P.cap()).toBe(1);
    P.setPrefs({ lessPrivate: true });
    expect(P.cap()).toBe(3);
    S.state.settings.aiEngine = 'own'; // picked, but no key and no yes: no AI at all
    expect(P.cap()).toBe(0);
  });

  it('keeps only what a cap allows, and gives anything made from the log its highest tier', async () => {
    const { P } = await load();
    const items = [{ tier: 1 as const }, { tier: 2 as const }, { tier: 3 as const }];
    expect(P.visible(items, 1)).toEqual([{ tier: 1 }]);
    expect(P.visible(items, 3)).toHaveLength(3);
    expect(P.visible(items, 0)).toEqual([]);
    expect(P.derivedTier([1, 3, 2])).toBe(3);
    expect(P.derivedTier([])).toBe(1);
  });

  it('keeps its switches on this device, checked like everything else from storage', async () => {
    const { P } = await load();
    localStorage.setItem('arise-life-prefs', '{"lessPrivate":"yes","paused":true,"extra":1}');
    expect(P.prefs()).toEqual({ lessPrivate: false, paused: true });
    localStorage.setItem('arise-life-prefs', 'not json');
    expect(P.prefs()).toEqual({ lessPrivate: false, paused: false });
    P.setPrefs({ paused: true });
    P.forgetPrefs();
    expect(P.prefs().paused).toBe(false);
  });
});
