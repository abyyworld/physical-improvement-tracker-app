// "What Arise noticed", kept ready: the patterns in the Player's own days (lib/patterns.ts, from
// the rows in rows.ts), worked out on this device with no AI. They're worked out in idle time a
// little after the app opens and after the data changes, and kept until then; the You tab shows
// them, and the coach gets only the ones its AI may read (ai.js asks through useInsight), so a
// pattern made from messages or sleep never reaches an AI that may not read those.

import * as AI from '../ai.js';
import * as S from '../store';
import { findPatterns, WINDOW_DAYS, type DayRow, type Pattern } from '../lib/patterns';
import * as L from './log';
import { addDays } from './dates';
import { dayRows } from './rows';
import type { LifeTier } from './types';

export interface Insight {
  day: string; // the day it was worked out (today then)
  at: number;
  rows: DayRow[]; // the 6 weeks before that day, and that day
  patterns: Pattern[];
}

const HEAD = "## Patterns Arise found on this device (the Player's own days over the last 6 weeks; what goes together, not proof)";
const LEFT_OUT = "Some patterns use parts of the life log this AI may not read, so they're left out.";

let cache: Insight | null = null;
let running: Promise<Insight | null> | null = null;
let gen = 0; // goes up when the data goes, so a result still on its way isn't kept
let timer: ReturnType<typeof setTimeout> | undefined;
let started = false;

// What was worked out last, or null.
export const peek = () => cache;

function work(): Promise<Insight | null> {
  if (running) return running;
  const g = gen;
  const p: Promise<Insight | null> = (async () => {
    const day = S.todayKey();
    const rows = await dayRows(addDays(day, -WINDOW_DAYS), day);
    if (g !== gen) return null;
    cache = { day, at: Date.now(), rows, patterns: findPatterns(rows, day) };
    return cache;
  })().finally(() => {
    if (running === p) running = null;
  });
  running = p;
  return p;
}

// The patterns: the ones kept, or worked out again when they're older than `maxAge` (ms) or from
// another day. null if the data went meanwhile.
export async function get({ maxAge = Infinity }: { maxAge?: number } = {}): Promise<Insight | null> {
  if (cache && cache.day === S.todayKey() && Date.now() - cache.at <= maxAge) return cache;
  return work();
}

// Nothing kept: the log was emptied, or another account's data took this one's place.
export function forgetInsight() {
  gen++;
  cache = null;
  running = null;
  clearTimeout(timer);
}

const idle = (fn: () => void) => {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  if (ric) ric(fn, { timeout: 10000 });
  else fn();
};
// Works them out again `ms` from now, when the device is idle (once, however often it's asked).
function later(ms: number) {
  clearTimeout(timer);
  timer = setTimeout(
    () =>
      idle(() => {
        if (running) later(1000); // after the one under way, which may predate the change
        else work().catch(() => {});
      }),
    ms,
  );
}

// For the coach's context: only the patterns this AI may read (`cap`), the top 2 for a small model
// (`compact`), else up to 5; and a line when some were left out. `tier`: the highest of those given.
export function contextFor(cap: number, compact = false): { text: string; tier: LifeTier } {
  if (started && (!cache || cache.day !== S.todayKey())) later(0);
  const all = cache?.patterns || [];
  if (!all.length) return { text: '', tier: 1 };
  const ok = all.filter((p) => p.tier <= cap);
  const shown = ok.slice(0, compact ? 2 : 5);
  const lines = [HEAD, ...shown.map((p) => `- ${p.text}`)];
  if (ok.length < all.length) lines.push(LEFT_OUT);
  return { text: lines.join('\n'), tier: shown.reduce<LifeTier>((t, p) => (p.tier > t ? p.tier : t), 1) };
}

// Hooks the patterns into the coach, and keeps them up to date: a few seconds after the app opens,
// and a few seconds after the log or the app's data changes.
export function initInsight({ delay = 3000 }: { delay?: number } = {}) {
  if (started) return;
  started = true;
  AI.useInsight((cap: number, compact: boolean) => contextFor(cap, compact));
  L.onChange(() => later(5000));
  S.onSave(() => later(5000));
  L.onClearing(forgetInsight);
  S.onReset(forgetInsight);
  if (delay >= 0) later(delay);
}
