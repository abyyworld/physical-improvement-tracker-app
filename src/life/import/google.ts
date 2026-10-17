// Google Takeout: My Activity (Search, YouTube, Chrome, Maps and the rest, in any language),
// YouTube's watch-history.json and search-history.json (the same format), and Chrome's
// BrowserHistory.json.
//
// A My Activity record: {"header": "Search", "title": "Searched for protein bars",
// "titleUrl": "https://www.google.com/search?q=protein+bars", "time": "2024-01-02T03:04:05.678Z",
// "products": ["Search"], "subtitles": [{"name": "Channel", "url": "…"}], "details": [{"name": "From Google Ads"}]}
// The title is in the Player's language, so what it was is read from the link and the product.

import type { LifeEvent, LifeKind, LifeSource } from '../types';
import type { TextInput } from './types';
import { JsonItems } from './json-stream';
import { clean, drain, hashId, hostOf, isoMs, str } from './util';

type Rec = Record<string, unknown>;

const isGoogle = (host: string) => /(^|\.)google\.[a-z.]+$/.test(host);
const isYouTube = (host: string) => /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/.test(host);

function param(u: URL, ...names: string[]): string | undefined {
  for (const n of names) {
    const v = u.searchParams.get(n);
    if (v && v.trim()) return v.trim();
  }
  return undefined;
}

const parse = (url: string | undefined): URL | null => {
  if (!url) return null;
  try {
    return new URL(url);
  } catch {
    return null;
  }
};

// What was searched, from the link: Google, Image/Video Search, YouTube, Maps, Play Store…
export function searchQuery(url: string | URL | null | undefined): string | undefined {
  const u = typeof url === 'string' ? parse(url) : url;
  if (!u) return undefined;
  const host = u.hostname.replace(/^www\./, '');
  if (isYouTube(host)) return u.pathname.startsWith('/results') ? param(u, 'search_query', 'q') : undefined;
  if (!isGoogle(host)) return undefined;
  const maps = u.pathname.match(/^\/maps\/search\/([^/@]+)/);
  if (maps) {
    try {
      return decodeURIComponent(maps[1].replace(/\+/g, ' ')).trim() || undefined;
    } catch {
      return undefined;
    }
  }
  if (/^\/(search|maps|store\/search|webhp|images)/.test(u.pathname) || host.startsWith('play.') || host.startsWith('news.') || host.startsWith('books.')) {
    if (u.pathname.startsWith('/url')) return undefined;
    return param(u, 'q', 'query');
  }
  return undefined;
}

// A Google result that was clicked: https://www.google.com/url?q=https://example.com/…
function redirectTarget(u: URL | null): string | undefined {
  if (u && u.pathname === '/url' && isGoogle(u.hostname.replace(/^www\./, ''))) {
    const t = param(u, 'q', 'url');
    if (t && /^https?:\/\//.test(t)) return t;
  }
  return undefined;
}

const lower = (a: unknown): string[] => (Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string').map((x) => x.toLowerCase()) : []);

// One My Activity record as a life event, or null for what isn't worth keeping (ads, the
// Discover feed, broken records).
export function activityEvent(r: unknown): LifeEvent | null {
  if (!r || typeof r !== 'object') return null;
  const rec = r as Rec;
  const at = isoMs(rec.time);
  const title0 = clean(rec.title, 300);
  if (!Number.isFinite(at) || !title0) return null;
  const products = lower(rec.products);
  const header = clean(rec.header, 80);
  const details = Array.isArray(rec.details) ? rec.details.map((d) => clean((d as Rec)?.name, 80)) : [];
  // Ads seen or clicked, and Discover's "8 cards in your feed": not things the Player did.
  if (products.includes('ads') || products.includes('discover') || details.some((d) => /google ads/i.test(d))) return null;
  const url0 = str(rec.titleUrl);
  const u = parse(url0); // once: it's the slow part
  const host = u ? u.hostname.replace(/^www\./, '') : '';
  const h = header.toLowerCase();

  let source: LifeSource = 'google';
  if (products.some((p) => p.startsWith('youtube')) || h.startsWith('youtube') || isYouTube(host)) source = 'youtube';
  else if (products.includes('chrome') || h === 'chrome') source = 'chrome';
  else if (products.includes('maps') || h === 'maps' || /\/maps(\/|$)/.test(u?.pathname ?? '')) source = 'maps';

  const q = searchQuery(u);
  const target = redirectTarget(u);
  let kind: LifeKind = 'other';
  let title = title0;
  let url = url0;
  if (q) {
    kind = 'search';
    title = source === 'youtube' ? `Searched YouTube for "${clean(q, 150)}"` : source === 'maps' ? `Searched Maps for "${clean(q, 150)}"` : `Searched "${clean(q, 150)}"`;
  } else if (source === 'youtube') {
    // YouTube Music is listening; the rest of YouTube, watching.
    const music = host.startsWith('music.') || h === 'youtube music';
    kind = url0 && /\/watch|youtu\.be\/|\/shorts\//.test(url0) ? (music ? 'listen' : 'watch') : 'other';
  } else if (source === 'chrome') {
    kind = 'visit';
  } else if (target) {
    kind = 'visit';
    url = target;
  } else if (url0 && host && !isGoogle(host)) {
    kind = 'visit';
  }
  // The channel, for YouTube; else which Google product, when it says more than the source.
  const sub = Array.isArray(rec.subtitles) ? clean((rec.subtitles[0] as Rec)?.name, 120) : '';
  const detail = source === 'youtube' ? sub : header && !['search', 'chrome', 'maps'].includes(h) ? header : sub;
  // Watching is everyday; searches, browsing and everything else Google keeps is sensitive.
  const tier = source === 'youtube' && kind !== 'search' ? 2 : 3;
  const e: LifeEvent = { id: `${source}:${hashId(kind, at, title0, url0)}`, source, kind, at, title, tier };
  if (detail) e.detail = detail;
  if (url && /^https?:\/\//.test(url)) e.url = url.slice(0, 1000);
  return e;
}

export async function* parseMyActivity(input: TextInput): AsyncGenerator<LifeEvent[]> {
  const items = new JsonItems();
  const out: LifeEvent[] = [];
  for await (const chunk of input.text) {
    for (const it of items.push(chunk)) {
      const e = activityEvent(it.value);
      if (e) out.push(e);
    }
    yield* drain(out);
  }
  yield* drain(out, true);
}

// Chrome's BrowserHistory.json: {"Browser History": [{"title": "…", "url": "…",
// "time_usec": 1617404690134513, "page_transition": "LINK", "client_id": "…"}]}
export function chromeEvent(r: unknown): LifeEvent | null {
  if (!r || typeof r !== 'object') return null;
  const rec = r as Rec;
  const url = str(rec.url);
  const usec = typeof rec.time_usec === 'number' ? rec.time_usec : Number(rec.time_usec);
  if (!url || !/^https?:\/\//i.test(url) || !Number.isFinite(usec) || usec <= 0) return null;
  const at = Math.round(usec / 1000);
  const host = hostOf(url);
  const page = clean(rec.title, 150) || host || clean(url, 150);
  const e: LifeEvent = { id: `chrome:${hashId('visit', usec, url)}`, source: 'chrome', kind: 'visit', at, title: `Visited ${page}`, url: url.slice(0, 1000), tier: 3 };
  if (host && host !== page) e.detail = host;
  return e;
}

export async function* parseChromeHistory(input: TextInput): AsyncGenerator<LifeEvent[]> {
  const items = new JsonItems(['Browser History']);
  const out: LifeEvent[] = [];
  for await (const chunk of input.text) {
    for (const it of items.push(chunk)) {
      const e = chromeEvent(it.value);
      if (e) out.push(e);
    }
    yield* drain(out);
  }
  yield* drain(out, true);
}
