// Which AI may read which part of the life log.
//
//   tier 1: the Player's goals and quests in Arise (already sent to any AI they picked)
//   tier 2: everyday activity: watching, listening, games, workouts, steps, calendar, notes
//   tier 3: sensitive: searches, browsing, places, messages, calls, money, health details
//
// The private AI (sealed enclave) and the AI on this device may read all three. The free AI and
// the Player's own AI service are companies that can read what they're sent, so they get tier 1
// only, unless the Player turns on "Let less private AIs read my life log". Anything made from the
// log (a summary, a fact) carries the highest tier of what it was made from.

import { engine as currentEngine, isPrivate } from '../ai.js';
import { cleanLifePrefs, type LifePrefs } from '../lib/validate';
import type { LifeTier } from './types';
export { floorTier } from './tiers';

export type Engine = 'private' | 'device' | 'free' | 'own';
export type Cap = 0 | LifeTier; // 0: nothing at all (no AI)

// ---------- the Player's switches (on this device only, like the choice of AI)

const PREFS = 'arise-life-prefs';

export function prefs(): LifePrefs {
  try {
    return cleanLifePrefs(JSON.parse(localStorage.getItem(PREFS) || '{}'));
  } catch {
    return cleanLifePrefs({});
  }
}

export function setPrefs(patch: Partial<LifePrefs>): LifePrefs {
  const next = cleanLifePrefs({ ...prefs(), ...patch });
  try {
    localStorage.setItem(PREFS, JSON.stringify(next));
  } catch {}
  return next;
}

export function forgetPrefs() {
  try {
    localStorage.removeItem(PREFS);
  } catch {}
}

// ---------- the rules

export const lessPrivate = (e: Engine | null | undefined) => e === 'free' || e === 'own';

// The highest tier this engine may read.
export function capFor(e: Engine | null | undefined, { lessPrivateOk = prefs().lessPrivate } = {}): Cap {
  if (e === 'private' || e === 'device') return 3;
  if (e === 'free' || e === 'own') return lessPrivateOk ? 3 : 1;
  return 0;
}

// For the AI in use right now.
export function cap(): Cap {
  const e = currentEngine() as Engine | null;
  if (!e) return 0;
  return isPrivate() ? 3 : capFor(e);
}

export const canSee = (tier: LifeTier, c: Cap) => tier <= c;

// Only what this cap allows.
export const visible = <T extends { tier: LifeTier }>(items: readonly T[], c: Cap): T[] => items.filter((x) => x.tier <= c);

// The tier of something made from these: the highest of them (1 for nothing).
export const derivedTier = (tiers: Iterable<LifeTier>): LifeTier => {
  let t: LifeTier = 1;
  for (const x of tiers) if (x > t) t = x;
  return t;
};

// In plain words, for the screens.
export function tierText(tier: LifeTier): string {
  if (tier === 1) return 'Any AI you pick can read this when the coach uses it.';
  return `Only the private AI and the AI on your device read this${prefs().lessPrivate ? ', and the less private ones, because you allowed it' : ''}.`;
}
