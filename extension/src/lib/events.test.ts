// Visits, searches and time on site as life events: what they say, and ids that stay the same.

import { describe, expect, it } from 'vitest';
import { browserName, recordable, siteOf, siteTimeEvent, visitEvent, visitKey } from './events';

const ctx = { own: ['mywork.example'], arise: ['https://abyyworld.github.io/physical-improvement-tracker-app/'], browser: 'Chrome on macOS' };
const T = Date.UTC(2026, 9, 17, 12, 0, 0) + 0.375; // Chrome's visit times have fractions of a ms

describe('visits and searches', () => {
  it('makes a visit: title, the address without its query, the site, tier 3', async () => {
    const e = await visitEvent({ url: 'https://www.nytimes.com/2026/10/16/health/sleep.html?smid=share', title: '  How Sleep   Builds Muscle  ', time: T }, ctx);
    expect(e).toEqual({
      id: expect.stringMatching(/^browser:[A-Za-z0-9_-]{22}$/),
      source: 'browser',
      kind: 'visit',
      at: Math.round(T),
      title: 'How Sleep Builds Muscle',
      detail: 'nytimes.com',
      url: 'https://www.nytimes.com/2026/10/16/health/sleep.html',
      tier: 3,
      meta: { site: 'nytimes.com', browser: 'Chrome on macOS' },
    });
  });

  it('uses the site when the page has no title', async () => {
    expect((await visitEvent({ url: 'https://example.org/a', time: T }, ctx))!.title).toBe('example.org');
  });

  it('makes a search from a search page', async () => {
    const e = await visitEvent({ url: 'https://www.google.com/search?q=protein+bars&oq=protein', title: 'protein bars - Google Search', time: T }, ctx);
    expect(e).toMatchObject({
      kind: 'search',
      title: 'Searched "protein bars"',
      detail: 'Google',
      url: 'https://www.google.com/search?q=protein%20bars',
      tier: 3,
      meta: { engine: 'google', query: 'protein bars', site: 'google.com', browser: 'Chrome on macOS' },
    });
  });

  it('marks visits browser sync brought from another device', async () => {
    const e = await visitEvent({ url: 'https://example.org/', time: T, isLocal: false }, ctx);
    expect(e!.meta!.otherDevice).toBe(true);
    const local = await visitEvent({ url: 'https://example.org/', time: T, isLocal: true }, ctx);
    expect(local!.meta!.otherDevice).toBeUndefined();
    const firefox = await visitEvent({ url: 'https://example.org/', time: T }, ctx); // Firefox doesn't say
    expect(firefox!.meta!.otherDevice).toBeUndefined();
  });

  it('gives the same visit the same id, from any browser, and different visits different ids', async () => {
    const a = await visitEvent({ url: 'https://example.org/page?x=1', title: 'A', time: T }, ctx);
    const again = await visitEvent({ url: 'https://example.org/page?x=2', title: 'A changed title', time: T }, { ...ctx, browser: 'Edge on Windows' });
    expect(again!.id).toBe(a!.id);
    const later = await visitEvent({ url: 'https://example.org/page', time: T + 1000 }, ctx);
    const other = await visitEvent({ url: 'https://example.org/other', time: T }, ctx);
    expect(new Set([a!.id, later!.id, other!.id]).size).toBe(3);
    const s1 = await visitEvent({ url: 'https://www.google.com/search?q=a', time: T }, ctx);
    const s2 = await visitEvent({ url: 'https://www.google.com/search?q=a&start=10', time: T }, ctx);
    const s3 = await visitEvent({ url: 'https://www.google.com/search?q=b', time: T }, ctx);
    expect(s2!.id).toBe(s1!.id);
    expect(s3!.id).not.toBe(s1!.id);
    expect(await visitKey({ url: 'https://a.com/', time: T })).toBe(await visitKey({ url: 'https://a.com/', time: T }));
    expect(await visitKey({ url: 'https://a.com/', time: T })).not.toBe(await visitKey({ url: 'https://a.com/', time: T + 1 }));
  });

  it('leaves out reloads, pages inside pages, and sites never recorded', async () => {
    expect(await visitEvent({ url: 'https://example.org/', time: T, transition: 'reload' }, ctx)).toBeNull();
    expect(await visitEvent({ url: 'https://ads.example/frame', time: T, transition: 'auto_subframe' }, ctx)).toBeNull();
    expect(await visitEvent({ url: 'https://example.org/', time: T, transition: 'typed' }, ctx)).not.toBeNull();
    for (const url of [
      'https://secure.chase.com/web/auth/dashboard',
      'https://www.pornhub.com/view_video.php?viewkey=x',
      'https://my.1password.com/vaults',
      'https://mychart.hospital.org/MyChart/',
      'https://accounts.google.com/signin',
      'https://www.mywork.example/payroll',
      'https://abyyworld.github.io/physical-improvement-tracker-app/#settings',
      'http://localhost:5173/',
      'http://192.168.0.1/admin',
      'chrome://history/',
      'about:blank',
    ]) {
      expect(await visitEvent({ url, time: T }, ctx), url).toBeNull();
      expect(recordable(url, ctx), url).toBe(false);
    }
    // A bank's search is never a search either.
    expect(await visitEvent({ url: 'https://www.paypal.com/search?q=refund', time: T }, ctx)).toBeNull();
    expect(await visitEvent({ url: 'https://example.org/', time: Number.NaN }, ctx)).toBeNull();
  });

  it('names the site for time on site, or nothing', () => {
    expect(siteOf('https://m.youtube.com/watch?v=1', ctx)).toBe('youtube.com');
    expect(siteOf('https://www.chase.com/', ctx)).toBeNull();
    expect(siteOf('chrome://newtab/', ctx)).toBeNull();
  });
});

describe('time on site', () => {
  const hour = new Date(2026, 9, 17, 14).getTime();
  it('makes one event per site per hour', async () => {
    const e = await siteTimeEvent({ hour, end: hour + 3_600_000, site: 'youtube.com', seconds: 1530 }, 'install1', 0, 'Chrome on macOS');
    expect(e).toEqual({
      id: expect.stringMatching(/^browser:[A-Za-z0-9_-]{22}$/),
      source: 'browser',
      kind: 'app',
      at: hour,
      end: hour + 3_600_000,
      title: '26 min on youtube.com',
      detail: 'youtube.com',
      value: 25.5,
      unit: 'min',
      tier: 3,
      meta: { site: 'youtube.com', seconds: 1530, browser: 'Chrome on macOS' },
    });
    expect((await siteTimeEvent({ hour, end: hour, site: 'a.com', seconds: 31 }, 'i', 0, 'x')).title).toBe('1 min on a.com');
  });

  it('keeps its id stable, and apart for another browser or another part of the hour', async () => {
    const h = { hour, end: hour + 3_600_000, site: 'a.com', seconds: 600 };
    const a = await siteTimeEvent(h, 'one', 0, 'x');
    expect((await siteTimeEvent({ ...h, seconds: 999 }, 'one', 0, 'y')).id).toBe(a.id);
    expect((await siteTimeEvent(h, 'two', 0, 'x')).id).not.toBe(a.id);
    expect((await siteTimeEvent(h, 'one', 1, 'x')).id).not.toBe(a.id);
  });
});

describe('the browser’s name', () => {
  it('tells browsers apart', () => {
    const chromeMac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
    expect(browserName(chromeMac, [{ brand: 'Google Chrome' }, { brand: 'Chromium' }], 'macOS')).toBe('Chrome on macOS');
    expect(browserName(`${chromeMac} Edg/141.0.0.0`, [{ brand: 'Microsoft Edge' }], 'Windows')).toBe('Edge on Windows');
    expect(browserName(chromeMac, [{ brand: 'Brave' }, { brand: 'Chromium' }], 'macOS')).toBe('Brave on macOS');
    expect(browserName(chromeMac, [{ brand: 'Chromium' }], '', true)).toBe('Brave on macOS');
    expect(browserName('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0')).toBe('Firefox on Windows');
    expect(browserName('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36', [{ brand: 'Chromium' }], 'Linux')).toBe('Chromium on Linux');
    expect(browserName('something else')).toBe('Browser');
  });
});
