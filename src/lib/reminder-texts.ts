// What a web reminder says, kept on the device for the service worker.
//
// The reminders server (worker/reminders) only knows when to send a push, and a push only says
// which reminder it is and for which day: {kind: 'morning' | 'evening', date: 'YYYY-MM-DD'}. The
// words come from here: the app keeps the next two weeks of reminder texts in the device's cache
// (src/web-reminders.ts), and the service worker (sw.ts) shows the one for the push it gets. So
// reminders are as personal as in the iPhone app, and the server never knows what they say.

export const CACHE = 'arise-reminders';
// The address the texts are kept under. It's only a name in the cache; nothing is ever fetched.
export const TEXTS = 'reminder-texts.json';

export type Kind = 'morning' | 'evening';
export interface Line {
  title: string;
  body: string;
}
export interface Day {
  done: boolean;
  morning: Line | null; // null on a day with nothing to remind about
  evening: Line | null;
}
export interface Texts {
  days: Record<string, Day>;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function parsePush(data: string): { kind: Kind; date: string } | null {
  try {
    const p = JSON.parse(data);
    if ((p?.kind === 'morning' || p?.kind === 'evening') && typeof p.date === 'string' && DATE.test(p.date)) return { kind: p.kind, date: p.date };
  } catch {}
  return null;
}

const GENERIC: Record<Kind | 'other', Line> = {
  morning: { title: 'Arise', body: 'A new day. Your daily quests are waiting.' },
  evening: { title: 'Arise', body: "Today isn't done yet. There's still time." },
  other: { title: 'Arise', body: 'Open Arise to see your quests.' },
};

// What a push shows. Browsers only let a site get pushes if every one shows a notification, so
// there's always something: the day's own text, or a plain one when the app hasn't left any (it
// wasn't opened for two weeks, say).
export function notificationFor(push: { kind: Kind; date: string } | null, texts: Texts | null): Line {
  if (!push) return GENERIC.other;
  const day = texts?.days?.[push.date];
  const line = day?.[push.kind];
  if (line && typeof line.title === 'string' && typeof line.body === 'string') return { title: line.title, body: line.body };
  // The day got done after this was sent (or on another device).
  if (day?.done) return { title: "Today's done", body: 'Nice work. Nothing left for today.' };
  if (day) return { title: 'Arise', body: 'Nothing due today.' };
  return GENERIC[push.kind];
}

const address = (scope: string) => new URL(TEXTS, scope).href;

export async function readTexts(scope: string): Promise<Texts | null> {
  try {
    const res = await (await caches.open(CACHE)).match(address(scope));
    return res ? ((await res.json()) as Texts) : null;
  } catch {
    return null;
  }
}

export async function writeTexts(scope: string, texts: Texts): Promise<void> {
  const cache = await caches.open(CACHE);
  await cache.put(address(scope), new Response(JSON.stringify(texts), { headers: { 'content-type': 'application/json' } }));
}

export const clearTexts = () => caches.delete(CACHE);

// In the service worker, for each push.
export async function showReminder(reg: Pick<ServiceWorkerRegistration, 'scope' | 'showNotification'>, data: string): Promise<void> {
  const push = parsePush(data);
  const line = notificationFor(push, await readTexts(reg.scope));
  await reg.showNotification(line.title, { body: line.body, icon: new URL('icons/icon-192.png', reg.scope).href, lang: 'en', data: { date: push?.date || '' } });
}
