// What Arise saw and noticed, kept ready: the Player's days as signals (signals.ts: sleep, steps,
// people, focus, screens... from what their devices already record), the eight parts of their life
// scored from those against their own usual (areas.ts), and the patterns in them (lib/patterns.ts),
// all worked out on this device with no AI and no network. They're worked out in idle time a little
// after the app opens and after the data changes, and kept in memory until then; nothing of it is
// saved or sent anywhere. The screens show them, and the coach gets only what its AI may read
// (ai.js asks through useInsight and useSignals), so anything made from messages, browsing or
// sleep never reaches an AI that may not read those.

import * as AI from '../ai.js';
import * as S from '../store';
import { cleanLife } from '../lib/life-check';
import { findPatterns, WINDOW_DAYS, type DayRow, type Pattern } from '../lib/patterns';
import * as L from './log';
import { addDays } from './dates';
import { daySignals, lifeAreas, rowsOf, signalsText, type DaySignals, type LifeArea } from './signals';
import type { LifeTier } from './types';

export interface Insight {
  day: string; // the day it was worked out (today then)
  at: number;
  signals: DaySignals[]; // the 6 weeks before that day, and that day (today so far), oldest first
  rows: DayRow[]; // the same days as rows for the patterns
  areas: LifeArea[]; // the eight parts of life, in the usual order (lib/life-check.ts AREA_IDS)
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
    const signals = await daySignals(addDays(day, -WINDOW_DAYS), day);
    if (g !== gen) return null;
    const rows = rowsOf(signals);
    const areas = lifeAreas(signals, day, { life: cleanLife(S.state.profile?.life) });
    cache = { day, at: Date.now(), signals, rows, areas, patterns: findPatterns(rows, day) };
    return cache;
  })().finally(() => {
    if (running === p) running = null;
  });
  running = p;
  return p;
}

// What was worked out: the one kept, or worked out again when they're older than `maxAge` (ms) or from
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

// For the coach's context: "What Arise saw", the last 7 days (3 for a small model) and the eight
// parts of life with why, each part only when this AI may read it (`cap`), and a line when some
// was left out (areas.ts signalsText). Nothing before any device or import has told Arise
// anything. `tier`: the highest of what was given.
export function signalsContextFor(cap: number, compact = false): { text: string; tier: LifeTier } {
  if (started && (!cache || cache.day !== S.todayKey())) later(0);
  if (!cache) return { text: '', tier: 1 };
  return signalsText(cache.signals, cache.areas, cap, { compact, today: cache.day });
}

// Hooks the patterns and what Arise saw into the coach, and keeps them up to date: a few seconds
// after the app opens, and a few seconds after the log or the app's data changes.
export function initInsight({ delay = 3000 }: { delay?: number } = {}) {
  if (started) return;
  started = true;
  AI.useInsight((cap: number, compact: boolean) => contextFor(cap, compact));
  AI.useSignals((cap: number, compact: boolean) => signalsContextFor(cap, compact));
  L.onChange(() => later(5000));
  S.onSave(() => later(5000));
  L.onClearing(forgetInsight);
  S.onReset(forgetInsight);
  if (delay >= 0) later(delay);
}
