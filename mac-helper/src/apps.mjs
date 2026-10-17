// App use: which app is in front, and for how long, per hour.
//
// Every 15 seconds the helper asks macOS which app is in front (`lsappinfo`, which needs no
// permission) and how long since the last key press or mouse move (`ioreg`). Time goes to the app
// in front while someone is there; the lock screen, the screen saver and 5 minutes without input
// don't count. Each app's time is added up per hour, and an hour is handed over once it's over,
// as one event per app ("Used Xcode for 40 min").
//
// When app use is first turned on, the week before can come from Screen Time's own records
// (knowledgeC.db, "/app/usage"), where this macOS still keeps them.

import path from 'node:path';
import { hasTable } from './snapshot.mjs';
import { HOUR, appleToMs, duration, hourStart, msToApple } from './time.mjs';

// ---------- names

const KNOWN = {
  'com.apple.MobileSMS': 'Messages',
  'com.apple.mail': 'Mail',
  'com.apple.iCal': 'Calendar',
  'com.apple.reminders': 'Reminders',
  'com.apple.FaceTime': 'FaceTime',
  'com.apple.Safari': 'Safari',
  'com.apple.finder': 'Finder',
  'com.apple.Terminal': 'Terminal',
  'com.apple.Notes': 'Notes',
  'com.apple.Music': 'Music',
  'com.apple.TV': 'TV',
  'com.apple.Photos': 'Photos',
  'com.apple.Preview': 'Preview',
  'com.apple.systempreferences': 'System Settings',
  'com.apple.AppStore': 'App Store',
  'com.apple.ScreenContinuity': 'iPhone Mirroring',
  'com.apple.mobilephone': 'Phone',
  'com.apple.dt.Xcode': 'Xcode',
  'com.google.Chrome': 'Chrome',
  'com.microsoft.edgemac': 'Edge',
  'org.mozilla.firefox': 'Firefox',
  'company.thebrowser.Browser': 'Arc',
  'com.microsoft.VSCode': 'VS Code',
  'com.tinyspeck.slackmacgap': 'Slack',
  'net.whatsapp.WhatsApp': 'WhatsApp',
  'desktop.WhatsApp': 'WhatsApp',
  'ru.keepcoder.Telegram': 'Telegram',
  'org.telegram.desktop': 'Telegram',
  'com.spotify.client': 'Spotify',
  'us.zoom.xos': 'Zoom',
  'com.hnc.Discord': 'Discord',
  'com.microsoft.teams2': 'Microsoft Teams',
  'com.openai.chat': 'ChatGPT',
  'com.anthropic.claudefordesktop': 'Claude',
  'notion.id': 'Notion',
  'com.figma.Desktop': 'Figma',
};

/** @type {Map<string, string>} */
const learned = new Map();

// What macOS calls an app, learned while it was in front (or found with Spotlight).
export function rememberAppName(bundle, name) {
  const n = String(name ?? '').trim().slice(0, 60);
  if (bundle && n) learned.set(bundle, n);
}
export const learnedNames = () => Object.fromEntries(learned);
export const hasAppName = (bundle) => learned.has(bundle) || !!KNOWN[bundle];

// A readable name for a bundle id: "com.spotify.client" is "Spotify".
export function appName(bundle) {
  const b = String(bundle ?? '');
  if (learned.has(b)) return /** @type {string} */ (learned.get(b));
  if (KNOWN[b]) return KNOWN[b];
  const parts = b.split('.').filter(Boolean);
  let last = parts.pop() || 'an app';
  if (/^(app|mac|macos|osx|desktop|client|application)$/i.test(last) && parts.length > 1) last = parts.pop() || last;
  return last.charAt(0).toUpperCase() + last.slice(1);
}

// Spotlight's name for an app it can find by bundle id, or ''.
/** @param {string} bundle @param {(cmd: string, args: string[]) => Promise<string>} run */
export async function findAppName(bundle, run) {
  if (!/^[\w.-]+$/.test(bundle)) return '';
  try {
    const out = await run('/usr/bin/mdfind', [`kMDItemCFBundleIdentifier == '${bundle}'`]);
    const app = out.split('\n').find((l) => l.trim().endsWith('.app'));
    return app ? path.basename(app.trim(), '.app') : '';
  } catch {
    return '';
  }
}

// ---------- what's in front

// `lsappinfo front` prints the front app's id, like ASN:0x0-0x2b02b:
export const parseFront = (text) => /ASN:0x[0-9a-f]+-0x[0-9a-f]+:?/i.exec(String(text))?.[0] || '';

// `lsappinfo info -only bundleid -only name <ASN>` prints lines like
//   "CFBundleIdentifier"="com.apple.Safari"
//   "LSDisplayName"="Safari"
export function parseAppInfo(text) {
  /** @type {Record<string, string>} */
  const pairs = {};
  for (const m of String(text).matchAll(/"([^"]+)"\s*=\s*"((?:[^"\\]|\\.)*)"/g)) pairs[m[1]] = m[2];
  const bundle = pairs.CFBundleIdentifier || pairs.bundleID || '';
  const name = pairs.LSDisplayName || pairs.CFBundleName || '';
  return bundle ? { bundle, name: name || appName(bundle) } : null;
}

// Seconds since the last key press, click or mouse move, from `ioreg -c IOHIDSystem`.
export function parseIdle(text) {
  const m = /"HIDIdleTime"\s*=\s*(\d+)/.exec(String(text));
  return m ? Number(m[1]) / 1e9 : null;
}

// Not using an app: the lock screen and the screen saver.
const AWAY = new Set(['com.apple.loginwindow', 'com.apple.ScreenSaver.Engine']);

// ---------- adding up per hour

/**
 * @typedef {{ bundle: string, name: string, hour: number, first: number, last: number, secs: number }} Bucket
 * @typedef {{ bundle: string, name: string, at: number }} Seen
 */

export class AppTracker {
  /** @param {{ idleLimit?: number, minSeconds?: number, maxGap?: number }} [opts] @param {any} [saved] */
  constructor({ idleLimit = 300, minSeconds = 60, maxGap = 60 } = {}, saved) {
    this.idleLimit = idleLimit;
    this.minSeconds = minSeconds;
    this.maxGap = maxGap;
    /** @type {Record<string, Bucket>} */
    this.buckets = {};
    /** @type {Seen | null} */
    this.prev = null;
    if (saved && typeof saved === 'object') {
      for (const [k, b] of Object.entries(saved.buckets || {})) {
        if (b && typeof b.bundle === 'string' && Number.isFinite(b.hour) && Number.isFinite(b.secs)) this.buckets[k] = { ...b, name: String(b.name || appName(b.bundle)) };
      }
      if (saved.prev && typeof saved.prev.bundle === 'string' && Number.isFinite(saved.prev.at)) this.prev = saved.prev;
    }
  }

  /**
   * One look at the screen: `front` is the app in front now ({ bundle, name } or null), `idle` the
   * seconds without input. The time since the last look goes to the app that was in front then
   * (at most a minute: a sleeping Mac doesn't count). Returns the hours that just ended.
   * @param {number} now @param {{ bundle: string, name: string } | null} front @param {number | null} idle
   */
  tick(now, front, idle) {
    const prev = this.prev;
    if (prev && now > prev.at) {
      let end = Math.min(now, prev.at + this.maxGap * 1000);
      // Gone since the last input: the time after it doesn't count.
      if (idle != null && idle >= this.idleLimit) end = Math.min(end, Math.max(prev.at, now - idle * 1000));
      this.add(prev, prev.at, end);
    }
    const here = !!front?.bundle && !AWAY.has(front.bundle) && (idle == null || idle < this.idleLimit);
    this.prev = here && front ? { bundle: front.bundle, name: front.name || appName(front.bundle), at: now } : null;
    return this.close(now);
  }

  /** @param {{ bundle: string, name: string }} app @param {number} from @param {number} to */
  add(app, from, to) {
    while (from < to) {
      const hour = hourStart(from);
      const end = Math.min(to, hour + HOUR);
      const key = `${hour}|${app.bundle}`;
      const b = (this.buckets[key] ||= { bundle: app.bundle, name: app.name, hour, first: from, last: end, secs: 0 });
      b.secs += (end - from) / 1000;
      b.first = Math.min(b.first, from);
      b.last = Math.max(b.last, end);
      from = end;
    }
  }

  // The hours before `now`'s, as events (an app used under a minute in an hour is left out).
  close(now) {
    const current = hourStart(now);
    const out = [];
    for (const [key, b] of Object.entries(this.buckets)) {
      if (b.hour >= current) continue;
      delete this.buckets[key];
      if (b.secs >= this.minSeconds) out.push(appEvent(b));
    }
    return out.sort((a, b) => a.at - b.at);
  }

  toJSON() {
    return { buckets: this.buckets, prev: this.prev };
  }
}

/** @param {Bucket} b */
export function appEvent(b) {
  const name = b.name || appName(b.bundle);
  return {
    id: `mac:app:${b.bundle}:${b.hour}`,
    source: 'mac',
    kind: 'app',
    at: Math.round(b.first),
    end: Math.round(b.last),
    title: `Used ${name} for ${duration(b.secs)}`,
    value: Math.round(b.secs / 60),
    unit: 'min',
    tier: 2,
    meta: { app: b.bundle },
  };
}

// ---------- the week before, from Screen Time's records

// Screen Time's "/app/usage" stream in ~/Library/Application Support/Knowledge/knowledgeC.db, added
// up the same way, for whole hours from `since` until the hour `until` falls in.
/** @param {import('node:sqlite').DatabaseSync} db @param {{ since: number, until: number, minSeconds?: number }} range */
export function readKnowledgeApps(db, { since, until, minSeconds = 60 }) {
  if (!hasTable(db, 'ZOBJECT')) return [];
  const stop = hourStart(until);
  const rows = /** @type {any[]} */ (
    db
      .prepare("SELECT ZVALUESTRING AS bundle, ZSTARTDATE AS start, ZENDDATE AS end FROM ZOBJECT WHERE ZSTREAMNAME = '/app/usage' AND ZENDDATE > ? AND ZSTARTDATE < ? ORDER BY ZSTARTDATE")
      .all(msToApple(since), msToApple(stop))
  );
  const t = new AppTracker({ minSeconds });
  for (const r of rows) {
    const from = appleToMs(r.start);
    const to = appleToMs(r.end);
    const bundle = typeof r.bundle === 'string' ? r.bundle : '';
    if (!from || !to || to <= from || !bundle || AWAY.has(bundle)) continue;
    t.add({ bundle, name: appName(bundle) }, Math.max(from, since), Math.min(to, stop));
  }
  return t.close(stop);
}
