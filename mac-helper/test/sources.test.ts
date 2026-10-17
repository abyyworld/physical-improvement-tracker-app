// What the helper reads from each source, through private copies of small databases shaped like
// the ones macOS keeps: calls (and which were missed), messages (who and when, words only when
// asked), notifications, Safari visits (and which came from another device), Contacts names, and
// Screen Time's app use.

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withSnapshot } from '../src/snapshot.mjs';
import { callEvent, cleanBundle, isMissed, messageEvent, notificationEvent, readCalls, readMessages, readNotifications, readSafari, visitEvent } from '../src/sources.mjs';
import { Names, contactFiles, readContacts } from '../src/contacts.mjs';
import { readKnowledgeApps } from '../src/apps.mjs';
import {
  CALLS_SCHEMA,
  KNOWLEDGE_SCHEMA,
  NOTES_SCHEMA,
  SAFARI_SCHEMA,
  addCall,
  addMessage,
  addNotification,
  addUsage,
  addVisit,
  attributedBody,
  contactsDb,
  messagesDb,
  notificationData,
  tempDir,
  walDb,
} from './fixtures';

const dirs: string[] = [];
const temp = () => {
  const d = tempDir();
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const noNames = { lookup: () => '' };
const read = <T>(file: string, fn: (db: import('node:sqlite').DatabaseSync) => T) => withSnapshot(file, path.join(path.dirname(file), 'tmp'), fn);

describe('private copies', () => {
  it('reads rows still in the write-ahead log, and never changes or locks the original', () => {
    const dir = temp();
    const file = path.join(dir, 'CallHistory.storedata');
    const db = walDb(file, CALLS_SCHEMA);
    addCall(db, { at: '2025-06-01T09:00:00Z', answered: 1, duration: 60 });
    expect(fs.statSync(`${file}-wal`).size).toBeGreaterThan(0);
    const before = [fs.readFileSync(file), fs.readFileSync(`${file}-wal`)];
    const rows = read(file, (copy) => readCalls(copy).rows);
    expect(rows).toHaveLength(1);
    // The originals are byte for byte the same, the app can still write, and no copy is left.
    expect(fs.readFileSync(file).equals(before[0])).toBe(true);
    expect(fs.readFileSync(`${file}-wal`).equals(before[1])).toBe(true);
    addCall(db, { at: '2025-06-01T10:00:00Z' });
    expect(fs.readdirSync(path.join(dir, 'tmp'))).toEqual([]);
    db.close();
  });

  it('says when the file is missing', () => {
    const dir = temp();
    expect(() => read(path.join(dir, 'nope.db'), () => 1)).toThrow(expect.objectContaining({ code: 'ENOENT' }));
    expect(fs.readdirSync(path.join(dir, 'tmp'))).toEqual([]);
  });
});

describe('calls', () => {
  function calls() {
    const file = path.join(temp(), 'CallHistory.storedata');
    const db = walDb(file, CALLS_SCHEMA);
    addCall(db, { uid: 'A1', at: '2025-06-01T09:00:00Z', answered: 0, originated: 0, address: '+998901234567' }); // missed
    addCall(db, { uid: 'A2', at: '2025-06-01T10:00:00Z', answered: 1, originated: 0, duration: 312, name: 'Aziz Karimov', address: '+998977777777' });
    addCall(db, { uid: 'A3', at: '2025-06-01T11:00:00Z', answered: 0, originated: 1, duration: 0, address: new TextEncoder().encode('+15550001111') }); // no answer
    addCall(db, { uid: 'A4', at: '2025-06-01T12:00:00Z', answered: 1, originated: 1, duration: 95, type: 8, address: 'friend@example.com' });
    addCall(db, { uid: 'A5', at: '2025-06-01T13:00:00Z', answered: 0, originated: 0, type: 16, address: 'friend@example.com' });
    addCall(db, { uid: 'A6', at: '2025-06-01T14:00:00Z', answered: 0, originated: 0, type: 0, provider: 'net.whatsapp.WhatsApp', name: 'Mom' });
    return { file, db };
  }

  it('knows a missed call: someone called, and it was not answered', () => {
    expect(isMissed({ originated: 0, answered: 0 })).toBe(true);
    expect(isMissed({ originated: 0, answered: 1 })).toBe(false);
    expect(isMissed({ originated: 1, answered: 0 })).toBe(false); // one you made, nobody picked up
  });

  it('turns each call into an event: who, when, how long, which way, missed or not', () => {
    const { file } = calls();
    const names = new Names();
    names.addPhone('+998 90 123 45 67', 'Mom');
    const r = read(file, (db) => readCalls(db));
    const events: any[] = r.rows.map((row: unknown) => callEvent(row, names));
    expect(events.map((e: { title: string }) => e.title)).toEqual([
      'Missed call from Mom',
      'Call from Aziz Karimov, 5 min',
      'Call to +15550001111, no answer',
      'FaceTime video call to friend@example.com, 2 min',
      'Missed FaceTime audio call from friend@example.com',
      'Missed WhatsApp call from Mom',
    ]);
    expect(events[0]).toEqual({
      id: 'mac:call:A1',
      source: 'mac',
      kind: 'call',
      at: Date.parse('2025-06-01T09:00:00Z'),
      title: 'Missed call from Mom',
      tier: 3,
      meta: { direction: 'in', missed: true, type: 'phone', with: '+998901234567' },
    });
    expect(events[1]).toMatchObject({ end: Date.parse('2025-06-01T10:05:12Z'), value: 5.2, unit: 'min', meta: { direction: 'in', missed: false } });
    expect(events[5].meta).toMatchObject({ type: 'app', app: 'net.whatsapp.WhatsApp' });
    expect(r.cursor).toBe(6);
  });

  it('reads only what is new, and nothing from before the source was turned on', () => {
    const { file, db } = calls();
    const first = read(file, (c) => readCalls(c, { since: Date.parse('2025-06-01T11:30:00Z') }));
    expect(first.rows.map((r: { uid: string }) => r.uid)).toEqual(['A4', 'A5', 'A6']);
    expect(read(file, (c) => readCalls(c, { after: first.cursor })).rows).toEqual([]);
    // A call synced from the iPhone later, though it happened earlier, still comes.
    addCall(db, { uid: 'LATE', at: '2025-06-01T12:30:00Z', answered: 1, duration: 30 });
    expect(read(file, (c) => readCalls(c, { after: first.cursor, since: Date.parse('2025-06-01T11:30:00Z') })).rows.map((r: { uid: string }) => r.uid)).toEqual(['LATE']);
  });

  it('starts over when the history was cleared and begun again', () => {
    const file = path.join(temp(), 'CallHistory.storedata');
    const db = walDb(file, CALLS_SCHEMA);
    addCall(db, { pk: 1, uid: 'N1', at: '2025-06-02T09:00:00Z' });
    expect(read(file, (c) => readCalls(c, { after: 500 })).rows).toHaveLength(1);
  });

  it("doesn't start over when only the newest calls were deleted, since Core Data never uses a key twice", () => {
    const file = path.join(temp(), 'CallHistory.storedata');
    const db = walDb(file, `${CALLS_SCHEMA}\nCREATE TABLE Z_PRIMARYKEY (Z_ENT INTEGER PRIMARY KEY, Z_NAME VARCHAR, Z_SUPER INTEGER, Z_MAX INTEGER);`);
    for (let pk = 1; pk <= 5; pk++) addCall(db, { pk, uid: `D${pk}`, at: `2025-06-02T0${pk}:00:00Z` });
    db.exec("INSERT INTO Z_PRIMARYKEY VALUES (2, 'CallRecord', 0, 5)");
    const uids = (after: number) => read(file, (c) => readCalls(c, { after })).rows.map((r: { uid: string }) => r.uid);
    expect(read(file, (c) => readCalls(c)).cursor).toBe(5);
    // The two newest deleted from Recents.
    db.exec('DELETE FROM ZCALLRECORD WHERE Z_PK >= 4');
    expect(read(file, (c) => readCalls(c, { after: 5 }))).toEqual({ rows: [], cursor: 5, more: false });
    addCall(db, { pk: 6, uid: 'D6', at: '2025-06-02T07:00:00Z' });
    db.exec('UPDATE Z_PRIMARYKEY SET Z_MAX = 6');
    expect(uids(5)).toEqual(['D6']);
    // A store made anew counts from 1 again: read from the start.
    db.exec('DELETE FROM ZCALLRECORD; UPDATE Z_PRIMARYKEY SET Z_MAX = 1');
    addCall(db, { pk: 1, uid: 'N1', at: '2025-06-02T08:00:00Z' });
    expect(uids(6)).toEqual(['N1']);
  });

  it('leaves out calls without a time, and copes with an older table', () => {
    const file = path.join(temp(), 'CallHistory.storedata');
    const db = walDb(file, 'CREATE TABLE ZCALLRECORD (Z_PK INTEGER PRIMARY KEY, ZDATE TIMESTAMP, ZADDRESS VARCHAR, ZANSWERED INTEGER, ZORIGINATED INTEGER);');
    db.exec("INSERT INTO ZCALLRECORD VALUES (1, 770000000, '+1555', 0, 0), (2, NULL, '+1556', 0, 0)");
    const rows = read(file, (c) => readCalls(c).rows);
    expect(rows.map((r: unknown) => callEvent(r, noNames))).toEqual([expect.objectContaining({ id: 'mac:call:pk1', title: 'Missed call from +1555' })]);
    expect(callEvent({ pk: 2, date: null, address: '+1556' }, noNames)).toBeNull();
  });
});

describe('messages', () => {
  function chat() {
    const file = path.join(temp(), 'chat.db');
    const db = messagesDb(file);
    addMessage(db, { guid: 'G1', at: '2025-06-01T09:00:00Z', chat: 1, handle: 1, text: 'Did you train today?' });
    addMessage(db, { guid: 'G2', at: '2025-06-01T09:01:00Z', chat: 1, handle: 1, fromMe: true, body: attributedBody('Yes, legs 💪') });
    addMessage(db, { guid: 'G3', at: '2025-06-01T09:02:00Z', chat: 2, handle: 2, body: attributedBody('Who is in for Saturday?') });
    addMessage(db, { guid: 'G4', at: '2025-06-01T09:03:00Z', chat: 2, fromMe: true, text: 'Me' });
    addMessage(db, { guid: 'G5', at: '2025-06-01T09:04:00Z', chat: 1, handle: 1, assoc: 2000 }); // a tapback
    addMessage(db, { guid: 'G6', at: '2025-06-01T09:05:00Z', chat: 2, handle: 1, item: 2 }); // the group renamed
    addMessage(db, { guid: 'G7', at: '2025-06-01T09:06:00Z', chat: 3, handle: 3, service: 'SMS', text: 'Your code is 1234' });
    return { file, db };
  }

  it('gives who and when only, unless message text is on', () => {
    const { file } = chat();
    const names = new Names();
    names.addPhone('+998901234567', 'Mom');
    names.addEmail('friend@example.com', 'Aziz');
    const rows = read(file, (db) => readMessages(db).rows);
    expect(rows[0]).not.toHaveProperty('text');
    expect(rows[0]).not.toHaveProperty('body');
    const events: any[] = rows.map((r: unknown) => messageEvent(r, names, false)).filter(Boolean);
    expect(events.map((e: { title: string }) => e.title)).toEqual(['Message from Mom', 'Message to Mom', 'Message from Aziz in Gym crew', 'Message to Gym crew', 'Message from +15550001111']);
    expect(events.every((e: object) => !('detail' in e))).toBe(true);
    expect(events[0]).toEqual({
      id: 'mac:msg:G1',
      source: 'mac',
      kind: 'message',
      at: Date.parse('2025-06-01T09:00:00Z'),
      title: 'Message from Mom',
      tier: 3,
      meta: { direction: 'in', group: false, with: '+998901234567', service: 'iMessage' },
    });
    expect(events[4].meta).toMatchObject({ service: 'SMS' });
  });

  it('adds the words when message text is on, from text or attributedBody', () => {
    const { file } = chat();
    const rows = read(file, (db) => readMessages(db, { text: true }).rows);
    const words = (rows.map((r: unknown) => messageEvent(r, noNames, true)).filter(Boolean) as any[]).map((e: { detail?: string }) => e.detail);
    expect(words).toEqual(['Did you train today?', 'Yes, legs 💪', 'Who is in for Saturday?', 'Me', 'Your code is 1234']);
  });

  it('reads only new rows, and nothing before the source was turned on', () => {
    const { file, db } = chat();
    const first = read(file, (c) => readMessages(c, { since: Date.parse('2025-06-01T09:02:30Z') }));
    expect(first.rows.map((r: { guid: string }) => r.guid)).toEqual(['G4', 'G5', 'G6', 'G7']);
    addMessage(db, { guid: 'G8', at: '2025-06-01T10:00:00Z', chat: 1, handle: 1, text: 'ok' });
    expect(read(file, (c) => readMessages(c, { after: first.cursor })).rows.map((r: { guid: string }) => r.guid)).toEqual(['G8']);
  });

  it("doesn't read every message again when the newest ones were deleted", () => {
    const { file, db } = chat();
    const first = read(file, (c) => readMessages(c));
    expect(first.cursor).toBe(7);
    db.exec('DELETE FROM message WHERE ROWID >= 6');
    expect(read(file, (c) => readMessages(c, { after: first.cursor }))).toEqual({ rows: [], cursor: 7, more: false });
    addMessage(db, { guid: 'G8', at: '2025-06-01T10:00:00Z', chat: 1, handle: 1, text: 'ok' });
    expect(read(file, (c) => readMessages(c, { after: first.cursor })).rows.map((r: { guid: string }) => r.guid)).toEqual(['G8']);
  });

  it('counts a message in two chats once', () => {
    const { file, db } = chat();
    db.exec('INSERT INTO chat_message_join (chat_id, message_id) VALUES (3, 1)');
    expect(read(file, (c) => readMessages(c).rows.filter((r: { guid: string }) => r.guid === 'G1'))).toHaveLength(1);
  });
});

describe('notifications', () => {
  function notes() {
    const file = path.join(temp(), 'db');
    const db = walDb(file, NOTES_SCHEMA);
    db.exec("INSERT INTO app VALUES (1, 'com.apple.MobileSMS', 0), (2, '_system_center_:com.apple.iCal', 0), (3, 'com.example.thing', 0)");
    addNotification(db, { app: 1, uuid: '00112233445566778899aabbccddeeff', at: '2025-06-01T09:00:00Z', data: notificationData('com.apple.MobileSMS', { titl: 'Mom', body: 'Call me' }) });
    addNotification(db, { app: 2, uuid: '0123456789abcdef0123456789abcdef', at: '2025-06-01T09:10:00Z', data: notificationData('com.apple.iCal', { titl: 'Leg day', subt: 'In 15 minutes' }) });
    addNotification(db, { app: 3, uuid: 'ffeeddccbbaa99887766554433221100', at: '2025-06-01T09:20:00Z', data: Uint8Array.of(1, 2, 3) });
    return { file, db };
  }

  it('gives the app and when, and the words only when text is on', () => {
    const { file } = notes();
    const r = read(file, (db) => readNotifications(db));
    const plain: any[] = r.rows.map((row: unknown) => notificationEvent(row, { text: false }));
    expect(plain.map((e: { title: string }) => e.title)).toEqual(['Notification from Messages', 'Notification from Calendar', 'Notification from Thing']);
    expect(plain[0]).toEqual({
      id: 'mac:note:00112233445566778899aabbccddeeff',
      source: 'mac',
      kind: 'notification',
      at: Date.parse('2025-06-01T09:00:00Z'),
      title: 'Notification from Messages',
      tier: 3,
      meta: { app: 'com.apple.MobileSMS' },
    });
    const words = (r.rows.map((row: unknown) => notificationEvent(row, { text: true })) as any[]).map((e: { detail?: string }) => e.detail);
    // A payload that can't be read still gives the app and the time, without words.
    expect(words).toEqual(['Mom · Call me', 'Leg day · In 15 minutes', undefined]);
    expect(cleanBundle('_system_center_:com.apple.iCal')).toBe('com.apple.iCal');
  });

  it('reads again a minute back, since usernoted writes rows late, and goes by delivery time', () => {
    const { file, db } = notes();
    const first = read(file, (c) => readNotifications(c));
    expect(first.rows).toHaveLength(3);
    // Delivered 30 seconds before the newest one already read, but written only now.
    addNotification(db, { app: 1, uuid: 'aa00000000000000000000000000000a', at: '2025-06-01T09:19:30Z' });
    const again = read(file, (c) => readNotifications(c, { after: first.cursor }));
    expect(again.rows.map((r: { uuid: Uint8Array }) => Buffer.from(r.uuid).toString('hex'))).toEqual(['aa00000000000000000000000000000a', 'ffeeddccbbaa99887766554433221100']);
  });

  it('skips what came before the source was turned on', () => {
    const { file } = notes();
    expect(read(file, (c) => readNotifications(c, { since: Date.parse('2025-06-01T09:05:00Z') })).rows).toHaveLength(2);
  });
});

describe('Safari', () => {
  it('gives the page, and whether the visit came from another device', () => {
    const file = path.join(temp(), 'History.db');
    const db = walDb(file, SAFARI_SCHEMA);
    addVisit(db, { url: 'https://www.example.com/protein', at: '2025-06-01T09:00:00Z', title: 'Protein bars compared' });
    addVisit(db, { url: 'https://news.example.org/', at: '2025-06-01T09:05:00Z', origin: 1 });
    const failed = addVisit(db, { url: 'https://broken.example/', at: '2025-06-01T09:06:00Z', ok: 0 });
    addVisit(db, { url: 'http://short.example/x', at: '2025-06-01T09:07:00Z', redirect: failed });
    addVisit(db, { url: 'file:///Users/me/secret.txt', at: '2025-06-01T09:08:00Z' });
    const r = read(file, (c) => readSafari(c));
    const events: any[] = r.rows.map((row: unknown) => visitEvent(row)).filter(Boolean);
    expect(events).toEqual([
      {
        id: 'mac:safari:1',
        source: 'mac',
        kind: 'visit',
        at: Date.parse('2025-06-01T09:00:00Z'),
        title: 'Visited Protein bars compared',
        url: 'https://www.example.com/protein',
        tier: 3,
        meta: { browser: 'safari', device: 'mac', site: 'example.com' },
      },
      expect.objectContaining({ id: 'mac:safari:2', title: 'Visited news.example.org', detail: 'On your iPhone or another device', meta: expect.objectContaining({ device: 'other' }) }),
    ]);
    expect(r.cursor).toBe(5);
    expect(visitEvent({ id: 9, time: 770000000, url: 'https://a.example/', ok: 1, redirect: null }, 'PROFILE1')?.id).toBe('mac:safari:PROFILE1:9');
  });
});

describe('Safari, after history was cleared', () => {
  it("doesn't read the history again when only the newest visits were cleared", () => {
    const file = path.join(temp(), 'History.db');
    const db = walDb(file, SAFARI_SCHEMA);
    for (let i = 1; i <= 5; i++) addVisit(db, { url: `https://example.com/${i}`, at: `2025-06-01T09:0${i}:00Z` });
    const first = read(file, (c) => readSafari(c));
    expect(first.rows).toHaveLength(5);
    // Clear History, the last hour.
    db.exec('DELETE FROM history_visits WHERE id >= 4');
    expect(read(file, (c) => readSafari(c, { after: first.cursor }))).toEqual({ rows: [], cursor: 5, more: false });
    addVisit(db, { url: 'https://example.com/new', at: '2025-06-01T10:00:00Z' });
    expect(read(file, (c) => readSafari(c, { after: first.cursor })).rows.map((r: { id: number }) => r.id)).toEqual([6]);
    // A history made anew is read from the start.
    db.exec("DELETE FROM history_visits; DELETE FROM sqlite_sequence WHERE name = 'history_visits'");
    addVisit(db, { url: 'https://example.com/again', at: '2025-06-01T11:00:00Z' });
    expect(read(file, (c) => readSafari(c, { after: 6 })).rows.map((r: { id: number }) => r.id)).toEqual([1]);
  });
});

describe('Contacts', () => {
  it('names numbers and addresses, with or without the country code', () => {
    const home = temp();
    const root = path.join(home, 'Library', 'Application Support', 'AddressBook');
    contactsDb(path.join(root, 'Sources', 'ABC-123', 'AddressBook-v22.abcddb')).close();
    const files = contactFiles(home);
    expect(files).toEqual([path.join(root, 'Sources', 'ABC-123', 'AddressBook-v22.abcddb')]);
    const names = new Names();
    read(files[0], (db) => readContacts(db, names));
    expect(names.lookup('+998901234567')).toBe('Mom');
    expect(names.lookup('901234567')).toBe('Mom');
    expect(names.lookup('+1 555 000 1111')).toBe('Dentist');
    expect(names.lookup('FRIEND@example.com')).toBe('Aziz Karimov');
    expect(names.lookup('+44 20 0000 0000')).toBe('');
    expect(names.lookup('')).toBe('');
  });

  it("doesn't guess when two people share the last 9 digits", () => {
    const names = new Names();
    names.addPhone('+1 212 555 1234', 'Ann');
    names.addPhone('+1 312 555 1234', 'Bob');
    expect(names.lookup('2125551234')).toBe('');
    expect(names.lookup('+12125551234')).toBe('Ann');
  });
});

describe("Screen Time's app use", () => {
  it('adds up each app per hour, for whole hours before app use was turned on', () => {
    const file = path.join(temp(), 'knowledgeC.db');
    const db = walDb(file, KNOWLEDGE_SCHEMA);
    addUsage(db, { bundle: 'com.apple.dt.Xcode', from: '2025-06-01T09:50:00Z', to: '2025-06-01T10:20:00Z' });
    addUsage(db, { bundle: 'com.apple.dt.Xcode', from: '2025-06-01T10:30:00Z', to: '2025-06-01T10:40:00Z' });
    addUsage(db, { bundle: 'com.google.Chrome', from: '2025-06-01T10:40:00Z', to: '2025-06-01T10:40:30Z' }); // under a minute
    addUsage(db, { bundle: 'com.spotify.client', from: '2025-06-01T11:10:00Z', to: '2025-06-01T11:50:00Z' }); // the hour it was turned on
    addUsage(db, { bundle: 'com.apple.Safari', from: '2025-06-01T10:00:00Z', to: '2025-06-01T10:30:00Z', stream: '/safari/history' });
    const events = read(file, (c) => readKnowledgeApps(c, { since: Date.parse('2025-06-01T00:00:00Z'), until: Date.parse('2025-06-01T11:30:00Z') }));
    expect(events).toEqual([
      expect.objectContaining({ id: `mac:app:com.apple.dt.Xcode:${Date.parse('2025-06-01T09:00:00Z')}`, title: 'Used Xcode for 10 min', value: 10, tier: 2, kind: 'app' }),
      expect.objectContaining({ id: `mac:app:com.apple.dt.Xcode:${Date.parse('2025-06-01T10:00:00Z')}`, title: 'Used Xcode for 30 min', value: 30, at: Date.parse('2025-06-01T10:00:00Z'), end: Date.parse('2025-06-01T10:40:00Z') }),
    ]);
  });
});
