// Reminders at a to-do's time in the web app (the phone apps schedule their own: native.js). The
// reminders server never learns about to-dos, so these come while Arise is open (a tab, or the
// installed app in the background), from this device only. Plain on the lock screen unless the
// Player turned on details in notifications.

import * as S from './store';
import { isNative } from './native.js';
import * as WR from './web-reminders';

const AHEAD = 24 * 3600_000; // timers for the next day; planned again on every change and visit
let timers = [];

// The to-dos due in the next day, not done yet, with when: [{ id, at }].
export function dueSoon(now = Date.now()) {
  return Object.values(S.state.todos)
    .filter((t) => !t.gone && !t.done && t.day && t.time)
    .map((t) => {
      const [y, m, d] = t.day.split('-').map(Number);
      const [h, min] = t.time.split(':').map(Number);
      return { id: t.id, at: new Date(y, m - 1, d, h, min).getTime() };
    })
    .filter((x) => x.at > now && x.at <= now + AHEAD)
    .sort((a, b) => a.at - b.at);
}

// Only with reminders on in Settings (and the browser's permission, which turning them on asks for).
export const allowed = () => !isNative && WR.isOn() && typeof Notification !== 'undefined' && Notification.permission === 'granted';

async function show(id) {
  const t = S.state.todos[id];
  if (!t || t.gone || t.done) return;
  const details = !!S.state.settings.notifyDetails;
  const title = details ? t.title : 'Something on your to-do list';
  const body = details ? 'On your to-do list in Arise.' : 'Open Arise to see it.';
  try {
    const reg = await globalThis.navigator?.serviceWorker?.getRegistration?.();
    if (reg) await reg.showNotification(title, { body, tag: `todo-${id}` });
    else new Notification(title, { body, tag: `todo-${id}` });
  } catch {}
}

// Plans the timers again from the to-dos as they are now. Says which ids it planned.
export function planAlerts(now = Date.now()) {
  for (const t of timers) clearTimeout(t);
  timers = [];
  if (!allowed()) return [];
  const due = dueSoon(now);
  for (const { id, at } of due) timers.push(setTimeout(() => void show(id), at - now));
  return due.map((x) => x.id);
}

export function initTodoAlerts() {
  if (isNative) return;
  S.onSave(() => planAlerts());
  globalThis.document?.addEventListener('visibilitychange', () => planAlerts());
  planAlerts();
}
