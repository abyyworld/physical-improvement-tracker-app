// The helper's own connectors to the other browsers, Mail and Calendar, read from small databases
// shaped like the ones those apps keep: what each read takes, what it leaves out, where it's up to,
// and what happens while a browser holds its history locked.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { failure, isLocked, withSnapshot } from '../src/snapshot.mjs';
import { browserFiles, readChromium, readFirefox, searchOf, webEvent, webEvents } from '../src/browsers.mjs';
import { mailEvent, mailFile, mailboxKind, readMail } from '../src/mail.mjs';
import { calendarChanges, calendarEvent, calendarFiles, inWindow, readCalendar } from '../src/calendar.mjs';
import { Names } from '../src/contacts.mjs';
import { Outbox } from '../src/outbox.mjs';
import {
  CALENDAR_CACHE_SCHEMA,
  FIREFOX_SCHEMA,
  LINK,
  addCalEvent,
  addChromeVisit,
  addFirefoxVisit,
  addMail,
  addOccurrences,
  apple,
  calendarDb,
  chromeDb,
  mailDb,
  tempDir,
  walDb,
} from './fixtures';

const dirs: string[] = [];
const open: DatabaseSync[] = [];
const temp = () => {
  const d = tempDir();
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const db of open.splice(0)) db.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const read = <T>(file: string, fn: (db: DatabaseSync) => T) => withSnapshot(file, fn);
const noNames = { lookup: () => '' };
const chrome = { key: 'chrome:Default', browser: 'chrome', name: 'Chrome', type: 'chromium' as const, file: '' };
const firefox = { key: 'firefox:abc', browser: 'firefox', name: 'Firefox', type: 'firefox' as const, file: '' };
const T = (iso: string) => Date.parse(iso);

// The browser running: it holds its history locked, the way Chrome does (and Firefox can).
function running(file: string) {
  const db = new DatabaseSync(file);
  open.push(db);
  db.exec('PRAGMA locking_mode = EXCLUSIVE');
  db.exec("INSERT INTO meta (key, value) VALUES ('running', '1')");
  return db;
}

describe('a browser that holds its history locked', () => {
  it('is read from what it has saved, read-only, with no copy made', () => {
    const dir = temp();
    const file = path.join(dir, 'History');
    const db = chromeDb(file);
    addChromeVisit(db, { url: 'https://example.com/a', at: '2025-06-01T09:00:00Z', title: 'A' });
    running(file);
    // Read as the other databases are, it can't be.
    let err: unknown;
    try {
      read(file, (c) => readChromium(c));
    } catch (e) {
      err = e;
    }
    expect(isLocked(err)).toBe(true);
    expect(failure(err)).toBe('error');
    // Even locked, what's saved comes, and nothing is written or copied.
    const before = fs.readFileSync(file);
    const listing = fs.readdirSync(dir).sort();
    const rows = withSnapshot(file, (c) => readChromium(c).rows, { evenLocked: true });
    expect(rows.map((r: { url: string }) => r.url)).toEqual(['https://example.com/a']);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    expect(fs.readdirSync(dir).sort()).toEqual(listing);
    expect(() => withSnapshot(file, (c) => c.exec("INSERT INTO meta (key, value) VALUES ('x', 'y')"), { evenLocked: true })).toThrow(/readonly/);
  });

  it("gets the newest visits later, once the browser has saved them, when it keeps them in its log", () => {
    const file = path.join(temp(), 'places.sqlite');
    const db = walDb(file, FIREFOX_SCHEMA);
    open.push(db);
    addFirefoxVisit(db, { url: 'https://example.com/saved', at: '2025-06-01T09:00:00Z' });
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.exec('PRAGMA locking_mode = EXCLUSIVE');
    addFirefoxVisit(db, { url: 'https://example.com/newest', at: '2025-06-01T09:05:00Z' });
    const urls = () => withSnapshot(file, (c) => readFirefox(c).rows.map((r: { url: string }) => r.url), { evenLocked: true });
    expect(urls()).toEqual(['https://example.com/saved']);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    expect(urls()).toEqual(['https://example.com/saved', 'https://example.com/newest']);
  });

  it('is read the usual way when the browser is closed', () => {
    const file = path.join(temp(), 'History');
    addChromeVisit(chromeDb(file), { url: 'https://example.com/a', at: '2025-06-01T09:00:00Z' });
    expect(read(file, (c) => readChromium(c).rows)).toHaveLength(1);
    expect(withSnapshot(file, (c) => readChromium(c).rows, { evenLocked: true })).toHaveLength(1);
  });
});

describe('the other browsers', () => {
  it('finds every profile of each browser, and Firefox', () => {
    const home = temp();
    const support = path.join(home, 'Library', 'Application Support');
    for (const p of ['Google/Chrome/Default', 'Google/Chrome/Profile 2', 'Google/Chrome/Guest Profile', 'Google/Chrome/System Profile', 'Microsoft Edge/Default', 'Arc/User Data/Default', 'com.operasoftware.Opera', 'Vivaldi/Default']) {
      fs.mkdirSync(path.join(support, p), { recursive: true });
      fs.writeFileSync(path.join(support, p, 'History'), '');
    }
    fs.mkdirSync(path.join(support, 'BraveSoftware', 'Brave-Browser', 'Default'), { recursive: true }); // installed, never used
    fs.mkdirSync(path.join(support, 'Firefox', 'Profiles', 'x1y2z3.default-release'), { recursive: true });
    fs.writeFileSync(path.join(support, 'Firefox', 'Profiles', 'x1y2z3.default-release', 'places.sqlite'), '');
    expect(browserFiles(home).map((p) => [p.key, p.browser, p.type, path.relative(support, p.file)])).toEqual([
      ['chrome:Default', 'chrome', 'chromium', 'Google/Chrome/Default/History'],
      ['chrome:Profile2', 'chrome', 'chromium', 'Google/Chrome/Profile 2/History'],
      ['edge:Default', 'edge', 'chromium', 'Microsoft Edge/Default/History'],
      ['arc:Default', 'arc', 'chromium', 'Arc/User Data/Default/History'],
      ['vivaldi:Default', 'vivaldi', 'chromium', 'Vivaldi/Default/History'],
      ['opera', 'opera', 'chromium', 'com.operasoftware.Opera/History'],
      ['firefox:x1y2z3default-release', 'firefox', 'firefox', 'Firefox/Profiles/x1y2z3.default-release/places.sqlite'],
    ]);
    expect(browserFiles(temp())).toEqual([]);
  });

  it("turns Chrome's visits and searches into events, and leaves out its own pages, frames, reloads and redirects", () => {
    const file = path.join(temp(), 'History');
    const db = chromeDb(file);
    addChromeVisit(db, { url: 'https://www.example.com/protein', at: '2025-06-01T09:00:00Z', title: 'Protein bars compared' });
    addChromeVisit(db, { url: 'https://www.google.com/search?q=leg+day&oq=leg&sourceid=chrome', at: '2025-06-01T09:01:00Z', title: 'leg day - Google Search', term: 'leg day' });
    addChromeVisit(db, { url: 'https://www.bing.com/search?q=knee+pain&form=QBLH', at: '2025-06-01T09:02:00Z' });
    addChromeVisit(db, { url: 'chrome://settings/', at: '2025-06-01T09:03:00Z' });
    addChromeVisit(db, { url: 'edge://history/', at: '2025-06-01T09:03:10Z' });
    addChromeVisit(db, { url: 'about:blank', at: '2025-06-01T09:03:20Z' });
    addChromeVisit(db, { url: 'file:///Users/me/secret.txt', at: '2025-06-01T09:03:30Z' });
    addChromeVisit(db, { url: 'chrome-extension://abcdef/popup.html', at: '2025-06-01T09:03:40Z' });
    addChromeVisit(db, { url: 'https://ads.example/frame', at: '2025-06-01T09:04:00Z', transition: LINK | 3 });
    addChromeVisit(db, { url: 'https://www.example.com/protein', at: '2025-06-01T09:05:00Z', transition: LINK | 8 });
    addChromeVisit(db, { url: 'http://short.example/x', at: '2025-06-01T09:06:00Z', transition: 0x10000000 }); // sent the browser on
    addChromeVisit(db, { url: 'https://long.example/landing', at: '2025-06-01T09:06:01Z', transition: 0x20000000 | 0x80000000 }); // where it went
    addChromeVisit(db, { url: 'https://hidden.example/', at: '2025-06-01T09:07:00Z', hidden: 1 });
    addChromeVisit(db, { url: 'https://news.example.org/', at: '2025-06-01T09:08:00Z', origin: 'a1b2c3d4' }); // from the phone
    const r = read(file, (c) => readChromium(c));
    const events: any[] = webEvents(r.rows, chrome);
    expect(events.map((e) => [e.kind, e.title])).toEqual([
      ['visit', 'Visited Protein bars compared'],
      ['search', 'Searched "leg day"'],
      ['search', 'Searched "knee pain"'],
      ['visit', 'Visited long.example'],
      ['visit', 'Visited news.example.org'],
    ]);
    expect(events[0]).toEqual({
      id: `mac:web:chrome:Default:1-${T('2025-06-01T09:00:00Z') / 1000}`,
      source: 'mac',
      kind: 'visit',
      at: T('2025-06-01T09:00:00Z'),
      title: 'Visited Protein bars compared',
      url: 'https://www.example.com/protein',
      tier: 3,
      meta: { browser: 'chrome', device: 'mac', site: 'example.com' },
    });
    // A search keeps the address it was made at; a known engine's, with only the words.
    expect(events[1].url).toBe('https://www.google.com/search?q=leg%20day');
    expect(events[2]).toMatchObject({ url: 'https://www.bing.com/search?q=knee%20pain', meta: { site: 'bing.com' } });
    expect(events[4]).toMatchObject({ detail: 'On another device', meta: { device: 'other' } });
    expect(r.cursor).toBe(14);
  });

  it('reads only what is new, nothing from before it was turned on, and starts over when history was cleared', () => {
    const file = path.join(temp(), 'History');
    const db = chromeDb(file);
    for (let i = 1; i <= 4; i++) addChromeVisit(db, { url: `https://example.com/${i}`, at: `2025-06-01T0${i}:00:00Z` });
    const first = read(file, (c) => readChromium(c, { since: T('2025-06-01T02:30:00Z') }));
    expect(first.rows.map((r: { url: string }) => r.url)).toEqual(['https://example.com/3', 'https://example.com/4']);
    expect(first.rows[0].ms).toBe(T('2025-06-01T03:00:00Z'));
    expect(read(file, (c) => readChromium(c, { after: first.cursor })).rows).toEqual([]);
    addChromeVisit(db, { url: 'https://example.com/5', at: '2025-06-01T05:00:00Z' });
    expect(read(file, (c) => readChromium(c, { after: first.cursor })).rows.map((r: { id: number }) => r.id)).toEqual([5]);
    // Clear browsing data, all time: Chrome starts its count again.
    db.exec("DELETE FROM visits; DELETE FROM sqlite_sequence WHERE name = 'visits'");
    addChromeVisit(db, { url: 'https://example.com/again', at: '2025-06-01T06:00:00Z' });
    expect(read(file, (c) => readChromium(c, { after: 5 })).rows.map((r: { id: number }) => r.id)).toEqual([1]);
  });

  it('counts going back to the same search, or on to its next page, once', () => {
    const file = path.join(temp(), 'History');
    const db = chromeDb(file);
    addChromeVisit(db, { url: 'https://www.google.com/search?q=squats', at: '2025-06-01T09:00:00Z' });
    addChromeVisit(db, { url: 'https://www.google.com/search?q=squats&start=10', at: '2025-06-01T09:02:00Z' });
    addChromeVisit(db, { url: 'https://www.google.com/search?q=SQUATS', at: '2025-06-01T09:10:00Z' });
    addChromeVisit(db, { url: 'https://www.google.com/search?q=squats', at: '2025-06-01T11:00:00Z' });
    const events = webEvents(read(file, (c) => readChromium(c).rows), chrome);
    expect(events.map((e: { at: number }) => e.at)).toEqual([T('2025-06-01T09:00:00Z'), T('2025-06-01T11:00:00Z')]);
  });

  it('knows the search engines by their results pages', () => {
    const words = (u: string) => searchOf(new URL(u))?.words ?? null;
    expect(words('https://duckduckgo.com/?q=protein&ia=web')).toBe('protein');
    expect(words('https://www.google.co.uk/search?q=leg+press')).toBe('leg press');
    expect(words('https://search.yahoo.com/search?p=rest+day')).toBe('rest day');
    expect(words('https://yandex.ru/search/?text=%D0%B1%D0%B5%D0%B3')).toBe('бег');
    expect(words('https://www.youtube.com/results?search_query=mobility')).toBe('mobility');
    expect(words('https://www.google.com/maps/place/x')).toBeNull();
    expect(words('https://www.paypal.com/search?q=refund')).toBeNull();
    expect(words('https://www.google.com/search?tbm=isch')).toBeNull();
  });

  it("turns Firefox's visits into events, without downloads, frames and reloads", () => {
    const file = path.join(temp(), 'places.sqlite');
    const db = walDb(file, FIREFOX_SCHEMA);
    addFirefoxVisit(db, { url: 'https://developer.mozilla.org/en-US/', at: '2025-06-01T09:00:00Z', title: 'MDN Web Docs' });
    addFirefoxVisit(db, { url: 'https://duckduckgo.com/?q=sleep+tips&t=ffab', at: '2025-06-01T09:01:00Z', type: 2 });
    addFirefoxVisit(db, { url: 'https://example.com/file.zip', at: '2025-06-01T09:02:00Z', type: 7 });
    addFirefoxVisit(db, { url: 'https://ads.example/frame', at: '2025-06-01T09:03:00Z', type: 8 });
    addFirefoxVisit(db, { url: 'https://developer.mozilla.org/en-US/', at: '2025-06-01T09:04:00Z', type: 9 });
    addFirefoxVisit(db, { url: 'https://t.example/r', at: '2025-06-01T09:05:00Z', hidden: 1 });
    addFirefoxVisit(db, { url: 'moz-extension://abc/options.html', at: '2025-06-01T09:06:00Z' });
    addFirefoxVisit(db, { url: 'about:preferences', at: '2025-06-01T09:07:00Z' });
    const r = read(file, (c) => readFirefox(c, { since: T('2025-06-01T08:00:00Z') }));
    const events: any[] = webEvents(r.rows, firefox);
    expect(events).toEqual([
      expect.objectContaining({ id: `mac:web:firefox:abc:1-${T('2025-06-01T09:00:00Z') / 1000}`, kind: 'visit', title: 'Visited MDN Web Docs', meta: { browser: 'firefox', device: 'mac', site: 'developer.mozilla.org' } }),
      expect.objectContaining({ kind: 'search', title: 'Searched "sleep tips"', url: 'https://duckduckgo.com/?q=sleep%20tips' }),
    ]);
    expect(r.cursor).toBe(8);
    expect(read(file, (c) => readFirefox(c, { after: 8 })).rows).toEqual([]);
    expect(read(file, (c) => readFirefox(c, { since: T('2025-06-01T09:06:30Z') })).rows).toHaveLength(1);
  });

  it("says when a history isn't laid out the way it knows", () => {
    const file = path.join(temp(), 'History');
    walDb(file, 'CREATE TABLE something_else (id INTEGER PRIMARY KEY)').close();
    expect(read(file, (c) => readChromium(c, { after: 3 }))).toEqual({ rows: [], cursor: 3, more: false, unknown: true });
    expect(read(file, (c) => readFirefox(c))).toMatchObject({ rows: [], unknown: true });
    expect(webEvent({ id: 1, ms: 5, url: 'https://example.com/' }, chrome)).toBeNull();
  });
});

describe('Mail', () => {
  it('reads the newest of Mail’s folders', () => {
    const home = temp();
    for (const v of ['V8', 'V10', 'V9', 'Vx']) fs.mkdirSync(path.join(home, 'Library', 'Mail', v), { recursive: true });
    expect(mailFile(home)).toBe(path.join(home, 'Library', 'Mail', 'V10', 'MailData', 'Envelope Index'));
    expect(mailFile(temp())).toMatch(/Mail\/V10\/MailData\/Envelope Index$/);
  });

  it('tells sent, junk, trash and drafts from the rest', () => {
    expect(['INBOX', '%5BGmail%5D/Sent%20Mail', 'Sent%20Items', 'Sent%20Messages', 'Junk', 'Junk%20E-mail', '%5BGmail%5D/Spam', 'Deleted%20Messages', '%5BGmail%5D/Bin', 'Trash', 'Drafts', 'Outbox', 'Archive', '%5BGmail%5D/All%20Mail'].map((b) => mailboxKind(`imap://X/${b}`))).toEqual([
      'keep', 'sent', 'sent', 'sent', 'skip', 'skip', 'skip', 'skip', 'skip', 'skip', 'skip', 'skip', 'keep', 'keep',
    ]);
    expect(mailboxKind('%E0%A4%A')).toBe('keep');
  });

  function mailbox() {
    const file = path.join(temp(), 'Envelope Index');
    const db = mailDb(file);
    // The same email in Gmail's Inbox and All Mail.
    addMail(db, { at: '2025-06-01T09:00:00Z', from: 'friend@example.com', name: 'Aziz', subject: 'Saturday run?', mailbox: 1, global: 101 });
    addMail(db, { at: '2025-06-01T09:00:00Z', from: 'friend@example.com', name: 'Aziz', subject: 'Saturday run?', mailbox: 2, global: 101 });
    // Sent by the Player: in Sent, and in All Mail too.
    addMail(db, { at: '2025-06-01T09:30:00Z', from: 'me@example.com', name: 'Me', subject: 'Yes!', prefix: 'Re: ', mailbox: 3, global: 102 });
    addMail(db, { at: '2025-06-01T09:30:00Z', from: 'me@example.com', name: 'Me', subject: 'Yes!', prefix: 'Re: ', mailbox: 2, global: 102 });
    addMail(db, { at: '2025-06-01T10:00:00Z', from: 'noreply@gym.example', name: 'City Gym', subject: 'Your class is booked', mailbox: 4, global: 103n * 10n ** 16n, messageId: 2n ** 62n });
    addMail(db, { at: '2025-06-01T10:10:00Z', from: 'win@lottery.example', subject: 'You won', mailbox: 5, global: 104 }); // junk
    addMail(db, { at: '2025-06-01T10:20:00Z', from: 'old@example.com', subject: 'Old news', mailbox: 6, global: 105 }); // trash
    addMail(db, { at: '2025-06-01T10:30:00Z', from: 'gone@example.com', subject: 'Deleted', mailbox: 4, global: 106, deleted: 1 });
    addMail(db, { at: '2025-06-01T11:00:00Z', from: 'Mom@Example.com', name: null, subject: 'Call me', prefix: 'Fwd: ', mailbox: 4, global: 107 });
    return { file, db };
  }

  it('gives who emailed and when, once each, and never what the Player sent', () => {
    const { file } = mailbox();
    const names = new Names();
    names.addEmail('mom@example.com', 'Mom');
    const r = read(file, (c) => readMail(c));
    expect(r.rows.every((row: object) => (row as { subject: unknown }).subject === null)).toBe(true);
    const outbox = new Outbox();
    outbox.add(r.rows.map((row: unknown) => mailEvent(row, names, false)));
    const events = outbox.page(0, 100).events;
    expect(events.map((e: { title: string }) => e.title)).toEqual(['Email from Aziz', 'Email from City Gym', 'Email from Mom']);
    expect(events[0]).toEqual({
      id: 'mac:mail:g101',
      source: 'mac',
      kind: 'message',
      at: T('2025-06-01T09:00:00Z'),
      title: 'Email from Aziz',
      tier: 3,
      meta: { channel: 'email', direction: 'in', with: 'friend@example.com' },
    });
    // Ids too big for a JavaScript number are kept whole.
    expect(events[1].id).toBe('mac:mail:g1030000000000000000');
    expect(r.cursor).toBe(9);
  });

  it('adds the subject only when message text is on', () => {
    const { file } = mailbox();
    const rows = read(file, (c) => readMail(c, { text: true }).rows);
    expect(rows.map((row: unknown) => mailEvent(row, noNames, true)?.detail)).toEqual(['Saturday run?', 'Saturday run?', 'Your class is booked', 'Fwd: Call me']);
    expect(rows.map((row: unknown) => mailEvent(row, noNames, false)).some((e: object | null) => !!e && 'detail' in e)).toBe(false);
  });

  it('reads only new mail, and nothing from before it was turned on', () => {
    const { file, db } = mailbox();
    const first = read(file, (c) => readMail(c, { since: T('2025-06-01T09:45:00Z') }));
    expect(first.rows.map((r: { address: string }) => r.address)).toEqual(['noreply@gym.example', 'Mom@Example.com']);
    addMail(db, { at: '2025-06-01T12:00:00Z', from: 'coach@example.com', subject: 'Plan', mailbox: 1, global: 108 });
    // An old email that only now came in (a new account): before `since`, so not read.
    addMail(db, { at: '2025-05-01T12:00:00Z', from: 'ancient@example.com', subject: 'Hi', mailbox: 1, global: 109 });
    expect(read(file, (c) => readMail(c, { after: first.cursor, since: T('2025-06-01T09:45:00Z') })).rows.map((r: { address: string }) => r.address)).toEqual(['coach@example.com']);
  });

  it("says when Mail's list isn't laid out the way it knows", () => {
    const file = path.join(temp(), 'Envelope Index');
    walDb(file, 'CREATE TABLE messages (ROWID INTEGER PRIMARY KEY, sender INTEGER)').close();
    expect(read(file, (c) => readMail(c))).toMatchObject({ rows: [], unknown: true });
    expect(mailEvent({ rowid: 1, date: 5 }, noNames, false)).toBeNull();
  });
});

describe('Calendar', () => {
  const window = { from: T('2025-06-01T00:00:00Z'), until: T('2025-06-15T00:00:00Z') };

  function calendar() {
    const file = path.join(temp(), 'Calendar.sqlitedb');
    const db = calendarDb(file);
    addCalEvent(db, { uuid: 'E-1', title: 'Dentist', start: '2025-06-02T09:00:00Z', end: '2025-06-02T10:00:00Z', place: 'Smile Clinic' });
    // Every Tuesday: one before the window, two in it, one after.
    addCalEvent(db, { uuid: 'E-2', title: 'Football', start: '2025-05-27T17:00:00Z', end: '2025-05-27T18:30:00Z', calendar: 2, repeats: ['2025-06-03T17:00:00Z', '2025-06-10T17:00:00Z', '2025-06-17T17:00:00Z'] });
    // Three days away: one row per day in OccurrenceCache.
    addCalEvent(db, { uuid: 'E-3', title: 'Samarkand trip', start: '2025-06-05T00:00:00Z', end: '2025-06-07T23:59:59Z', allDay: true });
    addCalEvent(db, { uuid: 'E-4', title: 'Match day', start: '2025-06-04T15:00:00Z', end: '2025-06-04T17:00:00Z', calendar: 3 }); // subscribed
    addCalEvent(db, { uuid: 'E-5', title: "Aziz's birthday", start: '2025-06-06T00:00:00Z', end: '2025-06-06T23:59:59Z', calendar: 4, birthday: 12, allDay: true });
    addCalEvent(db, { uuid: 'E-6', title: 'Independence Day', start: '2025-06-04T00:00:00Z', end: '2025-06-04T23:59:59Z', calendar: 5, allDay: true });
    addCalEvent(db, { uuid: 'E-7', title: 'Cancelled lunch', start: '2025-06-03T12:00:00Z', end: '2025-06-03T13:00:00Z', status: 3 });
    addCalEvent(db, { uuid: 'E-8', title: 'Arise: Leg day', start: '2025-06-02T18:00:00Z', end: '2025-06-02T19:00:00Z' }); // put there by Arise
    addCalEvent(db, { uuid: 'E-9', title: 'Hidden', start: '2025-06-02T20:00:00Z', end: '2025-06-02T21:00:00Z', hidden: 1 });
    addCalEvent(db, { uuid: 'E-10', title: 'Too far ahead', start: '2025-06-20T09:00:00Z', end: '2025-06-20T10:00:00Z' });
    addCalEvent(db, { uuid: 'E-11', title: 'Long ago', start: '2025-05-01T09:00:00Z', end: '2025-05-01T10:00:00Z' });
    return { file, db };
  }

  it("gives each event in the window, each repeat of a repeating one, and leaves out what isn't the Player's own", () => {
    const { file } = calendar();
    const r = read(file, (c) => readCalendar(c, window));
    expect(r.more).toBe(false);
    const events: any[] = r.rows.map(calendarEvent).filter(Boolean);
    expect(events.map((e) => [e.id, e.title])).toEqual([
      ['mac:cal:E-1', 'Dentist'],
      [`mac:cal:E-2:${apple('2025-06-03T17:00:00Z')}`, 'Football'],
      ['mac:cal:E-3', 'Samarkand trip'],
      [`mac:cal:E-2:${apple('2025-06-10T17:00:00Z')}`, 'Football'],
    ]);
    expect(events[0]).toEqual({
      id: 'mac:cal:E-1',
      source: 'mac',
      kind: 'event',
      at: T('2025-06-02T09:00:00Z'),
      end: T('2025-06-02T10:00:00Z'),
      title: 'Dentist',
      detail: 'At Smile Clinic',
      tier: 2,
      meta: { calendar: 'Home' },
    });
    expect(events[1].meta).toEqual({ calendar: 'Work' });
    // An all-day event is the day on this Mac's clock.
    expect(events[2]).toMatchObject({ at: new Date(2025, 5, 5).getTime(), end: new Date(2025, 5, 7, 23, 59, 59).getTime(), meta: { calendar: 'Home', allDay: true } });
  });

  it('asks for a day more on each side, since all-day events are clock time, and then keeps only the window', () => {
    const file = path.join(temp(), 'Calendar.sqlitedb');
    const db = calendarDb(file);
    addCalEvent(db, { uuid: 'B-1', title: 'Just before', start: '2025-05-31T11:00:00Z', end: '2025-05-31T12:00:00Z' });
    addCalEvent(db, { uuid: 'B-2', title: 'Just after', start: '2025-06-15T12:00:00Z', end: '2025-06-15T13:00:00Z' });
    addCalEvent(db, { uuid: 'B-3', title: 'Two days before', start: '2025-05-30T09:00:00Z', end: '2025-05-30T10:00:00Z' });
    const events: any[] = read(file, (c) => readCalendar(c, window)).rows.map(calendarEvent);
    expect(events.map((e) => e.title)).toEqual(['Just before', 'Just after']);
    expect(events.filter((e) => inWindow(e, window.from, window.until))).toEqual([]);
    expect(inWindow({ at: window.from - 3_600_000, end: window.from }, window.from, window.until)).toBe(true);
    expect(inWindow({ at: window.until - 1 }, window.from, window.until)).toBe(true);
    expect(inWindow({ at: window.until }, window.from, window.until)).toBe(false);
  });

  it('keeps the first repeat under the event’s own id, and a repeat moved on its own under when it was due', () => {
    const file = path.join(temp(), 'Calendar.sqlitedb');
    const db = calendarDb(file);
    const id = addCalEvent(db, { uuid: 'R-1', title: 'Yoga', start: '2025-06-02T07:00:00Z', end: '2025-06-02T08:00:00Z' });
    // The next one, due on the 9th, moved to the 10th.
    addOccurrences(db, id, 1, [apple('2025-06-10T07:00:00Z')], 3600, [apple('2025-06-09T07:00:00Z')]);
    const events: any[] = read(file, (c) => readCalendar(c, window)).rows.map(calendarEvent);
    expect(events.map((e) => [e.id, e.at])).toEqual([
      ['mac:cal:R-1', T('2025-06-02T07:00:00Z')],
      [`mac:cal:R-1:${apple('2025-06-09T07:00:00Z')}`, T('2025-06-10T07:00:00Z')],
    ]);
  });

  it('reads CalendarItem alone when there is no list of repeats', () => {
    const file = path.join(temp(), 'Calendar.sqlitedb');
    const db = calendarDb(file);
    addCalEvent(db, { uuid: 'E-1', title: 'Dentist', start: '2025-06-02T09:00:00Z', end: '2025-06-02T10:00:00Z' });
    addCalEvent(db, { uuid: 'E-2', title: 'Old', start: '2025-05-02T09:00:00Z', end: '2025-05-02T10:00:00Z' });
    db.exec('DROP TABLE OccurrenceCache');
    expect(read(file, (c) => readCalendar(c, window)).rows.map(calendarEvent).map((e: any) => e.id)).toEqual(['mac:cal:E-1']);
  });

  it('reads the older Calendar Cache, before macOS 14', () => {
    const file = path.join(temp(), 'Calendar Cache');
    const db = walDb(file, CALENDAR_CACHE_SCHEMA);
    db.exec(`INSERT INTO ZNODE VALUES (1, 10, 1, 'Home', 'N1'), (2, 10, 1, 'US Holidays', 'N2');
      INSERT INTO ZCALENDARITEM VALUES (1, 20, 1, 0, 1, ${apple('2025-06-02T09:00:00Z')}, ${apple('2025-06-02T10:00:00Z')}, 'Dentist', 'OLD-1', NULL, NULL),
        (2, 20, 1, 1, 2, ${apple('2025-06-04T00:00:00Z')}, ${apple('2025-06-04T23:59:59Z')}, 'Independence Day', 'OLD-2', NULL, NULL);`);
    const events: any[] = read(file, (c) => readCalendar(c, window)).rows.map(calendarEvent).filter(Boolean);
    expect(events).toEqual([expect.objectContaining({ id: 'mac:cal:OLD-1', title: 'Dentist', at: T('2025-06-02T09:00:00Z'), meta: { calendar: 'Home' } })]);
  });

  it("says when the calendar isn't laid out the way it knows, and where it looks", () => {
    const file = path.join(temp(), 'Calendar.sqlitedb');
    walDb(file, 'CREATE TABLE Events (id INTEGER PRIMARY KEY)').close();
    expect(read(file, (c) => readCalendar(c, window))).toEqual({ rows: [], more: false, unknown: true });
    expect(calendarFiles('/Users/me')).toEqual(['/Users/me/Library/Group Containers/group.com.apple.calendar/Calendar.sqlitedb', '/Users/me/Library/Calendars/Calendar Cache']);
  });

  it('hands over what is new or changed, and the ids of what went', () => {
    const ev = (id: string, at: number, title = 'Run') => ({ id, source: 'mac', kind: 'event', at, end: at + 3_600_000, title, tier: 2, meta: {} });
    const from = T('2025-06-01T00:00:00Z');
    const a = ev('mac:cal:A', T('2025-06-02T09:00:00Z'));
    const b = ev('mac:cal:B', T('2025-06-03T09:00:00Z'));
    const first = calendarChanges({}, [a, b], { from, complete: true });
    expect(first.put).toEqual([a, b]);
    expect(first.gone).toEqual([]);
    // Nothing changed: nothing to hand over.
    expect(calendarChanges(first.seen, [a, b], { from, complete: true })).toMatchObject({ put: [], gone: [] });
    // A moved, B cancelled.
    const moved = ev('mac:cal:A', T('2025-06-02T11:00:00Z'));
    const next = calendarChanges(first.seen, [moved], { from, complete: true });
    expect(next).toMatchObject({ put: [moved], gone: ['mac:cal:B'] });
    expect(Object.keys(next.seen)).toEqual(['mac:cal:A']);
    // Renamed: changed too.
    expect(calendarChanges(next.seen, [ev('mac:cal:A', T('2025-06-02T11:00:00Z'), 'Long run')], { from, complete: true }).put).toHaveLength(1);
    // One that's over before the window now starts went behind it, not away.
    expect(calendarChanges(first.seen, [b], { from: T('2025-06-02T12:00:00Z'), complete: true }).gone).toEqual([]);
    // When not the whole window was read, nothing counts as gone.
    const part = calendarChanges(first.seen, [a], { from, complete: false });
    expect(part.gone).toEqual([]);
    expect(Object.keys(part.seen).sort()).toEqual(['mac:cal:A', 'mac:cal:B']);
  });
});
