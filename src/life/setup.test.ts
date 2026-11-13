// Your setup, on Connect: which parts there are, where each stands and what's next.

import { describe, expect, it } from 'vitest';
import { items, progress, type Facts } from './setup';

const NONE: Facts = {
  configured: { sync: true, reminders: true },
  signedIn: false,
  ai: { engine: null, label: '', private: true },
  reminders: false,
  native: null,
  lock: false,
  accounts: [],
  computer: { browser: false, mac: false },
  history: [],
  apps: { all: 0, web: 0 },
};
const by = (f: Facts) => Object.fromEntries(items(f).map((i) => [i.id, i]));

describe('your setup', () => {
  it('starts with the recommended parts, and says what is next', () => {
    const list = items(NONE);
    expect(list.map((i) => i.id)).toEqual(['account', 'ai', 'reminders', 'phone', 'lock', 'accounts', 'computer', 'history', 'apps']);
    expect(list.filter((i) => i.recommended).map((i) => i.id)).toEqual(['account', 'ai', 'reminders', 'phone']);
    expect(progress(list)).toMatchObject({ done: 0, all: 9, next: { id: 'account' } });
  });

  it('goes to the next recommended part before the optional ones, and says when all is done', () => {
    const f: Facts = { ...NONE, signedIn: true, ai: { engine: 'private', label: 'Private AI', private: true }, reminders: true, native: 'ios' };
    expect(progress(items(f))).toMatchObject({ done: 4, next: { id: 'lock' } });
    const all: Facts = { ...f, lock: true, accounts: ['Google'], computer: { browser: true, mac: false }, history: ['Spotify'], apps: { all: 1, web: 0 } };
    expect(progress(items(all))).toEqual({ done: 9, all: 9, next: null });
  });

  it('marks less private choices', () => {
    const f = by({ ...NONE, ai: { engine: 'free', label: 'Free AI', private: false }, apps: { all: 2, web: 1 } });
    expect(f.ai).toMatchObject({ done: true, status: 'Free AI, less private', less: true });
    expect(f.apps).toMatchObject({ done: true, status: '2 apps connected, 1 on the web', less: true });
    expect(by(NONE).ai.less).toBeUndefined();
  });

  it('says where each stands in plain words', () => {
    const f = by({ ...NONE, native: 'android', reminders: true, accounts: ['Google', 'Steam', 'PlayStation'], computer: { browser: true, mac: true }, history: null });
    expect(f.phone.status).toBe('In the Android app');
    expect(f.reminders.go).toEqual({ view: 'settings', to: 'notifyPanel', label: 'Change' });
    expect(f.accounts.status).toBe('Google, Steam and PlayStation');
    expect(f.computer.status).toBe('Browser and Mac helper linked');
    expect(f.history.status).toBe('Checking…');
    expect(by(NONE).reminders.go.to).toBe('remindersPanel');
  });

  it('leaves out what this copy of Arise has no server for', () => {
    const list = items({ ...NONE, configured: { sync: false, reminders: false } });
    expect(list.map((i) => i.id)).not.toContain('account');
    expect(list.map((i) => i.id)).not.toContain('reminders');
    // The phone apps make their own reminders.
    expect(items({ ...NONE, configured: { sync: false, reminders: false }, native: 'ios' }).map((i) => i.id)).toContain('reminders');
  });
});
