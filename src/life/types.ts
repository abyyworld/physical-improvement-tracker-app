// One thing that happened in the Player's life, from any source: Arise itself, something they
// typed, an imported export (Google, Spotify, Netflix, Apple Health…), or a linked device.
// The life log (src/life/log.ts) keeps these on the device; everything leaves it only sealed.

export type LifeSource =
  | 'arise' // quests, workouts, journal, weigh-ins: made from the app's own data
  | 'manual' // typed into "Add to your day"
  | 'google' // Google searches and other My Activity
  | 'youtube'
  | 'chrome'
  | 'maps' // places and trips
  | 'spotify'
  | 'netflix'
  | 'health' // Apple Health and the devices that write to it
  | 'whatsapp'
  | 'email' // Gmail, Outlook
  | 'calendar'
  | 'shortcut' // iPhone Shortcuts automations
  | 'browser' // the browser extension
  | 'mac' // the Mac helper
  | 'android' // the Android app: calls, notifications, app use
  | 'steam'
  | 'psn'
  | 'bank'
  | 'other';

export type LifeKind =
  | 'search'
  | 'visit'
  | 'watch'
  | 'listen'
  | 'play'
  | 'place'
  | 'trip'
  | 'workout'
  | 'sleep'
  | 'steps'
  | 'health'
  | 'event'
  | 'call'
  | 'message'
  | 'notification'
  | 'app'
  | 'purchase'
  | 'note'
  | 'quest'
  | 'mood'
  | 'other';

// How personal it is, which decides which AI may read it (src/life/policy.ts):
// 1: the Player's goals and quests in Arise (any AI they chose);
// 2: everyday activity: watching, listening, games, workouts, steps, calendar, notes;
// 3: sensitive: searches, browsing, places, messages, calls, money, health details.
// Tiers 2 and 3 go only to the private AI or the AI on the device, unless the Player says otherwise.
export type LifeTier = 1 | 2 | 3;

export interface LifeEvent {
  // Stable, so importing the same file twice adds nothing: `${source}:${the source's own id}`, or
  // `${source}:` plus a hash of kind, time and title when the source has no id.
  id: string;
  source: LifeSource;
  kind: LifeKind;
  at: number; // when it started, in ms since 1970 (UTC)
  end?: number; // when it ended, for things that last
  title: string; // short and readable: 'Searched "protein bars"', 'Watched Breaking Bad: S1E3'
  detail?: string;
  url?: string;
  value?: number; // steps, minutes, an amount…
  unit?: string;
  tier: LifeTier;
  meta?: Record<string, string | number | boolean>;
}
