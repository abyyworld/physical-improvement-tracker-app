// Reminders for the web app: a notification every morning at the time the Player picks, and an
// evening check on days that aren't done yet, like the iPhone app's (native.js). They work in the
// installed app on iPhone and iPad (iOS 16.4 or later), on Android and in desktop browsers.
//
// A web app can't plan notifications on the device, so the small server in worker/reminders
// sends a push at each time. It knows this device's push address, its time zone, reminder times
// and the weekdays with anything due, and the last day the app said was done (so that day's
// evening check is skipped). What a reminder says stays here: the app keeps the next two weeks of
// texts in the device's cache, where the service worker finds them when a push comes
// (lib/reminder-texts.ts).
//
// Whether they're on, and the times, belong to this device. They're kept in localStorage with
// the server's id and token for it, never synced and never put in backups.

import * as S from './store';
import * as R from './reminders.js';
import { isNative } from './native.js';
import { REMINDERS } from './reminders-config';
import { clearTexts, writeTexts, type Texts } from './lib/reminder-texts';

const KEY = 'arise-push';
const TEXT_DAYS = 14;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

interface Device {
  morning: string;
  evening: boolean;
  eveningAt: string;
  id?: string; // the server's record of this device, while reminders are on
  token?: string;
  sent?: string; // the schedule the server has (see signature)
  done?: string; // the last day the server was told is done
  gone: { id: string; token: string }[]; // records turned off the server hasn't said it deleted (see forget)
}

export const HOME_SCREEN = 'Add Arise to your Home Screen first (Share, then Add to Home Screen), then turn this on there.';

// ---------- what this device can do

const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = () => !!window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;

// The server is set up (src/reminders-config.ts), and this isn't the iPhone app, which has its own.
export const configured = () => !!REMINDERS.server && !isNative;
export const supported = () => configured() && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
// iPhone and iPad only allow it in the app added to the Home Screen, not in Safari itself.
export const needsHomeScreen = () => configured() && !supported() && isIOS() && !standalone();
export const permission = (): NotificationPermission => (typeof Notification === 'undefined' ? 'default' : Notification.permission);

export function blockedHelp(): string {
  if (isIOS()) return 'Notifications are blocked for Arise. Turn them on in the Settings app, under Notifications, then Arise.';
  if (/android/i.test(navigator.userAgent)) return "Notifications are blocked for Arise. Turn them on in your phone's Settings, under Apps, then Arise (or Chrome), then Notifications.";
  return "Notifications are blocked for Arise. Allow them in the browser's settings for this site (the icon at the left end of the address bar), then turn this on again.";
}

// ---------- this device's settings

function load(): Device {
  const st = S.state.settings;
  let d: Partial<Device> = {};
  try {
    d = JSON.parse(localStorage.getItem(KEY) || '{}') || {};
  } catch {}
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  return {
    morning: TIME.test(str(d.morning) || '') ? d.morning! : st.remindAt || '07:00',
    evening: typeof d.evening === 'boolean' ? d.evening : st.evening !== false,
    eveningAt: TIME.test(str(d.eveningAt) || '') ? d.eveningAt! : st.eveningAt || '20:30',
    id: str(d.id),
    token: str(d.token),
    sent: str(d.sent),
    done: str(d.done),
    gone: Array.isArray(d.gone) ? d.gone.filter((g) => str(g?.id) && str(g?.token)).map(({ id, token }) => ({ id, token })) : [],
  };
}

function store(d: Device) {
  try {
    localStorage.setItem(KEY, JSON.stringify(d));
  } catch {}
}

export const isOn = () => !!load().token;

export function settings() {
  const d = load();
  return { on: !!d.token, morning: d.morning, evening: d.evening, eveningAt: d.eveningAt, eveningTooEarly: d.evening && d.eveningAt <= d.morning };
}

// ---------- what the server and the service worker get

// The schedule: this device's time zone and times, and the weekdays with anything to remind
// about in the coming week (today counts while it isn't done).
export function schedule(d = load(), today = S.todayKey()) {
  const days = new Set<number>();
  for (const day of R.days(8, today)) if (day.morning) days.add(S.parseKey(day.date).getDay());
  return {
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    morning: d.morning,
    // Like the iPhone app, only an evening check that's later than the morning reminder.
    evening: d.evening && d.eveningAt > d.morning ? d.eveningAt : null,
    days: [...days].sort((a, b) => a - b),
  };
}

// What the service worker shows for each push: the next two weeks of reminder texts.
export function texts(today = S.todayKey()): Texts {
  const out: Texts = { days: {} };
  for (const d of R.days(TEXT_DAYS, today)) out.days[d.date] = { done: d.done, morning: d.morning, evening: d.evening };
  return out;
}

// An error whose message is written for the Player. A browser's own ("Registration failed - push
// service error") isn't, so they get BROWSER_FAILED instead.
class Plain extends Error {}
const BROWSER_FAILED = "This browser couldn't set up notifications. Try another browser, or use the calendar below.";

class ServerError extends Plain {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call(path: string, body?: object) {
  const url = new URL(`v1/${path}`, REMINDERS.server.replace(/\/*$/, '/')).href;
  let res: Response;
  try {
    res = await fetch(url, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  } catch {
    throw new ServerError(0, "Couldn't reach the reminders server. Are you online?");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ServerError(res.status, data?.error?.message || "The reminders server couldn't do that just now. Try again later.");
  return data;
}

const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const signature = (s: ReturnType<typeof schedule>, endpoint: string) => JSON.stringify({ ...s, endpoint });

async function registration(): Promise<ServiceWorkerRegistration> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, fail) => {
    timer = setTimeout(() => fail(new Plain("Arise's offline support isn't running yet. Reload the page and try again.")), 10_000);
  });
  try {
    return await Promise.race([navigator.serviceWorker.ready, late]);
  } finally {
    clearTimeout(timer);
  }
}

// This browser's push subscription, made with the server's public key.
async function pushSubscription(reg: ServiceWorkerRegistration): Promise<PushSubscription> {
  const key = fromB64url((await call('vapid')).key);
  let sub = await reg.pushManager.getSubscription();
  const had = sub?.options?.applicationServerKey;
  // One made for another server can't get this one's pushes.
  if (sub && !(had && key.length === had.byteLength && new Uint8Array(had).every((b, i) => b === key[i]))) {
    await sub.unsubscribe().catch(() => {});
    sub = null;
  }
  return sub ?? reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
}

async function signUp(d: Device, sub: PushSubscription) {
  const s = schedule(d);
  const { id, token } = await call('subscribe', { subscription: sub.toJSON(), ...s });
  // Onto what's stored now, as the times can change meanwhile (sync sends them next).
  store({ ...load(), id, token, sent: signature(s, sub.endpoint), done: '' });
}

// Deletes the server's records of this device that were turned off, now or before (offline, say).
// Each is kept until the server says it's gone, as until then it keeps sending pushes, which the
// service worker must show.
async function forget(): Promise<void> {
  for (const g of load().gone) {
    try {
      await call('unsubscribe', g);
    } catch (err) {
      if ((err as ServerError).status !== 404) continue; // tried again on the next refresh
    }
    const d = load();
    store({ ...d, gone: d.gone.filter((x) => x.id !== g.id) });
  }
}

// This device's settings with reminders off, and its server record (if any) still to delete.
function off(d: Device): Device {
  return { morning: d.morning, evening: d.evening, eveningAt: d.eveningAt, gone: [...d.gone, ...(d.id && d.token ? [{ id: d.id, token: d.token }] : [])] };
}

const unsubscribeBrowser = () => navigator.serviceWorker.getRegistration().then((reg) => reg?.pushManager.getSubscription()).then((sub) => sub?.unsubscribe());

// One at a time, so a quick on, off, on can't mix up.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const p = queue.then(fn);
  queue = p.catch(() => {});
  return p;
}

// ---------- turning it on and off

export type Outcome = { result: 'on' | 'denied' | 'dismissed' | 'unsupported' | 'error'; message?: string };

// Called straight from the tap on the switch: iPhone and iPad only ask for permission from a tap.
export async function turnOn(): Promise<Outcome> {
  if (!supported()) return { result: 'unsupported' };
  const asked = Notification.requestPermission();
  const p = await asked;
  if (p === 'denied') return { result: 'denied' };
  if (p !== 'granted') return { result: 'dismissed' };
  return serial(async () => {
    try {
      const reg = await registration();
      const d = load();
      const sub = await pushSubscription(reg);
      // The texts go first, so they're there for the very first push.
      const t = texts();
      await writeTexts(reg.scope, t);
      lastTexts = JSON.stringify(t);
      await signUp(d, sub);
      await sync().catch(() => {}); // the rest can wait for the next change
      return { result: 'on' as const };
    } catch (err) {
      // Still off. The server may have stored the sign-up and only its answer got lost: without
      // the browser's subscription, the push service tells it the address is gone.
      if (!isOn()) {
        lastTexts = '';
        await Promise.allSettled([unsubscribeBrowser(), typeof caches === 'undefined' ? null : clearTexts()]);
      }
      return { result: 'error' as const, message: err instanceof Plain ? err.message : BROWSER_FAILED };
    }
  });
}

export function turnOff(): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = null;
  return serial(async () => {
    store(off(load()));
    lastTexts = '';
    // Either one stops them: the server forgets this device, and once the browser drops its
    // subscription the push service tells the server the address is gone.
    await Promise.allSettled([forget(), 'serviceWorker' in navigator ? unsubscribeBrowser() : null, typeof caches === 'undefined' ? null : clearTexts()]);
  });
}

export function setTimes(patch: Partial<Pick<Device, 'morning' | 'evening' | 'eveningAt'>>) {
  const d = load();
  if (patch.morning && TIME.test(patch.morning)) d.morning = patch.morning;
  if (patch.eveningAt && TIME.test(patch.eveningAt)) d.eveningAt = patch.eveningAt;
  if (typeof patch.evening === 'boolean') d.evening = patch.evening;
  store(d);
  if (d.token) refresh(800);
}

// ---------- keeping the server and the texts up to date

let lastTexts = '';

async function sync(again = true): Promise<void> {
  if (!supported()) return;
  await forget();
  const d = load();
  if (!d.id || !d.token) return;
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return;
  // Blocked in the browser's settings since: the notifications can't show, so stop them.
  if (permission() !== 'granted') {
    store(off(load()));
    await forget();
    return;
  }
  const today = S.todayKey();
  const t = texts(today);
  const json = JSON.stringify(t);
  if (json !== lastTexts) {
    await writeTexts(reg.scope, t);
    lastTexts = json;
  }
  // The browser can drop or replace a subscription by itself.
  const sub = (await reg.pushManager.getSubscription()) || (await pushSubscription(reg));
  const s = schedule(d, today);
  try {
    // Each answer is stored onto what's stored by then, not onto `d`: the times can change while
    // a request is on its way (setTimes then sends them next).
    const sent = signature(s, sub.endpoint);
    if (sent !== d.sent) {
      await call('update', { id: d.id, token: d.token, subscription: sub.toJSON(), ...s });
      store({ ...load(), sent });
    }
    // Once a day: the day is done (or nothing's left to remind about), so no evening check.
    // Undone again (a quest unticked), and it's back on.
    const quiet = !t.days[today].morning;
    if (quiet ? d.done !== today : d.done === today) {
      await call('done', { id: d.id, token: d.token, date: today, done: quiet });
      store({ ...load(), done: quiet ? today : '' });
    }
  } catch (err) {
    if ((err as ServerError).status !== 404 || !again) throw err;
    // The server has forgotten this device (it lost its data, say): sign up again, with a new
    // subscription if its key changed too, then finish.
    await signUp(d, await pushSubscription(reg));
    return sync(false);
  }
}

let timer: ReturnType<typeof setTimeout> | null = null;

export function refresh(delay = 2000) {
  const d = load();
  // On, or turned off with the server's record still to delete.
  if (!d.token && !d.gone.length) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void refreshNow(), delay);
}

export function refreshNow(): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = null;
  return serial(sync).catch(() => {}); // offline: it tries again on the next change or visit
}

export function initWebReminders() {
  if (!supported()) return;
  S.onSave(() => refresh());
  document.addEventListener('visibilitychange', () => {
    // A phone gives a page a moment before suspending it, so send what's waiting straight away.
    if (document.visibilityState === 'hidden') {
      if (timer) void refreshNow();
    } else refresh(0); // a new day, or a new time zone
  });
  refresh(0);
}
