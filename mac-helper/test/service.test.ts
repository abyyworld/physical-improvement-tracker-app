// The helper as a whole, on a pretend Mac: a home folder with small copies of the databases macOS
// keeps, and fake answers from lsappinfo and ioreg. Nothing is read until the Player turns it on;
// what's read is queued once, keeps its place across restarts, and goes out over the local server.

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Service, hasFullDiskAccess, sourceFiles, trimLog } from '../src/service.mjs';
import { formatCode, loadCode, saveCode } from '../src/config.mjs';
import { writeJson } from '../src/outbox.mjs';
import { ask } from '../src/auth.mjs';
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
import type { DatabaseSync } from 'node:sqlite';

const dirs: string[] = [];
const services: Service[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(services.splice(0).map((s) => s.stop()));
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const NOW = Date.parse('2025-06-02T12:00:00Z');

// A Mac with a bit of everything, the apps still writing (their newest rows in the -wal files).
function mac() {
  const root = tempDir();
  dirs.push(root);
  const home = path.join(root, 'home');
  const lib = path.join(home, 'Library');
  const dbs: Record<string, DatabaseSync> = {};
  dbs.calls = walDb(path.join(lib, 'Application Support', 'CallHistoryDB', 'CallHistory.storedata'), CALLS_SCHEMA);
  addCall(dbs.calls, { uid: 'C1', at: '2025-06-02T08:00:00Z', address: '+998901234567' });
  addCall(dbs.calls, { uid: 'OLD', at: '2025-04-01T08:00:00Z', address: '+998901234567' }); // before the 30 days
  dbs.messages = messagesDb(path.join(lib, 'Messages', 'chat.db'));
  addMessage(dbs.messages, { guid: 'M1', at: '2025-06-02T09:00:00Z', chat: 1, handle: 1, body: attributedBody('Train with me?') });
  dbs.notes = walDb(path.join(lib, 'Group Containers', 'group.com.apple.usernoted', 'db2', 'db'), NOTES_SCHEMA);
  dbs.notes.exec("INSERT INTO app VALUES (1, 'com.apple.MobileSMS', 0)");
  addNotification(dbs.notes, { app: 1, uuid: '00112233445566778899aabbccddeeff', at: '2025-06-02T09:00:05Z', data: notificationData('com.apple.MobileSMS', { titl: 'Mom', body: 'Train with me?' }) });
  dbs.safari = walDb(path.join(lib, 'Safari', 'History.db'), SAFARI_SCHEMA);
  addVisit(dbs.safari, { url: 'https://example.com/plan', at: '2025-06-02T10:00:00Z', title: 'Training plan', origin: 1 });
  dbs.knowledge = walDb(path.join(lib, 'Application Support', 'Knowledge', 'knowledgeC.db'), KNOWLEDGE_SCHEMA);
  addUsage(dbs.knowledge, { bundle: 'com.apple.Safari', from: '2025-06-01T20:00:00Z', to: '2025-06-01T20:30:00Z' });
  contactsDb(path.join(lib, 'Application Support', 'AddressBook', 'Sources', 'S1', 'AddressBook-v22.abcddb')).close();
  fs.mkdirSync(path.join(lib, 'Application Support', 'com.apple.TCC'), { recursive: true });
  fs.writeFileSync(path.join(lib, 'Application Support', 'com.apple.TCC', 'TCC.db'), '');
  return { root, home, dbs, base: path.join(root, '.arise-helper') };
}

function service(m: ReturnType<typeof mac>, clock = { t: NOW }) {
  const run = vi.fn(async (cmd: string, args: string[]) => {
    if (cmd.endsWith('lsappinfo') && args[0] === 'front') return 'ASN:0x0-0x2b02b:\n';
    if (cmd.endsWith('lsappinfo')) return '"CFBundleIdentifier"="com.apple.dt.Xcode"\n"LSDisplayName"="Xcode"\n';
    if (cmd.endsWith('ioreg')) return '"HIDIdleTime" = 2000000000\n';
    return '';
  });
  const s = new Service({ base: m.base, userHome: m.home, now: () => clock.t, run, log: () => {}, darwinUserDir: '' });
  services.push(s);
  return { s, run, clock };
}

const ids = (s: Service) => s.outbox.page(0, 1000).events.map((e: { id: string }) => e.id);

describe('the helper on a Mac', () => {
  it('reads nothing until something is turned on', async () => {
    const m = mac();
    const { s, run } = service(m);
    await s.tick(true);
    expect(s.outbox.items).toEqual([]);
    expect(run).not.toHaveBeenCalledWith('/usr/bin/lsappinfo', expect.anything());
    const info = s.info();
    expect(info.settings).toEqual({ calls: false, notifications: false, messages: false, text: false, safari: false, apps: false });
    expect(Object.values(info.sources).every((x: any) => x.state === 'off')).toBe(true);
    expect(info.fullDiskAccess).toBe(true);
    expect(fs.statSync(m.base).mode & 0o777).toBe(0o700);
    expect(fs.readFileSync(path.join(m.base, 'data', 'code'), 'utf8')).toMatch(/^[0-9A-HJKMNP-TV-Z]{20}$/);
  });

  it('reads calls and messages, with names from Contacts, but only who and when', async () => {
    const m = mac();
    const { s } = service(m);
    s.setSettings({ calls: true, messages: true });
    await s.tick(true);
    const events = s.outbox.page(0, 100).events;
    expect(events.map((e: { title: string }) => e.title)).toEqual(['Missed call from Mom', 'Message from Mom']);
    expect(events.some((e: object) => 'detail' in e)).toBe(false);
    expect(s.info().sources.calls).toMatchObject({ state: 'ok', found: 1, waiting: 1 });
    // The apps can still write, and reading again finds nothing new.
    addCall(m.dbs.calls, { uid: 'C2', at: '2025-06-02T11:00:00Z', answered: 1, duration: 61 });
    await s.tick(true);
    expect(ids(s)).toEqual(['mac:call:C1', 'mac:msg:M1', 'mac:call:C2']);
    await s.tick(true);
    expect(ids(s)).toHaveLength(3);
  });

  it('adds the words only with text on, and takes them back when it goes off', async () => {
    const m = mac();
    const { s } = service(m);
    s.setSettings({ messages: true, notifications: true, text: true });
    await s.tick(true);
    expect(s.outbox.page(0, 100).events.map((e: { detail?: string }) => e.detail)).toEqual(['Mom · Train with me?', 'Train with me?']);
    s.setSettings({ text: false });
    expect(s.outbox.page(0, 100).events.map((e: { detail?: string }) => e.detail)).toEqual([undefined, undefined]);
  });

  it('drops what waits from a source when it goes off, and starts afresh when it comes back', async () => {
    const m = mac();
    const { s } = service(m);
    s.setSettings({ calls: true, safari: true });
    await s.tick(true);
    expect(ids(s)).toEqual(['mac:call:C1', 'mac:safari:1']);
    s.setSettings({ calls: false });
    expect(ids(s)).toEqual(['mac:safari:1']);
    expect(s.info().sources.calls.state).toBe('off');
    expect(JSON.parse(fs.readFileSync(path.join(m.base, 'data', 'config.json'), 'utf8')).settings.calls).toBe(false);
  });

  it('brings back what was dropped when the source comes back on, but not what Arise already has', async () => {
    const m = mac();
    const { s } = service(m);
    s.setSettings({ messages: true, calls: true });
    await s.tick(true);
    expect(ids(s)).toEqual(['mac:call:C1', 'mac:msg:M1']);
    s.ack(1); // Arise has the call
    s.setSettings({ messages: false, calls: false });
    expect(ids(s)).toEqual([]);
    s.setSettings({ messages: true, calls: true });
    await s.tick(true);
    expect(ids(s)).toEqual(['mac:msg:M1']);
  });

  it("doesn't queue what it was still reading when a source was turned off", async () => {
    const m = mac();
    m.dbs.notes.exec("INSERT INTO app VALUES (2, 'com.example.brandnew', 0)");
    addNotification(m.dbs.notes, { app: 2, uuid: 'ab'.repeat(16), at: '2025-06-02T11:00:00Z' });
    const { s, run } = service(m);
    s.setSettings({ notifications: true, calls: true, apps: true });
    // The Player turns them off while Spotlight looks up the new app's name.
    run.mockImplementation(async (cmd: string) => {
      if (cmd.endsWith('mdfind')) s.setSettings({ notifications: false, calls: false, apps: false });
      return '';
    });
    await s.tick(true);
    expect(run).toHaveBeenCalledWith('/usr/bin/mdfind', expect.anything());
    expect(s.outbox.items).toEqual([]);
    expect(run).not.toHaveBeenCalledWith('/usr/bin/lsappinfo', expect.anything());
    expect(Object.values(s.info().sources).every((x: any) => x.state === 'off')).toBe(true);
  });

  it('gets through a burst of more notifications within a minute than fit on a page', async () => {
    const m = mac();
    const t0 = Date.parse('2025-06-02T11:00:00Z');
    m.dbs.notes.exec('BEGIN');
    for (let i = 0; i < 600; i++) addNotification(m.dbs.notes, { app: 1, uuid: (i + 1).toString(16).padStart(32, '0'), at: new Date(t0 + i * 50).toISOString() });
    m.dbs.notes.exec('COMMIT');
    addNotification(m.dbs.notes, { app: 1, uuid: 'f'.repeat(32), at: '2025-06-02T11:02:00Z' });
    const { s } = service(m);
    s.setSettings({ notifications: true });
    await s.tick(true);
    // The one from 9:00, all 600 from the burst, and the one after it.
    expect(new Set(ids(s)).size).toBe(602);
    expect(ids(s).at(-1)).toBe(`mac:note:${'f'.repeat(32)}`);
    expect(s.cursors.notifications.after).toBe(Date.parse('2025-06-02T11:02:00Z') / 1000 - 978307200);
  });

  it('writes down where it is only when something changed, and at most once a minute while reading', async () => {
    const m = mac();
    const { s, clock } = service(m);
    s.setSettings({ notifications: true });
    const write = vi.spyOn(fs, 'writeFileSync');
    const writes = () => write.mock.calls.filter((c) => String(c[0]).includes('state.json')).length;
    await s.tick(true);
    expect(ids(s)).toHaveLength(1);
    expect(writes()).toBe(0); // written a moment ago, with the switch
    clock.t += 60_000;
    await s.tick(true);
    expect(writes()).toBe(1);
    // The database changes, but all it gives is the notification already read (a minute back).
    m.dbs.notes.exec('UPDATE app SET badge = 1');
    clock.t += 60_000;
    await s.tick(true);
    expect(writes()).toBe(1);
    addNotification(m.dbs.notes, { app: 1, uuid: 'cd'.repeat(16), at: '2025-06-02T11:59:00Z' });
    await s.tick(true);
    expect(writes()).toBe(2);
    expect(ids(s)).toHaveLength(2);
    // With many waiting, less often: the whole queue is written each time.
    s.found('notifications', s.outbox.add(Array.from({ length: 9000 }, (_, i) => ({ id: `mac:test:${i}`, kind: 'notification' }))));
    clock.t += 60_000;
    await s.tick(true);
    expect(writes()).toBe(2);
    clock.t += 4 * 60_000;
    await s.tick(true);
    expect(writes()).toBe(3);
  });

  it('adds up app use per hour, and brings in the week before from Screen Time once', async () => {
    const m = mac();
    const { s, clock } = service(m);
    s.setSettings({ apps: true });
    for (let i = 0; i < 20; i++) {
      await s.tick();
      clock.t += 15_000;
    }
    // Screen Time's 30 minutes of Safari last night.
    expect(s.outbox.page(0, 100).events.map((e: { title: string }) => e.title)).toEqual(['Used Safari for 30 min']);
    // The first look after 1 pm hands over the noon hour: 4 min 45 sec of looks, plus up to a
    // minute after the last one.
    clock.t = Date.parse('2025-06-02T13:00:30Z');
    await s.tick();
    expect(s.outbox.page(0, 100).events.map((e: { title: string }) => e.title)).toEqual(['Used Safari for 30 min', 'Used Xcode for 6 min']);
    await s.tick(true);
    expect(s.outbox.items).toHaveLength(2);
  });

  it('says when it needs Full Disk Access', async () => {
    const m = mac();
    const { s } = service(m);
    expect(hasFullDiskAccess(path.join(m.root, 'nowhere', 'TCC.db'))).toBeNull();
    s.setSettings({ calls: true, safari: true });
    const denied = Object.assign(new Error('Operation not permitted'), { code: 'EPERM' });
    const open = fs.openSync;
    // Without Full Disk Access, macOS refuses to open anything there.
    vi.spyOn(fs, 'openSync').mockImplementation((...a: Parameters<typeof fs.openSync>) => {
      if (String(a[0]).startsWith(path.join(m.home, 'Library'))) throw denied;
      return open(...a);
    });
    vi.spyOn(fs, 'copyFileSync').mockImplementation(() => {
      throw denied;
    });
    await s.tick(true);
    expect(s.info()).toMatchObject({ fullDiskAccess: false, sources: { calls: { state: 'no-access' }, safari: { state: 'no-access' } } });
    expect(s.outbox.items).toEqual([]);
  });

  it('reads each database where it is, and keeps no copy of any', async () => {
    const m = mac();
    // A copy an older version left behind when it stopped halfway.
    fs.mkdirSync(path.join(m.base, 'tmp', 'read-x'), { recursive: true });
    fs.writeFileSync(path.join(m.base, 'tmp', 'read-x', 'db'), 'old copy');
    const { s } = service(m);
    expect(fs.existsSync(path.join(m.base, 'tmp'))).toBe(false);
    const copy = vi.spyOn(fs, 'copyFileSync');
    s.setSettings({ calls: true, notifications: true, messages: true, text: true, safari: true, apps: true });
    await s.tick(true);
    expect(s.outbox.items.length).toBeGreaterThan(4);
    expect(copy).not.toHaveBeenCalled();
    const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)).map((f) => `${e.name}/${f}`) : [e.name]));
    expect(files(m.base).sort()).toEqual(['apps.json', 'code', 'config.json', 'state.json'].map((f) => `data/${f}`));
  });

  it('says when there is nothing to read on this Mac', async () => {
    const m = mac();
    fs.rmSync(path.join(m.home, 'Library', 'Messages'), { recursive: true });
    const { s } = service(m);
    s.setSettings({ messages: true });
    await s.tick(true);
    expect(s.info().sources.messages.state).toBe('missing');
  });

  it('keeps its place and what waits across a restart', async () => {
    const m = mac();
    const first = service(m).s;
    first.setSettings({ calls: true, notifications: true });
    await first.tick(true);
    expect(ids(first)).toEqual(['mac:note:00112233445566778899aabbccddeeff', 'mac:call:C1']);
    first.ack(1); // Arise has the notification
    await first.stop();
    const again = service(m).s;
    await again.tick(true);
    expect(ids(again)).toEqual(['mac:call:C1']);
  });

  it('keeps its log short while it runs, every hour', async () => {
    const m = mac();
    const { s, clock } = service(m);
    const log = path.join(m.base, 'logs', 'helper.log');
    fs.writeFileSync(log, 'x'.repeat(2 * 1024 * 1024));
    await s.tick();
    expect(fs.statSync(log).size).toBe(256 * 1024);
    fs.appendFileSync(log, 'y'.repeat(1024 * 1024));
    clock.t += 30 * 60_000;
    await s.tick();
    expect(fs.statSync(log).size).toBe(1280 * 1024);
    clock.t += 30 * 60_000;
    await s.tick();
    expect(fs.statSync(log).size).toBe(256 * 1024);
    expect(fs.readFileSync(log, 'utf8').endsWith('y')).toBe(true);
  });

  it('finds the older notification database on macOS 14 and earlier', () => {
    const files = sourceFiles('/Users/me', '/var/folders/ab/xyz/0/');
    expect(files.notifications).toEqual(['/Users/me/Library/Group Containers/group.com.apple.usernoted/db2/db', '/var/folders/ab/xyz/0/com.apple.notificationcenter/db2/db']);
    expect(files.calls).toEqual(['/Users/me/Library/Application Support/CallHistoryDB/CallHistory.storedata']);
    expect(files.messages).toEqual(['/Users/me/Library/Messages/chat.db']);
    expect(files.safari).toEqual([{ key: '', file: '/Users/me/Library/Safari/History.db' }]);
  });

  it('hands events to Arise over 127.0.0.1, with the pairing code', async () => {
    const m = mac();
    const { s } = service(m);
    s.setSettings({ calls: true });
    await s.start(0);
    const port = (s.server!.address() as { port: number }).port;
    const code = fs.readFileSync(path.join(m.base, 'data', 'code'), 'utf8');
    // As Arise asks, with proof of the code as it was shown (with dashes).
    const get = (p: string, body?: unknown, typed = formatCode(code)) => ask(`http://127.0.0.1:${port}`, typed, p, body, { origin: 'https://abyyworld.github.io' });
    await s.tick(true);
    const status = await get('/v1/status');
    expect(status).toMatchObject({ app: 'arise-helper', node: process.execPath, settings: { calls: true }, waiting: 1 });
    const page = await get('/v1/events?after=0');
    expect(page.events.map((e: { id: string }) => e.id)).toEqual(['mac:call:C1']);
    await get('/v1/ack', { upTo: page.next });
    expect(s.outbox.items).toEqual([]);
    await expect(get('/v1/status', undefined, 'nope')).rejects.toMatchObject({ status: 401 });
    // A new code works at once; the old one stops.
    fs.writeFileSync(path.join(m.base, 'data', 'code'), 'ZZZZZ00000ZZZZZ00000');
    await expect(get('/v1/status')).rejects.toMatchObject({ status: 401 });
    expect(await get('/v1/status', undefined, 'zzzzz-00000-zzzzz-00000')).toMatchObject({ app: 'arise-helper' });
  });
});

// Any program running as the same user can change ~/.arise-helper. A link put there must never make
// the helper, with its Full Disk Access, change or empty the file it points to.
describe('its own folder', () => {
  // A file only Full Disk Access could reach, as far as the test is concerned.
  const guarded = (m: ReturnType<typeof mac>, name = 'chat.db', size = 2 * 1024 * 1024) => {
    const file = path.join(m.home, 'Library', 'Protected', name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'p'.repeat(size));
    return { file, same: () => fs.readFileSync(file, 'utf8') === 'p'.repeat(size) };
  };

  it("won't trim a log that is a link or another file's second name", () => {
    const m = mac();
    service(m);
    const log = path.join(m.base, 'logs', 'helper.log');
    const linked = guarded(m);
    fs.symlinkSync(linked.file, log);
    trimLog(log);
    expect(linked.same()).toBe(true);
    fs.rmSync(log);
    const other = guarded(m, 'other.db');
    fs.linkSync(other.file, log);
    trimLog(log);
    expect(other.same()).toBe(true);
    // Its own log is still kept short.
    fs.rmSync(log);
    fs.writeFileSync(log, 'x'.repeat(2 * 1024 * 1024));
    trimLog(log);
    expect(fs.statSync(log).size).toBe(256 * 1024);
  });

  it('writes a new file in place of a link, and never through it', async () => {
    const m = mac();
    const { s } = service(m);
    const state = guarded(m, 'state.db', 100);
    const code = guarded(m, 'code.db', 100);
    fs.rmSync(path.join(m.base, 'data', 'state.json'), { force: true });
    fs.symlinkSync(state.file, path.join(m.base, 'data', 'state.json'));
    fs.rmSync(path.join(m.base, 'data', 'code'));
    fs.symlinkSync(code.file, path.join(m.base, 'data', 'code'));
    // And where an older helper put its temporary file, a name anyone could guess.
    const guess = guarded(m, 'guess.db', 100);
    fs.symlinkSync(guess.file, path.join(m.base, 'data', `config.json.${process.pid}.tmp`));
    s.setSettings({ calls: true });
    expect(loadCode(m.base)).toMatch(/^[0-9A-Z]{20}$/);
    expect(state.same()).toBe(true);
    expect(code.same()).toBe(true);
    expect(guess.same()).toBe(true);
    fs.rmSync(path.join(m.base, 'data', `config.json.${process.pid}.tmp`));
    expect(fs.lstatSync(path.join(m.base, 'data', 'state.json')).isFile()).toBe(true);
    expect(fs.lstatSync(path.join(m.base, 'data', 'code')).isFile()).toBe(true);
    // Nothing else left behind: no temporary file, and not one at a name it could have guessed.
    expect(fs.readdirSync(path.join(m.base, 'data')).sort()).toEqual(['code', 'config.json', 'state.json']);
    expect(fs.readdirSync(path.dirname(state.file)).sort()).toEqual(['code.db', 'guess.db', 'state.db']);
  });

  it('stops rather than use a data or log folder, or a home for its things, that is a link', () => {
    for (const which of ['data', 'logs', '']) {
      const m = mac();
      const elsewhere = path.dirname(guarded(m).file);
      fs.mkdirSync(path.dirname(path.join(m.base, which || '.')), { recursive: true });
      fs.symlinkSync(elsewhere, which ? path.join(m.base, which) : m.base);
      const before = fs.readdirSync(elsewhere).sort();
      expect(() => service(m), which || 'base').toThrow(/isn't the helper's own folder/);
      expect(() => saveCode(m.base, 'ABCDE12345FGHJK67890')).toThrow(/isn't the helper's own folder/);
      if (which !== 'logs') expect(() => writeJson(path.join(m.base, 'data', 'config.json'), {})).toThrow(/isn't the helper's own folder/);
      expect(fs.readdirSync(elsewhere).sort()).toEqual(before);
    }
  });
});
