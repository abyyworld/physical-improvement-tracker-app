// Sharing a goal's progress with a friend, end-to-end encrypted: the parts both sides use. The
// link, the snapshot a friend sees (and checking it), sealing it, and fetching it. The Player's
// side is share.ts; the page a friend sees is share-view.ts.
//
// A share is a random 128-bit id and a random AES-256-GCM key. The link is
// <site>#share=<id>.<key>, and the part after the # stays in the browser: it never reaches a
// server. The cloud keeps shares/<id> = { owner, iv, ct, v: 1, updated }, the snapshot sealed
// with the key and bound to the id (firestore.rules). So the server can't read it, and anyone
// with the link can.

import { linkKey, newLinkKey, open, randomBytes, seal, toB64url, type Sealed } from './crypto';

export interface ShareRef {
  id: string; // 128 random bits, base64url (22 characters)
  key: string; // the 256-bit key, base64url (43 characters)
  at: number; // when this link was made: a newer link wins over an older one (lib/merge.ts)
  name?: true; // the page shows the Player's first name
}

const ID = /^[A-Za-z0-9_-]{22}$/;
const KEY = /^[A-Za-z0-9_-]{43}$/;
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 8.64e15;

// A goal's share as it comes from a backup, the cloud or this device's storage, or nothing.
export function cleanShareRef(raw: unknown): ShareRef | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !ID.test(r.id) || typeof r.key !== 'string' || !KEY.test(r.key) || !isTime(r.at)) return undefined;
  return { id: r.id, key: r.key, at: r.at, ...(r.name === true ? { name: true as const } : {}) };
}

export const newShareRef = async (): Promise<ShareRef> => ({ id: toB64url(randomBytes(16)), key: await newLinkKey(), at: Date.now() });

// `site` is where the app is: the page's own address on the web, the website in the iPhone app.
export const shareLink = (site: string, ref: { id: string; key: string }) => `${site.split('#')[0]}#share=${ref.id}.${ref.key}`;

// Any address part that starts like a share link opens the friend's page (which then says if the
// link is broken), never the app.
export const isShareHash = (hash: string) => /^#share=/.test(hash);
export function parseShareHash(hash: string): { id: string; key: string } | null {
  const m = /^#share=([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/.exec(hash);
  return m ? { id: m[1], key: m[2] } : null;
}

// ---------- what a friend sees

// Each day of the last 28 for this goal: done, missed, a day off, or today (not done yet).
export type DayMark = 'd' | 'm' | 'o' | 't';
export interface SharedQuest {
  title: string;
  when: string; // "every day", "3 times a week"
  streak: number; // days in a row, or weeks for a weekly quest
  weekly?: true;
}
export interface SharedMeasure {
  name: string;
  unit: string;
  value?: number; // the latest one logged
  on?: string; // the day it was logged
  target?: number;
}
export interface Snapshot {
  v: 1;
  title: string;
  area: string; // the area's name, like Fitness
  status: 'active' | 'paused' | 'done';
  name?: string; // the Player's first name, only if they chose to show it
  streak: number; // the Player's streak, across everything they do in Arise
  quests: SharedQuest[];
  from: string; // the first day in `days`
  days: string; // a DayMark a day, from `from` to the day it was updated
  measures: SharedMeasure[];
  milestones: { title: string; done: string }[]; // the ones done
  milestonesOf: number; // how many the goal has
  updated: number;
}
// Everything a snapshot may hold. Nothing else is ever sent (share.test.ts checks it).
export const SNAPSHOT_FIELDS = ['v', 'title', 'area', 'status', 'name', 'streak', 'quests', 'from', 'days', 'measures', 'milestones', 'milestonesOf', 'updated'] as const;

const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const isDate = (v: unknown): v is string => typeof v === 'string' && DATE.test(v);
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const count = (v: unknown, max: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(max, Math.floor(v)) : 0);
const number = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e12 ? v : undefined);
const list = (v: unknown, max: number) => (Array.isArray(v) ? v.slice(0, max) : []).filter((x): x is Record<string, unknown> => !!x && typeof x === 'object');

// A snapshot as it came out of the cloud, rebuilt from what's allowed (and capped), so the page
// can trust it. Null if it isn't one.
export function cleanSnapshot(raw: unknown): Snapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  const title = text(s.title, 120);
  if (s.v !== 1 || !title || !isDate(s.from) || !isTime(s.updated)) return null;
  const out: Snapshot = {
    v: 1,
    title,
    area: text(s.area, 24),
    status: s.status === 'paused' || s.status === 'done' ? s.status : 'active',
    streak: count(s.streak, 100_000),
    quests: list(s.quests, 30).flatMap((q) => {
      const t = text(q.title, 80);
      return t ? [{ title: t, when: text(q.when, 40), streak: count(q.streak, 100_000), ...(q.weekly === true ? { weekly: true as const } : {}) }] : [];
    }),
    from: s.from,
    days: typeof s.days === 'string' ? s.days.slice(0, 28).replace(/[^dmot]/g, 'o') : '',
    measures: list(s.measures, 10).flatMap((m) => {
      const name = text(m.name, 40);
      if (!name) return [];
      const out: SharedMeasure = { name, unit: text(m.unit, 12) };
      const value = number(m.value);
      const target = number(m.target);
      if (value != null) out.value = value;
      if (value != null && isDate(m.on)) out.on = m.on;
      if (target != null) out.target = target;
      return [out];
    }),
    milestones: list(s.milestones, 30).flatMap((m) => {
      const t = text(m.title, 120);
      return t && isDate(m.done) ? [{ title: t, done: m.done }] : [];
    }),
    milestonesOf: 0,
    updated: s.updated,
  };
  out.milestonesOf = Math.max(out.milestones.length, count(s.milestonesOf, 30));
  const name = text(s.name, 24);
  if (name) out.name = name;
  return out;
}

// ---------- sealing it

export const MAX_CT = 20_000; // the most ciphertext a share may hold (firestore.rules)
const aad = (id: string) => `share/${id}`;

export interface ShareDoc {
  owner: string;
  iv: string;
  ct: string;
  v: 1;
  updated: number;
}

export async function sealSnapshot(ref: { id: string; key: string }, snap: Snapshot): Promise<Sealed> {
  return seal(await linkKey(ref.key), JSON.stringify(snap), aad(ref.id));
}

// Null when what's inside isn't a snapshot. Throws a CryptoError when it doesn't open with this
// key, or isn't this share's (a copy of another one put in its place).
export async function openSnapshot(ref: { id: string; key: string }, sealed: Sealed): Promise<Snapshot | null> {
  const text = await open(await linkKey(ref.key), sealed, aad(ref.id));
  try {
    return cleanSnapshot(JSON.parse(text));
  } catch {
    return null;
  }
}

// ---------- fetching it, for a friend

// shares/<id>, read the way the Firestore SDK reads it, under the same rules, as someone who isn't
// signed in. A plain request rather than the SDK: the SDK keeps a note in the browser's storage
// each day it's used, and a friend's browser keeps nothing. Null: there's no such share (it was
// turned off, or replaced by a new link).
export async function fetchShare(id: string, project: { projectId: string; apiKey: string }, get: typeof fetch = fetch): Promise<Sealed | null> {
  if (!ID.test(id)) return null;
  const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(project.projectId)}/databases/(default)/documents/shares/${id}?key=${encodeURIComponent(project.apiKey)}`;
  const res = await get(url, { cache: 'no-store', credentials: 'omit' });
  if (res.status === 404) return null;
  if (!res.ok) throw Object.assign(new Error(`The cloud said ${res.status}.`), { code: res.status === 403 ? 'permission-denied' : 'unavailable' });
  const fields = ((await res.json()) as { fields?: Record<string, { stringValue?: unknown }> }).fields || {};
  const iv = fields.iv?.stringValue;
  const ct = fields.ct?.stringValue;
  if (typeof iv !== 'string' || typeof ct !== 'string') return null;
  return { iv, ct };
}
