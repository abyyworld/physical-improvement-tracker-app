// @vitest-environment jsdom
// The one line about a day that the journal's notifications may show: from its journal (the AI's
// or the Player's), else its summary, else the journal built from the log; '' for an empty day.
// Handed to the reminders on the device.

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../ai.js', () => ({ engine: () => null, isPrivate: () => true, ready: () => false, useMemory: vi.fn(), memoryStrength: () => 'none', trustedModel: () => false, askMemory: vi.fn() }));

async function load() {
  vi.resetModules();
  globalThis.indexedDB = new IDBFactory();
  const L = await import('./log');
  const M = await import('./memory');
  const J = await import('./journal-notes');
  const R = await import('../reminders.js');
  const S = await import('../store');
  return { L, M, J, R, S };
}
const T = (k: string, h = 12, m = 0) => {
  const [y, mo, d] = k.split('-').map(Number);
  return new Date(y, mo - 1, d, h, m).getTime();
};
async function putSummary(row: object) {
  const db = await (await import('./db')).open();
  const tx = db.transaction('summaries', 'readwrite');
  tx.objectStore('summaries').put(row);
  await new Promise((r) => (tx.oncomplete = r));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 17, 10)); // Saturday 17 October 2026
  localStorage.clear();
});
afterEach(() => vi.useRealTimers());

describe('the line about a day', () => {
  it("comes from the day's journal, its summary, or the one built from the log", async () => {
    const { L, J } = await load();
    await L.addEvents([
      { id: 'manual:a', source: 'manual', kind: 'note', at: T('2026-10-16', 9), title: 'Long walk by the sea', tier: 2 },
      { id: 'steam:p1', source: 'steam', kind: 'play', at: T('2026-10-16', 21), title: 'Played Hades', value: 90, unit: 'min', tier: 2 },
    ]);
    expect(await J.lineAbout('2026-10-16')).toBe('I played Hades for 1 h 30 min and wrote 1 note.');
    // A summary of the day, written by the memory (read again, as when the app next opens).
    await putSummary({ id: 'd:2026-10-16', kind: 'day', key: '2026-10-16', text: 'You walked by the sea and played Hades. A calm day.', tier: 2, cap: 3, sig: 'x', n: 2, at: 1, by: 'private:gpt-oss-120b' });
    vi.resetModules();
    const again = await import('./journal-notes');
    expect(await again.lineAbout('2026-10-16')).toBe('You walked by the sea and played Hades.');
    // The day's journal wins.
    await (await import('./memory')).saveJournalEdit('2026-10-16', 'The sea was wild today. I loved it.\n\nMorning\nA long walk.');
    expect(await again.lineAbout('2026-10-16')).toBe('The sea was wild today.');
    expect(await again.lineAbout('2026-10-15')).toBe('');
  });

  it('hands yesterday and today to the reminders, said of the whole day', async () => {
    const { L, J, R, S } = await load();
    await L.addEvents([{ id: 'manual:b', source: 'manual', kind: 'note', at: T('2026-10-17', 8), title: 'Coffee', tier: 2 }]);
    await J.refreshLines();
    S.state.settings.notifyDetails = true;
    expect(R.checkinLine('2026-10-17')).toEqual({ title: 'How was today?', body: 'So far: I wrote 1 note. Add a note or your mood.' });
    expect(R.recapLine('2026-10-18')).toEqual({ title: 'Yesterday', body: 'I wrote 1 note.' });
    // Yesterday had nothing: it says so.
    expect(R.recapLine('2026-10-17')).toEqual({ title: 'Yesterday', body: 'Nothing in your journal for yesterday. Tap to add something.' });
    S.state.settings.notifyDetails = false;
    expect(R.recapLine('2026-10-18')).toEqual({ title: 'Yesterday', body: 'Your journal for yesterday is ready.' });
  });
});
