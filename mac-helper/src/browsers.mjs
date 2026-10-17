// The other browsers' history: Chrome, Edge, Brave, Arc, Vivaldi and Opera (all built on
// Chromium, so they keep the same History file) and Firefox (places.sqlite). Each profile is read
// on its own, with its own cursor, the way Safari's profiles are.
//
// These browsers lock their history while they run. The helper then reads what the browser has
// already saved in the file (snapshot.mjs, `evenLocked`), and the newest visits on a later read.
// Each visit is a life event like Safari's; a search (the browser's own record of what was typed
// in its address bar, or a search engine's results page) is a search.

import fs from 'node:fs';
import path from 'node:path';
import { columns, hasTable } from './snapshot.mjs';
import { APPLE_EPOCH } from './time.mjs';
import { clip, col, page, str } from './sources.mjs';

// Where each keeps its profiles, under ~/Library/Application Support.
export const BROWSERS = [
  { key: 'chrome', name: 'Chrome', dir: ['Google', 'Chrome'] },
  { key: 'edge', name: 'Edge', dir: ['Microsoft Edge'] },
  { key: 'brave', name: 'Brave', dir: ['BraveSoftware', 'Brave-Browser'] },
  { key: 'arc', name: 'Arc', dir: ['Arc', 'User Data'] },
  { key: 'vivaldi', name: 'Vivaldi', dir: ['Vivaldi'] },
  { key: 'opera', name: 'Opera', dir: ['com.operasoftware.Opera'] },
];

/** @typedef {{ key: string, browser: string, name: string, type: 'chromium' | 'firefox', file: string }} Profile */

const list = (dir) => {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
};
const isFile = (f) => {
  try {
    return fs.statSync(f).isFile();
  } catch {
    return false;
  }
};
const tag = (s) => s.replace(/[^\w-]/g, '').slice(0, 40);

// Every profile's history there is. Chromium's profiles are "Default", "Profile 1" and so on (Opera
// keeps its one profile in the folder itself); Firefox's are in Profiles/.
/** @param {string} userHome @returns {Profile[]} */
export function browserFiles(userHome) {
  const support = path.join(userHome, 'Library', 'Application Support');
  /** @type {Profile[]} */
  const out = [];
  for (const b of BROWSERS) {
    const root = path.join(support, ...b.dir);
    for (const d of ['', ...list(root).filter((x) => /^(Default|Profile \d+)$/.test(x))]) {
      const file = path.join(root, d, 'History');
      if (isFile(file)) out.push({ key: d ? `${b.key}:${tag(d)}` : b.key, browser: b.key, name: b.name, type: 'chromium', file });
    }
  }
  const ff = path.join(support, 'Firefox', 'Profiles');
  for (const d of list(ff)) {
    const file = path.join(ff, d, 'places.sqlite');
    if (isFile(file)) out.push({ key: `firefox:${tag(d)}`, browser: 'firefox', name: 'Firefox', type: 'firefox', file });
  }
  return out;
}

const none = (after) => ({ rows: [], cursor: after, more: false, unknown: true });

// ---------- Chromium: History (urls, visits, keyword_search_terms)

// Chromium counts time in microseconds since 1601-01-01; this many ms before 1970.
const MS_1601 = 11644473600000;

/** @param {import('node:sqlite').DatabaseSync} db */
export function readChromium(db, { after = 0, since = 0 } = {}) {
  if (!hasTable(db, 'visits') || !hasTable(db, 'urls')) return none(after);
  const v = columns(db, 'visits');
  const u = columns(db, 'urls');
  if (!v.has('id') || !v.has('url') || !v.has('visit_time') || !u.has('id') || !u.has('url')) return none(after);
  const terms = hasTable(db, 'keyword_search_terms') && ['url_id', 'term'].every((c) => columns(db, 'keyword_search_terms').has(c));
  // A visit's time doesn't fit in a JavaScript number (node:sqlite won't read it), so SQLite turns
  // it into ms since 1970 first.
  const sql = `SELECT v.id AS id, v.visit_time / 1000 - ${MS_1601} AS ms, ${col(v, 'transition', 'v.transition')} AS tr,
      ${col(v, 'originator_cache_guid', 'v.originator_cache_guid')} AS origin, u.url AS url, ${col(u, 'title', 'u.title')} AS title,
      ${col(u, 'hidden', 'u.hidden')} AS hidden, ${terms ? '(SELECT k.term FROM keyword_search_terms k WHERE k.url_id = u.id LIMIT 1)' : 'NULL'} AS term
    FROM visits v JOIN urls u ON u.id = v.url
    WHERE v.id > ? AND v.visit_time >= ? ORDER BY v.id LIMIT ?`;
  return page(db, 'visits', 'id', 'id', after, sql, [(BigInt(Math.max(0, Math.floor(since))) + BigInt(MS_1601)) * 1000n]);
}

// ---------- Firefox: places.sqlite (moz_places, moz_historyvisits)

/** @param {import('node:sqlite').DatabaseSync} db */
export function readFirefox(db, { after = 0, since = 0 } = {}) {
  if (!hasTable(db, 'moz_historyvisits') || !hasTable(db, 'moz_places')) return none(after);
  const v = columns(db, 'moz_historyvisits');
  const p = columns(db, 'moz_places');
  if (!['id', 'place_id', 'visit_date'].every((c) => v.has(c)) || !p.has('id') || !p.has('url')) return none(after);
  // Microseconds since 1970.
  const sql = `SELECT v.id AS id, v.visit_date / 1000 AS ms, ${col(v, 'visit_type', 'v.visit_type')} AS type, p.url AS url,
      ${col(p, 'title', 'p.title')} AS title, ${col(p, 'hidden', 'p.hidden')} AS hidden
    FROM moz_historyvisits v JOIN moz_places p ON p.id = v.place_id
    WHERE v.id > ? AND v.visit_date >= ? ORDER BY v.id LIMIT ?`;
  return page(db, 'moz_historyvisits', 'id', 'id', after, sql, [Math.max(0, Math.floor(since)) * 1000]);
}

// ---------- searches on a results page

const TLD = String.raw`(?:com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})`;
/** @type {[RegExp, RegExp, string[]][]} host, path, where the words are */
const ENGINES = [
  [new RegExp(`^(www\\.)?google\\.${TLD}$`), /^\/search\/?$/, ['q']],
  [/^(www\.|cn\.)?bing\.com$/, /^\/search\/?$/, ['q']],
  [/^(html\.|lite\.|start\.)?duckduckgo\.com$/, /^\/((html|lite)\/?)?$/, ['q']],
  [/^([a-z]{2}\.)?search\.yahoo\.(com|co\.jp)$/, /^\/search/, ['p', 'q']],
  [/^(www\.)?(yandex|ya)\.(ru|com|com\.tr|kz|by)$/, /^\/search\/?$/, ['text']],
  [/^(www\.)?ecosia\.org$/, /^\/search\/?$/, ['q']],
  [/^search\.brave\.com$/, /^\/search\/?$/, ['q']],
  [/^(www\.)?startpage\.com$/, /^\/(do|sp)\/search\/?$/, ['query', 'q']],
  [/^kagi\.com$/, /^\/search\/?$/, ['q']],
  [/^(www\.)?baidu\.com$/, /^\/s\/?$/, ['wd', 'word']],
  [/^(www\.)?perplexity\.ai$/, /^\/search(\/new)?\/?$/, ['q']],
  [/^(www\.|m\.)?youtube\.com$/, /^\/results\/?$/, ['search_query']],
];

// The words of a search engine's results page, and its address with only those words (not the
// tracking and paging the rest of it has). null for any other page.
/** @param {URL} url @returns {{ words: string, url: string } | null} */
export function searchOf(url) {
  for (const [host, at, params] of ENGINES) {
    if (!host.test(url.hostname) || !at.test(url.pathname)) continue;
    for (const k of params) {
      const words = clip(url.searchParams.get(k), 200);
      if (words) return { words, url: `${url.origin}${url.pathname}?${k}=${encodeURIComponent(words)}` };
    }
  }
  return null;
}

// ---------- visits and searches as life events

// Chromium's page transitions: the low byte says how the page was reached (3 and 4 are frames
// inside a page, 8 a reload); a visit that starts a chain of redirects but doesn't end it only
// sent the browser on to the next page, which is its own visit.
const FRAME = new Set([3, 4]);
const RELOAD = 8;
const CHAIN_START = 0x10000000;
const CHAIN_END = 0x20000000;
// Firefox's visit types: 4 something inside a page, 7 a download, 8 a link in a frame, 9 a reload.
const FIREFOX_SKIP = new Set([4, 7, 8, 9]);

const href = (url) => (url.href.length > 2000 ? `${url.origin}${url.pathname}`.slice(0, 2000) : url.href);

/** @param {any} row @param {Profile} profile */
export function webEvent(row, profile) {
  const at = Number(row.ms);
  if (!Number.isFinite(at) || at <= APPLE_EPOCH * 1000 || at >= 4102444800000) return null;
  // Pages the browser hides from its own history (redirects, frames).
  if (Number(row.hidden) === 1) return null;
  if (profile.type === 'chromium' && row.tr != null) {
    const t = Number(row.tr);
    if (FRAME.has(t & 0xff) || (t & 0xff) === RELOAD) return null;
    if (t & (CHAIN_START | CHAIN_END) && !(t & CHAIN_END)) return null;
  }
  if (profile.type === 'firefox' && FIREFOX_SKIP.has(Number(row.type))) return null;
  let url;
  try {
    url = new URL(str(row.url));
  } catch {
    return null;
  }
  // Web pages only: not the browser's own pages (chrome://, edge://, about:), files, or extensions.
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.replace(/^www\./, '');
  // Chrome keeps the history of the person's other devices in the same file, when it syncs it.
  const elsewhere = !!str(row.origin);
  const base = {
    id: `mac:web:${profile.key}:${Number(row.id)}-${Math.round(at / 1000)}`,
    source: 'mac',
    at,
  };
  const meta = { browser: profile.browser, device: elsewhere ? 'other' : 'mac', site: clip(host, 100) };
  const extra = elsewhere ? { detail: 'On another device' } : {};
  const found = searchOf(url);
  const words = clip(str(row.term), 200) || found?.words || '';
  if (words) return { ...base, kind: 'search', title: `Searched "${clip(words, 150)}"`, ...extra, url: found ? found.url : href(url), tier: 3, meta };
  return { ...base, kind: 'visit', title: `Visited ${clip(str(row.title), 120) || host}`, ...extra, url: href(url), tier: 3, meta };
}

// Going back to a results page, or on to its next page, is the same search: once in 30 minutes.
/** @param {any[]} rows @param {Profile} profile */
export function webEvents(rows, profile) {
  /** @type {Map<string, number>} */
  const last = new Map();
  const out = [];
  for (const row of rows) {
    const ev = webEvent(row, profile);
    if (!ev) continue;
    if (ev.kind === 'search') {
      const k = ev.title.toLowerCase();
      const before = last.get(k);
      last.set(k, ev.at);
      if (before !== undefined && ev.at - before >= 0 && ev.at - before < 30 * 60000) continue;
    }
    out.push(ev);
  }
  return out;
}
