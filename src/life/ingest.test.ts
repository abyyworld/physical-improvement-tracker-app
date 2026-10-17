// @vitest-environment jsdom
// Arise's own data in the life log: tier-1 events with ids that stay the same, kept in step with
// the app (added, changed, taken out), and wiped with the app's data.

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const T = (k: string, h = 12, m = 0) => {
  const [y, mo, d] = k.split('-').map(Number);
  return new Date(y, mo - 1, d, h, m).getTime();
};

const DATA = {
  sessions: [
    {
      id: 's1',
      workout: 'a',
      date: '2026-10-15',
      started: T('2026-10-15', 18),
      finished: T('2026-10-15', 18, 40),
      easy: false,
      items: [{ ex: 'band_row', setup: 'green band', sets: [{ r: 12, done: true }, { r: 10, done: true }] }],
    },
  ],
  football: ['2026-10-14'],
  logs: { '2026-10-16': { t: 'Good day.\nSlept well.', e: 4, at: T('2026-10-16', 21) }, '2026-10-13': { e: 2, at: T('2026-10-13', 22) } },
  body: { entries: [{ date: '2026-10-12', weight: 72.5, waist: 80, shoulders: null, at: T('2026-10-12', 8) }] },
  ai: { chat: [{ role: 'user', text: 'How do I get faster?', at: T('2026-10-16', 7) }, { role: 'assistant', text: 'Sprint.', at: T('2026-10-16', 7, 1) }] },
};

async function load(data: object = DATA) {
  vi.resetModules();
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
  localStorage.setItem('pit-data-v1', JSON.stringify(data));
  const S = await import('../store');
  S.saveGoal({
    id: 'g1',
    title: 'Learn Spanish',
    category: 'learning',
    created: '2026-10-01',
    quests: [{ id: 'q1', title: 'Study', schedule: { kind: 'daily' }, created: '2026-10-01', amount: { target: 30, unit: 'min' } }],
    measures: [{ id: 'm1', name: 'Words known', unit: 'words', better: 'up' }],
    milestones: [{ id: 'k1', title: 'First 500 words', done: '2026-10-10' }],
  });
  S.tick('q1', { done: true, amount: 30 }, '2026-10-16');
  S.logValue('m1', 420, '2026-10-15');
  const L = await import('./log');
  const I = await import('./ingest');
  return { S, L, I };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 17, 10));
});
afterEach(() => vi.useRealTimers());

describe("Arise's own data as events", () => {
  it('makes a tier-1 event with a stable id for each thing done', async () => {
    const { S, I } = await load();
    const list = I.ariseEvents(S.state);
    expect(list.map((e) => e.id).sort()).toEqual([
      'arise:body:2026-10-12',
      `arise:chat:${T('2026-10-16', 7)}`,
      'arise:football:2026-10-14',
      'arise:goal:fitness', // made from the workouts when the data loads (store.ts)
      'arise:goal:g1',
      'arise:journal:2026-10-13',
      'arise:journal:2026-10-16',
      'arise:measure:m1:2026-10-15',
      'arise:milestone:g1:k1',
      'arise:quest:2026-10-16:q1',
      'arise:workout:s1',
    ]);
    expect(list.every((e) => e.source === 'arise' && e.tier === 1)).toBe(true);
    const by = (id: string) => list.find((e) => e.id === id)!;
    expect(by('arise:quest:2026-10-16:q1')).toMatchObject({ kind: 'quest', title: 'Done: Study (30 of 30 min)', value: 30, unit: 'min' });
    expect(by('arise:workout:s1')).toMatchObject({ kind: 'workout', at: T('2026-10-15', 18), value: 40, unit: 'min' });
    expect(by('arise:workout:s1').detail).toContain('12/10 (green band)');
    expect(by('arise:journal:2026-10-16')).toMatchObject({ kind: 'note', title: 'Journal: Good day.', at: T('2026-10-16', 21) });
    expect(by('arise:journal:2026-10-16').detail).toContain('Energy 4/5.');
    expect(by('arise:journal:2026-10-13')).toMatchObject({ kind: 'mood', title: 'Energy 2/5' });
    expect(by('arise:body:2026-10-12').title).toBe('Weigh-in: 72.5 kg, waist 80 cm');
    expect(by('arise:measure:m1:2026-10-15').title).toBe('Words known: 420 words');
    expect(by('arise:milestone:g1:k1')).toMatchObject({ title: 'Milestone reached: First 500 words', at: T('2026-10-10', 12) });
    expect(by(`arise:chat:${T('2026-10-16', 7)}`)).toMatchObject({ kind: 'message', title: 'Asked the coach: How do I get faster?' });
  });

  it('files a quest ticked late under the day it was for', async () => {
    const { S, I } = await load();
    S.tick('q1', { done: true }, '2026-10-12'); // ticked today, for Monday
    expect(I.ariseEvents(S.state).find((e) => e.id === 'arise:quest:2026-10-12:q1')?.at).toBe(T('2026-10-12', 12));
  });
});

describe('keeping the log in step', () => {
  it('brings in all of the history once, and then only what changed', async () => {
    const { S, L, I } = await load();
    await I.ingestNow();
    expect(await L.count()).toBe(11);
    const changes: string[] = [];
    L.onChange((c) => changes.push(`${c.type} ${c.count}`));
    await I.ingestNow();
    expect(changes).toEqual([]);

    S.tick('q1', { done: false }, '2026-10-16'); // unticked: it goes
    S.setLog('2026-10-16', { t: 'Great day.' }); // edited: it changes
    S.state.ai.chat = []; // a new chat: the questions stay in the log
    S.save();
    await I.ingestNow();
    expect(changes).toEqual(['update 1', 'delete 1']);
    expect(await L.getEvent('arise:quest:2026-10-16:q1')).toBeNull();
    expect((await L.getEvent('arise:journal:2026-10-16'))?.title).toBe('Journal: Great day.');
    expect(await L.getEvent(`arise:chat:${T('2026-10-16', 7)}`)).not.toBeNull();
  });

  it('empties the life log when the data on this device is wiped', async () => {
    const { S, L, I } = await load();
    I.initIngest();
    await I.ingestNow();
    await L.addEvents([{ id: 'spotify:1', source: 'spotify', kind: 'listen', at: T('2026-10-16', 9), title: 'A song', tier: 2 }]);
    expect(await L.count()).toBe(12);
    S.resetAll();
    await vi.waitFor(async () => expect(await L.count()).toBe(0));
  });
});
