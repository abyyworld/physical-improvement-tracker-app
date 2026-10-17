// @vitest-environment jsdom
// The journal's notifications in the iPhone and Android app, planned on the phone: the evening
// check-in and the morning "Yesterday", in plain words unless the Player shows details, within
// the 64 iOS keeps, and a tap opening the day's journal. Capacitor's LocalNotifications is
// simulated.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Scheduled = { id: number; title: string; body: string; schedule: { at: Date }; extra?: { open: string; day: string } };

function fakePhone() {
  const scheduled: Scheduled[] = [];
  const listeners = new Map<string, (data: unknown) => void>();
  (globalThis as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => true,
    PluginHeaders: [{ name: 'LocalNotifications' }],
    nativePromise: async (plugin: string, method: string, options: { notifications?: Scheduled[] } = {}) => {
      if (plugin !== 'LocalNotifications') throw new Error(`${plugin} isn't simulated`);
      if (method === 'checkPermissions' || method === 'requestPermissions') return { display: 'granted' };
      if (method === 'cancelAll') return void scheduled.splice(0);
      if (method === 'schedule') return void scheduled.push(...(options.notifications || []));
      throw new Error(`${method} isn't simulated`);
    },
    nativeCallback: (plugin: string, method: string, options: { eventName: string }, cb: (data: unknown) => void) => {
      if (plugin === 'LocalNotifications' && method === 'addListener') listeners.set(options.eventName, cb);
      return 'callback-1';
    },
  };
  return { scheduled, tap: (extra: object) => listeners.get('localNotificationActionPerformed')?.({ actionId: 'tap', notification: { id: 5000, extra } }) };
}

async function load() {
  vi.resetModules();
  const S = await import('./store');
  const R = await import('./reminders.js');
  const N = await import('./native.js');
  return { S, R, N };
}

const at = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 9, 12)); // Friday 9 October 2026, noon
});
afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as { Capacitor?: unknown }).Capacitor;
});

describe('planned on the phone', () => {
  it('has the check-in each evening and "Yesterday" each morning for a week, opening the right day', async () => {
    const { N } = await load();
    const list = N.upcoming();
    const checkins = list.filter((n) => n.id >= 5000);
    const recaps = list.filter((n) => n.id >= 4000 && n.id < 5000);
    expect(checkins.map((n) => [at(n.at), n.open])).toEqual(Array.from({ length: 7 }, (_, i) => [`2026-10-${String(9 + i).padStart(2, '0')} 21:30`, `2026-10-${String(9 + i).padStart(2, '0')}`]));
    // Today's 07:00 has gone: from tomorrow, about the day before.
    expect(recaps.map((n) => [at(n.at), n.open])).toEqual(Array.from({ length: 6 }, (_, i) => [`2026-10-${10 + i} 07:00`, `2026-10-${String(9 + i).padStart(2, '0')}`]));
    expect(checkins[0]).toMatchObject({ title: 'How was today?', body: "Add a note or your mood to today's journal." });
    expect(recaps[0]).toMatchObject({ title: 'Yesterday', body: 'Your journal for yesterday is ready.' });
    // Soonest first.
    expect(list.slice(0, -1).map((n) => +n.at)).toEqual([...list.slice(0, -1)].map((n) => +n.at).sort((a, b) => a - b));
  });

  it('says what the journal says only with details on', async () => {
    const { S, R, N } = await load();
    R.setJournalLines({ '2026-10-08': 'I ran 5 km in the rain.', '2026-10-09': 'I did a push workout.' });
    const texts = () => N.upcoming().filter((n) => n.id >= 4000 && n.id < 6000).map((n) => n.body);
    expect(texts().join(' ')).not.toMatch(/rain|push workout/);
    S.state.settings.notifyDetails = true;
    const on = N.upcoming();
    expect(on.find((n) => n.id === 5000)!.body).toBe('So far: I did a push workout. Add a note or your mood.');
    expect(on.find((n) => n.id === 4001)!.body).toBe('I did a push workout.'); // tomorrow morning, about today
    expect(on.find((n) => n.id === 4002)!.body).toBe('Your journal for yesterday is ready.');
    // A day with nothing in it says so, whatever the switch.
    R.setJournalLines({ '2026-10-09': '' });
    expect(N.upcoming().find((n) => n.id === 4001)!.body).toBe('Nothing in your journal for yesterday. Tap to add something.');
  });

  it('follows their own switches and times, "Yesterday" at the morning reminder unless moved', async () => {
    const { S, N } = await load();
    S.state.settings.remindAt = '06:15';
    S.state.settings.checkinAt = '22:05';
    expect(at(N.upcoming().find((n) => n.id === 4001)!.at)).toBe('2026-10-10 06:15');
    expect(at(N.upcoming().find((n) => n.id === 5000)!.at)).toBe('2026-10-09 22:05');
    S.state.settings.recapAt = '08:40';
    expect(at(N.upcoming().find((n) => n.id === 4001)!.at)).toBe('2026-10-10 08:40');
    S.state.settings.recap = false;
    S.state.settings.checkin = false;
    expect(N.upcoming().filter((n) => n.id >= 4000)).toEqual([]);
  });

  it('keeps to the 64 iOS keeps, soonest first, with the note that they stop where they do', async () => {
    const { S, N } = await load();
    // A quest every day: 40 mornings and 14 evening checks, with the journal's 13 too many.
    S.saveGoal({ id: 'g1', title: 'Learn Spanish', category: 'learning', quests: [{ id: 'q1', title: 'Study', schedule: { kind: 'daily' }, created: '2026-10-01' }] });
    const list = N.upcoming();
    expect(list).toHaveLength(64);
    const stop = list.at(-1)!;
    expect(stop).toMatchObject({ id: 3000, title: 'Your reminders stop here' });
    expect(+stop.at).toBeGreaterThan(+list.at(-2)!.at);
    expect(list.filter((n) => n.id >= 5000)).toHaveLength(7);
    // Without the journal's, as before: up to 40 days ahead.
    S.state.settings.recap = false;
    S.state.settings.checkin = false;
    expect(at(N.upcoming().at(-1)!.at)).toBe('2026-11-18 07:00');
  });
});

describe('on the phone', () => {
  it('schedules them with the day each opens, and again when what the journal says changes', async () => {
    const phone = fakePhone();
    const { S, R, N } = await load();
    S.state.settings.notify = true;
    await N.initNative();
    await vi.waitFor(() => expect(phone.scheduled.length).toBeGreaterThan(0));
    const checkin = phone.scheduled.find((n) => n.id === 5000)!;
    expect(checkin).toMatchObject({ title: 'How was today?', extra: { open: 'journal', day: '2026-10-09' } });
    expect(phone.scheduled.find((n) => n.id === 4001)!.extra).toEqual({ open: 'journal', day: '2026-10-09' });
    expect(phone.scheduled.find((n) => n.id === 3000)!.extra).toBeUndefined();
    // The journal changes (with details on): planned again with its words.
    S.state.settings.notifyDetails = true;
    R.setJournalLines({ '2026-10-09': 'I read for an hour.' });
    await vi.waitFor(() => expect(phone.scheduled.find((n) => n.id === 5000)?.body).toBe('So far: I read for an hour. Add a note or your mood.'), { timeout: 4000 });
  });

  it("opens the day's journal when one is tapped, and nothing for other taps", async () => {
    const phone = fakePhone();
    const { N } = await load();
    await N.initNative();
    const opened: string[] = [];
    const listen = (e: Event) => opened.push((e as CustomEvent).detail.day);
    window.addEventListener('arise:journal', listen);
    try {
      phone.tap({ open: 'journal', day: '2026-10-08' });
      phone.tap({});
      phone.tap({ open: 'journal', day: '<b>' });
      expect(opened).toEqual(['2026-10-08']);
    } finally {
      window.removeEventListener('arise:journal', listen);
    }
  });
});
