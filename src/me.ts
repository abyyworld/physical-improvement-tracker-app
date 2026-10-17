// Arise as the Player's "me" for other apps (the format is lib/me.ts): what Arise knows, put
// together for an app, and the me links that keep an app up to date.
//
// A me link belongs to one app. It's a page in the cloud (shares/<id>: the same place and shape as
// a shared goal's page, so firestore.rules needs nothing new), sealed with a key that's only in
// the link. It needs an account, holds only what the Player picked for that app, and updates
// itself after changes. Turning it off, or making a new one, leaves the empty page a goal's link
// leaves, for good.
//
// The links are kept on this device, not synced, like the memory they're made from: another
// device doesn't know what this one learned, so it could only ever send an app less. Deleting the
// account turns them all off (sync.ts turns off every page the account keeps), and so does
// removing this device's data while signed in (Erase all data, Sign out and remove my data). Only
// a page's own account can turn it off: one this device can't turn off now (erased while signed
// out, or its data taken over by another account) waits, with whose it is, until that account is
// signed in here again.

import * as S from './store';
import * as A from './account';
import * as SYNC from './sync';
import * as M from './life/memory';
import { firstName, goalStreak, problem } from './share';
import * as LS from './lib/share';
import * as ME from './lib/me';
import { cleanAboutChoice, cleanMeLinks, cleanOffLater, MAX_ME_LINKS, type MeLink, type OffLater } from './lib/validate';

export type { MeLink };
export { problem };

const LINKS = 'arise-me-links';
const OFF_LATER = 'arise-me-off';
const ABOUT = 'arise-about-me';
const DELAY = 10_000; // after a change, once things are quiet
const AFTER_SYNC = 1500;

// ---------- this device's storage

const read = (k: string): unknown => {
  try {
    return JSON.parse(localStorage.getItem(k) || 'null');
  } catch {
    return null;
  }
};
const write = (k: string, v: unknown) => {
  try {
    if (v == null || (Array.isArray(v) && !v.length)) localStorage.removeItem(k);
    else localStorage.setItem(k, JSON.stringify(v));
  } catch {}
};

export const links = (): MeLink[] => cleanMeLinks(read(LINKS));
const saveLinks = (list: MeLink[]) => write(LINKS, list);
const offLater = () => cleanOffLater(read(OFF_LATER));
// Pages to turn off once their account can (an entry's owner is '' while not known).
const putOff = (list: OffLater[]) => write(OFF_LATER, cleanOffLater([...offLater(), ...list]));
const forget = (id: string) => {
  notes.delete(id);
  saveLinks(links().filter((l) => l.id !== id));
};

// Only while it's still the same link: it may have been turned off or replaced meanwhile.
function patchLink(id: string, key: string, patch: Partial<MeLink>) {
  saveLinks(links().map((l) => (l.id === id && l.key === key ? { ...l, ...patch } : l)));
}

export const aboutChoice = (): ME.MeChoice => cleanAboutChoice(read(ABOUT));
export const setAboutChoice = (c: ME.MeChoice) => write(ABOUT, cleanAboutChoice(c));

// ---------- what Arise knows, for an app

// From the app's data and the memory as it's loaded now: the Player's first name, active goals,
// facts (the best first, as in the profile), today's quests and the summaries of the last 7 days.
// Facts and days carry how private they are to share (memory.ts shareOf), not the tier the AI
// reads them at: to the AI, Arise's own journal, weigh-ins and coach questions are tier 1.
export function sourceNow(): ME.MeSource {
  const today = S.todayKey();
  const week = S.addDays(today, -7);
  return {
    name: firstName(),
    goals: S.activeGoals().map((g) => ({ title: g.title, why: g.why, streak: goalStreak(g, today) })),
    facts: M.rankFacts(M.activeFacts()).map((f) => ({ text: f.text, since: f.since, tier: M.shareOf(f) })),
    today: { day: today, quests: S.questsFor(today).map(({ quest, done }) => ({ title: quest.title, done })) },
    days: M.daySummaries()
      .filter((s) => s.key < today && s.key >= week)
      .sort((a, b) => b.key.localeCompare(a.key))
      .map((s) => ({ day: s.key, text: s.text, tier: M.shareOf(s) })),
  };
}

export async function source(): Promise<ME.MeSource> {
  await M.load();
  return sourceNow();
}

// Exactly what an app with this choice gets now (before any trimming to fit a page).
export const payloadFor = async (c: ME.MeChoice, now = Date.now()) => ME.buildMe(await source(), c, now);

// ---------- the pages in the cloud

// What went wrong with each link's last update here, if it did.
const notes = new Map<string, string>();
export const note = (id: string) => notes.get(id) || '';

const pageRef = (id: string) => {
  const { fb, db } = A.firebase();
  return fb.doc(db, 'shares', id);
};

function signedIn() {
  const u = SYNC.status.user;
  if (!u) throw new A.AccountError('signed-out', 'Connecting an app needs an account. Make one, or sign in, under Settings, Account.');
  return u;
}

const sigOf = (p: ME.MePayload) => M.fingerprint([ME.bodyOf(p)]);

// The page as the cloud keeps it, and the fingerprint of what it says.
async function page(ref: { id: string; key: string }, full: ME.MePayload, owner: string): Promise<{ doc: LS.ShareDoc; sig: string }> {
  const { sealed } = await ME.sealMe(ref, full);
  return { doc: { owner, iv: sealed.iv, ct: sealed.ct, v: 1, updated: full.updated }, sig: sigOf(full) };
}

const denied = (err: unknown) => /permission-denied/.test(String((err as { code?: string })?.code));

const OTHER = 'This link was made with another account, so only that account can change it or turn it off. It goes off the next time that account is signed in here.';

// After the cloud refused a write to a page: '' when the page is off (or gone), so it never works
// again anyway; the account whose page it is when it's another one's. Anything else: `err`.
async function refusedBy(id: string, uid: string, err: unknown): Promise<string> {
  const { fb } = A.firebase();
  const snap = await fb.getDoc(pageRef(id));
  const d = snap.exists() ? (snap.data() as { off?: boolean; owner?: unknown }) : null;
  if (!d || d.off) return '';
  if (typeof d.owner === 'string' && d.owner && d.owner !== uid) return d.owner;
  throw err;
}

// Turns a page off for good: '' once it is off, or the account whose page it is, when that's
// another one, which only it can turn off.
async function pageOff(id: string, uid: string): Promise<string> {
  try {
    const { fb } = A.firebase();
    await fb.setDoc(pageRef(id), LS.SHARE_OFF);
    return '';
  } catch (err) {
    if (!denied(err)) throw err;
    return refusedBy(id, uid, err);
  }
}

// ---------- what the Player does

// A new link for one app: its page goes up first, so a link on the list always has one.
export async function connect(app: string, choice: ME.MeChoice): Promise<MeLink> {
  const user = signedIn();
  if (links().length >= MAX_ME_LINKS) throw new Error(`You can connect up to ${MAX_ME_LINKS} apps. Turn one off first.`);
  const ref = await LS.newShareRef();
  const c = ME.cleanChoice(choice, ME.LINK_DEFAULT);
  const { doc, sig } = await page(ref, await payloadFor(c), user.uid);
  const { fb } = A.firebase();
  await fb.setDoc(pageRef(ref.id), doc);
  const link = cleanMeLinks([{ id: ref.id, key: ref.key, app: app.trim(), at: ref.at, choice: c, owner: user.uid, sig, sent: doc.updated }])[0];
  saveLinks([...links(), link]);
  return link;
}

// A new link for the same app. The old one stops working for good, in the same go.
export async function newLink(id: string): Promise<MeLink | null> {
  const user = signedIn();
  const old = links().find((l) => l.id === id);
  if (!old) return null;
  const ref = await LS.newShareRef();
  const { doc, sig } = await page(ref, await payloadFor(old.choice), user.uid);
  const { fb, db } = A.firebase();
  const batch = fb.writeBatch(db);
  batch.set(pageRef(ref.id), doc);
  batch.set(pageRef(old.id), LS.SHARE_OFF);
  try {
    await batch.commit();
  } catch (err) {
    if (!denied(err)) throw err;
    // The old page is off already: the new one goes up on its own. Another account's: only that
    // account can turn it off, so nothing changes here but that it waits for it.
    const other = await refusedBy(old.id, user.uid, err);
    if (other) {
      putOff([{ id: old.id, owner: other }]);
      forget(old.id);
      throw new A.AccountError('me-other', OTHER);
    }
    await fb.setDoc(pageRef(ref.id), doc);
  }
  const link: MeLink = { ...old, id: ref.id, key: ref.key, at: ref.at, owner: user.uid, sig, sent: doc.updated };
  notes.delete(old.id);
  saveLinks(links().map((l) => (l.id === old.id ? link : l)));
  return link;
}

// Turns the page off for good, so the link stops working, and forgets the link. Another
// account's page waits for that account (and this says so).
export async function turnOff(id: string): Promise<void> {
  const user = signedIn();
  const other = await pageOff(id, user.uid);
  if (other) putOff([{ id, owner: other }]);
  forget(id);
  if (other) throw new A.AccountError('me-other', OTHER);
}

// What an app gets from now on. True once its page says so; throws if it couldn't be updated
// (the choice stays, and the page follows with a later update).
export async function setChoice(id: string, choice: ME.MeChoice): Promise<boolean> {
  signedIn();
  const l = links().find((x) => x.id === id);
  if (!l) return false;
  patchLink(l.id, l.key, { choice: ME.cleanChoice(choice, ME.LINK_DEFAULT), sig: undefined });
  await refresh();
  if (note(id)) throw new A.AccountError('me-update', note(id));
  return links().some((x) => x.id === id);
}

const waiting = (l: MeLink): OffLater => ({ id: l.id, owner: l.owner || '' });

// Every link off, before this device's data is removed (sync.ts calls it then, once that's
// sure). Those it can't turn off now go off the next time their account is signed in here.
export async function turnOffAll(): Promise<void> {
  const list = links();
  if (!list.length) return;
  if (!SYNC.status.user) {
    putOff(list.map(waiting));
    saveLinks([]);
    return;
  }
  for (const l of list) {
    try {
      await turnOff(l.id);
    } catch {
      if (links().some((x) => x.id === l.id)) putOff([waiting(l)]);
      forget(l.id);
    }
  }
}

// This device's data was erased, or replaced by another account's: the links and the About me
// choice belong to the person whose data it was. Pages still up go off once their account can.
function forgetHere() {
  putOff(links().map(waiting));
  saveLinks([]);
  write(ABOUT, null);
  notes.clear();
}

// ---------- keeping the pages up to date

let timer: ReturnType<typeof setTimeout> | null = null;
let running: Promise<void> | null = null;
let next: Promise<void> | null = null;

// Brings every link's page up to date after `ms`, unless asked again before then.
export function soon(ms = DELAY) {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!SYNC.status.user || (!links().length && !offLater().length)) return;
  timer = setTimeout(() => void refresh(), ms);
}

// Done once a round that began after this call has brought every page up to date.
export function refresh(): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = null;
  if (running) {
    next ||= running.then(() => {
      next = null;
      return refresh();
    });
    return next;
  }
  running = (async () => {
    const user = SYNC.status.user;
    if (!user) return;
    await turnOffLeftOver(user.uid);
    if (!links().length) return;
    // Never from a memory that couldn't be read: that would send an app nothing.
    try {
      await M.load();
    } catch {
      return;
    }
    for (const l of links()) await update(l, user.uid);
  })().finally(() => {
    running = null;
  });
  return running;
}

// Only this account's pages (and those whose account isn't known yet): another account's waits
// for it.
async function turnOffLeftOver(uid: string) {
  for (const { id, owner } of offLater()) {
    if (owner && owner !== uid) continue;
    let other: string;
    try {
      other = await pageOff(id, uid);
    } catch {
      continue; // try again next time
    }
    const rest = offLater().filter((x) => x.id !== id);
    write(OFF_LATER, other ? [...rest, { id, owner: other }] : rest);
  }
}

// Only while the page is up and this account's: one that's off (or gone) was turned off, here,
// in another tab or when the account was deleted, and stays off. Another account's (this device's
// data went to this account) can't be kept up to date from here, so it goes off once that account
// is signed in here again.
async function update(l: MeLink, uid: string) {
  try {
    const full = ME.buildMe(sourceNow(), l.choice);
    const sig = sigOf(full);
    if (l.sig === sig) {
      notes.delete(l.id);
      return;
    }
    const { doc } = await page(l, full, uid);
    const { fb, db } = A.firebase();
    const result: { ok?: true; owner?: string } = await fb.runTransaction(db, async (tx) => {
      const now = await tx.get(pageRef(l.id));
      if (!now.exists() || (now.data() as { off?: boolean }).off) return {};
      const owner = (now.data() as LS.ShareDoc).owner;
      if (owner !== uid) return { owner };
      tx.set(pageRef(l.id), doc);
      return { ok: true };
    });
    notes.delete(l.id);
    if (result.ok) return patchLink(l.id, l.key, { sig, sent: doc.updated });
    if (result.owner && links().some((x) => x.id === l.id)) putOff([{ id: l.id, owner: result.owner }]);
    forget(l.id);
  } catch (err) {
    notes.set(l.id, problem(err));
  }
}

export function initMe() {
  S.onSave(() => soon());
  M.onMemoryChange(() => soon());
  SYNC.onSynced(() => soon(AFTER_SYNC));
  SYNC.onClearing(turnOffAll);
  S.onReset(forgetHere);
  // About to be put away: now, rather than after the wait. Back again, maybe on a new day: soon.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && timer) void refresh();
    else if (document.visibilityState === 'visible') soon();
  });
  // Today's quests and the last 7 days move on by themselves.
  soon();
}
