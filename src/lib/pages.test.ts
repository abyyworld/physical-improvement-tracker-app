// The site's own pages (the privacy policy): the service worker lets them through instead of
// opening the app, and the policy stays a plain page anyone can read.

import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isAccountCode } from './crypto';
import { OWN_PAGE_FILES, OWN_PAGES, PRIVACY_URL } from './pages';

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
    // A shared goal's link too: the app's page shows it (main.ts), offline or not.
    for (const a of ['./', 'index.html', './#settings', `./#share=${'a'.repeat(22)}.${'b'.repeat(43)}`, '?privacy=1', '?next=/privacy', 'privacy-notes', 'not-privacy.html']) {
      expect(passesThrough(a), a).toBe(false);
    }
  });

  it('covers every page in public/', () => {
    const pages = readdirSync(PUBLIC).filter((f) => f.endsWith('.html'));
    expect(pages).toContain('privacy.html');
    for (const p of pages) expect(passesThrough(p), p).toBe(true);
  });

  // Kept offline, an old copy of the policy would show until the app next updates itself.
  it('never keeps an old copy of them offline', () => {
    for (const p of readdirSync(PUBLIC).filter((f) => f.endsWith('.html'))) expect(OWN_PAGE_FILES, p).toContain(p);
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

  // Sections by their headings, so a check can't pass on words from somewhere else on the page.
  const section = (id: string) => {
    const m = new RegExp(`id="${id}"[\\s\\S]*?(?=<h2|$)`).exec(html);
    return (m?.[0] || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  };

  it('tells people who can no longer sign in how to get their account deleted', () => {
    expect(section('choices')).toMatch(/needs your password/);
    expect(section('choices')).toMatch(/Can't sign in any more\?/);
    expect(section('children')).toMatch(/password/);
    expect(section('contact')).toMatch(/delete an account you can't sign in to/);
  });

  it('names every way a plain password or a reset email can come about', () => {
    expect(section('account')).toMatch(/password was set from a reset email/);
    expect(section('account')).toMatch(/any email account/);
  });

  it('says what the private AI proxy gets and how long its counter lasts', () => {
    expect(section('ai')).toMatch(/includes your sign-in email/);
    expect(section('ai')).toMatch(/deleted at midnight UTC/);
  });

  it('says what the reminders server keeps, who delivers reminders, and when it is all deleted', () => {
    const s = section('reminders');
    for (const kept of [/push address/, /time zone/, /reminder times/, /last day the app said was done/]) expect(s).toMatch(kept);
    expect(s).toMatch(/push service of your browser's maker/);
    expect(s).toMatch(/When you turn notifications off, the server deletes everything/);
    expect(s).toMatch(/push service says the address is gone/);
    expect(s).toMatch(/no reminder has got through to the device for two weeks/);
    expect(s).toMatch(/keeps no logs/);
  });

  it('shows account codes the way the app makes them', () => {
    const codes = text.match(/ARISE(-[0-9A-Z]{4})+/g) || [];
    expect(codes.length).toBeGreaterThan(0);
    for (const c of codes) expect(isAccountCode(c), c).toBe(true);
  });

  it('has no long dashes', () => {
    expect(text).not.toMatch(/[\u2013\u2014]/);
  });
});
