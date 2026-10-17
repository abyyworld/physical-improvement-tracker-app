// The Player's switches for the life log, kept in this device's storage. On its own (no app
// imports), so the sync (cloud.ts) can read and set them too.
//
// "Stop learning" (`paused`) syncs between the Player's devices, so another device doesn't keep
// learning: `pausedAt` says when it last changed, and the newest choice wins. "Let less private AIs
// read my life log" stays on each device, like the choice of AI.

import { cleanLifePrefs, type LifePrefs } from '../lib/validate';

const PREFS = 'arise-life-prefs';

const watchers = new Set<() => void>();
// Told when the Player changes a switch that syncs.
export function onPrefsChange(cb: () => void): () => void {
  watchers.add(cb);
  return () => watchers.delete(cb);
}

export function prefs(): LifePrefs {
  try {
    return cleanLifePrefs(JSON.parse(localStorage.getItem(PREFS) || '{}'));
  } catch {
    return cleanLifePrefs({});
  }
}

function write(next: LifePrefs) {
  try {
    localStorage.setItem(PREFS, JSON.stringify(next));
  } catch {}
}

export function setPrefs(patch: Partial<LifePrefs>): LifePrefs {
  const now = prefs();
  const { pausedAt: _p, ...rest } = patch;
  const flip = typeof rest.paused === 'boolean' && rest.paused !== now.paused;
  const next = cleanLifePrefs({ ...now, ...rest, ...(flip ? { pausedAt: Date.now() } : {}) });
  write(next);
  if (flip) {
    for (const cb of [...watchers]) {
      try {
        cb();
      } catch {}
    }
  }
  return next;
}

// From another device (the sync): taken as it is, with its time. (Time 0: as if never chosen, so
// the account's own choice wins on its first sync here.)
export function takePaused(paused: boolean, pausedAt: number) {
  const { pausedAt: _p, ...rest } = prefs();
  write(cleanLifePrefs({ ...rest, paused, ...(pausedAt ? { pausedAt } : {}) }));
}

export function forgetPrefs() {
  try {
    localStorage.removeItem(PREFS);
  } catch {}
}
