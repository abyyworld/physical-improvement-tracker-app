// @vitest-environment jsdom
// Your most-visited sites, counted on this device from the life log's visits.

import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { rankSites, siteOf } from './top-sites.js';

const visit = (site: string, at: number, extra: object = {}) => ({ kind: 'visit', at, meta: { site }, ...extra });

describe('most-visited sites', () => {
  it("names a site by the extension's name for it, or the address, without www", () => {
    expect(siteOf({ meta: { site: 'www.GitHub.com' } })).toBe('github.com');
    expect(siteOf({ url: 'https://docs.google.com/document/d/1' })).toBe('docs.google.com');
    expect(siteOf({ url: 'chrome://settings' })).toBe('');
    expect(siteOf({ url: 'not a url' })).toBe('');
    expect(siteOf({ meta: { site: '<script>' } })).toBe('');
  });

  it('counts visits per site, the most first, then the latest', () => {
    const list = rankSites([visit('github.com', 1), visit('github.com', 2), visit('news.ycombinator.com', 5), visit('www.github.com', 3), visit('bbc.co.uk', 9), { kind: 'search', at: 4, meta: { site: 'google.com' } }]);
    expect(list).toEqual([
      { site: 'github.com', visits: 3, last: 3 },
      { site: 'bbc.co.uk', visits: 1, last: 9 },
      { site: 'news.ycombinator.com', visits: 1, last: 5 },
    ]);
    expect(rankSites(Array.from({ length: 10 }, (_, i) => visit(`s${i}.com`, i))).length).toBe(6);
  });
});

describe('on Today', () => {
  it('shows the card once there are visits, with links to the sites and no icons fetched', async () => {
    const L = await import('./log');
    const TOP = await import('./top-sites.js');
    document.body.innerHTML = TOP.slot();
    await TOP.fill();
    expect(document.getElementById('topSites')!.innerHTML).toBe(''); // nothing yet: no card
    const now = Date.now();
    await L.addEvents([
      { id: 'browser:a', source: 'browser', kind: 'visit', at: now - 1000, title: 'Repo', url: 'https://github.com/x', tier: 3, meta: { site: 'github.com' } },
      { id: 'browser:b', source: 'browser', kind: 'visit', at: now - 2000, title: 'Repo 2', url: 'https://github.com/y', tier: 3, meta: { site: 'github.com' } },
      { id: 'browser:c', source: 'browser', kind: 'visit', at: now - 40 * 86_400_000, title: 'Old', url: 'https://old.example.com', tier: 3, meta: { site: 'old.example.com' } },
    ]);
    await TOP.fill();
    const card = document.getElementById('topSites')!;
    expect(card.textContent).toContain('Your most-visited sites');
    expect([...card.querySelectorAll('a.site')].map((a) => a.getAttribute('href'))).toEqual(['https://github.com']);
    expect(card.textContent).toContain('2 visits in two weeks');
    expect(card.querySelector('img')).toBeNull();
    expect(card.querySelector('a')!.getAttribute('rel')).toContain('noreferrer');
  });
});
