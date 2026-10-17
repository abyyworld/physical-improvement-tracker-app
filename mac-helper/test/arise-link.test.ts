// Arise's side (src/life/mac-link.ts) with the real helper on a pretend Mac: link with the code it
// made, turn sources on, and bring what it read into the life log. Run in Node (the helper needs
// node:sqlite), with a small stand-in for the browser's localStorage.

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LifeEvent } from '../../src/life/types';
import { PORT, SWITCHES } from '../src/config.mjs';
import { SOURCES } from '../src/sources.mjs';
import { Service } from '../src/service.mjs';
import { CALLS_SCHEMA, addCalEvent, addCall, addMail, addMessage, calendarDb, mailDb, messagesDb, tempDir, walDb } from './fixtures';

const dirs: string[] = [];
let service: Service | null = null;

beforeEach(() => {
  const kept = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => kept.get(k) ?? null,
    setItem: (k: string, v: string) => void kept.set(k, String(v)),
    removeItem: (k: string) => void kept.delete(k),
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await service?.stop();
  service = null;
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function load() {
  vi.resetModules();
  return { mac: await import('../../src/life/mac-link'), life: await import('../../src/life/store-port') };
}

describe('Arise and the real helper', () => {
  it('agree on the port, the sources and the switches', async () => {
    const { mac } = await load();
    expect(mac.PORT).toBe(PORT);
    expect([...mac.SOURCES]).toEqual(SOURCES);
    expect([...mac.SWITCHES].sort()).toEqual([...SWITCHES].sort());
  });

  it('link, turn calls and messages on, and bring them into the life log', async () => {
    const root = tempDir();
    dirs.push(root);
    const home = path.join(root, 'home');
    const now = Date.now();
    const calls = walDb(path.join(home, 'Library', 'Application Support', 'CallHistoryDB', 'CallHistory.storedata'), CALLS_SCHEMA);
    addCall(calls, { uid: 'REAL1', at: new Date(now - 3600_000).toISOString(), address: '+998901234567' });
    const chat = messagesDb(path.join(home, 'Library', 'Messages', 'chat.db'));
    addMessage(chat, { guid: 'REALM1', at: new Date(now - 1800_000).toISOString(), chat: 1, handle: 1, text: 'See you at 6' });
    service = new Service({ base: path.join(root, '.arise-helper'), userHome: home, run: async () => '', log: () => {}, darwinUserDir: '' });
    await service.start(0);
    const port = (service.server!.address() as { port: number }).port;
    const code = fs.readFileSync(path.join(root, '.arise-helper', 'data', 'code'), 'utf8');

    const { mac, life } = await load();
    const got = new Map<string, LifeEvent>();
    life.setLifeStore({
      addEvents: async (events) => {
        let n = 0;
        for (const e of events) if (!got.has(e.id)) got.set(e.id, e), n++;
        return n;
      },
    });
    mac.useHelper(null, `http://127.0.0.1:${port}`);
    // Typed in lower case, with dashes.
    const st = await mac.link(code.toLowerCase().replace(/(.{5})(?=.)/g, '$1-'));
    expect(st.settings.calls).toBe(false);
    await expect(mac.link('ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ')).rejects.toMatchObject({ problem: 'code' });
    await mac.link(code);
    await mac.setSwitches({ calls: true });
    await mac.setSwitches({ messages: true });
    await service.tick(true);
    expect(await mac.pull()).toBe(2);
    expect([...got.values()].map((e) => [e.id, e.title, e.tier, e.detail])).toEqual([
      ['mac:call:REAL1', 'Missed call from +998901234567', 3, undefined],
      ['mac:msg:REALM1', 'Message from +998901234567', 3, undefined],
    ]);
    // Acknowledged, so the helper let them go.
    expect(service.outbox.items).toEqual([]);
    expect(mac.totals()).toEqual({ calls: 1, messages: 1 });
    const after = await mac.refresh();
    expect(after?.sources.calls.state).toBe('ok');
    expect(after?.node).toBe(process.execPath);
    expect(await mac.pull()).toBe(0);
  });

  it('bring in emails and calendar events, with a moved event in its old place and a cancelled one gone', async () => {
    const root = tempDir();
    dirs.push(root);
    const home = path.join(root, 'home');
    const iso = (ms: number) => new Date(ms).toISOString();
    const soon = Math.floor(Date.now() / 3600_000) * 3600_000 + 2 * 86400_000;
    const mail = mailDb(path.join(home, 'Library', 'Mail', 'V10', 'MailData', 'Envelope Index'));
    addMail(mail, { at: iso(Date.now() - 3600_000), from: 'coach@example.com', name: 'Coach', subject: 'Your plan', mailbox: 1, global: 7 });
    const cal = calendarDb(path.join(home, 'Library', 'Group Containers', 'group.com.apple.calendar', 'Calendar.sqlitedb'));
    addCalEvent(cal, { uuid: 'A', title: 'Leg day', start: iso(soon), end: iso(soon + 3600_000) });
    addCalEvent(cal, { uuid: 'B', title: 'Lunch', start: iso(soon + 7200_000), end: iso(soon + 10800_000) });
    service = new Service({ base: path.join(root, '.arise-helper'), userHome: home, run: async () => '', log: () => {}, darwinUserDir: '' });
    await service.start(0);
    const port = (service.server!.address() as { port: number }).port;
    const code = fs.readFileSync(path.join(root, '.arise-helper', 'data', 'code'), 'utf8');

    const { mac, life } = await load();
    const got = new Map<string, LifeEvent>();
    life.setLifeStore({
      addEvents: async (events) => events.filter((e) => !got.has(e.id) && got.set(e.id, e)).length,
      upsertEvents: async (events) => events.filter((e) => got.set(e.id, e)).length,
      removeIds: async (ids) => ids.filter((id) => got.delete(id)).length,
    });
    mac.useHelper(null, `http://127.0.0.1:${port}`);
    await mac.link(code);
    await mac.setSwitches({ mail: true, calendar: true });
    await service.tick(true);
    expect(await mac.pull()).toBe(3);
    expect([...got.values()].map((e) => [e.id, e.title, e.tier])).toEqual([
      ['mac:mail:g7', 'Email from Coach', 3],
      ['mac:cal:A', 'Leg day', 2],
      ['mac:cal:B', 'Lunch', 2],
    ]);
    // Leg day moved an hour later and renamed; lunch deleted.
    cal.exec(`UPDATE CalendarItem SET summary = 'Leg day, gym', start_date = start_date + 3600, end_date = end_date + 3600 WHERE UUID = 'A';
      UPDATE OccurrenceCache SET occurrence_date = occurrence_date + 3600, occurrence_start_date = occurrence_start_date + 3600, occurrence_end_date = occurrence_end_date + 3600
        WHERE event_id = (SELECT ROWID FROM CalendarItem WHERE UUID = 'A');
      DELETE FROM OccurrenceCache WHERE event_id = (SELECT ROWID FROM CalendarItem WHERE UUID = 'B'); DELETE FROM CalendarItem WHERE UUID = 'B';`);
    await service.tick(true);
    await mac.pull();
    expect([...got.values()].map((e) => [e.id, e.title, e.at])).toEqual([
      ['mac:mail:g7', 'Email from Coach', expect.any(Number)],
      ['mac:cal:A', 'Leg day, gym', soon + 3600_000],
    ]);
    expect(service.outbox.items).toEqual([]);
    expect(mac.totals()).toEqual({ mail: 1, calendar: 3 });
  });
});
