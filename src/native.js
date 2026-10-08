// Extras for the iOS app, which wraps this same web app with Capacitor: real daily notifications,
// a copy of your data in a file the phone keeps, and sharing files. In a browser none of this runs.

import * as S from './store';
import * as R from './reminders.js';

const cap = window.Capacitor;
export const isNative = !!cap?.isNativePlatform?.();
const has = (name) => isNative && !!cap.PluginHeaders?.some((h) => h.name === name);
const call = (plugin, method, options = {}) => cap.nativePromise(plugin, method, options);

// iOS keeps at most 64 pending notifications per app, so plan about 6 weeks ahead. The list is
// rebuilt every time the app opens or your data changes.
const MORNING_DAYS = 40;
const EVENING_DAYS = 14;
const DATA_FILE = 'Arise data.json';

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

// Everything that should be pending right now. Done days, football days and rest days get nothing.
export function upcoming(now = new Date()) {
  const st = S.state.settings;
  const rot = S.planMode() === 'rotation';
  const today = S.todayKey();
  const list = [];
  // On a rotation, the real session name is only known for the first day that isn't done yet.
  let open = false;
  for (let i = 0; i < MORNING_DAYS; i++) {
    const k = S.addDays(today, i);
    if (S.covered(k)) continue;
    const name = R.questName(k, !open);
    open = true;
    if (!name) continue;
    const morning = timeOn(k, st.remindAt, '07:00');
    if (morning > now) list.push({ id: 1000 + i, title: R.morningLine(k, name), body: R.quoteFor(k), at: morning });
    const evening = timeOn(k, st.eveningAt, '20:30');
    if (st.evening && i < EVENING_DAYS && evening > now && evening > morning) {
      list.push({
        id: 2000 + i,
        title: R.eveningLine(k, name),
        body: rot && S.restAllowance() > 0 ? "Log it in the app when you're done, or take a rest day if you have one left." : "Log it in the app when you're done.",
        at: evening,
      });
    }
  }
  const last = S.addDays(today, MORNING_DAYS);
  list.push({
    id: 3000,
    title: 'Your reminders stop here',
    body: "Open Arise to keep them coming. They're topped up every time you open the app.",
    at: timeOn(last, st.remindAt, '07:00'),
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
      notifications: list.map((n) => ({ id: n.id, title: n.title, body: n.body, schedule: { at: n.at }, sound: 'default', threadIdentifier: 'arise' })),
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

// ---------- data file

// A copy of everything in the app's Documents folder. The Files app shows it under
// On My iPhone, Arise. If iOS ever clears the app's web storage, the app loads it back.
let backupReady = false;
let backupTimer = null;

async function writeDataFile() {
  clearTimeout(backupTimer);
  backupTimer = null;
  if (!backupReady || !has('Filesystem')) return;
  try {
    await call('Filesystem', 'writeFile', { path: DATA_FILE, data: S.snapshot(), directory: 'DOCUMENTS', encoding: 'utf8' });
  } catch (err) {
    console.warn('Could not write the data file', err);
  }
}

function queueDataFile() {
  clearTimeout(backupTimer);
  backupTimer = setTimeout(writeDataFile, 4000);
}

async function restoreIfEmpty() {
  if (!S.freshStart() || !has('Filesystem')) return false;
  try {
    const { data } = await call('Filesystem', 'readFile', { path: DATA_FILE, directory: 'DOCUMENTS', encoding: 'utf8' });
    return typeof data === 'string' && S.restoreSnapshot(data);
  } catch {
    return false; // no file yet: a real first start
  }
}

// ---------- sharing

// Browsers download files; inside the app the share sheet does it (Save to Files, AirDrop, Mail...).
export async function shareFile(name, text) {
  const { uri } = await call('Filesystem', 'writeFile', { path: name, data: text, directory: 'CACHE', encoding: 'utf8' });
  try {
    await call('Share', 'share', { title: name, files: [uri] });
  } catch (err) {
    if (!/cancel/i.test(err?.message || '')) throw err;
  }
}

// ---------- start

export async function initNative() {
  if (!isNative) return;
  document.documentElement.classList.add('native');
  S.onSave(() => {
    queueSync();
    queueDataFile();
  });
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
}
