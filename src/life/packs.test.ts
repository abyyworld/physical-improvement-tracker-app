// How two copies of a life log pack come together: newest wins per item, deletions stay deleted,
// wipes delete what they cover even on a device that never saw it, the Player's facts beat the
// AI's, and every device ends up with the same pack whatever order things happen in.

import { describe, expect, it } from 'vitest';
import type { LifeFact, LifeSummary } from '../lib/validate';
import { canonical, cleanContent, emptyContent, eventPack, isEmpty, mergeContent, mergeWipes, monthOf, MEM, summaryPack, syncable, TOMB_KEEP, tidy, type Content, type SyncedEvent } from './packs';

const NOW = Date.UTC(2026, 9, 17, 10);
const DAY = 864e5;
const at = (s: string) => Date.parse(`${s}Z`);
const ev = (id: string, m: number, extra: Partial<SyncedEvent> = {}): SyncedEvent => ({ id: `spotify:${id}`, source: 'spotify', kind: 'listen', at: at('2026-10-05T09:00'), title: `Song ${id}`, tier: 2, m, ...extra });
const pack = (c: Partial<Content>): Content => ({ ...emptyContent(), ...c });
const K = 'e:2026-10';
const ids = (c: Content) => c.events.map((e) => e.id).sort();
// Times in these tests are small numbers, a moment before `now` (1000) unless a test says.
const merge = (a: Content, b: Content, opts = {}) => mergeContent(K, a, b, { now: 1000, ...opts });

describe('which pack', () => {
  it('files events by their month in UTC, whatever the time zone of the device', () => {
    expect(eventPack({ at: at('2026-10-31T23:30') })).toBe('e:2026-10');
    expect(eventPack({ at: at('2026-11-01T00:00') })).toBe('e:2026-11');
    expect(monthOf(at('2027-01-01T00:00'))).toBe('2027-01');
    expect(summaryPack('d:2026-10-16')).toBe('s:2026');
    expect(summaryPack('w:2025-12-29')).toBe('s:2025');
    expect(summaryPack('m:2026-10')).toBe('s:2026');
  });

  it("syncs everything but what Arise makes again from the app's own data, except questions to the coach", () => {
    expect(syncable({ id: 'spotify:1', source: 'spotify' })).toBe(true);
    expect(syncable({ id: 'manual:abc', source: 'manual' })).toBe(true);
    expect(syncable({ id: 'arise:quest:2026-10-01:q1', source: 'arise' })).toBe(false);
    expect(syncable({ id: 'arise:chat:1760000000000', source: 'arise' })).toBe(true);
  });
});

describe('two devices', () => {
  it('keeps what each added while offline', () => {
    const a = pack({ events: [ev('1', 10), ev('2', 20)] });
    const b = pack({ events: [ev('1', 10), ev('3', 30)] });
    expect(ids(merge(a, b))).toEqual(['spotify:1', 'spotify:2', 'spotify:3']);
    expect(canonical(K, merge(a, b))).toBe(canonical(K, merge(b, a)));
  });

  it('takes the newer version of an item changed on both', () => {
    const a = pack({ events: [ev('1', 10, { title: 'Old' })] });
    const b = pack({ events: [ev('1', 50, { title: 'New' })] });
    expect(merge(a, b).events[0].title).toBe('New');
    expect(merge(b, a).events[0].title).toBe('New');
    // Same time, different words: both devices pick the same one.
    const c = pack({ events: [ev('1', 50, { title: 'Other' })] });
    expect(merge(b, c).events[0].title).toBe(merge(c, b).events[0].title);
  });

  it("doesn't bring back an item deleted on one device from another that still has it", () => {
    const deleted = pack({ tombs: { 'spotify:1': 40 } });
    const older = pack({ events: [ev('1', 10), ev('2', 10)] });
    const out = merge(older, deleted);
    expect(ids(out)).toEqual(['spotify:2']);
    expect(out.tombs).toEqual({ 'spotify:1': 40 }); // kept, for devices still to come
    expect(canonical(K, merge(deleted, older))).toBe(canonical(K, out));
  });

  it('lets an item added again after its deletion win, and drops the tombstone', () => {
    const deleted = pack({ tombs: { 'spotify:1': 40 } });
    const again = pack({ events: [ev('1', 60, { title: 'Back' })] });
    const out = merge(deleted, again);
    expect(out.events.map((e) => e.title)).toEqual(['Back']);
    expect(out.tombs).toEqual({});
  });

  it('lets a deletion win a tie', () => {
    expect(ids(merge(pack({ events: [ev('1', 40)] }), pack({ tombs: { 'spotify:1': 40 } })))).toEqual([]);
  });

  it('forgets tombstones after 400 days', () => {
    const old = NOW - TOMB_KEEP - DAY;
    const out = merge(pack({ tombs: { 'spotify:1': old, 'spotify:2': NOW - DAY } }), pack({}), { now: NOW });
    expect(out.tombs).toEqual({ 'spotify:2': NOW - DAY });
  });

  it('drops what a device had before it last synced, when it was away longer than tombstones last', () => {
    const synced = NOW - TOMB_KEEP - 10 * DAY;
    const here = pack({ events: [ev('old', synced - DAY), ev('new', NOW - DAY)] });
    // The cloud lost "old" (deleted, its tombstone long gone) but has another device's "b".
    const cloud = pack({ events: [ev('b', NOW - 5 * DAY)] });
    expect(ids(merge(here, cloud, { now: NOW, staleBefore: synced }))).toEqual(['spotify:b', 'spotify:new']);
    // Not away that long: nothing is dropped.
    expect(ids(merge(here, cloud, { now: NOW }))).toEqual(['spotify:b', 'spotify:new', 'spotify:old']);
  });
});

describe('wipes (deleting a source, a span of days, or everything)', () => {
  const wipe = { at: 100, what: 'events' as const, source: 'spotify' as const };

  it('delete what they cover, even from a device that never saw the deletion, but not what came after', () => {
    const offline = pack({ events: [ev('1', 50), ev('2', 150), ev('n', 50, { id: 'netflix:n', source: 'netflix', kind: 'watch' })] });
    const out = merge(offline, pack({}), { wipes: [wipe] });
    expect(ids(out)).toEqual(['netflix:n', 'spotify:2']);
    expect(out.tombs).toEqual({}); // the wipe itself covers them
  });

  it('cover a span of time', () => {
    const w = { at: 100, what: 'events' as const, from: at('2026-10-05T00:00'), to: at('2026-10-06T00:00') };
    const out = merge(pack({ events: [ev('in', 50), ev('out', 50, { at: at('2026-10-07T09:00') })] }), pack({}), { wipes: [w] });
    expect(ids(out)).toEqual(['spotify:out']);
  });

  it('erase everything older, facts and summaries too', () => {
    const all = { at: 100, what: 'all' as const };
    expect(ids(merge(pack({ events: [ev('1', 50), ev('2', 150)] }), pack({}), { wipes: [all] }))).toEqual(['spotify:2']);
    const sum = (key: string, t: number): LifeSummary => ({ id: `d:${key}`, kind: 'day', key, text: 'A day.', tier: 2, cap: 3, sig: 'x', n: 1, at: t });
    const s = mergeContent('s:2026', pack({ sums: [sum('2026-10-01', 50), sum('2026-10-02', 150)] }), pack({}), { now: 1000, wipes: [all] });
    expect(s.sums.map((x) => x.key)).toEqual(['2026-10-02']);
  });

  it('are kept once each, and for 400 days', () => {
    const source = { at: NOW - 2 * DAY, what: 'events' as const, source: 'spotify' as const };
    const a = [{ at: NOW - DAY, what: 'all' as const }, { at: NOW - TOMB_KEEP - DAY, what: 'memory' as const }];
    const b = [{ at: NOW - DAY, what: 'all' as const }, source];
    expect(mergeWipes(a, b, NOW)).toEqual([source, { at: NOW - DAY, what: 'all' }]);
  });
});

describe('facts', () => {
  const fact = (id: string, from: 'ai' | 'you', t: number, text = 'You run on Sundays.'): LifeFact => ({ id, text, since: '2026-10-01', from, tier: 2, sources: ['2026-10-01'], at: t });
  const m = (a: Partial<Content>, b: Partial<Content>) => mergeContent(MEM, pack(a), pack(b), { now: 1000 });

  it("let the Player's own version beat the AI's, however new the AI's is", () => {
    const mine = fact('f1', 'you', 10, 'You run on Saturdays.');
    const ai = fact('f1', 'ai', 99);
    expect(m({ facts: [mine] }, { facts: [ai] }).facts).toEqual([mine]);
    expect(m({ facts: [ai] }, { facts: [mine] }).facts).toEqual([mine]);
  });

  it("let the Player's deletion beat a newer AI version, so it doesn't come back", () => {
    const out = m({ tombs: { f1: 10 } }, { facts: [fact('f1', 'ai', 99)] });
    expect(out.facts).toEqual([]);
    expect(out.tombs).toEqual({ f1: 10 });
  });

  it("let the newer of the Player's edit and deletion win", () => {
    expect(m({ tombs: { f1: 10 } }, { facts: [fact('f1', 'you', 99)] }).facts.map((f) => f.id)).toEqual(['f1']);
    expect(m({ tombs: { f1: 100 } }, { facts: [fact('f1', 'you', 99)] }).facts).toEqual([]);
  });

  it('are wiped with the memory, and "Stop learning" takes the newest choice', () => {
    const out = m({ facts: [fact('f1', 'you', 10), fact('f2', 'ai', 200)], prefs: { paused: true, at: 50 } }, { wipes: [{ at: 100, what: 'memory' }], prefs: { paused: false, at: 70 } });
    expect(out.facts.map((f) => f.id)).toEqual(['f2']);
    expect(out.prefs).toEqual({ paused: false, at: 70 });
    expect(out.wipes).toEqual([{ at: 100, what: 'memory' }]);
  });
});

describe('what comes from the cloud', () => {
  it('goes through the same checks as everything else, and only what belongs in that pack stays', () => {
    const c = cleanContent(K, {
      events: [ev('ok', 5), { ...ev('bad', 5), at: 'yesterday' }, ev('nov', 5, { at: at('2026-11-02T10:00') }), { id: 'arise:quest:x', source: 'arise', kind: 'quest', at: at('2026-10-05T09:00'), title: 'Done', tier: 1, m: 1 }, '<script>'],
      tombs: { 'spotify:x': 5, 'bad id': 5, 'spotify:y': 'soon' },
      facts: [{ id: 'f1' }],
    });
    expect(ids(c)).toEqual(['spotify:ok']);
    expect(c.tombs).toEqual({ 'spotify:x': 5 });
    expect(c.facts).toEqual([]); // not in an events pack
    expect(cleanContent(MEM, { wipes: [{ at: 5, what: 'events', source: 'tiktok' }, { at: 5, what: 'all' }, { at: 5, what: 'events', from: 'x' }] }).wipes).toEqual([{ at: 5, what: 'all' }]);
  });

  it('looks the same on every device, so an unchanged pack is never sent again', () => {
    const a = pack({ events: [ev('2', 1), ev('1', 1)], tombs: { b: 1, a: 2 } });
    const b = pack({ events: [ev('1', 1), ev('2', 1)], tombs: { a: 2, b: 1 } });
    expect(canonical(K, a)).toBe(canonical(K, b));
    expect(isEmpty(tidy(K, pack({ tombs: { x: NOW - TOMB_KEEP - DAY } }), { now: NOW }))).toBe(true);
  });
});
