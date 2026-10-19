// What kind of time an app or a site is: work, fun, social feeds, or other, from the names and
// ids the Mac helper, the Android app and the browser extension send, and the addresses visited.

import { describe, expect, it } from 'vitest';
import { appOf, categorize, categorizeApp, categorizeDomain, domainOf, isBrowserApp } from './categories';
import type { LifeEvent } from '../life/types';

const ev = (e: Partial<LifeEvent> & Pick<LifeEvent, 'source' | 'kind'>): LifeEvent => ({ id: `${e.source}:x`, at: 0, title: 'Something', tier: 2, ...e });

describe('apps', () => {
  it('knows apps by the Mac helper bundle id, whatever its name', () => {
    // The helper's title has the name the Mac shows ("Code" for VS Code), the meta its bundle id.
    const code = ev({ source: 'mac', kind: 'app', title: 'Used Code for 50 min', meta: { app: 'com.microsoft.VSCode' } });
    expect(appOf(code)).toEqual({ name: 'Code', id: 'com.microsoft.VSCode' });
    expect(categorize(code)).toBe('work');
    expect(categorize(ev({ source: 'mac', kind: 'app', title: 'Used Slack for 25 min', meta: { app: 'com.tinyspeck.slackmacgap' } }))).toBe('work');
    expect(categorize(ev({ source: 'mac', kind: 'app', title: 'Used Music for 40 min', meta: { app: 'com.apple.Music' } }))).toBe('fun');
    // Every JetBrains IDE.
    expect(categorizeApp('PyCharm', 'com.jetbrains.pycharm')).toBe('work');
    expect(categorizeApp('Whatever', 'com.jetbrains.goland')).toBe('work');
  });

  it("knows Android apps by their label and package, and the iPhone's Shortcuts app time by name", () => {
    expect(categorize(ev({ source: 'android', kind: 'app', title: 'Used Instagram for 20 min', meta: { device: 'android', app: 'Instagram', pkg: 'com.instagram.android' } }))).toBe('social');
    expect(categorize(ev({ source: 'android', kind: 'app', title: 'Used TikTok for 1 h', meta: { device: 'android', app: 'TikTok', pkg: 'com.zhiliaoapp.musically' } }))).toBe('social');
    expect(categorize(ev({ source: 'android', kind: 'app', title: 'Used YouTube for 45 min', meta: { device: 'android', app: 'YouTube', pkg: 'com.google.android.youtube' } }))).toBe('fun');
    expect(categorize(ev({ source: 'shortcut', kind: 'app', title: 'Used Netflix for 50 min', meta: { app: 'Netflix' } }))).toBe('fun');
    expect(categorize(ev({ source: 'shortcut', kind: 'app', title: 'Used Notion for 30 min', meta: { app: 'Notion' } }))).toBe('work');
    expect(categorize(ev({ source: 'android', kind: 'app', title: 'Used Calculator for 2 min', meta: { app: 'Calculator', pkg: 'com.android.calculator2' } }))).toBe('other');
  });

  it('matches names whole, case and ".app" aside, and longer names by how they start', () => {
    expect(categorizeApp('Microsoft Teams')).toBe('work');
    expect(categorizeApp('XCODE.app')).toBe('work');
    expect(categorizeApp('IntelliJ IDEA Ultimate')).toBe('work');
    expect(categorizeApp('X')).toBe('social');
    // A short name only on its own: "Word Search" is a game, not Microsoft Word.
    expect(categorizeApp('Word Search')).toBeNull();
    expect(categorizeApp('Xylophone')).toBeNull();
    expect(categorizeApp('')).toBeNull();
  });

  it('takes the person\'s own choices first', () => {
    expect(categorizeApp('WhatsApp')).toBeNull();
    expect(categorizeApp('WhatsApp', '', { apps: { whatsapp: 'social' } })).toBe('social');
    expect(categorizeApp('Code', 'com.microsoft.vscode', { apps: { 'com.microsoft.vscode': 'fun' } })).toBe('fun');
    expect(categorizeDomain('youtube.com', { domains: { 'youtube.com': 'work' } })).toBe('work');
  });

  it('knows the browsers, so their time can be split by the sites visited', () => {
    expect(isBrowserApp(ev({ source: 'mac', kind: 'app', title: 'Used Safari for 40 min', meta: { app: 'com.apple.Safari' } }))).toBe(true);
    expect(isBrowserApp(ev({ source: 'mac', kind: 'app', title: 'Used Google Chrome for 10 min', meta: { app: 'com.google.Chrome' } }))).toBe(true);
    expect(isBrowserApp(ev({ source: 'android', kind: 'app', title: 'Used Chrome for 10 min', meta: { app: 'Chrome', pkg: 'com.android.chrome' } }))).toBe(true);
    expect(isBrowserApp(ev({ source: 'mac', kind: 'app', title: 'Used Code for 10 min', meta: { app: 'com.microsoft.VSCode' } }))).toBe(false);
    // The extension's time on a site is already a site.
    expect(isBrowserApp(ev({ source: 'browser', kind: 'app', title: '30 min on github.com', meta: { site: 'github.com', browser: 'Chrome on macOS' } }))).toBe(false);
  });
});

describe('sites', () => {
  it('takes the address without www. or m.', () => {
    expect(domainOf('https://www.youtube.com/watch?v=1')).toBe('youtube.com');
    expect(domainOf('https://m.facebook.com/home')).toBe('facebook.com');
    expect(domainOf('mobile.twitter.com')).toBe('twitter.com');
    expect(domainOf('GitHub.com/abyyworld')).toBe('github.com');
    expect(domainOf('not a url://')).toBe('');
  });

  it('puts the narrower part of a site first: Google Docs is work, Google search is not', () => {
    expect(categorizeDomain('docs.google.com')).toBe('work');
    expect(categorizeDomain('meet.google.com')).toBe('work');
    expect(categorizeDomain('google.com')).toBeNull();
    expect(categorizeDomain('music.youtube.com')).toBe('fun');
    expect(categorizeDomain('old.reddit.com')).toBe('social');
    expect(categorizeDomain('x.com')).toBe('social');
    expect(categorizeDomain('box.com')).toBeNull(); // not x.com
    expect(categorizeDomain('stackoverflow.com')).toBe('work');
    expect(categorizeDomain('chatgpt.com')).toBe('work');
    expect(categorizeDomain('claude.ai')).toBe('work');
    expect(categorizeDomain('netflix.com')).toBe('fun');
    expect(categorizeDomain('bbc.co.uk')).toBeNull();
  });

  it("knows a school's own course site", () => {
    expect(categorizeDomain('moodle.uni.ac.uk')).toBe('work');
    expect(categorizeDomain('school.instructure.com')).toBe('work');
    expect(categorizeDomain('canvas.school.edu')).toBe('work');
  });

  it('reads the site from the helper and the extension, else from the link', () => {
    expect(categorize(ev({ source: 'mac', kind: 'visit', title: 'Visited Pull requests', url: 'https://github.com/pulls', meta: { browser: 'safari', device: 'mac', site: 'github.com' } }))).toBe('work');
    expect(categorize(ev({ source: 'browser', kind: 'app', title: '55 min on youtube.com', meta: { site: 'youtube.com', browser: 'Chrome on Windows' } }))).toBe('fun');
    expect(categorize(ev({ source: 'chrome', kind: 'visit', title: 'Visited Instagram', url: 'https://www.instagram.com/' }))).toBe('social');
    expect(categorize(ev({ source: 'chrome', kind: 'visit', title: 'Visited BBC News', url: 'https://www.bbc.co.uk/news' }))).toBe('other');
  });
});

describe('the rest', () => {
  it('calls games, videos and music fun from any source', () => {
    expect(categorize(ev({ source: 'psn', kind: 'play', title: 'Played Astro Bot for 1 h' }))).toBe('fun');
    expect(categorize(ev({ source: 'steam', kind: 'other', title: 'Steam' }))).toBe('fun');
    expect(categorize(ev({ source: 'netflix', kind: 'watch', title: 'Watched Dark: S1E1' }))).toBe('fun');
    expect(categorize(ev({ source: 'spotify', kind: 'listen', title: 'Listened to One More Time by Daft Punk' }))).toBe('fun');
  });

  it('leaves everything else as other', () => {
    expect(categorize(ev({ source: 'health', kind: 'steps', title: '6,400 steps' }))).toBe('other');
    expect(categorize(ev({ source: 'mac', kind: 'app', title: 'Used Finder for 3 min', meta: { app: 'com.apple.finder' } }))).toBe('other');
  });
});
