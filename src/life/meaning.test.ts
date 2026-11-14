// Search by meaning, on this device: a question's words widened to related ones.

import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { GROUPS, groupsOf, widen } from './meaning';
import { queryWords } from './log';

const names = (w: string) => groupsOf(w).map((i) => GROUPS[i].name);

describe('search by meaning', () => {
  it('finds the groups a word belongs to, whatever its form', () => {
    expect(names('exercise')).toEqual(['exercise']);
    expect(names('runn')).toEqual(['exercise']); // "running", as log.ts trims it
    expect(names('ran')).toEqual(['exercise']);
    expect(names('workout')).toEqual(['exercise']);
    expect(names('work')).toEqual(['work']);
    expect(names('restaurant')).toEqual(['food']);
    expect(names('cardio')).toEqual(['exercise']);
    expect(names('song')).toEqual(['music']);
    expect(names('search')).toEqual([]);
    expect(names('business')).toEqual([]);
    expect(names('slept')).toEqual(['sleep']);
    expect(names('exercising'.slice(0, -3))).toEqual(['exercise']);
    expect(names('bought')).toEqual(['money']);
    expect(names('pizza')).toEqual(['food']);
    expect(names('re')).toEqual([]); // too short to start a word of theirs
    expect(names('protein')).toEqual([]);
  });

  it("widens a question's words, its own first, within a limit", () => {
    const w = widen(queryWords('What did I do for exercise?'));
    expect(w.groups).toEqual(['exercise']);
    expect(w.words[0]).toBe('exercise*'); // their own words still start words, as before
    expect(w.words).toEqual(expect.arrayContaining(['workout', 'run', 'gym', 'yoga']));
    expect(w.related).not.toContain('exercise');
    expect(w.words.length).toBeLessThanOrEqual(24);
    expect(widen(['food', 'friend']).groups).toEqual(['food', 'people']);
    expect(widen(['protein'])).toEqual({ words: ['protein*'], related: [], groups: [] });
    expect(widen(['ran']).words[0]).toBe('run*');
  });

  it('keeps only single words to look up, and no little words that start lots of others', () => {
    for (const g of GROUPS) {
      for (const w of g.words) {
        expect(w, g.name).toMatch(/^[a-z]+\*?$/);
        if (w.endsWith('*')) expect(w.length - 1, w).toBeGreaterThanOrEqual(4); // a stem of four letters or more
      }
    }
    for (const noisy of ['sea', 'visit', 'push', 'pull', 'bus', 'car', 'app', 'ill', 'rest', 'date', 'band']) expect(GROUPS.flatMap((g) => g.words), noisy).not.toContain(noisy);
  });
});

describe('looking them up', () => {
  it('finds plain forms of a short word, never longer words it starts', async () => {
    const L = await import('./log');
    const ev = (id: string, title: string) => ({ id: `manual:${id}`, source: 'manual' as const, kind: 'note' as const, at: Date.UTC(2026, 9, 1) + id.length, title, tier: 2 as const });
    await L.addEvents([ev('a', 'Went for a run'), ev('bb', 'Running in the park'), ev('ccc', 'Got a new career'), ev('dddd', 'Searched "sea views"'), ev('eeeee', 'Exercising at home')]);
    const titles = async (words: string[]) => (await L.search('', { any: true, words })).map((e) => e.title).sort();
    expect(await titles(['run'])).toEqual(['Running in the park', 'Went for a run']);
    expect(await titles(['car'])).toEqual([]);
    expect(await titles(['exercis*'])).toEqual(['Exercising at home']);
  });
});
