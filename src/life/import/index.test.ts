import { describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { classify, detect, importFile } from './index';
import { entryBytes, listZip } from './zip';
import type { LifeEvent } from '../types';
import { fileOf, zipBlob } from '../../test/life-fixtures';

const activity = (n: number, header = 'Search') =>
  JSON.stringify(
    Array.from({ length: n }, (_, i) => ({ header, title: `Searched for thing ${i}`, titleUrl: `https://www.google.com/search?q=thing+${i}`, time: new Date(Date.UTC(2019 + (i % 8), 0, 1 + (i % 28))).toISOString(), products: [header] })),
  );
const watch = JSON.stringify([{ header: 'YouTube', title: 'Watched A', titleUrl: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', time: '2024-01-01T10:00:00Z', products: ['YouTube'] }]);
const chrome = JSON.stringify({ 'Browser History': [{ title: 'Page', url: 'https://example.com', time_usec: 1700000000000000, page_transition: 'LINK' }] });
const html = '<html><head><title>My Activity</title><style>.mdl-cell{}</style></head><body><div class="mdl-grid"><div class="outer-cell mdl-cell"><div class="content-cell">Searched for&nbsp;<a href="x">x</a></div></div></div></body></html>';
const healthXml = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE HealthData [\n<!ELEMENT HealthData (ExportDate,Me,(Record|Workout)*)>\n]>\n<HealthData locale="en_US">\n <Record type="HKQuantityTypeIdentifierStepCount" sourceName="iPhone" unit="count" startDate="2024-01-01 10:00:00 +0000" endDate="2024-01-01 10:10:00 +0000" value="900"/>\n <Workout workoutActivityType="HKWorkoutActivityTypeYoga" duration="20" durationUnit="min" startDate="2024-01-02 07:00:00 +0000" endDate="2024-01-02 07:20:00 +0000"/>\n</HealthData>\n`;

// A store in memory, like the life log: same id, kept once.
function memoryStore() {
  const kept = new Map<string, LifeEvent>();
  const batches: number[] = [];
  return {
    kept,
    batches,
    async addEvents(events: LifeEvent[]) {
      batches.push(events.length);
      let added = 0;
      for (const e of events) if (!kept.has(e.id)) (kept.set(e.id, e), added++);
      return added;
    },
  };
}

describe('detect', () => {
  it('finds every part of a Google Takeout zip, in any language, and skips the rest', async () => {
    const zip = zipBlob({
      'Takeout/archive_browser.html': '<html>index</html>',
      'Takeout/My Activity/Search/MyActivity.json': activity(3),
      'Takeout/Meine Aktivitäten/Suche/MeineAktivitäten.json': activity(2, 'Suche'),
      'Takeout/YouTube and YouTube Music/history/watch-history.json': watch,
      'Takeout/YouTube and YouTube Music/history/search-history.html': html,
      'Takeout/Chrome/BrowserHistory.json': chrome,
      'Takeout/Google Photos/Trip/IMG_0001.jpg.json': '{"title":"IMG_0001.jpg"}',
      'Takeout/Google Photos/Trip/IMG_0001.jpg': new Uint8Array([0xff, 0xd8, 0xff]),
      'Takeout/Drive/notes.csv': 'a,b\n1,2\n',
    });
    const d = await detect(fileOf([zip], 'takeout-20240101T000000Z-001.zip'));
    expect(d.zip).toBe(true);
    expect(d.problem).toBeUndefined();
    expect(d.html).toBe(1);
    expect(d.found.map((f) => [f.kind, f.label])).toEqual([
      ['google-activity', 'Google activity: Search'],
      ['google-activity', 'Google activity: Suche'],
      ['google-activity', 'YouTube history'],
      ['chrome-history', 'Chrome history'],
    ]);
  });

  it('says when a Takeout is all HTML, a .tgz, empty or something else', async () => {
    expect((await detect(fileOf([zipBlob({ 'Takeout/My Activity/Search/MyActivity.html': html })], 'takeout.zip'))).problem).toBe('html');
    expect((await detect(fileOf([html], 'MyActivity.html'))).problem).toBe('html');
    expect((await detect(fileOf([new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0])], 'takeout.tgz'))).problem).toBe('tgz');
    expect((await detect(fileOf([], 'empty.json'))).problem).toBe('empty');
    expect((await detect(fileOf(['{"hello": "world"}'], 'other.json'))).problem).toBe('unknown');
    expect((await detect(fileOf(['name,city\nAnna,London\n'], 'people.csv'))).problem).toBe('unknown');
  });

  it('knows each service’s files on their own and in their zips', async () => {
    const one = async (name: string, text: string) => (await detect(fileOf([text], name))).found.map((f) => f.kind);
    expect(await one('Timeline.json', '{"semanticSegments":[{"startTime":"2024-01-01T00:00:00Z"}]}')).toEqual(['maps-timeline']);
    expect(await one('location-history.json', '[{"endTime":"2025-07-07T14:45:10.000-04:00","startTime":"2025-07-07T13:30:00.000-04:00","visit":{}}]')).toEqual(['maps-timeline']);
    expect(await one('2019_JANUARY.json', '{"timelineObjects":[]}')).toEqual(['maps-semantic']);
    expect(await one('StreamingHistory_music_0.json', '[{"endTime":"2024-01-01 10:00","artistName":"A","trackName":"B","msPlayed":1}]')).toEqual(['spotify-account']);
    expect(await one('Streaming_History_Audio_2024.json', '[{"ts":"2024-01-01T10:00:00Z","ms_played":1}]')).toEqual(['spotify-extended']);
    expect(await one('NetflixViewingHistory.csv', 'Title,Date\n"A","1/2/23"\n')).toEqual(['netflix-history']);
    expect(await one('NetflixViewingHistory (1).csv', 'Titel,Datum\n"A","2.1.23"\n')).toEqual(['netflix-history']);
    expect(await one('WhatsApp Chat with Anna.txt', '1/13/24, 9:15 PM - Anna: Hi\n1/13/24, 9:16 PM - Me: Hey\n')).toEqual(['whatsapp']);
    expect(await one('statement.csv', 'Date,Description,Amount\n01/02/2024,Shop,-1.00\n02/02/2024,Shop,-2.00\n')).toEqual(['bank-csv']);

    const spotify = await detect(fileOf([zipBlob({ 'Spotify Extended Streaming History/Streaming_History_Audio_2019-2021_0.json': '[{"ts":"2020-01-01T10:00:00Z","ms_played":100000,"master_metadata_track_name":"S","master_metadata_album_artist_name":"A"}]', 'Spotify Extended Streaming History/ReadMeFirst_ExtendedStreamingHistory.pdf': 'pdf' })], 'my_spotify_data.zip'));
    expect(spotify.found.map((f) => f.label)).toEqual(['Spotify listening (all years)']);

    const netflix = await detect(fileOf([zipBlob({ 'netflix-report/CONTENT_INTERACTION/ViewingActivity.csv': 'Profile Name,Start Time,Duration,Attributes,Title,Supplemental Video Type,Device Type,Bookmark,Latest Bookmark,Country\nAnna,2024-01-01 10:00:00,00:30:00,,Show,,TV,00:30:00,00:30:00,GB\nBen,2024-01-01 11:00:00,00:30:00,,Show,,TV,00:30:00,00:30:00,GB\nAnna,2024-01-02 10:00:00,00:30:00,,Show,,TV,00:30:00,00:30:00,GB\n', 'netflix-report/ACCOUNT/AccountDetails.csv': 'a,b\n' })], 'netflix-report.zip'));
    expect(netflix.found).toEqual([expect.objectContaining({ kind: 'netflix-activity', profiles: ['Anna', 'Ben'] })]);

    const health = await detect(fileOf([zipBlob({ 'apple_health_export/export.xml': healthXml, 'apple_health_export/export_cda.xml': '<?xml version="1.0"?><ClinicalDocument/>', 'apple_health_export/workout-routes/route_1.gpx': '<gpx/>' })], 'export.zip'));
    expect(health.found.map((f) => f.kind)).toEqual(['apple-health']);

    const chat = await detect(fileOf([zipBlob({ '_chat.txt': '[13/01/24, 21:15:04] Anna: Hi\n[13/01/24, 21:16:04] Me: Hey\n', '00000012-PHOTO-2024-01-13.jpg': new Uint8Array([1]) })], 'WhatsApp Chat - Anna.zip'));
    expect(chat.found).toEqual([expect.objectContaining({ kind: 'whatsapp', chat: 'Anna', label: 'WhatsApp chat with Anna' })]);
  });

  it('reads a bank statement written in Windows-1252', async () => {
    const latin = new Uint8Array([...'Buchungstag;Empf'].map((c) => c.charCodeAt(0)).concat([0xe4], [...'nger;Betrag\n15.01.2024;M'].map((c) => c.charCodeAt(0)), [0xfc], [...'ller;-4,50\n16.01.2024;Shop;-1,00\n'].map((c) => c.charCodeAt(0))));
    const d = await detect(fileOf([latin], 'umsatz.csv'));
    expect(d.found[0]).toMatchObject({ kind: 'bank-csv', encoding: 'windows-1252' });
    expect(d.found[0].csv!.columns).toEqual(['Buchungstag', 'Empfänger', 'Betrag']);
    const store = memoryStore();
    await importFile(fileOf([latin], 'umsatz.csv'), { onEvents: store.addEvents, detection: d });
    expect([...store.kept.values()][0].title).toBe('Spent 4.50 at Müller');
  });

  it('classifies from the start of a file', () => {
    expect(classify('x.xml', '<?xml version="1.0"?>\n<!DOCTYPE HealthData [', true)).toBe('apple-health');
    expect(classify('x.json', '﻿[ {"header": "YouTube", "title": "Watched", "time": "2024"', true)).toBe('google-activity');
    expect(classify('x.json', '[{"snippet": {}}]', true)).toBeNull();
    expect(classify('x.csv', 'a,b', true)).toBeNull();
  });
});

describe('importFile', () => {
  it('reads every part of a zip into the store, with progress, in batches, and a second time adds nothing', async () => {
    const zip = fileOf([zipBlob({ 'Takeout/My Activity/Search/MyActivity.json': activity(1203), 'Takeout/Chrome/BrowserHistory.json': chrome })], 'takeout.zip');
    const store = memoryStore();
    const progress: number[] = [];
    const r = await importFile(zip, { onEvents: store.addEvents, onProgress: (p) => progress.push(p.read / p.total) });
    expect(r).toMatchObject({ found: 1204, added: 1204, labels: ['Google activity: Search', 'Chrome history'] });
    expect(new Date(r.from!).getUTCFullYear()).toBe(2019);
    expect(new Date(r.to!).getUTCFullYear()).toBe(2026);
    expect(Math.max(...store.batches)).toBe(500);
    expect(progress.at(-1)).toBe(1);
    expect(progress.every((p, i) => i === 0 || p >= progress[i - 1])).toBe(true);
    const again = await importFile(zip, { onEvents: store.addEvents });
    expect(again).toMatchObject({ found: 1204, added: 0 });
    expect(store.kept.size).toBe(1204);
  });

  it('reads only the parts asked for, and a stored (unpacked) zip too', async () => {
    const zip = fileOf([zipBlob({ 'a/MyActivity.json': activity(5), 'b/BrowserHistory.json': chrome }, { store: true })], 't.zip');
    const d = await detect(zip);
    const store = memoryStore();
    const r = await importFile(zip, { onEvents: store.addEvents, detection: d, paths: ['b/BrowserHistory.json'] });
    expect(r).toMatchObject({ found: 1, labels: ['Chrome history'] });
  });

  it('reads Apple Health from export.zip', async () => {
    const store = memoryStore();
    const r = await importFile(fileOf([zipBlob({ 'apple_health_export/export.xml': healthXml })], 'export.zip'), { onEvents: store.addEvents });
    expect(r.labels).toEqual(['Apple Health']);
    expect([...store.kept.values()].map((e) => e.title).sort()).toEqual(['900 steps', 'Yoga · 20 min']);
  });

  it('stops when cancelled, keeping what was already stored', async () => {
    const zip = fileOf([zipBlob({ 'MyActivity.json': activity(5000) })], 't.zip');
    const ctrl = new AbortController();
    const store = memoryStore();
    const r = await importFile(zip, {
      signal: ctrl.signal,
      onEvents: async (b) => {
        const n = await store.addEvents(b);
        ctrl.abort();
        return n;
      },
    });
    expect(r).toMatchObject({ cancelled: true, found: 500, added: 500 });
    expect(store.kept.size).toBe(500);
  });

  it('reports a file it can’t read instead of failing', async () => {
    const r = await importFile(fileOf(['just words'], 'notes.json'), { onEvents: () => 0 });
    expect(r).toMatchObject({ found: 0, added: 0, problem: 'unknown' });
  });
});

describe('zip reading', () => {
  it('lists entries and unpacks them in pieces', async () => {
    const big = 'x'.repeat(3_000_000);
    const zip = new Blob([new Uint8Array(zipSync({ 'a.txt': strToU8(big), 'dir/': new Uint8Array(0), 'b.txt': [strToU8('hello'), { level: 0 }] }))]);
    const entries = await listZip(zip);
    expect(entries.map((e) => [e.name, e.method, e.size])).toEqual([
      ['a.txt', 8, 3_000_000],
      ['b.txt', 0, 5],
    ]);
    let total = 0;
    let pieces = 0;
    for await (const c of entryBytes(zip, entries[0])) (total += c.length), pieces++;
    expect(total).toBe(3_000_000);
    expect(pieces).toBeGreaterThan(0);
  });

  it('says a broken zip is broken', async () => {
    await expect(listZip(new Blob([new Uint8Array(100)]))).rejects.toThrow();
  });
});
