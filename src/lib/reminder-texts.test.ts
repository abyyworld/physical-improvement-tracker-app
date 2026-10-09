// What the service worker shows for a reminder push: the text the app left on the device, or a
// plain one, and always something (browsers stop the pushes of a site that shows nothing).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { notificationFor, parsePush, showReminder, writeTexts, type Texts } from './reminder-texts';

const SCOPE = 'https://abyyworld.github.io/physical-improvement-tracker-app/';
const texts: Texts = {
  days: {
    '2026-10-09': {
      done: false,
      morning: { title: 'Quest unlocked: Study.', body: 'Keep trying, even when it feels pointless.' },
      evening: { title: 'Still time. A short version of Study beats a zero.', body: "Log it in the app when you're done." },
    },
    '2026-10-10': { done: true, morning: null, evening: null },
    '2026-10-11': { done: false, morning: null, evening: null },
  },
};

describe('reading a push', () => {
  it('takes only a kind and a date', () => {
    expect(parsePush('{"kind":"morning","date":"2026-10-09"}')).toEqual({ kind: 'morning', date: '2026-10-09' });
    expect(parsePush('{"kind":"evening","date":"2026-10-09","extra":"<b>"}')).toEqual({ kind: 'evening', date: '2026-10-09' });
    for (const bad of ['', 'nope', '{"kind":"night","date":"2026-10-09"}', '{"kind":"morning","date":"tomorrow"}', 'null', '[]']) expect(parsePush(bad), bad).toBeNull();
  });
});

describe('what it shows', () => {
  it("shows the day's own text", () => {
    expect(notificationFor({ kind: 'morning', date: '2026-10-09' }, texts)).toEqual(texts.days['2026-10-09'].morning);
    expect(notificationFor({ kind: 'evening', date: '2026-10-09' }, texts)).toEqual(texts.days['2026-10-09'].evening);
  });

  it('says so when the day got done after the push was sent', () => {
    expect(notificationFor({ kind: 'evening', date: '2026-10-10' }, texts)).toEqual({ title: "Today's done", body: 'Nice work. Nothing left for today.' });
    expect(notificationFor({ kind: 'morning', date: '2026-10-11' }, texts).body).toBe('Nothing due today.');
  });

  it('falls back to a plain line without texts for that day', () => {
    expect(notificationFor({ kind: 'morning', date: '2026-12-01' }, texts)).toEqual({ title: 'Arise', body: 'A new day. Your daily quests are waiting.' });
    expect(notificationFor({ kind: 'evening', date: '2026-10-09' }, null)).toEqual({ title: 'Arise', body: "Today isn't done yet. There's still time." });
    expect(notificationFor(null, texts)).toEqual({ title: 'Arise', body: 'Open Arise to see your quests.' });
    // Junk in the cache is ignored too.
    expect(notificationFor({ kind: 'morning', date: '2026-10-09' }, { days: { '2026-10-09': { done: false, morning: { title: 5 }, evening: null } } } as never).title).toBe('Arise');
  });
});

describe('the push handler', () => {
  const stores = new Map<string, Map<string, string>>();
  beforeEach(() => {
    stores.clear();
    vi.stubGlobal('caches', {
      open: async (name: string) => {
        const m = stores.get(name) ?? new Map<string, string>();
        stores.set(name, m);
        return { put: async (url: string, res: Response) => void m.set(url, await res.text()), match: async (url: string) => (m.has(url) ? new Response(m.get(url)) : undefined) };
      },
      delete: async (name: string) => stores.delete(name),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  const registration = () => {
    const shown: { title: string; options?: NotificationOptions }[] = [];
    return { shown, scope: SCOPE, showNotification: async (title: string, options?: NotificationOptions) => void shown.push({ title, options }) };
  };

  it('shows the text the app left, with the app icon', async () => {
    await writeTexts(SCOPE, texts);
    const reg = registration();
    await showReminder(reg, JSON.stringify({ kind: 'morning', date: '2026-10-09' }));
    expect(reg.shown).toEqual([
      {
        title: 'Quest unlocked: Study.',
        options: { body: 'Keep trying, even when it feels pointless.', icon: `${SCOPE}icons/icon-192.png`, lang: 'en', data: { date: '2026-10-09' } },
      },
    ]);
  });

  it('still shows a notification with no texts kept, or a push it cannot read', async () => {
    const reg = registration();
    await showReminder(reg, JSON.stringify({ kind: 'evening', date: '2026-10-09' }));
    await showReminder(reg, 'garbage');
    expect(reg.shown.map((n) => n.title)).toEqual(['Arise', 'Arise']);
    expect(reg.shown[0].options!.body).toBe("Today isn't done yet. There's still time.");

    vi.stubGlobal('caches', { open: async () => Promise.reject(new Error('quota')) });
    await showReminder(reg, JSON.stringify({ kind: 'morning', date: '2026-10-09' }));
    expect(reg.shown).toHaveLength(3);
  });
});
