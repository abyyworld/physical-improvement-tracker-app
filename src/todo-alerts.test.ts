// @vitest-environment jsdom
// Reminders at a to-do's time: in the web app while it's open, and in the phone apps' schedule.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./lib/firebase', () => import('./test/fake-firebase'));

const NOW = new Date(2026, 10, 13, 10);
const at = NOW.getTime();
const TODOS = {
  soon: { id: 'soon', title: 'Dentist', day: '2026-11-13', time: '15:30', created: at, at },
  done: { id: 'done', title: 'Gym', day: '2026-11-13', time: '12:00', done: at, created: at, at },
  past: { id: 'past', title: 'Breakfast', day: '2026-11-13', time: '08:00', created: at, at },
  next: { id: 'next', title: 'Call mum', day: '2026-11-20', time: '18:00', created: at, at },
  any: { id: 'any', title: 'Someday', created: at, at },
};

async function load(details = false) {
  vi.resetModules();
  localStorage.clear();
  localStorage.setItem('pit-data-v1', JSON.stringify({ sessions: [], profile: { onboarded: true, skipped: true }, settings: { notifyDetails: details }, todos: TODOS }));
  return { A: await import('./todo-alerts.js'), N: await import('./native.js') };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('to-do reminders', () => {
  it('on the web: only with notifications allowed, for the next day, plain unless details are on', async () => {
    const shown: [string, object][] = [];
    class Note {
      static permission = 'default';
      constructor(title: string, o: object) {
        shown.push([title, o]);
      }
    }
    vi.stubGlobal('Notification', Note);
    const { A } = await load();
    expect(A.planAlerts()).toEqual([]);
    Note.permission = 'granted';
    expect(A.dueSoon().map((x) => x.id)).toEqual(['soon']);
    expect(A.planAlerts()).toEqual(['soon']);
    await vi.advanceTimersByTimeAsync(5.5 * 3600_000);
    expect(shown).toEqual([['Something on your to-do list', { body: 'Open Arise to see it.', tag: 'todo-soon' }]]);
  });

  it("doesn't remind about one done meanwhile", async () => {
    const shown: string[] = [];
    vi.stubGlobal('Notification', Object.assign(function (this: unknown, t: string) { shown.push(t); }, { permission: 'granted' }));
    const { A } = await load(true);
    const S = await import('./store');
    A.planAlerts();
    S.setTodoDone('soon', true);
    await vi.advanceTimersByTimeAsync(6 * 3600_000);
    expect(shown).toEqual([]);
  });

  it('in the phone apps: each one with a time, soonest first, with details only if turned on', async () => {
    const { N } = await load();
    expect(N.todoReminders(NOW).map((r) => [r.title, r.at.getTime()])).toEqual([
      ['Something on your to-do list', new Date(2026, 10, 13, 15, 30).getTime()],
      ['Something on your to-do list', new Date(2026, 10, 20, 18).getTime()],
    ]);
    const more = await load(true);
    expect(more.N.todoReminders(NOW).map((r) => r.title)).toEqual(['Dentist', 'Call mum']);
    expect(more.N.upcoming(NOW).filter((n) => n.id >= 6000).map((n) => n.title)).toEqual(['Dentist', 'Call mum']);
  });
});
