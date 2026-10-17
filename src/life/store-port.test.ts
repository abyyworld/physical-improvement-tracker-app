// @vitest-environment jsdom
// The port finds the life log by itself, with all it offers, and a store set by hand wins.

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LifeEvent } from './types';

const event = (id: string, title: string): LifeEvent => ({ id, source: 'manual', kind: 'note', at: Date.UTC(2026, 9, 1, 9), title, tier: 2 });

beforeEach(() => vi.resetModules());

describe('the life store port', () => {
  it('loads the life log with add, upsert and remove', async () => {
    const port = await import('./store-port');
    const store = (await port.loadLifeStore())!;
    expect(store).not.toBeNull();
    expect(await port.lifeStore()).toBe(store);
    expect(await store.addEvents([event('manual:a', 'Walked'), event('manual:b', 'Read')])).toBe(2);
    expect(await store.addEvents([event('manual:a', 'Walked')])).toBe(0);
    expect(await store.upsertEvents!([event('manual:a', 'Walked the dog')])).toBe(1);
    expect(await store.removeIds!(['manual:b'])).toBe(1);
    const log = await import('./log');
    expect((await log.getEvent('manual:a'))?.title).toBe('Walked the dog');
    expect(await log.getEvent('manual:b')).toBeNull();
  });

  it('prefers a store set by hand, and hands it to anyone waiting', async () => {
    const port = await import('./store-port');
    const fake = { addEvents: async (e: LifeEvent[]) => e.length };
    port.setLifeStore(fake);
    expect(await port.lifeStore()).toBe(fake);
    expect(await port.loadLifeStore()).toBe(fake);
  });
});
