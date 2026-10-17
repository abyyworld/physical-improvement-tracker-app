// Netflix: what was watched.
//
// ViewingActivity.csv, in CONTENT_INTERACTION of the full data request (netflix-report.zip):
// Profile Name,Start Time,Duration,Attributes,Title,Supplemental Video Type,Device Type,Bookmark,Latest Bookmark,Country
// Start Time is UTC ("2024-01-02 03:04:05"), Duration "00:42:10". Rows with a Supplemental Video
// Type (TRAILER, HOOK, RECAP…) are previews, not watching.
//
// NetflixViewingHistory.csv, from Account, Profile, Viewing activity, "Download all":
// Title,Date with one profile's titles and the day only, written the way the account's country
// writes dates ("1/31/23", "31/01/2023", "31.01.23", Korean "24. 1. 31." with the year first).

import type { LifeEvent } from '../types';
import type { TextInput } from './types';
import { CsvRows } from './text-stream';
import { clean, drain, guessOrder, hashId, localMs, Repeats, utcMs, ymdOf } from './util';

const MIN_SECONDS = 60;

// "00:42:10" → seconds.
function seconds(v: string): number {
  const p = v.trim().split(':').map(Number);
  if (!p.length || p.some((n) => !Number.isFinite(n))) return NaN;
  return p.reduce((s, n) => s * 60 + n, 0);
}

const header = (row: string[]) => row.map((c) => c.replace(/^﻿/, '').trim().toLowerCase());

// The profiles in a ViewingActivity.csv, most rows first.
export async function netflixProfiles(input: TextInput): Promise<string[]> {
  const csv = new CsvRows();
  const counts = new Map<string, number>();
  let col = -1;
  let first = true;
  for await (const chunk of input.text) {
    for (const row of csv.push(chunk)) {
      if (first) {
        col = header(row).indexOf('profile name');
        if (col < 0) col = 0; // names in another language: the profile comes first
        first = false;
        continue;
      }
      const p = clean(row[col], 60);
      if (col >= 0 && p) counts.set(p, (counts.get(p) ?? 0) + 1);
    }
  }
  for (const row of csv.end()) {
    const p = clean(row[col], 60);
    if (col >= 0 && p) counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]).map(([p]) => p);
}

export async function* parseNetflixActivity(input: TextInput, opts: { profiles?: string[] } = {}): AsyncGenerator<LifeEvent[]> {
  const csv = new CsvRows();
  const only = opts.profiles?.length ? new Set(opts.profiles) : null;
  const out: LifeEvent[] = [];
  let cols: Record<string, number> | null = null;
  const row = (r: string[]) => {
    if (!cols) {
      const h = header(r);
      cols = { profile: h.indexOf('profile name'), start: h.indexOf('start time'), duration: h.indexOf('duration'), title: h.indexOf('title'), extra: h.indexOf('supplemental video type'), device: h.indexOf('device type') };
      // Names in another language: Netflix's own order of the columns.
      if (cols.start < 0 || cols.title < 0) cols = { profile: 0, start: 1, duration: 2, title: 4, extra: 5, device: 6 };
      return;
    }
    const c = cols;
    if (c.title < 0 || c.start < 0) return;
    if (c.extra >= 0 && (r[c.extra] ?? '').trim()) return; // a trailer or preview
    const profile = clean(r[c.profile], 60);
    if (only && !only.has(profile)) return;
    const title = clean(r[c.title], 200);
    const at = utcMs(r[c.start]);
    const sec = c.duration >= 0 ? seconds(r[c.duration] ?? '') : NaN;
    if (!title || !Number.isFinite(at)) return;
    if (Number.isFinite(sec) && sec < MIN_SECONDS) return;
    const e: LifeEvent = { id: `netflix:${hashId('watch', profile, at, title)}`, source: 'netflix', kind: 'watch', at, title: `Watched ${title}`, tier: 2 };
    if (Number.isFinite(sec)) {
      e.end = at + sec * 1000;
      e.value = Math.round(sec / 60);
      e.unit = 'min';
    }
    const device = clean(r[c.device], 60);
    const detail = [profile && `Profile ${profile}`, device].filter(Boolean).join(' · ');
    if (detail) e.detail = detail;
    if (profile) e.meta = { profile };
    out.push(e);
  };
  for await (const chunk of input.text) {
    for (const r of csv.push(chunk)) row(r);
    yield* drain(out);
  }
  for (const r of csv.end()) row(r);
  yield* drain(out, true);
}

// "1/31/23", "31.01.2023", "2023-01-31", "2023/1/31", "2023. 1. 31." → three numbers.
export function dateParts(v: string): [number, number, number] | null {
  const m = v.trim().match(/^(\d{1,4})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{1,4})\.?$/);
  return m ? [+m[1], +m[2], +m[3]] : null;
}

// Dots with spaces and one at the end ("24. 1. 31.", "2024. 01. 31."): Korean (and Hungarian),
// which put the year first, even with only two digits of it.
export const yearFirst = (v: string): boolean => /^\d{1,4}\.\s+\d{1,2}\.\s+\d{1,2}\.$/.test(v.trim());

export async function* parseNetflixHistory(input: TextInput): AsyncGenerator<LifeEvent[]> {
  // Only days, in the account's own order: read it all (it's small), then work out the order.
  const csv = new CsvRows();
  const rows: [string, [number, number, number]][] = [];
  let cols: { title: number; date: number } | null = null;
  let slash = 0;
  let korean = 0;
  const take = (r: string[]) => {
    if (!cols) {
      const h = header(r);
      cols = { title: h.indexOf('title'), date: h.indexOf('date') };
      if (cols.title < 0 || cols.date < 0) cols = { title: 0, date: 1 };
      return;
    }
    const title = clean(r[cols.title], 200);
    const d = dateParts(r[cols.date] ?? '');
    if (!title || !d) return;
    if ((r[cols.date] ?? '').includes('/')) slash++;
    if (yearFirst(r[cols.date] ?? '')) korean++;
    rows.push([title, d]);
  };
  for await (const chunk of input.text) for (const r of csv.push(chunk)) take(r);
  for (const r of csv.end()) take(r);
  // Nothing tells: "/" is most often month first (the US), "." and "-" day first.
  const order = korean > rows.length / 2 ? 'ymd' : guessOrder(rows.map(([, d]) => d), slash > rows.length / 2 ? 'mdy' : 'dmy');
  const repeats = new Repeats();
  const out: LifeEvent[] = [];
  for (const [title, d] of rows) {
    const [y, m, day] = ymdOf(d, order);
    const at = localMs(y, m, day, 12);
    if (!Number.isFinite(at)) continue;
    const key = `${y}-${m}-${day}\u0001${title}`;
    const n = repeats.next(key);
    out.push({ id: `netflix:${hashId('day', y, m, day, title, n)}`, source: 'netflix', kind: 'watch', at, title: `Watched ${title}`, tier: 2, meta: { dateOnly: true } });
    yield* drain(out);
  }
  yield* drain(out, true);
}
