// The small readers under everything the helper reads: Apple's binary plists (notifications),
// Messages' typedstream text, and Apple's clocks.

import { describe, expect, it } from 'vitest';
import { PlistError, parseBplist } from '../src/bplist.mjs';
import { attributedText } from '../src/typedstream.mjs';
import { APPLE_EPOCH, appleToMs, duration, hourStart, messagesMsSql, messagesToMs, msToApple } from '../src/time.mjs';
import { attributedBody, concat, notificationData, writeBplist } from './fixtures';
import { DatabaseSync } from 'node:sqlite';

describe('binary plists', () => {
  it('reads what a notification keeps: app, title, subtitle and body', () => {
    const data = notificationData('com.apple.MobileSMS', { titl: 'Mom', subt: 'Family', body: 'Call me when you can 📞', date: 781000000.5 });
    const p = parseBplist(data);
    expect(p.app).toBe('com.apple.MobileSMS');
    expect(p.req).toMatchObject({ titl: 'Mom', subt: 'Family', body: 'Call me when you can 📞', date: 781000000.5 });
  });

  it('reads every kind of value', () => {
    const when = new Date('2025-05-01T10:00:00Z');
    const p = parseBplist(writeBplist({ n: null, t: true, f: false, i: 42, r: 1.25, d: when, bytes: Uint8Array.of(1, 2, 3), list: ['a', 7, ['deep']], long: 'x'.repeat(300) }));
    expect(p).toMatchObject({ n: null, t: true, f: false, i: 42, r: 1.25, list: ['a', 7, ['deep']] });
    expect(p.d.getTime()).toBe(when.getTime());
    expect(Array.from(p.bytes)).toEqual([1, 2, 3]);
    expect(p.long).toHaveLength(300);
  });

  it('refuses what is not a plist, or is cut short, without hanging', () => {
    expect(() => parseBplist(new TextEncoder().encode('not a plist at all, just some text here....'))).toThrow(PlistError);
    const good = writeBplist({ a: 'b' });
    expect(() => parseBplist(good.slice(0, good.length - 5))).toThrow(PlistError);
    // An offset table pointing past the end.
    const bad = good.slice();
    bad[bad.length - 1] = 250;
    expect(() => parseBplist(bad)).toThrow(PlistError);
  });

  it('refuses an array that contains itself', () => {
    // bplist00, object 0: an array of one reference to object 0.
    const body = Uint8Array.of(0xa1, 0x00);
    const header = Uint8Array.from('bplist00', (c) => c.charCodeAt(0));
    const table = Uint8Array.of(8);
    const trailer = new Uint8Array(32);
    const tv = new DataView(trailer.buffer);
    trailer[6] = 1;
    trailer[7] = 1;
    tv.setBigUint64(8, 1n);
    tv.setBigUint64(16, 0n);
    tv.setBigUint64(24, 10n);
    expect(() => parseBplist(concat(header, body, table, trailer))).toThrow(PlistError);
  });
});

describe("Messages' attributedBody", () => {
  it('finds the words, short and long (1, 2 and 4 byte lengths)', () => {
    expect(attributedText(attributedBody('Hello World!'))).toBe('Hello World!');
    const mid = 'Running late, see you at the gym. '.repeat(10);
    expect(mid.length).toBeGreaterThan(127);
    expect(attributedText(attributedBody(mid))).toBe(mid.trim());
    const long = 'a'.repeat(70_000);
    expect(attributedText(attributedBody(long))).toBe(long);
  });

  it('keeps emoji and other scripts, and drops attachment marks', () => {
    expect(attributedText(attributedBody('Салом 👋 Привет'))).toBe('Салом 👋 Привет');
    expect(attributedText(attributedBody('￼ Look at this'))).toBe('Look at this');
  });

  it('gives nothing for nothing, or for something else', () => {
    expect(attributedText(null)).toBe('');
    expect(attributedText(new Uint8Array(0))).toBe('');
    expect(attributedText(new TextEncoder().encode('just bytes without the class'))).toBe('');
    // Cut off in the middle of the length.
    const b = attributedBody('x'.repeat(200));
    const at = b.indexOf(0x2b, b.indexOf(0x53 /* S of NSString */));
    expect(attributedText(b.slice(0, at + 2))).toBe('');
  });
});

describe("Apple's clocks", () => {
  it('turns seconds since 2001 into ms since 1970', () => {
    expect(appleToMs(0.5)).toBe(APPLE_EPOCH * 1000 + 500);
    expect(appleToMs(781000000)).toBe(Date.UTC(2025, 9, 1, 8, 26, 40));
    expect(msToApple(Date.UTC(2001, 0, 1))).toBe(0);
    for (const v of [0, -5, NaN, null, undefined, 'x', 1e12]) expect(appleToMs(v)).toBeNull();
  });

  it("reads Messages' nanoseconds, and old Macs' seconds", () => {
    const at = Date.UTC(2025, 4, 1, 12, 0, 0);
    const sec = at / 1000 - APPLE_EPOCH;
    expect(messagesToMs(sec * 1e9)).toBe(at);
    expect(messagesToMs(BigInt(sec) * 1_000_000_000n)).toBe(at);
    expect(messagesToMs(sec)).toBe(at);
    expect(messagesToMs(0)).toBeNull();
  });

  it('turns nanoseconds into ms in SQL, where JavaScript numbers would refuse them', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE m (date INTEGER)');
    db.prepare('INSERT INTO m VALUES (?), (?)').run(767793600_000_000_000n, 767793600);
    expect(() => db.prepare('SELECT date FROM m').all()).toThrow();
    const rows = db.prepare(`SELECT ${messagesMsSql('date')} AS ms FROM m`).all() as { ms: number }[];
    expect(rows.map((r) => r.ms)).toEqual([767793600000, 767793600000]);
  });

  it('says how long in plain words, and finds the hour', () => {
    expect(duration(40)).toBe('40 sec');
    expect(duration(12 * 60 + 10)).toBe('12 min');
    expect(duration(65 * 60)).toBe('1 h 5 min');
    expect(duration(2 * 3600)).toBe('2 h');
    expect(hourStart(Date.UTC(2025, 0, 1, 10, 59, 59))).toBe(Date.UTC(2025, 0, 1, 10));
  });
});
