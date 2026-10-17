// @vitest-environment jsdom
// What the memory writes and who writes it: only strong models (with a weak one, learning waits),
// each summary, fact and journal saying which AI wrote it, weeks never made from days a weak model
// wrote, and what weak models wrote before written again. And the journal: the AI's version of a
// recent day, only when that AI may read all of it, in the Player's voice, never over their edit.

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { LifeEvent } from './types';

type Ask = { instructions: string; prompt: string; engine?: string };
const BY: Record<string, string> = { private: 'private:gpt-oss-120b', free: 'free:@cf/openai/gpt-oss-120b', own: 'own:google:gemini-2.5-pro' };
const ai = vi.hoisted(() => ({ engine: 'private' as string | null, ask: null as unknown as Mock<(o: { instructions: string; prompt: string }) => Promise<unknown>>, strength: 'strong', by: '', trusted: [] as string[] }));
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
  const { fingerprint } = M;
  return { L, M, P, fingerprint };
}

const T = (k: string, h = 12, m = 0) => {
  const [y, mo, d] = k.split('-').map(Number);
  return new Date(y, mo - 1, d, h, m).getTime();
};
const DAY: LifeEvent[] = [
  { id: 'arise:quest:2026-10-16:q1', source: 'arise', kind: 'quest', at: T('2026-10-16', 8), title: 'Done: Study Spanish', tier: 1 },
  { id: 'spotify:a1', source: 'spotify', kind: 'listen', at: T('2026-10-16', 9), title: 'Listened to Daft Punk: One More Time', tier: 2 },
  { id: 'google:s1', source: 'google', kind: 'search', at: T('2026-10-16', 13, 20), title: 'Searched "flights to Rome"', tier: 3 },
  { id: 'arise:workout:w1', source: 'arise', kind: 'workout', at: T('2026-10-15', 18), title: 'Workout: Push', tier: 1 },
];
const daily = (summary: string, facts: object[] = []) => ({ json: { summary, facts } });
const journal = (intro: string, parts = [{ part: 'morning', text: 'At 08:00 I studied Spanish.' }]) => ({ json: { intro, parts } });
const isJournal = (o: { instructions: string }) => o.instructions.includes('journal entry');
const isWeek = (o: { instructions: string }) => o.instructions.includes('daily summaries of the week');
const isRollup = (o: { instructions: string }) => o.instructions.includes('daily summaries');
// Answers like the AI would: a day, its journal, or a week.
const answers = ({ day = 'A day.', diary = 'I had a good day.', week = 'A week.' } = {}) =>
  vi.fn(async (o: { instructions: string }) => (isJournal(o) ? journal(diary) : isRollup(o) ? { json: { summary: week } } : daily(day)));
const dayOf = (o: Ask) => /^The day: \w+,? (\d+ \w+ \d{4})\./.exec(o.prompt)?.[1];
const calls = () => ai.ask.mock.calls.map(([o]) => o as Ask);

// The life log's database, written straight away (as an older version, or another device, left it).
async function putRows(store: 'summaries' | 'facts', rows: object[]) {
  const db = await (await import('./db')).open();
  const tx = db.transaction(store, 'readwrite');
  for (const r of rows) tx.objectStore(store).put(r);
  await new Promise((r) => (tx.oncomplete = r));
}
const sigOf = (fingerprint: (p: string[]) => string, list: LifeEvent[]) => fingerprint(list.map((e) => `${e.id}|${e.at}|${e.title}|${(e.detail || '').length}|${e.tier}`));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 17, 10)); // Saturday 17 October 2026
  localStorage.clear();
  ai.engine = 'private';
  ai.ask = answers();
  ai.strength = 'strong';
  ai.by = '';
  ai.trusted = [];
});
afterEach(() => vi.useRealTimers());

describe('only strong models write the memory', () => {
  it('records which AI wrote each summary, fact and journal', async () => {
    const { L, M } = await load();
    await L.addEvents(DAY);
    ai.ask = vi.fn(async (o: { instructions: string }) => (isJournal(o) ? journal('I studied.') : daily('You studied.', [{ op: 'add', id: '', text: 'You study Spanish.' }])));
    await M.learn();
    expect(M.summaryFor('day', '2026-10-16')?.by).toBe('private:gpt-oss-120b');
    expect(M.journalFor('2026-10-16')?.by).toBe('private:gpt-oss-120b');
    expect(M.allFacts()[0]).toMatchObject({ text: 'You study Spanish.', by: 'private:gpt-oss-120b' });
    // Kept on the device.
    vi.resetModules();
    const again = await import('./memory');
    await again.load();
    expect(again.summaryFor('day', '2026-10-16')?.by).toBe('private:gpt-oss-120b');
    expect(again.allFacts()[0].by).toBe('private:gpt-oss-120b');
  });

  it('waits with a weak AI: nothing is sent and nothing is written', async () => {
    const { L, M } = await load();
    await L.addEvents(DAY);
    ai.engine = 'device';
    ai.strength = 'weak';
    expect(await M.learn()).toBe(0);
    expect(ai.ask).not.toHaveBeenCalled();
    expect(M.learning).toMatchObject({ waits: true, error: '' });
    expect(M.daySummaries()).toEqual([]);
    // Even when the Player asks for a day, or a journal.
    expect(await M.learn({ days: ['2026-10-16'] })).toBe(0);
    expect(await M.learn({ journal: '2026-10-16' })).toBe(0);
    expect(ai.ask).not.toHaveBeenCalled();
    // A strong one: learning goes on.
    ai.engine = 'private';
    ai.strength = 'strong';
    expect(await M.learn()).toBeGreaterThan(0);
    expect(M.learning.waits).toBe(false);
  });

  it('stops when the AI in use turns weak while it learns', async () => {
    const { L, M } = await load();
    await L.addEvents(DAY);
    ai.ask = vi.fn(async () => {
      ai.strength = 'weak'; // Settings: a smaller model picked, while the first answer comes
      return daily('A day.');
    });
    await M.learn();
    expect(ai.ask).toHaveBeenCalledTimes(1);
    expect(M.learning).toMatchObject({ waits: true, error: '' });
  });

  it('keeps nothing a weak model wrote, and waits', async () => {
    const { L, M } = await load();
    await L.addEvents(DAY);
    ai.by = 'free:@cf/openai/gpt-oss-20b';
    await M.learn();
    expect(ai.ask).toHaveBeenCalledTimes(1);
    expect(M.daySummaries()).toEqual([]);
    expect(M.learning.waits).toBe(true);
  });

  it('takes a model you trust for your key as strong, and only then', async () => {
    const { L, M } = await load();
    await L.addEvents(DAY);
    ai.engine = 'own';
    ai.by = 'own:mistral:mistral-medium-latest';
    await M.learn();
    expect(M.daySummaries()).toEqual([]);
    ai.trusted = ['mistral:mistral-medium-latest'];
    expect(await M.learn()).toBeGreaterThan(0);
    expect(M.summaryFor('day', '2026-10-15')?.by).toBe('own:mistral:mistral-medium-latest');
  });
});

describe('what weak models wrote before', () => {
  const week = ['2026-09-21', '2026-09-22', '2026-09-23'];
  const notes: LifeEvent[] = week.map((k, i) => ({ id: `manual:w${i}`, source: 'manual', kind: 'note', at: T(k, 9), title: `Note ${i}`, tier: 2 }));

  it("never makes a week from a day a weak model wrote: that day is written again first", async () => {
    const { L, M, fingerprint } = await load();
    await L.addEvents(notes);
    // Summaries of those days from before, by the AI on the device (or with no record of who wrote them).
    await putRows(
      'summaries',
      week.map((k, i) => ({ id: `d:${k}`, kind: 'day', key: k, text: `Weak words ${i}.`, tier: 2, cap: 3, sig: sigOf(fingerprint, [notes[i]]), n: 1, at: 1, ...(i ? { by: 'device:gemini-nano' } : {}) })),
    );
    // The strong AI can't read one of them this time.
    ai.ask = vi.fn(async (o: { instructions: string; prompt: string }) => {
      if (isRollup(o)) return { json: { summary: 'A week of notes.' } };
      if (o.prompt.includes('Note 2')) throw Object.assign(new Error('unreadable'), { code: 'format' });
      return daily('Strong words.');
    });
    await M.learn({ budget: 10 });
    expect(M.summaryFor('day', '2026-09-21')).toMatchObject({ text: 'Strong words.', by: 'private:gpt-oss-120b' });
    expect(M.summaryFor('day', '2026-09-23')?.text).toBe('Weak words 2.');
    expect(calls().filter(isRollup)).toEqual([]); // the week (and the month) wait
    expect(M.summaryFor('week', '2026-09-21')).toBeNull();

    // Once that day changes, it's written again, and then the week from strong days only.
    await L.addEvents([{ id: 'manual:w9', source: 'manual', kind: 'note', at: T('2026-09-23', 20), title: 'Note 9', tier: 2 }]);
    ai.ask = answers({ day: 'Strong words again.', week: 'A week of notes.' });
    await M.learn({ budget: 10 });
    const asked = calls().filter(isWeek);
    expect(asked).toHaveLength(1);
    expect(asked[0].prompt).not.toContain('Weak words');
    expect(M.summaryFor('week', '2026-09-21')).toMatchObject({ text: 'A week of notes.', by: 'private:gpt-oss-120b' });
  });

  it("writes a weak model's summaries again, and keeps its facts only when a strong one vouches for them", async () => {
    const { L, M, fingerprint } = await load();
    await L.addEvents(DAY);
    const d15 = DAY.filter((e) => e.at < T('2026-10-16', 0));
    await putRows('summaries', [{ id: 'd:2026-10-15', kind: 'day', key: '2026-10-15', text: 'Weak day.', tier: 1, cap: 3, sig: sigOf(fingerprint, d15), n: 1, at: 1, by: 'device:gemini-nano' }]);
    await putRows('facts', [
      { id: 'fweak1', text: 'You train on Thursdays.', since: '2026-10-15', from: 'ai', tier: 1, sources: ['2026-10-15'], at: 1, by: 'device:gemini-nano' },
      { id: 'fweak2', text: 'You hate mornings.', since: '2026-10-15', from: 'ai', tier: 1, sources: ['2026-10-15'], at: 1, by: 'device:gemini-nano' },
      { id: 'fweak3', text: 'You like push days.', since: '2026-10-15', from: 'ai', pinned: true, tier: 1, sources: ['2026-10-15'], at: 1 },
    ]);
    ai.ask = vi.fn(async (o: { instructions: string; prompt: string }) => {
      if (isJournal(o)) return journal('I trained.');
      if (!o.prompt.includes('Workout: Push')) return daily('A day.');
      // The strong model confirms one and says nothing of the other.
      const id = /F(\d+): You train on Thursdays\. \(check\)/.exec(o.prompt)?.[1];
      return daily('You did a push workout.', [{ op: 'update', id: `F${id}`, text: 'You train on Thursdays.' }]);
    });
    await M.learn();
    const day15 = calls().find((o) => o.prompt.includes('Workout: Push') && !isJournal(o))!;
    expect(day15.instructions).toContain('Facts marked (check) were written by a less careful AI.');
    expect(day15.prompt).toContain('You hate mornings. (check)');
    expect(day15.prompt).not.toContain('You like push days. (check)'); // pinned by the Player: theirs to keep
    expect(M.summaryFor('day', '2026-10-15')).toMatchObject({ text: 'You did a push workout.', by: 'private:gpt-oss-120b' });
    const texts = M.allFacts().map((f) => `${f.text} ${f.by || 'unrecorded'}`);
    expect(texts.sort()).toEqual(['You like push days. unrecorded', 'You train on Thursdays. private:gpt-oss-120b']);
  });

  it("never drops a fact the strong model wasn't shown, or one from before Arise recorded who wrote it", async () => {
    const { L, M, fingerprint } = await load();
    await L.addEvents(DAY);
    const d15 = DAY.filter((e) => e.at < T('2026-10-16', 0));
    await putRows('summaries', [{ id: 'd:2026-10-15', kind: 'day', key: '2026-10-15', text: 'Old day.', tier: 1, cap: 3, sig: sigOf(fingerprint, d15), n: 1, at: 1 }]);
    // One fact from before Arise recorded who wrote it, and more from a weak model than fit in
    // what's shown with a day.
    const weak = Array.from({ length: 250 }, (_, i) => ({ id: `fweak${String(i).padStart(3, '0')}`, text: `You like thing ${i}, which a small model saw in your day.`, since: '2026-10-15', from: 'ai', tier: 1, sources: ['2026-10-15'], at: 1, by: 'device:gemini-nano' }));
    await putRows('facts', [{ id: 'fearly', text: 'You hate mornings.', since: '2026-10-15', from: 'ai', tier: 1, sources: ['2026-10-15'], at: 1 }, ...weak]);
    // The strong model vouches for twelve of those it's shown, more than the 5 changes a day.
    ai.ask = vi.fn(async (o: { instructions: string; prompt: string }) => {
      if (isJournal(o)) return journal('I trained.');
      if (!o.prompt.includes('Workout: Push')) return daily('A day.');
      const ids = [...o.prompt.matchAll(/(F\d+): You like thing \d+, which a small model saw in your day\. \(check\)/g)].map((m) => m[1]);
      return { json: { summary: 'You did a push workout.', facts: [], confirm: ids.slice(0, 12) } };
    });
    await M.learn();
    const day15 = calls().find((o) => o.prompt.includes('Workout: Push') && !isJournal(o))!;
    expect(day15.prompt).toContain('You hate mornings. (check)');
    const shown = new Set([...day15.prompt.matchAll(/You like thing (\d+),/g)].map((m) => `fweak${m[1].padStart(3, '0')}`));
    expect(shown.size).toBeGreaterThan(12);
    expect(shown.size).toBeLessThan(250);
    const after = new Map(M.allFacts().map((f) => [f.id, f]));
    // From before: kept as it was, to be checked again, never dropped for it.
    expect(after.get('fearly')).toMatchObject({ sources: ['2026-10-15'] });
    expect(after.get('fearly')!.by).toBeUndefined();
    // Vouched for: all twelve. Shown and not vouched for: gone. Not shown: kept as they were.
    const vouched = weak.filter((f) => after.get(f.id)?.by === 'private:gpt-oss-120b').map((f) => f.id);
    expect(vouched).toHaveLength(12);
    for (const f of weak) {
      if (vouched.includes(f.id)) continue;
      if (shown.has(f.id)) expect(after.has(f.id)).toBe(false);
      else expect(after.get(f.id)).toMatchObject({ by: 'device:gemini-nano', sources: ['2026-10-15'] });
    }
    // The day isn't read again for the facts it had no room for.
    ai.ask.mockClear();
    await M.learn();
    expect(calls().filter((o) => o.prompt.includes('Workout: Push') && !isJournal(o))).toEqual([]);
  });

  it('never deletes a fact the Player pinned in another tab while the AI read the day', async () => {
    const { L, M, fingerprint } = await load();
    await L.addEvents(DAY);
    const d15 = DAY.filter((e) => e.at < T('2026-10-16', 0));
    await putRows('summaries', [{ id: 'd:2026-10-15', kind: 'day', key: '2026-10-15', text: 'Weak day.', tier: 1, cap: 3, sig: sigOf(fingerprint, d15), n: 1, at: 1, by: 'device:gemini-nano' }]);
    const fact = { id: 'fweak1', text: 'You hate mornings.', since: '2026-10-15', from: 'ai', tier: 1, sources: ['2026-10-15'], at: 1, by: 'device:gemini-nano' };
    await putRows('facts', [fact]);
    ai.ask = vi.fn(async (o: { instructions: string; prompt: string }) => {
      if (isJournal(o)) return journal('I trained.');
      if (!o.prompt.includes('Workout: Push')) return daily('A day.');
      await putRows('facts', [{ ...fact, pinned: true, at: 2 }]); // another tab, meanwhile
      return daily('You did a push workout.'); // and this one doesn't vouch for it
    });
    await M.learn();
    expect(M.summaryFor('day', '2026-10-15')?.text).toBe('You did a push workout.');
    expect(M.allFacts()).toEqual([expect.objectContaining({ id: 'fweak1', pinned: true })]);
    const db = await (await import('./db')).open();
    const stored = await new Promise((r) => {
      const g = db.transaction('facts').objectStore('facts').get('fweak1');
      g.onsuccess = () => r(g.result);
    });
    expect(stored).toMatchObject({ id: 'fweak1', pinned: true });
  });

  it("writes a weak model's journal of an older day again", async () => {
    const { L, M } = await load();
    const old = { id: 'manual:old', source: 'manual' as const, kind: 'note' as const, at: T('2026-10-01', 9), title: 'Long walk', tier: 2 as const };
    await L.addEvents([old]);
    await putRows('summaries', [{ id: 'j:2026-10-01', kind: 'journal', key: '2026-10-01', text: 'I walked, says the weak one.', tier: 2, cap: 3, sig: 'x', n: 1, at: 1, by: 'free:@cf/openai/gpt-oss-20b', voice: 'first' }]);
    ai.ask = answers({ diary: 'I went for a long walk.' });
    await M.learn({ budget: 10 });
    expect(M.journalFor('2026-10-01')).toMatchObject({ text: 'I went for a long walk.\n\nMorning\nAt 08:00 I studied Spanish.', by: 'private:gpt-oss-120b' });
  });
});

describe('the journal the AI writes', () => {
  it('writes a recent day alongside its summary, in the first person, from the notes and your own words', async () => {
    const { L, M } = await load();
    await L.addEvents(DAY);
    M.useJournal({ own: (k) => (k === '2026-10-16' ? { text: 'Felt great after the run.', energy: 5 } : null) });
    await M.learn();
    const asked = calls().filter(isJournal);
    expect(asked.map(dayOf)).toEqual(['16 October 2026', '15 October 2026']);
    expect(asked[0].instructions).toContain('in the first person');
    expect(asked[0].prompt).toContain('13:20 Searched flights to Rome');
    expect(asked[0].prompt).toContain("The Player's own words about the day (their energy: 5 out of 5):\nFelt great after the run.");
    const j = M.journalFor('2026-10-16')!;
    expect(j).toMatchObject({ kind: 'journal', voice: 'first', tier: 3, cap: 3, by: 'private:gpt-oss-120b' });
    const view = await M.journalView('2026-10-16');
    expect(view.source).toBe('ai');
    expect(view.doc).toEqual({ intro: 'I had a good day.', parts: [{ part: 'morning', lines: ['At 08:00 I studied Spanish.'] }] });
    expect(view.built.parts.map((p) => p.part)).toEqual(['morning', 'afternoon']);
    // Up to date: nothing asked again.
    ai.ask.mockClear();
    await M.learn();
    expect(ai.ask).not.toHaveBeenCalled();
  });

  it('only when the AI in use may read the whole day', async () => {
    const { L, M } = await load();
    await L.addEvents(DAY);
    ai.engine = 'free'; // tier 1 only: the 16th has music and a search in it
    await M.learn();
    expect(calls().filter(isJournal).map(dayOf)).toEqual(['15 October 2026']);
    for (const o of calls()) expect(`${o.instructions}${o.prompt}`).not.toMatch(/Daft Punk|Rome/);
    expect(M.journalFor('2026-10-16')).toBeNull();
    expect(M.journalFor('2026-10-15')?.by).toBe('free:@cf/openai/gpt-oss-120b');
  });

  it('writes in the voice you pick, and again when you change it', async () => {
    const { L, M } = await load();
    await L.addEvents(DAY);
    let voice: 'first' | 'you' = 'you';
    M.useJournal({ voice: () => voice });
    await M.learn();
    expect(calls().filter(isJournal)[0].instructions).toContain('in the second person');
    expect(M.journalFor('2026-10-16')?.voice).toBe('you');
    voice = 'first';
    ai.ask.mockClear();
    await M.learn();
    expect(calls().filter(isJournal)).toHaveLength(2);
    expect(M.journalFor('2026-10-16')?.voice).toBe('first');
  });

  it("never writes over your edit, and writes it again only when you ask", async () => {
    const { L, M } = await load();
    M.initMemory({ delay: -1 });
    await L.addEvents(DAY);
    await M.learn();
    await M.saveJournalEdit('2026-10-16', 'My own words.\n\nmorning\nI ran before work.');
    expect(M.journalFor('2026-10-16')).toMatchObject({ edited: true, text: 'My own words.\n\nMorning\nI ran before work.' });
    expect(M.journalFor('2026-10-16')?.by).toBeUndefined();
    // The day changes: its summary is written again, its journal isn't.
    await L.addEvents([{ id: 'manual:n1', source: 'manual', kind: 'note', at: T('2026-10-16', 20), title: 'Dinner with Sam', tier: 2 }]);
    ai.ask.mockClear();
    await M.learn();
    expect(calls().filter((o) => !isJournal(o) && o.prompt.includes('Dinner with Sam'))).toHaveLength(1);
    expect(calls().filter((o) => isJournal(o) && o.prompt.includes('16 October'))).toEqual([]);
    expect((await M.journalView('2026-10-16')).source).toBe('edited');
    // "Write it again".
    ai.ask = answers({ diary: 'I ran, worked, and had dinner with Sam.' });
    expect(await M.rewriteJournal('2026-10-16')).toBe('ai');
    expect(M.journalFor('2026-10-16')).toMatchObject({ text: expect.stringContaining('dinner with Sam'), by: 'private:gpt-oss-120b' });
    expect(M.journalFor('2026-10-16')?.edited).toBeUndefined();
  });

  it('keeps an edit made while the AI writes, in this tab or another', async () => {
    for (const where of ['here', 'other tab'] as const) {
      const { L, M } = await load();
      await L.addEvents(DAY);
      let answer!: () => void;
      ai.ask = vi.fn((o: { instructions: string }) => (isJournal(o) ? new Promise((ok) => (answer = () => ok(journal('The AI wrote this.')))) : Promise.resolve(daily('A day.'))));
      const running = M.learn({ budget: 2 });
      await vi.waitFor(() => expect(calls().filter(isJournal)).toHaveLength(1));
      if (where === 'here') await M.saveJournalEdit('2026-10-16', 'I wrote this myself.');
      else {
        vi.resetModules();
        const other = await import('./memory'); // another tab: its own copy of the memory, the same database
        await other.saveJournalEdit('2026-10-16', 'I wrote this myself.');
      }
      answer();
      await running;
      vi.resetModules();
      const stored = await import('./memory');
      await stored.load();
      expect(stored.journalFor('2026-10-16'), where).toMatchObject({ text: 'I wrote this myself.', edited: true });
      if (where === 'here') expect(M.journalFor('2026-10-16')?.text).toBe('I wrote this myself.');
    }
  });

  it('writes nothing from a journal that comes back after the log was emptied', async () => {
    const { L, M } = await load();
    M.initMemory({ delay: -1 });
    await L.addEvents(DAY);
    let answer!: () => void;
    ai.ask = vi.fn((o: { instructions: string }) => (isJournal(o) ? new Promise((ok) => (answer = () => ok(journal('Old person journal.')))) : Promise.resolve(daily('A day.'))));
    const running = M.learn();
    await vi.waitFor(() => expect(calls().filter(isJournal)).toHaveLength(1));
    await L.eraseAll();
    answer();
    await running;
    expect(M.journalFor('2026-10-16')).toBeNull();
    expect((await L.exportAll()).summaries).toEqual([]);
  });

  it('stops writing journals when the Player stops learning', async () => {
    const { L, M, P } = await load();
    await L.addEvents(DAY);
    ai.ask = vi.fn(async () => {
      P.setPrefs({ paused: true });
      return daily('A day.');
    });
    await M.learn();
    expect(ai.ask).toHaveBeenCalledTimes(1);
    expect(M.journalFor('2026-10-16')).toBeNull();
  });

  it('goes back to the journal from the log when no AI may write it, and keeps your edit when its day is forgotten', async () => {
    const { L, M } = await load();
    M.initMemory({ delay: -1 });
    await L.addEvents(DAY);
    await M.saveJournalEdit('2026-10-15', 'Leg day, really.');
    await M.learn();
    expect(M.journalFor('2026-10-16')?.by).toBeTruthy();
    // Deleting from a day: the AI's journal of it goes, the Player's own edit stays.
    await L.removeIds(['spotify:a1']);
    await L.removeIds(['arise:workout:w1']);
    await vi.waitFor(() => expect(M.journalFor('2026-10-16')).toBeNull());
    expect(M.journalFor('2026-10-15')?.text).toBe('Leg day, really.');
    // No AI: "Write it again" brings back the one built from the log in place of your edit, and
    // keeps an AI's journal as it is.
    ai.engine = null;
    expect(await M.rewriteJournal('2026-10-15')).toBe('built');
    expect(M.journalFor('2026-10-15')).toBeNull();
    ai.engine = 'private';
    await M.learn({ journal: '2026-10-16' });
    expect(M.journalFor('2026-10-16')?.by).toBe('private:gpt-oss-120b');
    ai.engine = null;
    expect(await M.rewriteJournal('2026-10-16')).toBe('kept');
    expect(M.journalFor('2026-10-16')?.by).toBe('private:gpt-oss-120b');
    // An empty edit does the same.
    await M.saveJournalEdit('2026-10-16', 'Mine.');
    expect(await M.saveJournalEdit('2026-10-16', '  \n ')).toBeNull();
    expect(M.journalFor('2026-10-16')).toBeNull();
  });

  it("never writes today's: it fills in from the log as the day goes", async () => {
    const { L, M } = await load();
    await L.addEvents([{ id: 'manual:today', source: 'manual', kind: 'note', at: T('2026-10-17', 8, 15), title: 'Coffee in the garden', tier: 2 }]);
    await M.learn();
    expect(calls().filter(isJournal)).toEqual([]);
    const view = await M.journalView('2026-10-17');
    expect(view.source).toBe('built');
    expect(view.doc.parts).toEqual([{ part: 'morning', lines: ['08:15 Coffee in the garden'] }]);
    expect(view.doc.intro).toBe('So far today, I wrote 1 note.');
  });
});
