// Study packs and how a card is learned: the link, a pack from outside checked field by field,
// spaced repetition, the cards a round picks, XP with its daily caps, and two devices' answers.

import { describe, expect, it } from 'vitest';
import * as ST from './study';
import { linkKey, newLinkKey, open, seal } from './crypto';

const ID = 'AbCdEfGhIjKlMnOpQrStUv';
const KEY = 'a'.repeat(43);

const PACK = {
  format: 'arise.study/v1',
  updated: '2026-10-20',
  modules: [
    {
      id: 'databases',
      module: 'Databases and Web Programming',
      short: 'Databases',
      tests: [{ title: 'Class test 2', date: '2026-10-26', covers: 'Weeks 1-4', note: 'In the lecture.', source: 'Week 1 slides, slide 5' }],
      topics: [
        { id: 'db-w1-er', week: 1, title: 'ER modelling' },
        { id: 'db-w3-sql', week: 3, title: 'SQL' },
      ],
      cards: [
        { id: 'db-w1-er-01', topic: 'db-w1-er', type: 'mcq', q: 'One customer, many orders: which cardinality?', choices: ['1:1', '1:M', 'M:M'], answer: 1, explain: 'One side has many.', source: 'Week 1 slides, slide 61' },
        { id: 'db-w1-er-02', topic: 'db-w1-er', type: 'recall', q: 'What does an M:M relationship need in a relational database?', back: 'A junction table.', explain: 'It holds a pair of foreign keys.', source: 'Week 1 slides, slide 85' },
        { id: 'db-w3-sql-01', topic: 'db-w3-sql', type: 'mcq', q: 'Which keeps groups by a condition on an aggregate?', code: 'SELECT dept, COUNT(*)\nFROM staff\nGROUP BY dept', choices: ['WHERE', 'HAVING'], answer: 1, explain: 'HAVING filters groups.', source: 'Week 3 slides, slide 20' },
      ],
    },
  ],
};

describe('the study link', () => {
  it('takes just the code, or a whole Arise address ending in #study=', () => {
    expect(ST.parseLink(`${ID}.${KEY}`)).toEqual({ id: ID, key: KEY });
    expect(ST.parseLink(`  https://abyyworld.github.io/physical-improvement-tracker-app/#study=${ID}.${KEY}\n`)).toEqual({ id: ID, key: KEY });
  });

  it("refuses anything that isn't one", () => {
    for (const bad of ['', 'hello', `${ID}.${KEY.slice(1)}`, `${ID}x.${KEY}`, `${ID}.${KEY}<script>`, null, 42]) expect(ST.parseLink(bad)).toBeNull();
  });
});

describe('a pack from outside', () => {
  it('keeps every good card', () => {
    const p = ST.cleanPack(PACK)!;
    expect(p.modules[0].cards.map((c) => c.id)).toEqual(['db-w1-er-01', 'db-w1-er-02', 'db-w3-sql-01']);
    expect(p.modules[0].tests[0].date).toBe('2026-10-26');
    expect(p.modules[0].cards[2].code).toBe('SELECT dept, COUNT(*)\nFROM staff\nGROUP BY dept');
  });

  it('drops cards that would break a round: no topic, an answer out of range, a recall card with nothing on the back, a repeated id', () => {
    const m = PACK.modules[0];
    const p = ST.cleanPack({
      ...PACK,
      modules: [
        {
          ...m,
          cards: [
            ...m.cards,
            { ...m.cards[0], id: 'db-x-01', topic: 'nope' },
            { ...m.cards[0], id: 'db-x-02', answer: 3 },
            { ...m.cards[1], id: 'db-x-03', back: '' },
            { ...m.cards[0], q: 'Same id again' },
            { ...m.cards[0], id: 'Bad Id!' },
          ],
        },
      ],
    })!;
    expect(p.modules[0].cards.map((c) => c.id)).toEqual(['db-w1-er-01', 'db-w1-er-02', 'db-w3-sql-01']);
  });

  it('needs the format, and at least one module', () => {
    expect(ST.cleanPack({ ...PACK, format: 'other' })).toBeNull();
    expect(ST.cleanPack({ ...PACK, modules: [] })).toBeNull();
    expect(ST.cleanPack('nope')).toBeNull();
  });

  it('opens a sealed pack with the key from its link, and only for its own id', async () => {
    const key = await newLinkKey();
    const sealed = await seal(await linkKey(key), JSON.stringify(PACK), ST.packAad(ID));
    expect(ST.cleanPack(JSON.parse(await open(await linkKey(key), sealed, ST.packAad(ID))))).toEqual(ST.cleanPack(PACK));
    await expect(open(await linkKey(key), sealed, ST.packAad('BbCdEfGhIjKlMnOpQrStUv'))).rejects.toThrow();
  });
});

describe('spaced repetition', () => {
  it('spaces a card out with each right answer, and brings it back today when missed', () => {
    let c = ST.answer(undefined, true, '2026-10-20', 1);
    expect(c).toEqual({ b: 1, due: '2026-10-21', at: 1, r: 1, w: 0 });
    c = ST.answer(c, true, '2026-10-21', 2);
    expect(c.due).toBe('2026-10-24');
    c = ST.answer(c, false, '2026-10-24', 3);
    expect(c).toEqual({ b: 0, due: '2026-10-24', at: 3, r: 2, w: 1 });
  });

  it('never goes past the last box', () => {
    let c: ST.CardState | undefined;
    for (let i = 0; i < 10; i++) c = ST.answer(c, true, '2026-10-20', i + 1);
    expect(c!.b).toBe(ST.BOXES.length - 1);
    expect(c!.due).toBe('2026-11-19');
  });

  it('picks cards due first (the longest waiting first), then new ones, at most six new', () => {
    const cards = Array.from({ length: 20 }, (_, i) => ({ id: `c-${i}` }) as ST.Card);
    const state: Record<string, ST.CardState> = {
      'c-5': { b: 2, due: '2026-10-19', at: 1, r: 2, w: 0 },
      'c-9': { b: 1, due: '2026-10-15', at: 1, r: 1, w: 0 },
      'c-7': { b: 3, due: '2026-11-01', at: 1, r: 3, w: 0 },
    };
    const ids = ST.pickRound(cards, state, '2026-10-20').map((c) => c.id);
    expect(ids.slice(0, 2)).toEqual(['c-9', 'c-5']);
    expect(ids.slice(2, 8)).toEqual(['c-0', 'c-1', 'c-2', 'c-3', 'c-4', 'c-6']);
    // Then the least known of the rest, so a round is always full.
    expect(ids).toHaveLength(8 + 1);
    expect(ids[8]).toBe('c-7');
  });

  it('counts what is known (box 3 and up), seen and due', () => {
    const p = ST.cleanPack(PACK)!;
    const state = { 'db-w1-er-01': { b: 3, due: '2026-10-27', at: 1, r: 3, w: 0 }, 'db-w1-er-02': { b: 0, due: '2026-10-20', at: 1, r: 0, w: 1 } };
    expect(ST.progress(p.modules[0].cards, state, '2026-10-20')).toEqual({ known: 1, seen: 2, due: 1, all: 3, pct: 33 });
  });

  it('lists tests still to come, nearest first, and plays the module with a test soon', () => {
    const p = ST.cleanPack(PACK)!;
    expect(ST.upcoming(p, '2026-10-20').map((t) => [t.module, t.days])).toEqual([['Databases', 6]]);
    expect(ST.upcoming(p, '2026-10-27')).toEqual([]);
    expect(ST.nextModule(p, {}, '2026-10-20').id).toBe('databases');
  });
});

describe('study XP', () => {
  it('gives 20 a round and 2 a first answer right, up to four rounds and 40 right a day', () => {
    const s = ST.cleanStudy({ rounds: { '2026-10-19': { n: 1, right: 7, total: 10, at: 1 }, '2026-10-20': { n: 9, right: 80, total: 90, at: 2 } } });
    expect(ST.studyXP(s)).toBe(20 + 14 + 4 * 20 + 40 * 2);
  });
});

describe('two devices', () => {
  it('keeps the later answer to each card, the later day of rounds, and the later link', () => {
    const a = ST.cleanStudy({ link: `${ID}.${KEY}`, linkAt: 5, cards: { 'db-1': { b: 2, due: '2026-10-22', at: 10, r: 2, w: 0 }, 'db-2': { b: 1, due: '2026-10-21', at: 3, r: 1, w: 0 } }, rounds: { '2026-10-20': { n: 1, right: 5, total: 10, at: 10 } } });
    const b = ST.cleanStudy({ link: '', linkAt: 9, cards: { 'db-1': { b: 0, due: '2026-10-20', at: 4, r: 1, w: 1 }, 'db-2': { b: 0, due: '2026-10-20', at: 8, r: 1, w: 1 } }, rounds: { '2026-10-20': { n: 2, right: 12, total: 20, at: 12 } } });
    const m = ST.mergeStudy(a, b);
    expect(m.link).toBe('');
    expect(m.cards['db-1'].b).toBe(2);
    expect(m.cards['db-2'].b).toBe(0);
    expect(m.rounds['2026-10-20'].n).toBe(2);
    expect(ST.mergeStudy(b, a)).toEqual(m);
  });

  it('cleans what comes from the cloud: bad ids, dates and numbers go', () => {
    const s = ST.cleanStudy({ link: 'not a link', cards: { 'ok-1': { b: 99, due: '2026-10-20', at: 1, r: -3, w: 'x' }, 'Bad!': { b: 1, due: '2026-10-20' }, 'no-due': { b: 1 } }, rounds: { yesterday: { n: 1 } } });
    expect(s).toEqual({ link: '', linkAt: 0, cards: { 'ok-1': { b: 5, due: '2026-10-20', at: 1, r: 0, w: 0 } }, rounds: {} });
  });
});
