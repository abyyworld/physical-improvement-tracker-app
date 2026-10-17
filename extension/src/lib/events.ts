// What the extension hands to Arise's life log: one event per page visited or search made, and
// one per site per hour for time spent there. All of it is tier 3 (searches and browsing are
// sensitive: only the private AI or the AI on the device may read them, see src/life/types.ts).
//
// Ids are stable, so the same visit read twice (or from two linked browsers, when browser sync
// copied it from one to the other) is added once: `browser:` plus a fingerprint of what it is.

import type { LifeEvent } from '../../../src/life/types';
import { digest } from './bytes';
import { findSearch } from './search';
import { isSkipped } from './skip';
import type { SiteHour } from './time';
import { cleanUrl, isLocal, matchesPrefix } from './url';

export interface Visit {
  url: string;
  title?: string;
  time: number; // ms since 1970
  transition?: string;
  isLocal?: boolean; // Chrome: false when browser sync brought it from another device
}

export interface Context {
  own: readonly string[]; // the person's own sites to skip
  arise: readonly string[]; // Arise's own addresses (nothing to record there)
  browser: string; // e.g. "Chrome on macOS"
}

// Reloads, and pages inside other pages (ads, embedded videos), aren't visits anyone made.
const SKIP_TRANSITIONS = new Set(['reload', 'auto_subframe', 'manual_subframe']);
const MAX_TITLE = 200;

const tidy = (s: unknown, max: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max).trim();

// The fingerprint of a visit itself, to know it was already read (recorder.ts).
export const visitKey = (v: Visit) => digest(`seen|${Math.round(v.time)}|${v.url}`);
// The fingerprint of a search's words, to leave out the same search again soon after (going back
// to the results, or their next page).
export const searchKey = (engine: string, query: string) => digest(`query|${engine}|${query.toLowerCase()}`);

// Whether a page is recorded at all.
export function recordable(url: string, ctx: Context): boolean {
  const c = cleanUrl(url);
  return !!c && !isLocal(c.host) && !isSkipped(c.host, ctx.own) && !matchesPrefix(url, ctx.arise);
}

// The site a page belongs to, if it's recorded (for time on site).
export function siteOf(url: string, ctx: Context): string | null {
  return recordable(url, ctx) ? cleanUrl(url)!.site : null;
}

export async function visitEvent(v: Visit, ctx: Context): Promise<LifeEvent | null> {
  if (!Number.isFinite(v.time) || (v.transition && SKIP_TRANSITIONS.has(v.transition)) || !recordable(v.url, ctx)) return null;
  const c = cleanUrl(v.url)!;
  const at = Math.round(v.time);
  const meta: Record<string, string | number | boolean> = { site: c.site, browser: ctx.browser };
  if (v.isLocal === false) meta.otherDevice = true;
  const s = findSearch(v.url);
  if (s) {
    return {
      id: `browser:${await digest(`search|${at}|${s.engine}|${s.query}`)}`,
      source: 'browser',
      kind: 'search',
      at,
      title: `Searched "${s.query}"`,
      detail: s.name,
      url: s.url,
      tier: 3,
      meta: { ...meta, engine: s.engine, query: s.query },
    };
  }
  return {
    id: `browser:${await digest(`visit|${at}|${c.url}`)}`,
    source: 'browser',
    kind: 'visit',
    at,
    title: tidy(v.title, MAX_TITLE) || c.site,
    detail: c.site,
    url: c.url,
    tier: 3,
    meta,
  };
}

// Time on one site in one hour. `install` tells this copy of the extension apart (two browsers
// can both spend time on the same site in the same hour), and `part` an hour cut short when the
// browser closed from the rest of it.
export async function siteTimeEvent(h: SiteHour, install: string, part: number, browser: string): Promise<LifeEvent> {
  const minutes = Math.round((h.seconds / 60) * 10) / 10;
  return {
    id: `browser:${await digest(`time|${install}|${h.site}|${h.hour}|${part}`)}`,
    source: 'browser',
    kind: 'app',
    at: h.hour,
    end: h.end,
    title: `${Math.max(1, Math.round(h.seconds / 60))} min on ${h.site}`,
    detail: h.site,
    value: minutes,
    unit: 'min',
    tier: 3,
    meta: { site: h.site, seconds: h.seconds, browser },
  };
}

// The browser's name for the list of linked browsers in Arise, e.g. "Edge on Windows".
export function browserName(ua: string, brands: readonly { brand: string }[] = [], platform = '', brave = false): string {
  const has = (b: string) => brands.some((x) => x.brand === b);
  const name = /Firefox\//.test(ua)
    ? 'Firefox'
    : brave || has('Brave')
      ? 'Brave'
      : has('Microsoft Edge') || /Edg\//.test(ua)
        ? 'Edge'
        : has('Opera') || /OPR\//.test(ua)
          ? 'Opera'
          : has('Google Chrome')
            ? 'Chrome'
            : /Chrome\//.test(ua)
              ? 'Chromium'
              : 'Browser';
  const os = platform || (/Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /CrOS/.test(ua) ? 'ChromeOS' : /Android/.test(ua) ? 'Android' : /Linux/.test(ua) ? 'Linux' : '');
  return os ? `${name} on ${os}` : name;
}
