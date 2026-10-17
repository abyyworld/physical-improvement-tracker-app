import { describe, expect, it } from 'vitest';
import { activityEvent, chromeEvent, parseChromeHistory, parseMyActivity, searchQuery } from './google';
import { input, run, titles, wellFormed } from '../../test/life-fixtures';

// Records as Google Takeout writes them (My Activity, JSON).
const myActivity = [
  { header: 'Search', title: 'Searched for protein bars', titleUrl: 'https://www.google.com/search?q=protein+bars', time: '2024-03-01T08:15:30.123Z', products: ['Search'], activityControls: ['Web & App Activity'] },
  { header: 'Search', title: 'Visited Best protein bars of 2024 - Example', titleUrl: 'https://www.google.com/url?q=https://example.com/protein-bars&usg=AOvVaw0abc', time: '2024-03-01T08:16:02.456Z', products: ['Search'], activityControls: ['Web & App Activity'] },
  { header: 'YouTube', title: 'Watched How to do your first pull-up', titleUrl: 'https://www.youtube.com/watch?v=abcdefghijk', subtitles: [{ name: 'Calisthenics Basics', url: 'https://www.youtube.com/channel/UC123' }], time: '2024-03-01T19:00:00.000Z', products: ['YouTube'], activityControls: ['YouTube watch history'] },
  { header: 'YouTube', title: 'Watched Super Shiny Phone', titleUrl: 'https://www.youtube.com/watch?v=zzzzzzzzzzz', time: '2024-03-01T19:05:00.000Z', products: ['YouTube'], details: [{ name: 'From Google Ads' }], activityControls: ['YouTube watch history'] },
  { header: 'YouTube', title: 'Searched for pull up progression', titleUrl: 'https://www.youtube.com/results?search_query=pull+up+progression', time: '2024-03-01T18:59:00Z', products: ['YouTube'] },
  { header: 'Maps', title: 'Searched for coffee near me', titleUrl: 'https://www.google.com/maps/search/coffee+near+me/@51.5,-0.12,15z', time: '2024-03-02T09:00:00.000Z', products: ['Maps'] },
  { header: 'Discover', title: '7 cards in your feed', time: '2024-03-02T07:00:00.000Z', products: ['Discover'] },
  { header: 'Chrome', title: 'Visited Arise, daily quests', titleUrl: 'https://example.org/arise', time: '2024-03-02T10:00:00.000Z', products: ['Chrome'] },
  { header: 'Google Play Store', title: 'Used Duolingo', titleUrl: 'https://play.google.com/store/apps/details?id=com.duolingo', time: '2024-03-02T11:00:00.000Z', products: ['Google Play Store'] },
];

describe('Google My Activity', () => {
  it('reads searches, results clicked, YouTube and Maps, and leaves out ads and the Discover feed', async () => {
    const { events } = await run(parseMyActivity(input('Takeout/My Activity/Search/MyActivity.json', JSON.stringify(myActivity, null, 2))));
    expect(titles(events)).toEqual([
      'Searched "protein bars"',
      'Visited Best protein bars of 2024 - Example',
      'Watched How to do your first pull-up',
      'Searched YouTube for "pull up progression"',
      'Searched Maps for "coffee near me"',
      'Visited Arise, daily quests',
      'Used Duolingo',
    ]);
    expect(events.every(wellFormed)).toBe(true);
    const [search, visit, watch, ytSearch, maps, chrome, play] = events;
    expect(search).toMatchObject({ source: 'google', kind: 'search', tier: 3, at: Date.parse('2024-03-01T08:15:30.123Z') });
    expect(visit).toMatchObject({ source: 'google', kind: 'visit', url: 'https://example.com/protein-bars', tier: 3 });
    expect(watch).toMatchObject({ source: 'youtube', kind: 'watch', tier: 2, detail: 'Calisthenics Basics', url: 'https://www.youtube.com/watch?v=abcdefghijk' });
    expect(ytSearch).toMatchObject({ source: 'youtube', kind: 'search', tier: 3 });
    expect(maps).toMatchObject({ source: 'maps', kind: 'search', tier: 3 });
    expect(chrome).toMatchObject({ source: 'chrome', kind: 'visit', tier: 3 });
    expect(play).toMatchObject({ source: 'google', kind: 'other', detail: 'Google Play Store' });
  });

  it('works in any language: what it was comes from the link, the title stays as written', async () => {
    const german = [
      { header: 'Google Suche', title: 'Nach Proteinriegel gesucht', titleUrl: 'https://www.google.de/search?q=Proteinriegel', time: '2023-05-04T10:00:00.000Z', products: ['Search'] },
      { header: 'YouTube', title: 'Klimmzug Tutorial angesehen', titleUrl: 'https://www.youtube.com/watch?v=abcdefghijk', subtitles: [{ name: 'Kanal' }], time: '2023-05-04T11:00:00.000Z', products: ['YouTube'] },
      { header: 'Поиск', title: 'Искали: протеин', titleUrl: 'https://www.google.ru/search?q=%D0%BF%D1%80%D0%BE%D1%82%D0%B5%D0%B8%D0%BD', time: '2023-05-04T12:00:00.000Z', products: ['Search'] },
    ];
    const { events } = await run(parseMyActivity(input('Takeout/Meine Aktivitäten/Suche/MeineAktivitäten.json', JSON.stringify(german))));
    expect(titles(events)).toEqual(['Searched "Proteinriegel"', 'Klimmzug Tutorial angesehen', 'Searched "протеин"']);
    expect(events[1]).toMatchObject({ kind: 'watch', source: 'youtube', detail: 'Kanal' });
  });

  it('gives the same record the same id (so a second import adds nothing), and different records different ids', async () => {
    const a = await run(parseMyActivity(input('a.json', JSON.stringify(myActivity))));
    const b = await run(parseMyActivity(input('b.json', JSON.stringify(myActivity), 5)));
    expect(b.events.map((e) => e.id)).toEqual(a.events.map((e) => e.id));
    expect(new Set(a.events.map((e) => e.id)).size).toBe(a.events.length);
    expect(a.events[0].id).toMatch(/^google:[0-9a-f]{16}$/);
  });

  it('skips broken records and empty files, and survives a file cut off half way', async () => {
    expect((await run(parseMyActivity(input('e.json', '')))).events).toEqual([]);
    expect((await run(parseMyActivity(input('e.json', '[]')))).events).toEqual([]);
    const broken = `[{"header":"Search","title":"Searched for a","titleUrl":"https://www.google.com/search?q=a","time":"2024-01-01T00:00:00Z","products":["Search"]},
      {"header":"Search","title":"no time"},
      {"header":"Search","title":"Searched for b","titleUrl":"https://www.google.com/search?q=b","time":"not a time"},
      {"header":"Search","title":"Searched for \\"c\\" {braces} [and] \\\\ more","titleUrl":"https://www.google.com/search?q=c","time":"2024-01-02T00:00:00.000000Z","products":["Search"]},
      {"header":"Search","title":"Searched for d","titleUrl":"https://www.google.com/sea`;
    const { events } = await run(parseMyActivity(input('cut.json', broken, 3)));
    expect(titles(events)).toEqual(['Searched "a"', 'Searched "c"']);
    expect(events[1].at).toBe(Date.parse('2024-01-02T00:00:00Z'));
  });

  it('hands over a big file in batches of 500, a piece at a time', async () => {
    const n = 12_345;
    async function* big() {
      yield '[';
      for (let i = 0; i < n; i++) {
        yield `${i ? ',' : ''}{"header":"YouTube","title":"Watched Video ${i}","titleUrl":"https://www.youtube.com/watch?v=v${String(i).padStart(10, '0')}","time":"${new Date(Date.UTC(2020, 0, 1) + i * 60_000).toISOString()}","products":["YouTube"]}`;
      }
      yield ']';
    }
    const { batches, events } = await run(parseMyActivity({ name: 'watch-history.json', text: big() }));
    expect(events.length).toBe(n);
    expect(batches.every((b) => b.length <= 500)).toBe(true);
    expect(batches.length).toBe(Math.ceil(n / 500));
    expect(new Set(events.map((e) => e.id)).size).toBe(n);
  });

  it('finds the query in the link', () => {
    expect(searchQuery('https://www.google.com/search?q=a+b&hl=en')).toBe('a b');
    expect(searchQuery('https://www.google.co.uk/search?tbm=isch&q=cats')).toBe('cats');
    expect(searchQuery('https://www.youtube.com/results?search_query=lofi')).toBe('lofi');
    expect(searchQuery('https://www.google.com/maps/search/Tashkent+city/@41.3,69.2,12z')).toBe('Tashkent city');
    expect(searchQuery('https://www.google.com/url?q=https://x.org')).toBeUndefined();
    expect(searchQuery('https://example.com/search?q=x')).toBeUndefined();
    expect(searchQuery('not a link')).toBeUndefined();
    expect(activityEvent(null)).toBeNull();
    expect(activityEvent({ title: 'x', time: '2024-01-01T00:00:00Z' })).toMatchObject({ source: 'google', kind: 'other' });
  });
});

describe('Chrome history', () => {
  const history = {
    'Browser History': [
      { favicon_url: 'https://example.com/favicon.ico', page_transition: 'LINK', title: 'Example page', url: 'https://example.com/page', client_id: 'W1vSb98l403jhPeK==', time_usec: 1617404690134513 },
      { page_transition: 'TYPED', title: '', url: 'https://news.example.org/', client_id: 'x', time_usec: 1617404700000000 },
      { page_transition: 'LINK', title: 'Settings', url: 'chrome://settings/', client_id: 'x', time_usec: 1617404710000000 },
      { page_transition: 'LINK', title: 'No time', url: 'https://example.com/' },
    ],
  };

  it('reads visits from BrowserHistory.json, leaving out chrome:// pages', async () => {
    const { events } = await run(parseChromeHistory(input('Takeout/Chrome/BrowserHistory.json', JSON.stringify(history, null, 1))));
    expect(titles(events)).toEqual(['Visited Example page', 'Visited news.example.org']);
    expect(events[0]).toMatchObject({ source: 'chrome', kind: 'visit', tier: 3, at: 1617404690135, url: 'https://example.com/page', detail: 'example.com' });
    expect(events.every(wellFormed)).toBe(true);
    expect(chromeEvent({ url: 'https://a.b', time_usec: '1617404690134513' })).toMatchObject({ title: 'Visited a.b' });
  });

  it('only reads the history, even when other lists come first', async () => {
    const text = JSON.stringify({ 'Session Info': [{ title: 'x', url: 'https://x.y', time_usec: 1 }], ...history });
    const { events } = await run(parseChromeHistory(input('History.json', text, 1)));
    expect(events.length).toBe(2);
  });
});
