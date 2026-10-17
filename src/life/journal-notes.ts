// What the journal's notifications may say (src/reminders.js): one line about yesterday, for the
// morning "Yesterday", and one about today, for the evening check-in. From the day's journal (the
// AI's, or the Player's own version), else its summary, else the journal built from the log.
// Worked out on this device whenever the log, the memory or the day changes. They're only shown
// with "Show details in notifications" on, and nothing here leaves the device.

import * as R from '../reminders.js';
import * as L from './log';
import * as M from './memory';
import { addDays, dayEnd, dayKey } from './dates';
import { lineFor, parseText } from './diary';

// One line about day k, or '' when there's nothing in its journal.
export async function lineAbout(k: string): Promise<string> {
  await M.load();
  const stored = M.journalFor(k);
  if (stored) return lineFor(parseText(stored.text));
  const summary = M.summaryFor('day', k);
  if (summary) return lineFor({ intro: summary.text, parts: [] });
  // Said of the whole day, even while today is still going: tomorrow's "Yesterday" may use it.
  const built = await M.builtJournal(k, dayEnd(k));
  return built.empty ? '' : lineFor(built);
}

export async function refreshLines(now = Date.now()): Promise<void> {
  const today = dayKey(now);
  const yesterday = addDays(today, -1);
  const [y, t] = await Promise.all([lineAbout(yesterday), lineAbout(today)]);
  R.setJournalLines({ [yesterday]: y, [today]: t });
}

let timer: ReturnType<typeof setTimeout> | null = null;
let started = false;

export function initJournalNotes({ delay = 1500 }: { delay?: number } = {}) {
  if (started) return;
  started = true;
  const soon = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      refreshLines().catch(() => {});
    }, delay);
  };
  L.onChange(soon);
  M.onMemoryChange(soon);
  // A new day since the app was last looked at.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') soon();
  });
  soon();
}
