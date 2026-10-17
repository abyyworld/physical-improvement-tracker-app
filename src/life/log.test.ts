// The life log on the device: adding (idempotent, checked), reading by time, searching, counting,
// deleting and downloading.

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import * as L from './log';
import { closeDB } from './db';
import type { LifeEvent } from './types';

const T = (s: string) => new Date(s).getTime(); // local time
const ev = (id: string, at: string, title: string, extra: Partial<LifeEvent> = {}): LifeEvent => ({ id: `spotify:${id}`, source: 'spotify', kind: 'listen', at: T(at), title, tier: 2, ...extra });

beforeEach(() => {
  closeDB();
  globalThis.indexedDB = new IDBFactory();
});

describe('adding events', () => {
  it('adds new events once, however often the same batch comes in', async () => {
    const batch = [ev('1', '2026-10-01T08:00', 'Listened to Song A'), ev('2', '2026-10-01T09:00', 'Listened to Song B')];
    expect(await L.addEvents(batch)).toBe(2);
    expect(await L.addEvents(batch)).toBe(0);
    expect(await L.addEvents([...batch, ev('3', '2026-10-02T09:00', 'Listened to Song C'), ev('3', '2026-10-02T09:00', 'twice in one batch')])).toBe(1);
    expect(await L.count()).toBe(3);
  });

  it('drops events that fail the check, and keeps the rest of the batch', async () => {
    const bad = [
      { id: 'spotify:x', source: 'spotify', kind: 'listen', at: 'yesterday', title: 'no time', tier: 2 },
      { id: 'netflix:x', source: 'spotify', kind: 'listen', at: T('2026-10-01T08:00'), title: 'id from another source', tier: 2 },
      { id: 'spotify:y', source: 'tiktok', kind: 'listen', at: T('2026-10-01T08:00'), title: 'unknown source', tier: 2 },
      { id: 'spotify:z', source: 'spotify', kind: 'listen', at: T('2026-10-01T08:00'), title: '   ', tier: 2 },
      null,
      'text',
    ];
    expect(await L.addEvents([...bad, ev('ok', '2026-10-01T10:00', 'Fine')] as unknown[])).toBe(1);
    expect((await L.eventsBetween(0, Infinity)).map((e) => e.id)).toEqual(['spotify:ok']);
  });

  it('never stores a sensitive kind below tier 3, whatever the importer said', async () => {
    await L.addEvents([{ id: 'whatsapp:1', source: 'whatsapp', kind: 'message', at: T('2026-10-01T08:00'), title: 'Message from Sam', tier: 1 }]);
    expect((await L.getEvent('whatsapp:1'))?.tier).toBe(3);
  });

  it('takes big imports in batches, and says which days changed', async () => {
    const changes: L.LifeChange[] = [];
    const off = L.onChange((c) => changes.push(c));
    const many = Array.from({ length: 2500 }, (_, i) => ev(`n${i}`, `2026-09-${String(1 + (i % 28)).padStart(2, '0')}T12:00`, `Song ${i}`));
    expect(await L.addEvents(many)).toBe(2500);
    off();
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ type: 'add', count: 2500, sources: ['spotify'] });
    expect(changes[0].days).toHaveLength(28);
    expect(await L.count()).toBe(2500);
  });

  it('replaces only what changed with upsertEvents', async () => {
    const a = { id: 'arise:log:2026-10-01', source: 'arise' as const, kind: 'note' as const, at: T('2026-10-01T20:00'), title: 'Journal: good day', tier: 1 as const };
    expect(await L.upsertEvents([a])).toBe(1);
    expect(await L.upsertEvents([a])).toBe(0);
    expect(await L.upsertEvents([{ ...a, title: 'Journal: great day' }])).toBe(1);
    expect((await L.getEvent(a.id))?.title).toBe('Journal: great day');
  });
});

describe('reading', () => {
  beforeEach(async () => {
    await L.addEvents([
      ev('1', '2026-10-01T08:00', 'Listened to Song A'),
      ev('2', '2026-10-01T22:00', 'Listened to Song B'),
      { id: 'netflix:1', source: 'netflix', kind: 'watch', at: T('2026-10-02T21:00'), title: 'Watched Breaking Bad: S1E3', tier: 2 },
      { id: 'google:1', source: 'google', kind: 'search', at: T('2026-10-05T10:00'), title: 'Searched "protein bars"', tier: 3 },
      { id: 'google:2', source: 'google', kind: 'search', at: T('2026-10-06T10:00'), title: 'Searched "best protein powder"', tier: 3 },
    ]);
  });

  it('reads a time range, oldest or newest first, by source and kind', async () => {
    const day = await L.eventsBetween(T('2026-10-01T00:00'), T('2026-10-02T00:00'));
    expect(day.map((e) => e.title)).toEqual(['Listened to Song A', 'Listened to Song B']);
    expect((await L.eventsBetween(0, Infinity, { newest: true, limit: 2 })).map((e) => e.id)).toEqual(['google:2', 'google:1']);
    expect((await L.eventsBetween(0, Infinity, { sources: ['google'] })).map((e) => e.id)).toEqual(['google:1', 'google:2']);
    expect((await L.eventsBetween(0, Infinity, { sources: ['google', 'netflix'], kinds: ['watch'] })).map((e) => e.id)).toEqual(['netflix:1']);
  });

  it('lists the days with anything in them, newest first', async () => {
    expect(await L.daysWithEvents()).toEqual(['2026-10-06', '2026-10-05', '2026-10-02', '2026-10-01']);
    expect(await L.daysWithEvents({ before: T('2026-10-05T00:00'), limit: 1 })).toEqual(['2026-10-02']);
  });

  it('counts each day in a range, leaving out the empty ones', async () => {
    expect(await L.countByDay(T('2026-10-01T00:00'), T('2026-11-01T00:00'))).toEqual({ '2026-10-01': 2, '2026-10-02': 1, '2026-10-05': 1, '2026-10-06': 1 });
    // Only what's inside the range, even part of a day.
    expect(await L.countByDay(T('2026-10-01T12:00'), T('2026-10-05T00:00'))).toEqual({ '2026-10-01': 1, '2026-10-02': 1 });
    expect(await L.countByDay(T('2026-10-03T00:00'), T('2026-10-05T00:00'))).toEqual({});
    expect(await L.countByDay(T('2026-10-05T00:00'), T('2026-10-05T00:00'))).toEqual({});
    expect(await L.countByDay(-Infinity, Infinity)).toEqual({});
  });

  it('counts by source', async () => {
    expect(await L.countBySource()).toEqual({ spotify: 2, netflix: 1, google: 2 });
  });

  it('finds events by the start of their words, newest first', async () => {
    expect((await L.search('protein')).map((e) => e.id)).toEqual(['google:2', 'google:1']);
    expect((await L.search('protein bar')).map((e) => e.id)).toEqual(['google:1']);
    expect((await L.search('What did I watch?')).map((e) => e.id)).toEqual(['netflix:1']);
    expect((await L.search('BREAKING bad')).map((e) => e.id)).toEqual(['netflix:1']);
    expect((await L.search('netflix')).map((e) => e.id)).toEqual(['netflix:1']);
    expect(await L.search('nothing like this')).toEqual([]);
    expect(await L.search('the of and')).toEqual([]);
    expect((await L.search('protein', { from: T('2026-10-06T00:00') })).map((e) => e.id)).toEqual(['google:2']);
  });

  it('finds events with any of the words, the best matches first', async () => {
    expect((await L.search('protein powder songs', { any: true })).map((e) => e.id)).toEqual(['google:2', 'google:1', 'spotify:2', 'spotify:1']);
  });

  it('deletes by source, by time, or both', async () => {
    const changes: L.LifeChange[] = [];
    L.onChange((c) => changes.push(c));
    expect(await L.deleteWhere({ source: 'google', from: T('2026-10-06T00:00') })).toBe(1);
    expect(changes.at(-1)).toMatchObject({ type: 'delete', count: 1, days: ['2026-10-06'], sources: ['google'] });
    expect(await L.deleteWhere({ from: T('2026-10-01T00:00'), to: T('2026-10-02T00:00') })).toBe(2);
    expect(await L.deleteWhere({ source: 'netflix' })).toBe(1);
    expect(await L.countBySource()).toEqual({ google: 1 });
    expect(await L.removeIds(['google:1', 'google:nope'])).toBe(1);
    expect(await L.count()).toBe(0);
  });

  it('downloads everything, oldest first', async () => {
    const all = await L.exportAll();
    expect(all.app).toBe('arise-life');
    expect(all.events.map((e) => e.id)).toEqual(['spotify:1', 'spotify:2', 'netflix:1', 'google:1', 'google:2']);
    expect(all.events.every((e) => !('w' in e))).toBe(true);
  });

  it('erases everything', async () => {
    await L.eraseAll();
    expect(await L.count()).toBe(0);
    expect(await L.span()).toBeNull();
  });
});

describe('a big log', () => {
  it('searches common words newest first without reading everything through the word index', async () => {
    // 6000 events share "song", more than the word index is used for: read a month at a time.
    const many = Array.from({ length: 6000 }, (_, i) => ev(`b${i}`, new Date(T('2025-01-01T12:00') + i * 3600e3).toISOString(), `Song number ${i}`));
    await L.addEvents(many);
    const hits = await L.search('song', { limit: 3 });
    expect(hits.map((e) => e.title)).toEqual(['Song number 5999', 'Song number 5998', 'Song number 5997']);
    expect((await L.search('song 4321')).map((e) => e.title)).toEqual(['Song number 4321']);
  });
});
