// The lists behind LifeSource and LifeKind, and the lowest tier each kind of thing can have.
// On its own (no app imports), so validation, the life log and a worker can all use it.

import type { LifeKind, LifeSource, LifeTier } from './types';

export const LIFE_SOURCES: readonly LifeSource[] = ['arise', 'manual', 'google', 'youtube', 'chrome', 'maps', 'spotify', 'netflix', 'health', 'whatsapp', 'email', 'calendar', 'shortcut', 'browser', 'mac', 'android', 'steam', 'psn', 'bank', 'other'];

export const LIFE_KINDS: readonly LifeKind[] = ['search', 'visit', 'watch', 'listen', 'play', 'place', 'trip', 'workout', 'sleep', 'steps', 'health', 'event', 'call', 'message', 'notification', 'app', 'purchase', 'note', 'quest', 'mood', 'other'];

// Sensitive whatever source it came from: what people search, read, where they go, who they talk
// to, what they buy, their body.
const SENSITIVE: ReadonlySet<LifeKind> = new Set(['search', 'visit', 'place', 'trip', 'message', 'call', 'notification', 'purchase', 'health', 'sleep']);

// A safety net under the tier an importer gives: Arise's own data (already sent to any AI the
// Player picked) can be tier 1; anything else is at least 2, and sensitive kinds at least 3. So a
// mistake in an importer can never hand a message or a search to a less private AI.
export function floorTier(source: LifeSource, kind: LifeKind): LifeTier {
  if (source === 'arise') return 1;
  return SENSITIVE.has(kind) ? 3 : 2;
}

// How private something is to share with another app (About me and me links: lib/me.ts). Unlike
// the tier for the AI, Arise's own data isn't let off: a weigh-in, an energy score or a question
// to the coach is as sensitive as a health record or a message, and a journal entry is written
// down like any note. Only quests, workouts, goals and their milestones and measures stay at 1.
const SHARE_SENSITIVE: ReadonlySet<LifeKind> = new Set([...SENSITIVE, 'mood']);
export function shareTier(e: { source: LifeSource; kind: LifeKind; tier: LifeTier }): LifeTier {
  const floor: LifeTier = SHARE_SENSITIVE.has(e.kind) ? 3 : e.source === 'arise' && e.kind !== 'note' ? 1 : 2;
  return Math.max(e.tier, floor) as LifeTier;
}

export const SOURCE_NAMES: Record<LifeSource, string> = {
  arise: 'Arise',
  manual: 'Your notes',
  google: 'Google',
  youtube: 'YouTube',
  chrome: 'Chrome',
  maps: 'Maps',
  spotify: 'Spotify',
  netflix: 'Netflix',
  health: 'Health',
  whatsapp: 'WhatsApp',
  email: 'Email',
  calendar: 'Calendar',
  shortcut: 'Shortcuts',
  browser: 'Browser',
  mac: 'Mac',
  android: 'Android phone',
  steam: 'Steam',
  psn: 'PlayStation',
  bank: 'Bank',
  other: 'Other',
};
