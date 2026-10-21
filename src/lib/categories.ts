// What kind of time an app or a website is, so Arise can tell focused time from fun and from
// social feeds without anyone saying so:
//
//   work:   making and studying: code editors and dev tools, office and docs, design, planning,
//           courses, AI chat, and talking for work (Slack, Teams, Zoom, Meet, Mail)
//   fun:    videos, games and music
//   social: social feeds (Instagram, TikTok, X, Reddit, Facebook, Snapchat, Threads)
//   other:  anything else
//
// Matched case-insensitively on the app's name or id (the Mac helper sends a bundle id, the
// Android app a label and a package name) or on the site's address without "www." or "m.".
// The lists are small and plain on purpose, so they're easy to change; a person's own choices
// can go on top (`own`).
//
// Pure: no app imports.

import type { LifeEvent } from '../life/types';

export type Category = 'work' | 'fun' | 'social' | 'other';
export const CATEGORIES: readonly Category[] = ['work', 'fun', 'social', 'other'];

// Apps by name, as people see them. A name matches when it is one of these, or starts with one of
// five letters or more and a space ("IntelliJ IDEA Ultimate").
export const APPS: Record<Exclude<Category, 'other'>, readonly string[]> = {
  work: [
    // code and dev tools
    'visual studio code', 'vs code', 'code', 'xcode', 'cursor', 'terminal', 'iterm', 'iterm2', 'warp', 'ghostty', 'intellij idea', 'pycharm', 'webstorm',
    'goland', 'clion', 'rider', 'phpstorm', 'rubymine', 'datagrip', 'android studio', 'fleet', 'github desktop', 'sublime text', 'zed', 'nova', 'bbedit',
    'docker desktop', 'postman', 'tower', 'sourcetree',
    // office, docs, design and planning
    'microsoft word', 'word', 'microsoft excel', 'excel', 'microsoft powerpoint', 'powerpoint', 'microsoft onenote', 'onenote', 'pages', 'numbers', 'keynote',
    'google docs', 'google sheets', 'google slides', 'google drive', 'notion', 'obsidian', 'figma', 'sketch', 'linear', 'jira', 'confluence', 'trello', 'asana',
    'craft', 'bear', 'ulysses', 'scrivener', 'overleaf', 'zotero', 'anki',
    // study and AI chat
    'canvas', 'canvas student', 'moodle', 'coursera', 'khan academy', 'duolingo', 'chatgpt', 'claude', 'gemini', 'perplexity',
    // talking for work
    'slack', 'microsoft teams', 'teams', 'zoom', 'zoom.us', 'zoom workplace', 'google meet', 'webex', 'mail', 'outlook', 'microsoft outlook', 'gmail', 'spark', 'superhuman',
  ],
  fun: [
    'youtube', 'netflix', 'twitch', 'prime video', 'amazon prime video', 'disney+', 'disney plus', 'hulu', 'max', 'hbo max', 'apple tv', 'tv', 'plex', 'vlc', 'iina', 'crunchyroll',
    'steam', 'epic games launcher', 'epic games', 'battle.net', 'minecraft', 'roblox', 'league of legends', 'fortnite', 'xbox', 'playstation', 'game center',
    'spotify', 'music', 'apple music', 'youtube music', 'soundcloud', 'tidal', 'deezer', 'podcasts', 'audible',
  ],
  social: ['instagram', 'tiktok', 'x', 'twitter', 'reddit', 'facebook', 'snapchat', 'threads', 'pinterest', 'tumblr', 'bluesky', 'mastodon', 'be real', 'bereal'],
};

// Apps by their id: Mac bundle ids and Android package names, lower case. An id ending in "."
// matches every id that starts with it.
export const APP_IDS: Record<Exclude<Category, 'other'>, readonly string[]> = {
  work: [
    'com.microsoft.vscode', 'com.microsoft.vscodeinsiders', 'com.apple.dt.xcode', 'com.todesktop.230313mzl4w4u92', 'com.apple.terminal', 'com.googlecode.iterm2',
    'dev.warp.warp-stable', 'com.mitchellh.ghostty', 'com.jetbrains.', 'com.google.android.studio', 'com.github.githubclient', 'com.sublimetext.', 'dev.zed.zed',
    'com.microsoft.word', 'com.microsoft.excel', 'com.microsoft.powerpoint', 'com.microsoft.onenote.mac', 'com.apple.iwork.pages', 'com.apple.iwork.numbers',
    'com.apple.iwork.keynote', 'notion.id', 'md.obsidian', 'com.figma.desktop', 'com.linear', 'com.atlassian.', 'com.tinyspeck.slackmacgap', 'com.slack',
    'com.microsoft.teams', 'com.microsoft.teams2', 'us.zoom.xos', 'us.zoom.videomeetings', 'com.google.android.apps.meetings', 'com.apple.mail',
    'com.microsoft.outlook', 'com.microsoft.office.outlook', 'com.google.android.gm', 'com.openai.chat', 'com.openai.chatgpt', 'com.anthropic.claudefordesktop',
    'com.anthropic.claude', 'com.instructure.candroid', 'com.moodle.moodlemobile', 'org.coursera.android', 'org.khanacademy.android', 'com.duolingo',
    'com.google.android.apps.docs', 'com.google.android.apps.docs.editors.',
  ],
  fun: [
    'com.google.android.youtube', 'com.google.ios.youtube', 'com.netflix.mediaclient', 'com.netflix.netflix', 'tv.twitch.android.app', 'tv.twitch',
    'com.amazon.avod.thirdpartyclient', 'com.amazon.aiv.aivapp', 'com.disney.disneyplus', 'com.hulu.plus', 'com.wbd.stream', 'com.apple.tv', 'org.videolan.vlc',
    'com.colliderli.iina', 'com.valvesoftware.steam', 'com.epicgames.', 'net.battle.app', 'com.blizzard.', 'com.mojang.', 'com.roblox.', 'com.riotgames.',
    'com.spotify.client', 'com.spotify.music', 'com.apple.music', 'com.apple.podcasts', 'com.google.android.apps.youtube.music', 'com.soundcloud.android',
    'com.audible.application',
  ],
  social: [
    'com.instagram.android', 'com.burbn.instagram', 'com.zhiliaoapp.musically', 'com.ss.android.ugc.trill', 'com.twitter.android', 'com.atebits.tweetie2',
    'com.reddit.frontpage', 'com.facebook.katana', 'com.facebook.facebook', 'com.snapchat.android', 'com.toyopagroup.picaboo', 'com.instagram.barcelona',
    'com.pinterest', 'com.tumblr', 'xyz.blueskyweb.app', 'com.bereal.ft',
  ],
};

// Sites by their address. A site matches when the address is one of these or ends in "." and
// one of these ("music.youtube.com" is youtube.com), so put the narrower one first where a
// part of a site is different from the rest (docs.google.com is work, google.com is other).
export const DOMAINS: Record<Exclude<Category, 'other'>, readonly string[]> = {
  work: [
    'github.com', 'gitlab.com', 'bitbucket.org', 'stackoverflow.com', 'stackexchange.com', 'docs.google.com', 'sheets.google.com', 'slides.google.com',
    'drive.google.com', 'meet.google.com', 'mail.google.com', 'calendar.google.com', 'gemini.google.com', 'notion.so', 'notion.site', 'figma.com', 'linear.app',
    'atlassian.net', 'atlassian.com', 'jira.com', 'trello.com', 'asana.com', 'overleaf.com', 'coursera.org', 'khanacademy.org', 'edx.org', 'udemy.com',
    'instructure.com', 'duolingo.com', 'chatgpt.com', 'chat.openai.com', 'claude.ai', 'perplexity.ai', 'slack.com', 'teams.microsoft.com', 'teams.live.com',
    'zoom.us', 'outlook.office.com', 'outlook.live.com', 'office.com', 'sharepoint.com', 'onedrive.live.com', 'webex.com', 'vercel.com', 'netlify.com',
    'developer.mozilla.org', 'npmjs.com', 'pypi.org',
  ],
  fun: [
    'youtube.com', 'youtu.be', 'netflix.com', 'twitch.tv', 'primevideo.com', 'disneyplus.com', 'hulu.com', 'max.com', 'tv.apple.com', 'music.apple.com',
    'crunchyroll.com', 'store.steampowered.com', 'steamcommunity.com', 'epicgames.com', 'roblox.com', 'chess.com', 'lichess.org', 'spotify.com', 'soundcloud.com',
    'tidal.com', 'deezer.com', 'bandcamp.com',
  ],
  social: [
    'instagram.com', 'tiktok.com', 'x.com', 'twitter.com', 'reddit.com', 'facebook.com', 'snapchat.com', 'threads.net', 'threads.com', 'pinterest.com',
    'tumblr.com', 'bsky.app', 'mastodon.social',
  ],
};

// Course sites that each school hosts on its own address ("moodle.uni.ac.uk", "school.instructure.com").
const STUDY_HOST = /(^|\.)(moodle|canvas|blackboard|brightspace)\./;

// The browsers: time in them is split by the sites visited (src/life/signals.ts).
const BROWSER_NAMES = ['safari', 'google chrome', 'chrome', 'firefox', 'microsoft edge', 'edge', 'arc', 'brave browser', 'brave', 'opera', 'vivaldi', 'orion', 'chromium', 'samsung internet', 'duckduckgo'];
const BROWSER_IDS = ['com.apple.safari', 'com.google.chrome', 'org.mozilla.firefox', 'com.microsoft.edgemac', 'company.thebrowser.browser', 'com.brave.browser', 'com.operasoftware.opera', 'com.vivaldi.vivaldi', 'com.kagi.kagimacos', 'org.chromium.chromium', 'com.android.chrome', 'com.sec.android.app.sbrowser', 'com.duckduckgo.mobile.android', 'org.mozilla.firefox_beta', 'com.microsoft.emmx'];

// A person's own choices, on top of the lists: app names or ids, and sites.
export interface Own {
  apps?: Record<string, Category>;
  domains?: Record<string, Category>;
}

const lower = (s: unknown) => (typeof s === 'string' ? s.trim().toLowerCase() : '');
// Mac bundle ids and Android package names look like "com.apple.Safari".
const looksLikeId = (s: string) => /^[a-z][\w-]*(\.[\w-]+){2,}$/i.test(s);

// The site's address without "www.", "m." or "mobile.", from a link or an address.
export function domainOf(urlOrHost: string): string {
  const s = lower(urlOrHost);
  if (!s) return '';
  let host = s;
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(s)) {
    try {
      host = new URL(s).hostname;
    } catch {
      return '';
    }
  } else host = s.split(/[/?#:]/)[0];
  host = host.replace(/^(www\d?|m|mobile)\./, '').replace(/\.$/, '');
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : '';
}

const idMatch = (id: string, list: readonly string[]) => list.some((x) => (x.endsWith('.') ? id.startsWith(x) : id === x));
// Short names ("x", "tv", "word") only on their own: "Word Search" is a game.
const nameMatch = (name: string, list: readonly string[]) => list.some((x) => name === x || (x.length >= 5 && name.startsWith(`${x} `)));
const hostMatch = (host: string, d: string) => host === d || host.endsWith(`.${d}`);

// An app, by its name and its id when there is one; null when the lists don't know it.
export function categorizeApp(name: string, id = '', own?: Own): Category | null {
  const n = lower(name).replace(/\.app$/, '');
  const i = lower(id);
  for (const key of [i, n]) if (key && own?.apps?.[key]) return own.apps[key];
  for (const c of ['social', 'fun', 'work'] as const) if (i && idMatch(i, APP_IDS[c])) return c;
  for (const c of ['social', 'fun', 'work'] as const) if (n && nameMatch(n, APPS[c])) return c;
  return null;
}

// A site, by its address; null when the lists don't know it.
export function categorizeDomain(urlOrHost: string, own?: Own): Category | null {
  const host = domainOf(urlOrHost);
  if (!host) return null;
  if (own?.domains) {
    const mine = Object.entries(own.domains).find(([d]) => hostMatch(host, domainOf(d)));
    if (mine) return mine[1];
  }
  // The narrowest match wins: docs.google.com before google.com, music.youtube.com is youtube.com.
  let best: { c: Category; len: number } | null = null;
  for (const c of ['work', 'fun', 'social'] as const) {
    for (const d of DOMAINS[c]) if (hostMatch(host, d) && (!best || d.length > best.len)) best = { c, len: d.length };
  }
  if (best) return best.c;
  return STUDY_HOST.test(host) ? 'work' : null;
}

// The app an event is about: its name ("Visual Studio Code") and its id ("com.microsoft.VSCode").
export function appOf(e: Pick<LifeEvent, 'title' | 'meta'>): { name: string; id: string } {
  const app = typeof e.meta?.app === 'string' ? e.meta.app.trim() : '';
  const pkg = typeof e.meta?.pkg === 'string' ? e.meta.pkg.trim() : '';
  const fromTitle = e.title.replace(/^(Used|Opened|Closed)\s+/i, '').replace(/\s+for\s+(\d|under\b).*$/i, '').trim();
  // Some bundle ids have only two parts ("notion.id", "md.obsidian", "com.linear"): one with a
  // dot and no spaces is an id too when the title gives the app another name ("zoom.us" is a name).
  const isId = looksLikeId(app) || (/^[a-z][\w-]*\.[\w-]+$/i.test(app) && !!fromTitle && fromTitle.toLowerCase() !== app.toLowerCase());
  const id = pkg || (isId ? app : '');
  const name = app && !isId ? app : fromTitle;
  return { name, id };
}

// The site an event is on: the extension's and the helper's `site`, else its link.
export function siteOf(e: Pick<LifeEvent, 'url' | 'meta' | 'detail'>): string {
  const site = typeof e.meta?.site === 'string' ? e.meta.site : '';
  return domainOf(site || e.url || '');
}

// Time in a browser: split by the sites visited, where Arise knows them.
export function isBrowserApp(e: Pick<LifeEvent, 'title' | 'meta' | 'source' | 'kind'>): boolean {
  if (e.kind !== 'app' || e.source === 'browser') return false;
  const { name, id } = appOf(e);
  const n = lower(name);
  const i = lower(id);
  return (!!i && BROWSER_IDS.includes(i)) || (!!n && nameMatch(n, BROWSER_NAMES));
}

// What kind of time an event is. Games are fun whatever they are, and so are videos and music
// from any source; a site or an app is looked up in the lists.
export function categorize(e: Pick<LifeEvent, 'kind' | 'source' | 'title'> & Partial<Pick<LifeEvent, 'url' | 'meta' | 'detail'>>, own?: Own): Category {
  if (e.kind === 'play' || e.kind === 'watch' || e.kind === 'listen' || e.source === 'steam' || e.source === 'psn') return 'fun';
  const site = siteOf({ url: e.url, meta: e.meta, detail: e.detail });
  if (site) {
    const c = categorizeDomain(site, own);
    if (c) return c;
  }
  if (e.kind === 'app' || e.kind === 'notification') {
    const { name, id } = appOf({ title: e.title, meta: e.meta });
    const c = categorizeApp(name, id, own);
    if (c) return c;
  }
  return 'other';
}
