// Small helpers every importer uses: stable ids, batches, dates, numbers and tidy text.

import type { LifeEvent } from '../types';

export const BATCH = 500;

// Full batches of events, taken off the front of `out`. With `final`, the rest too.
export function* drain(out: LifeEvent[], final = false): Generator<LifeEvent[]> {
  while (out.length >= BATCH) yield out.splice(0, BATCH);
  if (final && out.length) yield out.splice(0, out.length);
}

// A short, stable hash of some values (64 bits as 16 hex digits), so the same thing in the same
// file always gets the same id and importing it twice adds nothing.
export function hashId(...parts: unknown[]): string {
  const s = parts.map((p) => (p === undefined || p === null ? '' : String(p))).join('\u0001');
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995);
    h2 ^= h2 >>> 15;
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 0x85ebca6b) ^ Math.imul(h2 ^ (h2 >>> 13), 0xc2b2ae35);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 0x85ebca6b) ^ Math.imul(h1 ^ (h1 >>> 13), 0xc2b2ae35);
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

// Gives each repeat of the same key its own number (0, 1, 2…), so two coffees on the same day
// with the same price stay two events, and a second import of the file numbers them the same.
export class Repeats {
  private seen = new Map<string, number>();
  next(key: string): number {
    const n = this.seen.get(key) ?? 0;
    this.seen.set(key, n + 1);
    return n;
  }
}

// ---------- text

// One line, no control characters or direction marks, at most `max` characters.
export function clean(s: unknown, max = 200): string {
  const t = String(s ?? '')
    .replace(/[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩﻿]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

export const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

export function hostOf(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// ---------- numbers

export const num = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN);
export const int = (n: number): string => Math.round(n).toLocaleString('en-US');
export const round1 = (n: number): number => Math.round(n * 10) / 10;
export const fixed1 = (n: number): string => (Math.round(n * 10) / 10).toLocaleString('en-US', { maximumFractionDigits: 1 });

// "45 min", "1 h 20 min".
export function duration(min: number): string {
  const m = Math.round(min);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

// ---------- dates

const DAY = 86_400_000;
export { DAY };

// An ISO 8601 time ("2024-01-02T03:04:05.123456Z", "…+02:00"). NaN when it isn't one.
export function isoMs(v: unknown): number {
  if (typeof v !== 'string') return NaN;
  // More than 3 digits after the second: keep 3, which every engine reads.
  const s = v.trim().replace(/(\.\d{3})\d+/, '$1');
  if (!/^\d{4}-\d{2}-\d{2}T/.test(s)) return NaN;
  return Date.parse(s);
}

// A time in UTC written without a zone: "2024-01-02 03:04" or "2024-01-02 03:04:05".
export function utcMs(v: unknown): number {
  const m = typeof v === 'string' && v.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
}

// A wall-clock time on this device's clock.
export function localMs(y: number, mo: number, d: number, h = 12, mi = 0, s = 0): number {
  if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && h >= 0 && h <= 24 && mi >= 0 && mi < 60 && s >= 0 && s < 61)) return NaN;
  const t = new Date(y, mo - 1, d, h, mi, s);
  // 31 February and the like.
  return t.getDate() === d ? t.getTime() : NaN;
}

// Calendar day "2024-01-02" of a time, on this device's clock.
export function dayOf(ms: number): string {
  const t = new Date(ms);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

export const year2 = (y: number): number => (y < 100 ? 2000 + y : y);

// Which order the day, month and year come in, from many dates written with numbers only
// ([a, b, c] each). A 4-digit first part is year first; a first part over 12 means day first; a
// second part over 12 means month first. When nothing tells, `fallback`.
export function guessOrder(samples: Iterable<[number, number, number]>, fallback: 'dmy' | 'mdy'): 'dmy' | 'mdy' | 'ymd' {
  let dmy = 0;
  let mdy = 0;
  let ymd = 0;
  for (const [a, b] of samples) {
    if (a > 31) ymd++;
    else if (a > 12) dmy++;
    else if (b > 12) mdy++;
  }
  if (ymd && ymd >= dmy + mdy) return 'ymd';
  if (dmy > mdy) return 'dmy';
  if (mdy > dmy) return 'mdy';
  return fallback;
}

// [year, month, day] from three numbers in the given order.
export function ymdOf([a, b, c]: [number, number, number], order: 'dmy' | 'mdy' | 'ymd'): [number, number, number] {
  if (order === 'ymd') return [year2(a), b, c];
  if (order === 'mdy') return [year2(c), a, b];
  return [year2(c), b, a];
}
