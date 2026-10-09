// The site's own pages (the privacy policy): the service worker lets them through instead of
// opening the app, and the policy stays a plain page anyone can read.

import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OWN_PAGES, PRIVACY_URL } from './pages';

const PUBLIC = new URL('../../public/', import.meta.url);
// What Workbox's NavigationRoute matches its denylist against: the path and the query.
const passesThrough = (address: string) => {
  const u = new URL(address, 'https://abyyworld.github.io/physical-improvement-tracker-app/');
  return OWN_PAGES.some((re) => re.test(u.pathname + u.search));
};

describe('navigations the service worker leaves alone', () => {
  it('lets the privacy policy through, however it is linked', () => {
    for (const a of ['privacy.html', './privacy.html', 'privacy', 'privacy.html?ref=store', 'privacy.html#ai', '/privacy.html', PRIVACY_URL]) {
      expect(passesThrough(a), a).toBe(true);
    }
  });

  it('still opens the app everywhere else', () => {
    for (const a of ['./', 'index.html', './#settings', '?privacy=1', '?next=/privacy', 'privacy-notes', 'not-privacy.html']) {
      expect(passesThrough(a), a).toBe(false);
    }
  });

  it('covers every page in public/', () => {
    const pages = readdirSync(PUBLIC).filter((f) => f.endsWith('.html'));
    expect(pages).toContain('privacy.html');
    for (const p of pages) expect(passesThrough(p), p).toBe(true);
  });

  it('links the iPhone app to the published copy', () => {
    expect(PRIVACY_URL).toMatch(/^https:\/\/abyyworld\.github\.io\/physical-improvement-tracker-app\/privacy\.html$/);
  });
});

describe('the privacy policy page', () => {
  const html = readFileSync(new URL('privacy.html', PUBLIC), 'utf8');
  const text = html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ');

  it('is a plain page that works on a phone', () => {
    expect(html).toMatch(/<title>Arise privacy policy<\/title>/);
    expect(html).toMatch(/<meta name="viewport" content="width=device-width/);
    expect(html).toMatch(/<html lang="en">/);
    expect(html).not.toMatch(/<script/i);
    expect(html).toMatch(/prefers-color-scheme: light/);
  });

  it('says when it was last updated and how to get in touch', () => {
    expect(text).toMatch(/Last updated: \d{1,2} [A-Z][a-z]+ \d{4}/);
    expect(html).toContain('https://github.com/abyyworld/physical-improvement-tracker-app/issues');
  });

  it('has no long dashes', () => {
    expect(text).not.toMatch(/[\u2013\u2014]/);
  });
});
