// Extras for the iOS app, which wraps this same web app with Capacitor: real daily notifications,
// a copy of your data in a file the phone keeps, and sharing files and links. In a browser none of
// this runs.

import * as S from './store';
import * as R from './reminders.js';
import * as LOCK from './lib/lock';

const cap = window.Capacitor;
export const isNative = !!cap?.isNativePlatform?.();
const has = (name) => isNative && !!cap.PluginHeaders?.some((h) => h.name === name);
const call = (plugin, method, options = {}) => cap.nativePromise(plugin, method, options);

// iOS keeps at most 64 pending notifications per app, so plan about 6 weeks ahead. The list is
// rebuilt every time the app opens or your data changes (and the journal's when the journal does).
const MORNING_DAYS = 40;
const EVENING_DAYS = 14;
const JOURNAL_DAYS = 7; // the evening check-in and the morning "Yesterday"
const MAX_PENDING = 64;
const DATA_FILE = 'Arise data.json';
const LOCK_FILE = 'Arise lock.json';

// ---------- notifications

export const canNotify = () => has('LocalNotifications');

export async function permission() {
  if (!canNotify()) return 'unavailable';
  try {
    return (await call('LocalNotifications', 'checkPermissions')).display;
  } catch {
    return 'unavailable';
  }
}

export async function enableNotifications() {
  let p = await permission();
  if (p === 'unavailable') return p;
  if (p !== 'granted' && p !== 'denied') {
    try {
      p = (await call('LocalNotifications', 'requestPermissions')).display;
    } catch {
      p = 'denied';
    }
  }
  if (p === 'granted') {
    S.state.settings.notify = true;
    S.save();
    await syncNotifications(true);
  }
  return p;
}

export async function disableNotifications() {
  S.state.settings.notify = false;
  S.save();
  await syncNotifications(true);
}

function timeOn(k, hhmm, fallback) {
  const [h, m] = (hhmm || fallback).split(':').map(Number);
  const d = S.parseKey(k);
  d.setHours(h || 0, m || 0, 0, 0);
  return d;
}

// Everything that should be pending right now, soonest first. Done days, football days and rest
// days get no quest reminders; the journal's come every day (each has its own switch). `open`:
// the day whose journal a tap opens.
export function upcoming(now = new Date()) {
  const st = S.state.settings;
  const today = S.todayKey();
  /** @type {{ id: number; title: string; body: string; at: Date; open?: string }[]} */
  const list = [];
  R.days(MORNING_DAYS, today).forEach((d, i) => {
    if (!d.morning) return;
    const morning = timeOn(d.date, st.remindAt, '07:00');
    if (morning > now) list.push({ id: 1000 + i, title: d.morning.title, body: d.morning.body, at: morning });
    const evening = timeOn(d.date, st.eveningAt, '20:30');
    if (st.evening && i < EVENING_DAYS && evening > now && evening > morning) list.push({ id: 2000 + i, title: d.evening.title, body: d.evening.body, at: evening });
  });
  R.journalDays(JOURNAL_DAYS, today).forEach((d, i) => {
    const recap = timeOn(d.date, st.recapAt || st.remindAt, '07:00');
    if (st.recap && recap > now) list.push({ id: 4000 + i, title: d.recap.title, body: d.recap.body, at: recap, open: d.recap.day });
    const checkin = timeOn(d.date, st.checkinAt, '21:30');
    if (st.checkin && checkin > now) list.push({ id: 5000 + i, title: d.checkin.title, body: d.checkin.body, at: checkin, open: d.checkin.day });
  });
  list.sort((a, b) => a.at - b.at || a.id - b.id);
  // Within what iOS keeps: the soonest ones, and the note that they stop where they do.
  let stop = timeOn(S.addDays(today, MORNING_DAYS), st.remindAt, '07:00');
  if (list.length > MAX_PENDING - 1) {
    stop = list[MAX_PENDING - 1].at;
    list.length = MAX_PENDING - 1;
  }
  list.push({
    id: 3000,
    title: 'Your reminders stop here',
    body: "Open Arise to keep them coming. They're topped up every time you open the app.",
    at: stop,
  });
  return list;
}

let lastSig = '';
let queue = Promise.resolve();
let syncTimer = null;

async function doSync(force) {
  const list = S.state.settings.notify ? upcoming() : [];
  const sig = JSON.stringify(list);
  if (!force && sig === lastSig) return;
  lastSig = sig;
  try {
    await call('LocalNotifications', 'cancelAll');
    if (!list.length || (await permission()) !== 'granted') return;
    await call('LocalNotifications', 'schedule', {
      // A sound name iOS can't find plays the normal alert sound. Without one, the plugin sends them silently.
      notifications: list.map((n) => ({ id: n.id, title: n.title, body: n.body, schedule: { at: n.at }, sound: 'default', threadIdentifier: 'arise', ...(n.open ? { extra: { open: 'journal', day: n.open } } : {}) })),
    });
  } catch (err) {
    lastSig = '';
    console.warn('Could not schedule notifications', err);
  }
}

// Runs one at a time so a cancel from one pass never wipes what the next pass scheduled.
export function syncNotifications(force = false) {
  if (!canNotify()) return Promise.resolve();
  clearTimeout(syncTimer);
  syncTimer = null;
  queue = queue.then(() => doSync(force));
  return queue;
}

function queueSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncNotifications(), 1500);
}

// Tapping a journal notification opens that day's journal: the app listens for 'arise:journal'
// (from before this starts). The plugin keeps the tap that opened the app until a listener is here.
function listenForTaps() {
  if (!canNotify() || typeof cap.nativeCallback !== 'function') return;
  try {
    cap.nativeCallback('LocalNotifications', 'addListener', { eventName: 'localNotificationActionPerformed' }, (data) => {
      const extra = data?.notification?.extra;
      if (extra?.open !== 'journal' || !/^\d{4}-\d{2}-\d{2}$/.test(String(extra.day || ''))) return;
      window.dispatchEvent(new CustomEvent('arise:journal', { detail: { day: extra.day } }));
    });
  } catch {}
}

// ---------- data file

// A copy of everything in the app's Documents folder. The Files app shows it under
// On My iPhone, Arise. If iOS ever clears the app's web storage, the app loads it back.
// While the app lock is on, the copy is in the app's Library folder instead, which the Files app
// doesn't show, so it can't be read without the passcode. The lock is kept with it there, so it
// comes back with the data.
let backupReady = false;
let backupTimer = null;

async function writeDataFile() {
  clearTimeout(backupTimer);
  backupTimer = null;
  if (!backupReady || !has('Filesystem')) return;
  const lock = LOCK.read();
  const [dir, other] = lock ? ['LIBRARY', 'DOCUMENTS'] : ['DOCUMENTS', 'LIBRARY'];
  try {
    await call('Filesystem', 'writeFile', { path: DATA_FILE, data: S.snapshot(), directory: dir, encoding: 'utf8' });
    if (lock) await call('Filesystem', 'writeFile', { path: LOCK_FILE, data: JSON.stringify(lock), directory: 'LIBRARY', encoding: 'utf8' });
    else await call('Filesystem', 'deleteFile', { path: LOCK_FILE, directory: 'LIBRARY' }).catch(() => {});
    await call('Filesystem', 'deleteFile', { path: DATA_FILE, directory: other }).catch(() => {});
  } catch (err) {
    console.warn('Could not write the data file', err);
  }
}

// The app lock went on or off: the copy moves.
export const lockChanged = () => writeDataFile();

function queueDataFile() {
  clearTimeout(backupTimer);
  backupTimer = setTimeout(writeDataFile, 4000);
}

async function restoreIfEmpty() {
  if (!S.freshStart() || !has('Filesystem')) return false;
  // No file yet: a real first start.
  const read = (path, directory) => call('Filesystem', 'readFile', { path, directory, encoding: 'utf8' }).then((r) => r.data, () => null);
  const hidden = await read(DATA_FILE, 'LIBRARY');
  const data = hidden ?? (await read(DATA_FILE, 'DOCUMENTS'));
  if (typeof data !== 'string' || !S.restoreSnapshot(data)) return false;
  if (hidden != null) {
    const lock = await read(LOCK_FILE, 'LIBRARY');
    if (typeof lock === 'string') LOCK.restore(lock);
  }
  return true;
}

// ---------- sharing

// Browsers download files; inside the app the share sheet does it (Save to Files, AirDrop, Mail...).
// The sheet needs the file in the app's cache first. A backup there is all your data in plain
// text, so it's deleted once the sheet closes, and any left behind are cleared at start-up.
const SHARED = /^arise-.*\.(json|ics)$/;

export async function shareFile(name, text) {
  const { uri } = await call('Filesystem', 'writeFile', { path: name, data: text, directory: 'CACHE', encoding: 'utf8' });
  try {
    await call('Share', 'share', { title: name, files: [uri] });
  } catch (err) {
    if (!/cancel/i.test(err?.message || '')) throw err;
  } finally {
    await call('Filesystem', 'deleteFile', { path: name, directory: 'CACHE' }).catch(() => {});
  }
}

// A link (a shared goal's page) to the share sheet: Messages, WhatsApp, Mail, Copy and so on.
export const canShareLink = () => has('Share');
export async function shareLink({ title, text, url }) {
  try {
    await call('Share', 'share', { title, text, url, dialogTitle: title });
  } catch (err) {
    if (!/cancel/i.test(err?.message || '')) throw err;
  }
}

async function clearSharedFiles() {
  if (!has('Filesystem')) return;
  try {
    const { files } = await call('Filesystem', 'readdir', { path: '', directory: 'CACHE' });
    for (const f of files || []) {
      if (SHARED.test(f.name)) await call('Filesystem', 'deleteFile', { path: f.name, directory: 'CACHE' }).catch(() => {});
    }
  } catch {}
}

// ---------- start

export async function initNative() {
  if (!isNative) return;
  document.documentElement.classList.add('native');
  listenForTaps();
  S.onSave(() => {
    queueSync();
    queueDataFile();
  });
  // What the journal says changed (and with it the journal's notifications).
  R.onJournalLines(queueSync);
  document.addEventListener('visibilitychange', () => {
    // iOS gives an app a moment before suspending it, so save and schedule straight away.
    if (document.visibilityState === 'hidden') {
      if (backupTimer) writeDataFile();
      if (syncTimer) syncNotifications();
    } else {
      syncNotifications();
    }
  });
  if (await restoreIfEmpty()) {
    location.reload();
    return;
  }
  backupReady = true;
  writeDataFile();
  syncNotifications(true);
  clearSharedFiles();
}
