// Search by meaning, on this device: a question's words widened to related ones.

import { describe, expect, it } from 'vitest';
import { GROUPS, groupsOf, widen } from './meaning';
import { queryWords } from './log';

const names = (w: string) => groupsOf(w).map((i) => GROUPS[i].name);

describe('search by meaning', () => {
  it('finds the groups a word belongs to, whatever its form', () => {
    expect(names('exercise')).toEqual(['exercise']);
    expect(names('running')).toContain('exercise');
    expect(names('ran')).toContain('exercise');
    expect(names('slept')).toEqual(['sleep']);
    expect(names('bought')).toEqual(['money']);
    expect(names('pizza')).toEqual(['food']);
    expect(names('re')).toEqual([]); // too short to start a word of theirs
    expect(names('protein')).toEqual([]);
  });

  it("widens a question's words, its own first, within a limit", () => {
    const w = widen(queryWords('What did I do for exercise?'));
    expect(w.groups).toEqual(['exercise']);
    expect(w.words[0]).toBe('exercise');
    expect(w.words).toEqual(expect.arrayContaining(['workout', 'run', 'gym', 'yoga']));
    expect(w.related).not.toContain('exercise');
    expect(w.words.length).toBeLessThanOrEqual(24);
    expect(widen(['food', 'friend']).groups).toEqual(['food', 'people']);
    expect(widen(['protein'])).toEqual({ words: ['protein'], related: [], groups: [] });
    expect(widen(['ran']).words[0]).toBe('run');
  });

  it('keeps only single words to look up', () => {
    for (const g of GROUPS) for (const w of widen([g.words[0]]).words) expect(w, g.name).not.toContain(' ');
  });
});
