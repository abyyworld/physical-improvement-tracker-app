// @vitest-environment jsdom
// What Arise learns from the life log: the AI's changes to facts, the profile, summing up days
// (only from what the AI in use may read), weeks, recall for a question, forgetting, and the
// yesterday card.

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { LifeFact } from '../lib/validate';
import type { LifeEvent } from './types';

// The AI: which engine is in use, and its answers. Each answer says which model wrote it (`by`),
// as ai.js's do; `strength` is what ai.js says of the model in use (strong unless a test says).
type Ask = { instructions: string; prompt: string };
const BY: Record<string, string> = { private: 'private:gpt-oss-120b', free: 'free:@cf/openai/gpt-oss-120b', own: 'own:google:gemini-2.5-pro', device: 'device:gemini-nano' };
const ai = vi.hoisted(() => ({ engine: 'private' as string | null, ask: null as unknown as Mock<(o: Ask) => Promise<unknown>>, strength: 'strong', by: '', trusted: [] as string[] }));
vi.mock('../ai.js', () => ({
  engine: () => ai.engine,
  isPrivate: () => !['own', 'free'].includes(ai.engine as string),
  ready: () => !!ai.engine,
  askMemory: async (o: Ask) => ({ by: ai.by || BY[ai.engine as string] || '', ...((await ai.ask(o)) as object) }),
  useMemory: vi.fn(),
  memoryStrength: () => (ai.engine ? ai.strength : 'none'),
  trustedModel: (provider: string, model: string) => ai.trusted.includes(`${provider}:${model}`),
}));

async function load() {
  vi.resetModules();
  globalThis.indexedDB = new IDBFactory();
  const L = await import('./log');
  const M = await import('./memory');
  const P = await import('./policy');
  return { L, M, P };
}

const T = (k: string, h = 12, m = 0) => {
  const [y, mo, d] = k.split('-').map(Number);
  return new Date(y, mo - 1, d, h, m).getTime();
};
const DAY: LifeEvent[] = [
  { id: 'arise:quest:2026-10-16:q1', source: 'arise', kind: 'quest', at: T('2026-10-16', 8), title: 'Done: Study Spanish', tier: 1 },
  { id: 'spotify:a1', source: 'spotify', kind: 'listen', at: T('2026-10-16', 9), title: 'Listened to Daft Punk: One More Time', tier: 2 },
  { id: 'google:s1', source: 'google', kind: 'search', at: T('2026-10-16', 10), title: 'Searched "knee pain after running"', tier: 3 },
  { id: 'arise:workout:w1', source: 'arise', kind: 'workout', at: T('2026-10-15', 18), title: 'Workout: A · Back & biceps', tier: 1 },
  { id: 'netflix:n1', source: 'netflix', kind: 'watch', at: T('2026-10-14', 21), title: 'Watched Dark: S1E1', tier: 2 },
];
// What the AI was sent, as one string per request.
const sent = () => ai.ask.mock.calls.map(([o]) => `${(o as { instructions: string }).instructions}\n${(o as { prompt: string }).prompt}`);
const daily = (summary: string, facts: object[] = []) => ({ json: { summary, facts } });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 17, 10)); // Saturday 17 October 2026
  localStorage.clear();
  ai.engine = 'private';
  ai.ask = vi.fn(async () => daily('You had a day.'));
  ai.strength = 'strong';
  ai.by = '';
  ai.trusted = [];
});
afterEach(() => vi.useRealTimers());

describe("the AI's changes to facts", () => {
  const base: LifeFact[] = [
    { id: 'fa', text: 'You run on Sundays.', since: '2026-10-01', from: 'ai', tier: 1, sources: ['2026-10-01', '2026-10-08'], at: 1 },
    { id: 'fb', text: 'You live in Leeds.', since: '2026-09-01', from: 'you', tier: 2, sources: [], at: 1 },
    { id: 'fc', text: 'You see Sam on Fridays.', since: '2026-10-02', from: 'ai', tier: 3, sources: ['2026-10-02'], at: 1 },
    { id: 'fd', text: 'You drink coffee every morning.', since: '2026-10-03', from: 'ai', pinned: true, tier: 1, sources: ['2026-10-03'], at: 1 },
  ];
  const alias = new Map([
    ['F1', 'fa'],
    ['F2', 'fb'],
    ['F3', 'fc'],
    ['F4', 'fd'],
  ]);

  it('adds, confirms and retires, and never changes your own facts or the words of pinned ones', async () => {
    const { M } = await load();
    const { facts, changed } = M.applyOps(
      base,
      [
        { op: 'add', id: '', text: 'You like Daft Punk.' },
        { op: 'add', id: '', text: 'you run on sundays' }, // already known: a confirmation
        { op: 'update', id: 'F2', text: 'You live in York.' }, // yours
        { op: 'update', id: 'F4', text: 'You drink tea now.' }, // pinned
        { op: 'retire', id: 'F3', text: '' },
        { op: 'delete', id: 'F1', text: '' },
        null,
      ],
      { day: '2026-10-16', tier: 2, cap: 3, now: 99, alias, makeId: () => 'fnew' },
    );
    const by = (id: string) => facts.find((f) => f.id === id)!;
    expect(by('fnew')).toMatchObject({ text: 'You like Daft Punk.', from: 'ai', tier: 2, since: '2026-10-16', sources: ['2026-10-16'] });
    expect(by('fa')).toMatchObject({ text: 'You run on Sundays.', tier: 1, sources: ['2026-10-01', '2026-10-08', '2026-10-16'] });
    expect(by('fb').text).toBe('You live in Leeds.');
    expect(by('fd').text).toBe('You drink coffee every morning.');
    expect(by('fc').until).toBe('2026-10-16');
    expect(changed.map((f) => f.id).sort()).toEqual(['fa', 'fc', 'fnew']);
  });

  it('gives new words the tier of what the AI read', async () => {
    const { M } = await load();
    const { facts } = M.applyOps(base, [{ op: 'update', id: 'F1', text: 'You run on Sundays and Wednesdays.' }], { day: '2026-10-16', tier: 3, cap: 3, now: 99, alias });
    expect(facts.find((f) => f.id === 'fa')).toMatchObject({ text: 'You run on Sundays and Wednesdays.', tier: 3 });
  });

  it('lets an older day only confirm what a newer one said', async () => {
    const { M } = await load();
    const { facts } = M.applyOps(
      base,
      [
        { op: 'retire', id: 'F1', text: '' },
        { op: 'update', id: 'F1', text: 'You run on Saturdays.' },
        { op: 'update', id: 'F1', text: 'You run on Sundays.' },
      ],
      { day: '2026-09-30', tier: 1, cap: 3, now: 99, alias },
    );
    expect(facts.find((f) => f.id === 'fa')).toMatchObject({ text: 'You run on Sundays.', since: '2026-09-30', sources: ['2026-09-30', '2026-10-01', '2026-10-08'] });
    expect(facts.find((f) => f.id === 'fa')!.until).toBeUndefined();
  });

  it('takes every fact the AI vouches for as it is, beyond the limit on changes, and only ones it was shown', async () => {
    const { M } = await load();
    const many: LifeFact[] = Array.from({ length: 12 }, (_, i) => ({ id: `fm${i}`, text: `You like thing ${i}.`, since: '2026-10-01', from: 'ai', tier: 1, sources: ['2026-10-01'], at: 1, by: 'device:gemini-nano' }));
    const shown = new Map(many.slice(0, 11).map((f, i) => [`F${i + 1}`, f.id]));
    const { changed } = M.applyOps(many, [], { day: '2026-10-16', tier: 1, cap: 3, now: 99, alias: shown, by: 'private:gpt-oss-120b', confirm: [...shown.keys(), 'fm11', 'F99', 7] });
    expect(changed.map((f) => f.id).sort()).toEqual(many.slice(0, 11).map((f) => f.id).sort());
    for (const f of changed) expect(f).toMatchObject({ by: 'private:gpt-oss-120b', sources: ['2026-10-01', '2026-10-16'] });
  });

  it("can't touch facts above what the AI may read", async () => {
    const { M } = await load();
    const { changed } = M.applyOps(base, [{ op: 'retire', id: 'F3', text: '' }, { op: 'add', id: '', text: 'You see Sam on Fridays.' }], { day: '2026-10-16', tier: 1, cap: 1, now: 99, alias });
    expect(changed).toEqual([]);
  });

  it('builds the profile: pinned first, then yours, then the best confirmed, within its size', async () => {
    const { M } = await load();
    expect(M.buildProfile(base, { cap: 3, chars: 1000 })).toEqual(['- You drink coffee every morning.', '- You live in Leeds.', '- You run on Sundays.', '- You see Sam on Fridays.']);
    expect(M.buildProfile(base, { cap: 1, chars: 1000 })).toEqual(['- You drink coffee every morning.', '- You run on Sundays.']);
    expect(M.buildProfile(base, { cap: 3, chars: 40 })).toEqual(['- You drink coffee every morning.']);
  });
});

describe('the facts you change', () => {
  it('adds, edits, pins, deletes and restores, and an edited fact is yours from then on', async () => {
    const { M } = await load();
    const mine = await M.addFact('  I am vegetarian. ');
    expect(mine).toMatchObject({ text: 'I am vegetarian.', from: 'you', tier: 2, since: '2026-10-17' });
    const { L } = { L: await import('./log') };
    await L.addEvents([DAY[0]]);
    ai.ask = vi.fn(async () => daily('You studied.', [{ op: 'add', id: '', text: 'You study Spanish every day.' }]));
    await M.learn();
    const learned = M.allFacts().find((f) => f.from === 'ai')!;
    await M.editFact(learned.id, 'You study Spanish most days.');
    expect(M.allFacts().find((f) => f.id === learned.id)).toMatchObject({ from: 'you', text: 'You study Spanish most days.' });
    await M.pinFact(mine!.id, true);
    expect(M.allFacts().find((f) => f.id === mine!.id)?.pinned).toBe(true);
    await M.deleteFact(mine!.id);
    expect(M.allFacts().map((f) => f.id)).toEqual([learned.id]);

    // Kept on the device: a fresh start reads them back.
    vi.resetModules();
    const again = await import('./memory');
    await again.load();
    expect(again.allFacts()).toHaveLength(1);
  });

  it('gives a tier-1 fact you rewrite the tier of a fact you type, so a less private AI no longer gets it', async () => {
    const { L, M } = await load();
    await L.addEvents([DAY[0]]); // tier 1: the free AI may learn from it
    ai.engine = 'free';
    ai.ask = vi.fn(async () => daily('You studied.', [{ op: 'add', id: '', text: 'You do your reading quest most evenings.' }]));
    await M.learn();
    const learned = M.allFacts()[0];
    expect(learned.tier).toBe(1);
    expect(M.profileText('free')).toContain('reading quest');
    await M.editFact(learned.id, 'You read most evenings, after therapy on Tuesdays.');
    expect(M.allFacts()[0]).toMatchObject({ from: 'you', tier: 2 });
    expect(M.profileText('free')).toBe('');
    expect(M.profileText('private')).toContain('after therapy');
  });
});

describe('summing up days', () => {
  it('only sends what the AI in use may read, and never writes over a richer summary', async () => {
    const { L, M } = await load();
    await L.addEvents(DAY);
    ai.engine = 'free'; // tier 1 only
    ai.ask = vi.fn(async () => daily('You studied Spanish.', [{ op: 'add', id: '', text: 'You study Spanish most days.' }]));
    expect(await M.learn()).toBe(2); // 16 Oct and 15 Oct; 14 Oct has nothing it may read
    for (const s of sent()) expect(s).not.toMatch(/Daft Punk|knee pain|Dark: S1E1/);
    expect(M.summaryFor('day', '2026-10-16')).toMatchObject({ text: 'You studied Spanish.', tier: 1, cap: 1 });
    expect(M.allFacts()[0]).toMatchObject({ text: 'You study Spanish most days.', tier: 1 });

    // The private AI reads it all: the days with more in them are done again.
    ai.engine = 'private';
    ai.ask = vi.fn(async () => daily('You studied, listened to Daft Punk and looked up knee pain.'));
    expect(await M.learn()).toBe(2); // 16 Oct again, and 14 Oct; 15 Oct has nothing new
    expect(sent().join('\n')).toContain('knee pain');
    expect(M.summaryFor('day', '2026-10-16')).toMatchObject({ tier: 3, cap: 3 });
    expect(M.summaryFor('day', '2026-10-14')?.tier).toBe(2);

    // Back on the free AI: nothing is summed up again with less.
    ai.engine = 'free';
    ai.ask = vi.fn(async () => daily('Less.'));
    expect(await M.learn()).toBe(0);
    expect(ai.ask).not.toHaveBeenCalled();
    expect(M.summaryFor('day', '2026-10-16')?.text).toContain('knee pain');
  });

  // For About me and me links (me.ts): Arise's own journal, weigh-ins, energy and questions to the
  // coach are tier 1 for the AI, but not tier 1 to share with another app.
  it('notes how private each day and fact is to share with another app', async () => {
    const { L, M } = await load();
    const arise = (id: string, kind: LifeEvent['kind'], k: string, title: string): LifeEvent => ({ id: `arise:${id}`, source: 'arise', kind, at: T(k, 12), title, tier: 1 });
    await L.addEvents([
      arise('quest:2026-10-16:q1', 'quest', '2026-10-16', 'Done: Run'),
      arise('journal:2026-10-15', 'note', '2026-10-15', 'Journal: a long walk with Mum'),
      arise('journal:2026-10-14', 'note', '2026-10-14', 'Journal: panic attack before the meeting, upped my sertraline'),
      arise('body:2026-10-14', 'health', '2026-10-14', 'Weigh-in: 82 kg'),
      arise('chat:1', 'message', '2026-10-14', 'Asked the coach: is sertraline ok with running?'),
      arise('journal:2026-10-13', 'mood', '2026-10-13', 'Energy 2/5'),
    ]);
    ai.ask = vi.fn(async ({ prompt }: Ask) => {
      const k = /The day: (\w+)/.exec(prompt)![1];
      return daily(`A ${k}.`, [{ op: 'add', id: '', text: `You learned something on ${k}.` }]);
    });
    expect(await M.learn({ days: ['2026-10-16', '2026-10-15', '2026-10-14', '2026-10-13'] })).toBe(4);
    const share = (k: string) => {
      const s = M.summaryFor('day', k)!;
      const f = M.allFacts().find((x) => x.since === k)!;
      return [s.tier, M.shareOf(s), f.tier, M.shareOf(f)];
    };
    expect(share('2026-10-16')).toEqual([1, 1, 1, 1]); // a quest
    expect(share('2026-10-15')).toEqual([1, 2, 1, 2]); // the journal, like any note
    expect(share('2026-10-14')).toEqual([1, 3, 1, 3]); // a weigh-in and a question to the coach
    expect(share('2026-10-13')).toEqual([1, 3, 1, 3]); // energy

    // New words from a more private day carry its tier; facts and summaries from before this was
    // noted count as sensitive; the Player's own words are a note.
    const quest = M.allFacts().find((f) => f.since === '2026-10-16')!;
    const alias = new Map([['F1', quest.id]]);
    const { facts } = M.applyOps([quest], [{ op: 'update', id: 'F1', text: 'You run and take sertraline.' }], { day: '2026-10-17', tier: 1, share: 3, cap: 3, now: 9, alias });
    expect(M.shareOf(facts[0])).toBe(3);
    const { share: _s, ...old } = quest;
    expect(M.shareOf(old)).toBe(3);
    expect(M.shareOf({ ...old, from: 'you', tier: 2 })).toBe(2);
    expect(M.shareOf((await M.addFact('I like mornings.'))!)).toBe(2);
    expect(M.shareOf((await M.editFact(M.allFacts().find((f) => f.since === '2026-10-14')!.id, 'I run.'))!)).toBe(3);
  });

  it('keeps to its budget and carries on next time, and never sums up today', async () => {
    const { L, M } = await load();
    await L.addEvents([...DAY, { id: 'manual:today', source: 'manual', kind: 'note', at: T('2026-10-17', 9), title: 'Today', tier: 2 }]);
    expect(await M.learn({ budget: 1 })).toBe(1);
    expect(M.summaryFor('day', '2026-10-16')).not.toBeNull();
    expect(await M.learn({ budget: 5 })).toBe(2);
    expect(M.summaryFor('day', '2026-10-17')).toBeNull();
    expect(await M.learn()).toBe(0); // all up to date
  });

  it('sums up a day again when its log changes', async () => {
    const { L, M } = await load();
    M.initMemory({ delay: -1 });
    await L.addEvents(DAY);
    await M.learn();
    ai.ask.mockClear();
    await L.addEvents([{ id: 'manual:n1', source: 'manual', kind: 'note', at: T('2026-10-15', 20), title: 'Dinner with Sam', tier: 2 }]);
    expect(await M.learn()).toBe(1);
    expect(sent()[0]).toContain('Dinner with Sam');
  });

  it('lets a less private AI sum up a changed day without taking it away from the private one', async () => {
    const { L, M } = await load();
    M.initMemory({ delay: -1 });
    await L.addEvents([...DAY, { id: 'manual:old', source: 'manual', kind: 'note', at: T('2026-10-01', 9), title: 'Old note', tier: 2 }]);
    await M.learn({ budget: 10 }); // the private AI goes back as far as 1 October
    expect(M.summaryFor('day', '2026-10-01')).not.toBeNull();
    // Then something new comes in for 5 October, while the free AI is in use.
    ai.engine = 'free';
    await L.addEvents([
      { id: 'arise:quest:2026-10-05:q1', source: 'arise', kind: 'quest', at: T('2026-10-05', 8), title: 'Done: Study Spanish', tier: 1 },
      { id: 'google:late', source: 'google', kind: 'search', at: T('2026-10-05', 9), title: 'Searched "running shoes"', tier: 3 },
    ]);
    ai.ask.mockClear();
    expect(await M.learn()).toBe(2); // the day, and its week
    expect(sent().join('\n')).not.toContain('running shoes');
    expect(M.summaryFor('day', '2026-10-05')?.cap).toBe(1);
    // Back on the private AI, that day is still waiting for it.
    ai.engine = 'private';
    ai.ask.mockClear();
    expect(await M.learn()).toBe(2);
    expect(sent()[0]).toContain('running shoes');
    expect(M.summaryFor('day', '2026-10-05')).toMatchObject({ cap: 3, tier: 3 });
  });

  it('does nothing while paused, unless you ask for a day', async () => {
    const { L, M, P } = await load();
    await L.addEvents(DAY);
    P.setPrefs({ paused: true });
    expect(await M.learn()).toBe(0);
    expect(await M.learn({ days: ['2026-10-15'] })).toBe(1);
  });

  it('stops when the AI is out of credit, and skips a day it could not read until it changes', async () => {
    const { L, M } = await load();
    await L.addEvents(DAY);
    ai.ask = vi.fn(async () => {
      throw Object.assign(new Error('The private AI is out of credit right now.'), { code: 'billing' });
    });
    expect(await M.learn()).toBe(0);
    expect(ai.ask).toHaveBeenCalledTimes(1);
    expect(M.learning.error).toBe('The private AI is out of credit right now.');

    ai.ask = vi.fn(async () => {
      throw Object.assign(new Error('unreadable'), { code: 'format' });
    });
    await M.learn();
    const tried = ai.ask.mock.calls.length;
    expect(tried).toBe(3);
    await M.learn();
    expect(ai.ask.mock.calls.length).toBe(tried); // the same days aren't tried again
  });

  it('sums up a finished week from its days', async () => {
    const { L, M } = await load();
    const week = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'];
    await L.addEvents(week.map((k, i) => ({ id: `manual:w${i}`, source: 'manual', kind: 'note', at: T(k, 9), title: `Note ${i}`, tier: 2 })));
    ai.ask = vi.fn(async (o: { instructions: string }) => (o.instructions.includes('daily summaries') ? { json: { summary: 'A calm week of notes.' } } : daily('A day of notes.')));
    expect(await M.learn({ budget: 10 })).toBe(8);
    expect(M.summaryFor('week', '2026-10-05')).toMatchObject({ text: 'A calm week of notes.', tier: 2, n: 7 });
    expect(M.summaryFor('week', '2026-10-12')).toBeNull(); // not over yet
  });
});

describe('learning while things change', () => {
  it('sends nothing more once the Player turns the less private switch off, or switches AI, while it learns', async () => {
    const { L, M, P } = await load();
    await L.addEvents(DAY);
    ai.engine = 'free';
    P.setPrefs({ lessPrivate: true });
    ai.ask = vi.fn(async () => {
      P.setPrefs({ lessPrivate: false }); // in What Arise knows, while the first answer comes
      return daily('A day.');
    });
    await M.learn();
    expect(ai.ask).toHaveBeenCalledTimes(1);
    expect(M.learning.error).toBe('');

    const s = await load();
    await s.L.addEvents(DAY);
    ai.engine = 'private';
    const engines: (string | null)[] = [];
    ai.ask = vi.fn(async (o: Ask) => {
      engines.push((o as Ask & { engine?: string }).engine ?? null);
      ai.engine = 'own'; // Settings, your own AI service
      return daily('A day.');
    });
    await s.M.learn();
    expect(engines).toEqual(['private']);
  });

  it('writes nothing from an answer that comes after the log was emptied, and stops', async () => {
    const { L, M } = await load();
    M.initMemory({ delay: -1 });
    await L.addEvents(DAY);
    let answer!: () => void;
    ai.ask = vi.fn(() => new Promise((ok) => (answer = () => ok(daily('Old person summary.', [{ op: 'add', id: '', text: 'You are the old person.' }])))));
    const running = M.learn();
    await vi.waitFor(() => expect(ai.ask).toHaveBeenCalledTimes(1));
    await L.eraseAll(); // Erase all data, Delete everything, or another account's data taking over
    answer();
    expect(await running).toBe(0);
    expect(ai.ask).toHaveBeenCalledTimes(1);
    expect(M.allFacts()).toEqual([]);
    expect(M.daySummaries()).toEqual([]);
    vi.resetModules();
    const fresh = await import('./memory');
    await fresh.load();
    expect(fresh.allFacts()).toEqual([]);
    expect(fresh.daySummaries()).toEqual([]);
  });

  it('does the same when another tab or window empties the log', async () => {
    const { L, M } = await load();
    M.initMemory({ delay: -1 });
    await L.addEvents(DAY);
    let answer!: () => void;
    ai.ask = vi.fn(() => new Promise((ok) => (answer = () => ok(daily('Old person summary.', [{ op: 'add', id: '', text: 'You are the old person.' }])))));
    const running = M.learn();
    await vi.waitFor(() => expect(ai.ask).toHaveBeenCalledTimes(1));
    vi.resetModules();
    const other = await import('./log'); // the other tab: its own copy of the app, the same database
    await other.eraseAll();
    window.dispatchEvent(new StorageEvent('storage', { key: 'arise-life-ping', newValue: localStorage.getItem('arise-life-ping') }));
    answer();
    expect(await running).toBe(0);
    expect(M.allFacts()).toEqual([]);
    expect(M.daySummaries()).toEqual([]);
    expect(await other.exportAll()).toMatchObject({ summaries: [], facts: [] });
  });

  it('stops before the weeks and months when the Player stops learning', async () => {
    const { L, M, P } = await load();
    const week = ['2026-10-05', '2026-10-06'];
    await L.addEvents(week.map((k, i) => ({ id: `manual:w${i}`, source: 'manual', kind: 'note', at: T(k, 9), title: `Note ${i}`, tier: 2 })));
    ai.ask = vi.fn(async () => {
      P.setPrefs({ paused: true }); // Stop learning, while the first day is summed up
      return daily('A day of notes.');
    });
    expect(await M.learn({ budget: 10 })).toBe(1);
    expect(ai.ask).toHaveBeenCalledTimes(1);
    expect(M.summaryFor('week', '2026-10-05')).toBeNull();
  });

  it('counts every request against the budget, whatever comes of it', async () => {
    const { L, M } = await load();
    M.initMemory({ delay: -1 });
    await L.addEvents(Array.from({ length: 60 }, (_, i) => ({ id: `arise:quest:${i}`, source: 'arise', kind: 'quest', at: new Date(2026, 9, 16 - i, 8).getTime(), title: 'Done: Study Spanish', tier: 1 })));
    ai.engine = 'own';
    ai.ask = vi.fn(async () => {
      throw Object.assign(new Error('unreadable'), { code: 'format' });
    });
    await M.learn();
    expect(ai.ask).toHaveBeenCalledTimes(M.BUDGET.own);
  });

  it('sends only as much of what it knows as suits the AI', async () => {
    const { L, M } = await load();
    for (let i = 0; i < 60; i++) await M.addFact(`You like thing number ${i}, ${'and you like it very much '.repeat(8)}`);
    await L.addEvents([DAY[0]]);
    ai.engine = 'device';
    await M.learn();
    const known = (ai.ask.mock.calls[0][0] as Ask).prompt.split('\n\nThe day:')[0];
    expect(known.length).toBeLessThanOrEqual(900);
    expect(known).toContain('F1: You like thing number');
  });

  it("keeps what another tab or window changed, and reads it again when told", async () => {
    const { L, M } = await load();
    M.initMemory({ delay: -1 });
    await L.addEvents(DAY);
    ai.ask = vi.fn(async () => daily('A day.', [{ op: 'add', id: '', text: 'You run on Mondays.' }, { op: 'add', id: '', text: 'You smoke.' }]));
    await M.learn({ days: ['2026-10-15'] });
    const [run, smoke] = M.allFacts();
    // The other tab: its own copy of the memory, the same database.
    vi.resetModules();
    const other = await import('./memory');
    await other.editFact(run.id, 'You run on Mondays, early.');
    await other.deleteFact(smoke.id);
    // This tab hasn't heard yet, and learns from a later day: the AI changes and confirms the facts it was shown.
    ai.ask = vi.fn(async () => daily('Another day.', [{ op: 'update', id: 'F1', text: 'You run on Mondays at dawn.' }, { op: 'update', id: 'F2', text: 'You smoke.' }]));
    await M.learn({ days: ['2026-10-16'] });
    const stored = async () => {
      vi.resetModules();
      const m = await import('./memory');
      await m.load();
      return m.allFacts().map((f) => `${f.from}: ${f.text}`);
    };
    expect(await stored()).toEqual(['you: You run on Mondays, early.']);
    expect(M.allFacts().map((f) => `${f.from}: ${f.text}`)).toEqual(['you: You run on Mondays, early.']);

    await other.addFact('I live in Leeds.');
    expect(M.allFacts()).toHaveLength(1);
    window.dispatchEvent(new StorageEvent('storage', { key: 'arise-life-ping', newValue: localStorage.getItem('arise-life-ping') }));
    await vi.waitFor(() => expect(M.allFacts().map((f) => f.text)).toContain('I live in Leeds.'));
  });

  it('lets one tab or window learn at a time', async () => {
    const { L, M } = await load();
    await L.addEvents(DAY);
    const request = vi.fn(async (_name: string, _o: object, cb: (lock: object | null) => Promise<number>) => cb(null)); // another tab has it
    Object.defineProperty(navigator, 'locks', { value: { request }, configurable: true });
    try {
      expect(await M.learn()).toBe(0);
      expect(ai.ask).not.toHaveBeenCalled();
      expect(await M.learn({ days: ['2026-10-15'] })).toBe(0);
      expect(M.learning.error).toContain('another tab or window');
      request.mockImplementation(async (_name, _o, cb) => cb({ name: 'arise-life-learn' }));
      expect(await M.learn()).toBe(3);
    } finally {
      delete (navigator as { locks?: unknown }).locks;
    }
  });

  it("keeps a week a less private AI can't redo waiting for the private one", async () => {
    const { L, M, P } = await load();
    M.initMemory({ delay: -1 });
    const days = ['2026-09-21', '2026-09-22', '2026-09-23'];
    await L.addEvents(days.map((k, i) => ({ id: `manual:s${i}`, source: 'manual', kind: 'note', at: T(k, 9), title: `Note ${i}`, tier: 2 })));
    ai.ask = vi.fn(async (o: { instructions: string }) => (o.instructions.includes('daily summaries') ? { json: { summary: 'A quiet week.' } } : daily('A day of notes.')));
    expect(await M.learn({ budget: 3 })).toBe(3); // the days; no budget left for their week
    expect(M.summaryFor('week', '2026-09-21')).toBeNull();
    ai.engine = 'free'; // it may not read those days' summaries
    expect(P.cap()).toBe(1);
    await M.learn();
    ai.engine = 'private';
    await M.learn();
    expect(M.summaryFor('week', '2026-09-21')).toMatchObject({ text: 'A quiet week.', cap: 3 });
  });
});

describe('recall: what the log holds for a question', () => {
  async function ready() {
    const s = await load();
    await s.L.addEvents(DAY);
    ai.ask = vi.fn(async (o: { prompt: string }) => daily(o.prompt.includes('knee pain') ? 'You studied, listened to music and looked up knee pain.' : 'You worked out.'));
    await s.M.learn();
    return s;
  }

  it('finds the day and its events for a date', async () => {
    const { M } = await ready();
    const notes = await M.recall('What did I do yesterday?', 'private');
    expect(notes).toContain('Looked for: anything, yesterday (Fri 16 Oct).');
    expect(notes).toContain('You studied, listened to music and looked up knee pain.');
    expect(notes).toContain('Google: Searched "knee pain after running"');
    expect(notes).toContain('Fri, 16 Oct 2026 10:00, Google');
    expect(notes).not.toContain('hidden');
  });

  it('gives a less private AI only tier 1, and says some is hidden', async () => {
    const { M } = await ready();
    const notes = await M.recall('What did I do yesterday?', 'free');
    expect(notes).toContain('Done: Study Spanish');
    expect(notes).not.toMatch(/knee pain|Daft Punk/);
    expect(notes).toContain("Some of the log is hidden from this AI by the Player's privacy settings");
  });

  it('finds events by their words, whenever they were', async () => {
    const { M } = await ready();
    const notes = await M.recall('When did I last search for knee pain?', 'private');
    expect(notes).toContain('Looked for: "search knee pain".');
    expect(notes).toContain('Searched "knee pain after running"');
  });

  it("gives everything from a short time when the question's words aren't in the log, and leaves the date's words out", async () => {
    const { L, M } = await ready();
    await L.addEvents([
      { id: 'manual:m1', source: 'manual', kind: 'mood', at: T('2026-10-17', 8), title: 'Mood: Good', tier: 2 },
      { id: 'manual:n3', source: 'manual', kind: 'note', at: T('2026-10-03', 13), title: 'Lunch with Sam in the park', tier: 2 },
    ]);
    const morning = await M.recall('How did I feel this morning?', 'private');
    expect(morning).toContain('Mood: Good');
    expect(morning).not.toContain('Nothing in the life log matches this.');
    const day = await M.recall('What did I do on Oct. 3?', 'private');
    expect(day).toContain('Looked for: anything, that day (Sat 3 Oct).');
    expect(day).toContain('Lunch with Sam in the park');
    // Words that are there still pick out their events.
    expect(await M.recall('Did I see Sam on Oct. 3?', 'private')).toContain('Looked for: "see sam", that day (Sat 3 Oct).');
  });

  it('says when nothing matches, keeps to the small budget of the AI on the device, and needs an AI', async () => {
    const { L, M } = await ready();
    expect(await M.recall('What is my favourite pizza?', 'private')).toContain('Nothing in the life log matches this.');
    await L.addEvents(Array.from({ length: 50 }, (_, i) => ({ id: `spotify:x${i}`, source: 'spotify' as const, kind: 'listen' as const, at: T('2026-10-16', 11, i), title: `Listened to a long song title number ${i}`, tier: 2 as const })));
    expect((await M.recall('What did I listen to yesterday?', 'device')).length).toBeLessThanOrEqual(900);
    expect(await M.recall('What did I do yesterday?', null)).toBe('');
  });

  it('builds the profile for each AI from what it may read', async () => {
    const { M } = await load();
    expect(M.profileText('private')).toBe('');
    await M.addFact('I have asthma.'); // yours: tier 2
    expect(M.profileText('private')).toContain('- I have asthma.');
    expect(M.profileText('free')).toBe('');
  });
});

describe('forgetting', () => {
  it("drops the summaries of deleted days and the AI's facts that came only from them", async () => {
    const { L, M } = await load();
    M.initMemory({ delay: -1 });
    await L.addEvents(DAY);
    ai.ask = vi.fn(async (o: { prompt: string }) =>
      o.prompt.includes('Study Spanish') ? daily('Spanish.', [{ op: 'add', id: '', text: 'You learn Spanish.' }, { op: 'add', id: '', text: 'You train often.' }]) : daily('Training.', [{ op: 'add', id: '', text: 'You train often.' }]),
    );
    await M.learn();
    await M.addFact('I live in Leeds.');
    const { days } = await L.deleteWhereDays({ from: T('2026-10-16', 0), to: T('2026-10-17', 0) });
    await M.forgetDays(days);
    expect(M.summaryFor('day', '2026-10-16')).toBeNull();
    expect(M.summaryFor('day', '2026-10-15')).not.toBeNull();
    expect(M.allFacts().map((f) => f.text).sort()).toEqual(['I live in Leeds.', 'You train often.']);
    expect(M.allFacts().find((f) => f.text === 'You train often.')?.sources).toEqual(['2026-10-14', '2026-10-15']);
  });

  it('forgets what it learned from something you delete from your log', async () => {
    const { L, M } = await load();
    M.initMemory({ delay: -1 });
    await L.addEvents([...DAY, { id: 'manual:panic', source: 'manual', kind: 'note', at: T('2026-10-16', 15), title: 'Panic attack at work', tier: 2 }]);
    ai.ask = vi.fn(async (o: { prompt: string }) => (o.prompt.includes('Panic') ? daily('You had a panic attack at work.', [{ op: 'add', id: '', text: 'You get panic attacks at work.' }]) : daily('A day.')));
    await M.learn();
    expect(M.summaryFor('day', '2026-10-16')?.text).toContain('panic');
    await L.removeIds(['manual:panic']); // "Delete from your log"
    await vi.waitFor(() => expect(M.summaryFor('day', '2026-10-16')).toBeNull());
    expect(M.allFacts().map((f) => f.text)).not.toContain('You get panic attacks at work.');
    expect(await M.recall('What happened yesterday?', 'private')).not.toMatch(/panic/i);
    await M.learn(); // learned again from what's left
    expect(M.summaryFor('day', '2026-10-16')?.text).toBe('A day.');
  });

  it('forgets the summary of a day whose log was emptied while it was not listening', async () => {
    const { L, M } = await load(); // no initMemory: as when another tab deleted it
    await L.addEvents(DAY);
    await M.learn();
    expect(M.summaryFor('day', '2026-10-15')).not.toBeNull();
    await L.removeIds(['arise:workout:w1']);
    await M.learn();
    expect(M.summaryFor('day', '2026-10-15')).toBeNull();
  });

  it('forgets everything when the log is erased', async () => {
    const { L, M } = await load();
    M.initMemory({ delay: -1 });
    await L.addEvents(DAY);
    await M.learn();
    await M.addFact('I live in Leeds.');
    await L.eraseAll();
    expect(M.allFacts()).toEqual([]);
    expect(M.summaryFor('day', '2026-10-16')).toBeNull();
  });
});

describe('yesterday on Today', () => {
  it('shows its summary, or what the log holds, or nothing', async () => {
    const { L, M } = await load();
    expect(await M.recap()).toBeNull();
    await L.addEvents(DAY);
    expect(await M.recap()).toEqual({ day: '2026-10-16', from: 'log', text: 'In your log: 1 quest done, 1 song or show played and 1 search.' });
    ai.ask = vi.fn(async () => daily('You studied Spanish and went for a run.'));
    await M.learn();
    expect(await M.recap()).toEqual({ day: '2026-10-16', from: 'summary', text: 'You studied Spanish and went for a run.' });
  });
});
