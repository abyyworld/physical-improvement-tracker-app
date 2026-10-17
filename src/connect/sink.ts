// Handing what a linked account sent over to the life log, only ever through lifeStore()
// (src/life/store-port.ts). Every event has a stable id, so the same email or calendar event
// handed over twice is kept once.
//
// The port promises addEvents. When the life log also offers upsertEvents (to take a calendar
// event that moved) and removeIds (for cancelled events, and "Delete what Arise got from it"),
// they're used; without them, changes to things already handed over are left as they were.

import { lifeStore, type LifeStore } from '../life/store-port';
import type { LifeEvent } from '../life/types';
import * as IDS from './ids';
import { ConnectError } from './http';
import type { ServiceId } from './state';

export interface Sink extends LifeStore {
  upsertEvents?(events: LifeEvent[]): Promise<number>;
  removeIds?(ids: readonly string[]): Promise<number>;
}

// The life log, or a 'net' error when it isn't ready (the sync then tries again later, and
// nothing is skipped).
export async function sink(wait = 8000): Promise<Sink> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), wait)));
  const s = (await Promise.race([lifeStore(), late])) as Sink | null;
  clearTimeout(timer);
  if (!s) throw new ConnectError('net', "Your life log isn't ready yet. Arise will try again later.");
  return s;
}

// Whether the sync running for each account may still go on. Disconnecting, or the data on this
// device going ("Erase all data", signing out with the data removed, another account's data
// taking its place), stops it (engine.ts): from then on it asks the service for nothing more and
// hands nothing more over, even though it still holds the sign-in.
const live = new Map<ServiceId, () => boolean>();
export function watch(service: ServiceId, alive: () => boolean) {
  live.set(service, alive);
}
export function unwatch(service: ServiceId, alive: () => boolean) {
  if (live.get(service) === alive) live.delete(service);
}
// Throws when the sync running for this account was stopped. Called before each request a sync
// makes and before anything goes into the life log.
export function goOn(service: ServiceId) {
  if (live.get(service)?.() === false) throw new ConnectError('other', 'Stopped.');
}

// Hands events over. `replace`: things that can change (calendar events) replace the copy the
// log has. Returns how many were new.
export async function hand(service: ServiceId, events: LifeEvent[], { replace = false } = {}): Promise<number> {
  goOn(service);
  const unique = [...new Map(events.map((e) => [e.id, e])).values()];
  if (!unique.length) return 0;
  const s = await sink();
  goOn(service);
  const n = replace && s.upsertEvents ? await s.upsertEvents(unique) : await s.addEvents(unique);
  await IDS.add(service, unique.map((e) => e.id));
  return n;
}

// Takes things back out of the log (a cancelled or declined calendar event). Quietly does
// nothing when the log can't remove things yet.
export async function takeBack(service: ServiceId, ids: string[]): Promise<void> {
  goOn(service);
  if (!ids.length) return;
  const s = await sink();
  goOn(service);
  if (!s.removeIds) return;
  await s.removeIds(ids);
  await IDS.drop(ids);
}

// Everything that came from one account. False when the life log can't remove things.
export async function takeAllBack(service: ServiceId): Promise<boolean> {
  const ids = await IDS.list(service);
  if (!ids.length) return true;
  const s = await sink();
  if (!s.removeIds) return false;
  for (let i = 0; i < ids.length; i += 500) await s.removeIds(ids.slice(i, i + 500));
  await IDS.forget(service);
  return true;
}

// A short, stable hash for ids that are too long or too odd for the life log (an Outlook
// message id is about 150 characters). 64 bits: two FNV-1a passes with different seeds.
export function hash(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995) ^ (b >>> 13);
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}
