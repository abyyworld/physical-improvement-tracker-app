import { describe, expect, it } from 'vitest';
import { attr, CsvRows, Lines, sniffDelimiter, XmlTags, type Tag } from './text-stream';
import { JsonItems } from './json-stream';
import { guessOrder, hashId, isoMs, Repeats } from './util';

// Feeds the text in pieces of every size from 1 up, and checks the result never changes.
function everySplit<T>(text: string, read: (pieces: string[]) => T): T {
  const whole = read([text]);
  for (const size of [1, 2, 3, 5, 7, 13, 64]) {
    const pieces: string[] = [];
    for (let i = 0; i < text.length; i += size) pieces.push(text.slice(i, i + size));
    expect(read(pieces)).toEqual(whole);
  }
  return whole;
}

describe('reading text a piece at a time', () => {
  it('splits lines, whatever the line ends and wherever a piece ends', () => {
    const lines = everySplit('one\r\ntwo\nthree\rfour\r\n\r\nlast', (pieces) => {
      const l = new Lines();
      return [...pieces.flatMap((p) => l.push(p)), ...l.end()];
    });
    expect(lines).toEqual(['one', 'two', 'three', 'four', '', 'last']);
  });

  it('reads CSV: quotes, commas and line breaks inside quotes, doubled quotes, CRLF', () => {
    const csv = 'Title,Date\r\n"Breaking Bad: Season 1, ""Pilot""",1/20/23\r\n"Two\nlines",2/1/23\r\n,\r\nlast,row';
    const rows = everySplit(csv, (pieces) => {
      const c = new CsvRows();
      return [...pieces.flatMap((p) => c.push(p)), ...c.end()];
    });
    expect(rows).toEqual([['Title', 'Date'], ['Breaking Bad: Season 1, "Pilot"', '1/20/23'], ['Two\nlines', '2/1/23'], ['', ''], ['last', 'row']]);
    expect(new CsvRows(';').push('a;b;"c;d"\n')).toEqual([['a', 'b', 'c;d']]);
    expect(new CsvRows().end()).toEqual([]);
  });

  it('finds the delimiter', () => {
    expect(sniffDelimiter('a,b,c\n1,2,3\n')).toBe(',');
    expect(sniffDelimiter('Datum;Betrag;Text\n01.01.2024;-1,50;Kaffee, groß\n')).toBe(';');
    expect(sniffDelimiter('a\tb\n1\t2\n')).toBe('\t');
  });

  it('scans XML tags, stepping over comments, the DOCTYPE and quoted ">"', () => {
    const xml = `<?xml version="1.0"?>
<!DOCTYPE HealthData [
<!-- a comment with <Record> and > inside -->
<!ELEMENT HealthData (Record*)>
<!ATTLIST Record type CDATA #REQUIRED>
]>
<HealthData>
 <Record type="A" value="1 &gt; 0" note='single "quotes"' sourceName="Anna&#8217;s Watch"/>
 <Record type="B" weird="a>b">
  <MetadataEntry key="k" value="v"/>
 </Record>
 <Workout workoutActivityType="HKWorkoutActivityTypeRunning"></Workout>
</HealthData>`;
    const tags = everySplit(xml, (pieces) => {
      const x = new XmlTags();
      return pieces.flatMap((p) => x.push(p)).map((t: Tag) => `${t.close ? '/' : ''}${t.name}${t.self ? '/' : ''}`);
    });
    expect(tags).toEqual(['HealthData', 'Record/', 'Record', 'MetadataEntry/', '/Record', 'Workout', '/Workout', '/HealthData']);
    const only = new XmlTags(new Set(['Record'])).push(xml);
    expect(only.map((t) => attr(t.attrs, 'type'))).toEqual(['A', 'B', undefined]);
    expect(attr(only[0].attrs, 'value')).toBe('1 > 0');
    expect(attr(only[0].attrs, 'note')).toBe('single "quotes"');
    expect(attr(only[0].attrs, 'sourceName')).toBe('Anna’s Watch');
    expect(attr(only[1].attrs, 'weird')).toBe('a>b');
    expect(attr(' startDate="1" endDate="2" startDate="3"', 'startDate')).toBe('1');
    expect(attr(' workoutActivityType="x"', 'type')).toBeUndefined();
    expect(attr(' a="&#99999999; &bogus; &amp;"', 'a')).toBe('&#99999999; &bogus; &');
    expect(attr('\n\ttype = "spaced"', 'type')).toBe('spaced');
  });

  it('reads the objects of a JSON array, nested or under a key, wherever a piece ends', () => {
    const json = JSON.stringify({
      skip: [{ a: 1 }],
      'Browser History': [{ title: 'a "quoted" {brace} [bracket] \\ back', n: [1, { deep: [2] }] }, { title: 'é ü 中  ' }, 7, 'text'],
      after: { x: [{ y: 1 }] },
    });
    const items = everySplit(json, (pieces) => {
      const j = new JsonItems(['Browser History']);
      return pieces.flatMap((p) => j.push(p));
    });
    expect(items).toEqual([
      { key: 'Browser History', value: { title: 'a "quoted" {brace} [bracket] \\ back', n: [1, { deep: [2] }] } },
      { key: 'Browser History', value: { title: 'é ü 中  ' } },
    ]);
    const top = everySplit('[{"a":1},{"b":"}"},[{"no":1}]]', (pieces) => {
      const j = new JsonItems();
      return pieces.flatMap((p) => j.push(p)).map((i) => i.value);
    });
    expect(top).toEqual([{ a: 1 }, { b: '}' }]);
    const broken = new JsonItems();
    expect(broken.push('[{"a":1},{"b":tru},{"c":3}]').map((i) => i.value)).toEqual([{ a: 1 }, { c: 3 }]);
    expect(broken.broken).toBe(1);
  });
});

describe('small helpers', () => {
  it('hashes the same values the same way', () => {
    expect(hashId('a', 1, undefined)).toBe(hashId('a', 1, undefined));
    expect(hashId('a', 1)).not.toBe(hashId('a', 2));
    expect(hashId('ab', 'c')).not.toBe(hashId('a', 'bc'));
    expect(hashId('x')).toMatch(/^[0-9a-f]{16}$/);
    const r = new Repeats();
    expect([r.next('k'), r.next('k'), r.next('j')]).toEqual([0, 1, 0]);
  });

  it('reads times and guesses date orders', () => {
    expect(isoMs('2024-01-02T03:04:05.123456Z')).toBe(Date.UTC(2024, 0, 2, 3, 4, 5, 123));
    expect(isoMs('2024-01-02T03:04:05+02:00')).toBe(Date.UTC(2024, 0, 2, 1, 4, 5));
    expect(isoMs('yesterday')).toBeNaN();
    expect(guessOrder([[13, 1, 2024]], 'mdy')).toBe('dmy');
    expect(guessOrder([[1, 13, 2024]], 'dmy')).toBe('mdy');
    expect(guessOrder([[2024, 1, 13]], 'dmy')).toBe('ymd');
    expect(guessOrder([[1, 2, 2024]], 'mdy')).toBe('mdy');
  });
});
