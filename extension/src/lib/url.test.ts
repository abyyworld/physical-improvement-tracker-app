// What of an address is kept, the sites never recorded, and Arise's own addresses.

import { describe, expect, it } from 'vitest';
import { cleanUrl, isLocal, matchesPrefix, siteOf } from './url';
import { isSkipped, parseSkipList, skipGroup } from './skip';

describe('cleaning addresses', () => {
  it('keeps the site and the page, never the query string or the part after #', () => {
    expect(cleanUrl('https://www.nytimes.com/2026/10/16/health/sleep.html?smid=nytcore-ios-share&referringSource=articleShare#comments')).toEqual({
      url: 'https://www.nytimes.com/2026/10/16/health/sleep.html',
      host: 'www.nytimes.com',
      site: 'nytimes.com',
    });
    expect(cleanUrl('https://shop.example.com/checkout?email=me%40example.com&token=abc123')!.url).toBe('https://shop.example.com/checkout');
    expect(cleanUrl('https://example.com/reset#access_token=secret')!.url).toBe('https://example.com/reset');
  });

  it('leaves out the parts of a path that work like a key', () => {
    const cases: [string, string][] = [
      // A document shared by link: its id opens it for anyone.
      ['https://docs.google.com/document/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit', 'https://docs.google.com/document/…'],
      ['https://drive.google.com/file/d/1a2B3c4D5e6F7g8H9i0J/view', 'https://drive.google.com/file/…'],
      ['https://www.dropbox.com/s/a1b2c3d4e5f6g7h/holiday.pdf', 'https://www.dropbox.com/s/…'],
      ['https://discord.gg/abcDEF12', 'https://discord.gg/…'],
      ['https://chat.whatsapp.com/Kx3fGhJk9LmNoP', 'https://chat.whatsapp.com/…'],
      // Maps: the places, the way home, where the map was.
      ['https://www.google.com/maps/dir/12+Home+St,+Town/Clinic/@51.5,-0.1,15z/data=!3m1', 'https://www.google.com/maps/dir'],
      ['https://www.google.co.uk/maps/place/Big+Ben/@51.5007,-0.1246,17z', 'https://www.google.co.uk/maps/place'],
      ['https://www.google.com/maps/@51.5072,-0.1276,14z', 'https://www.google.com/maps'],
      ['https://maps.google.com/', 'https://maps.google.com/maps'],
      // Reset, sign-in, confirm and unsubscribe links: the code after the word goes.
      ['https://github.com/password_reset/abcdefghijklmnopqrstuvwxyz', 'https://github.com/password_reset/…'],
      ['https://example.com/accounts/reset/MQ/5ze-1d2b3c4e5f6a7b8c9d0e/', 'https://example.com/accounts/reset/…'],
      ['https://example.com/verify/abcdefgh', 'https://example.com/verify/…'],
      ['https://news.example/unsubscribe/xyz', 'https://news.example/unsubscribe/…'],
      ['https://app.example/auth/magic/link-code', 'https://app.example/auth/magic/…'],
      ['https://example.com/invite/Zx9', 'https://example.com/invite/…'],
      // Codes, ids and email addresses anywhere in a path.
      ['https://example.com/share/0f8fad5b-d9cb-469f-a165-70867728950e/photo', 'https://example.com/share/…/photo'],
      ['https://example.com/files/9f86d081884c7d659a2feaa0c55ad015/report', 'https://example.com/files/…/report'],
      ['https://example.com/u/me@example.org/settings', 'https://example.com/u/…/settings'],
      ['https://example.com/u/me%40example.org', 'https://example.com/u/…'],
      ['https://example.com/a/eyJhbGciOiJIUzI1NiJ9-x_Yz/b', 'https://example.com/a/…/b'],
    ];
    for (const [raw, kept] of cases) expect(cleanUrl(raw)!.url, raw).toBe(kept);
  });

  it('keeps ordinary paths: words, dates, page names and short ids', () => {
    for (const u of [
      'https://www.nytimes.com/2026/10/16/health/sleep.html',
      'https://en.wikipedia.org/wiki/Albert_Einstein',
      'https://www.youtube.com/shorts/dQw4w9WgXcQ',
      'https://www.amazon.com/Some-Product-Name/dp/B08N5WRWNW',
      'https://www.reddit.com/r/fitness/comments/abc123/how_to_do_a_pull_up/',
      'https://stackoverflow.com/questions/12345678/how-to-parse-json',
      'https://example.com/login',
      'https://example.com/blog/how-to-reset-your-router',
      'https://www.dropbox.com/home',
      'https://medium.com/@someone',
      'https://example.com/',
    ]) {
      expect(cleanUrl(u)!.url, u).toBe(u);
    }
  });

  it('drops a user name and password in the address, keeps an unusual port', () => {
    expect(cleanUrl('https://user:pass@example.com:8443/a/b?x=1')!.url).toBe('https://example.com:8443/a/b');
    expect(cleanUrl('http://example.com:80/plain')!.url).toBe('http://example.com/plain');
  });

  it('lower-cases the host and caps very long addresses', () => {
    expect(cleanUrl('HTTPS://WWW.Example.COM./Path')!.host).toBe('www.example.com');
    expect(cleanUrl(`https://example.com/${'a'.repeat(2000)}`)!.url.length).toBe(512);
  });

  it('only keeps web pages', () => {
    for (const u of ['chrome://settings/', 'about:blank', 'file:///Users/me/notes.txt', 'chrome-extension://abc/popup.html', 'moz-extension://x/y', 'data:text/html,hi', 'javascript:void(0)', 'view-source:https://a.com', '', 'nonsense']) {
      expect(cleanUrl(u), u).toBeNull();
    }
  });

  it('names the site without www. or m.', () => {
    expect(siteOf('www.youtube.com')).toBe('youtube.com');
    expect(siteOf('m.youtube.com')).toBe('youtube.com');
    expect(siteOf('www2.example.org')).toBe('example.org');
    expect(siteOf('mail.google.com')).toBe('mail.google.com');
    expect(siteOf('mobile.twitter.com')).toBe('twitter.com');
  });

  it('knows addresses on this computer', () => {
    for (const h of ['localhost', 'app.localhost', 'printer.local', '127.0.0.1', '192.168.1.1', '[::1]']) expect(isLocal(h), h).toBe(true);
    for (const h of ['example.com', 'local.example.com', '1password.com']) expect(isLocal(h), h).toBe(false);
  });

  it("matches Arise's own addresses, with any port on localhost", () => {
    const arise = ['https://abyyworld.github.io/physical-improvement-tracker-app/', 'http://localhost/'];
    expect(matchesPrefix('https://abyyworld.github.io/physical-improvement-tracker-app/#settings', arise)).toBe(true);
    expect(matchesPrefix('https://abyyworld.github.io/physical-improvement-tracker-app/index.html', arise)).toBe(true);
    expect(matchesPrefix('http://localhost:4173/', arise)).toBe(true);
    expect(matchesPrefix('http://localhost:5173/some/page', arise)).toBe(true);
    // Another site on the same GitHub Pages host is not Arise.
    expect(matchesPrefix('https://abyyworld.github.io/other-project/', arise)).toBe(false);
    expect(matchesPrefix('http://abyyworld.github.io/physical-improvement-tracker-app/', arise)).toBe(false);
    expect(matchesPrefix('https://localhost/', arise)).toBe(false);
    expect(matchesPrefix('https://evil.example/physical-improvement-tracker-app/', arise)).toBe(false);
    expect(matchesPrefix('not a url', arise)).toBe(false);
  });
});

describe('sites never recorded', () => {
  it('leaves out banks, health portals, adult sites and password managers, with their subdomains', () => {
    const cases: [string, string][] = [
      ['www.chase.com', 'Banks and money'],
      ['secure.chase.com', 'Banks and money'],
      ['www.paypal.com', 'Banks and money'],
      ['onlinebanking.mybank.example', 'Banks and money'],
      ['www.netbank.de', 'Banks and money'],
      ['app.monzo.com', 'Banks and money'],
      ['mychart.somehospital.org', 'Health portals'],
      ['healthy.kaiserpermanente.org', ''],
      ['kp.org', 'Health portals'],
      ['www.zocdoc.com', 'Health portals'],
      ['www.pornhub.com', 'Adult sites'],
      ['anything.xxx', 'Adult sites'],
      ['somepornsite.example', 'Adult sites'],
      ['onlyfans.com', 'Adult sites'],
      ['my.1password.com', 'Passwords and sign-in'],
      ['vault.bitwarden.com', 'Passwords and sign-in'],
      ['accounts.google.com', 'Passwords and sign-in'],
      ['login.microsoftonline.com', 'Passwords and sign-in'],
      ['acme.okta.com', 'Passwords and sign-in'],
      ['appleid.apple.com', 'Passwords and sign-in'],
    ];
    for (const [host, group] of cases) expect(skipGroup(host), host).toBe(group || null);
  });

  it('records ordinary sites, including ones whose names only look similar', () => {
    for (const h of ['www.youtube.com', 'www.google.com', 'mail.google.com', 'www.essex.ac.uk', 'www.middlesex.edu', 'www.apple.com', 'en.wikipedia.org', 'chaseoutdoors.example', 'news.ycombinator.com']) {
      expect(isSkipped(h), h).toBe(false);
    }
  });

  it("adds the person's own list", () => {
    const own = parseSkipList('  Example.com\nhttps://www.work-intranet.net/home?x=1, *.secret.org\nnot a site\n\nfoo/bar/baz\n');
    expect(own).toEqual(['example.com', 'work-intranet.net', 'secret.org']); // "foo" isn't a site name
    expect(own).not.toContain('not');
    expect(isSkipped('www.example.com', own)).toBe(true);
    expect(isSkipped('docs.secret.org', own)).toBe(true);
    expect(isSkipped('notexample.com', own)).toBe(false);
    expect(isSkipped('www.youtube.com', own)).toBe(false);
  });

  it('takes sites written the way people write them: other alphabets, a port', () => {
    expect(parseSkipList('bücher.de\nсбербанк.рф\nexample.com:8080\nme@gmail.com')).toEqual(['xn--bcher-kva.de', 'xn--80abap1arsf.xn--p1ai', 'example.com']);
    expect(isSkipped('www.xn--bcher-kva.de', parseSkipList('bücher.de'))).toBe(true);
    expect(isSkipped('example.com', parseSkipList('https://example.com:8443/x'))).toBe(true);
  });

  it('keeps the own list tidy', () => {
    expect(parseSkipList('a.com a.com A.COM www.a.com')).toEqual(['a.com']);
    expect(parseSkipList('')).toEqual([]);
    expect(parseSkipList(Array.from({ length: 900 }, (_, i) => `site${i}.com`).join('\n'))).toHaveLength(500);
  });
});
