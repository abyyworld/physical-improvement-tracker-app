// Sharing a goal's progress with a friend: making the link, keeping its page up to date, and
// turning it off. It needs an account, since the page is kept in the cloud (shares/<id> in
// firestore.rules), sealed with a key that's only in the link (lib/share.ts).
//
// What a friend sees is built here (snapshotOf), and nothing else goes: this goal's title and
// area, the Player's first name if they chose to show it, their streak, this goal's quests and
// their streaks, its last 28 days, its measures' latest numbers and targets, its milestones done,
// and when it was updated. Never the journal, the coach's chat, other goals or body data. Next
// to the sealed page, anyone with the link can also see the account's id and when the page was
// updated (lib/share.ts), and the share sheet says so.
//
// The goal keeps its link (goal.share), so it syncs: every device signed in to the account keeps
// the page up to date. Turning a link off, or replacing it, leaves an empty page there that the
// rules let nobody change (firestore.rules). So it stays off for good, whichever device or
// account tries, and a device that finds its page off (or gone) forgets the link.

import * as S from './store';
import * as G from './lib/goals';
import * as A from './account';
import * as SYNC from './sync';
import * as L from './lib/share';
import type { Goal } from './lib/goals';

const DELAY = 10_000; // after a change, once things are quiet
const AFTER_SYNC = 1500;

// ---------- what a friend sees

// The Player's first name, as they call themselves in Arise ('' if they haven't said).
export function firstName(): string {
  const full = S.state.settings.name || (typeof S.state.profile?.name === 'string' ? S.state.profile.name : '');
  return full.trim().split(/\s+/)[0].slice(0, 24);
}

// A day for this goal alone: done when everything it asked that day was done (or nothing was
// asked and something got done anyway), missed when something it asked wasn't, a day off when it
// asked nothing. Today isn't over, so it's never missed. A paused or achieved goal asks nothing.
function mark(g: Goal, k: string, today: string): L.DayMark {
  const quests = g.quests.filter((q) => G.live(q, k));
  const due = quests.filter((q) => G.dueOn(q, k));
  const open = due.some((q) => !G.isDone(S.state.checks, k, q.id));
  if (due.length && !open) return 'd';
  if (open && g.status === 'active') return k === today ? 't' : 'm';
  const did = quests.some((q) => G.isDone(S.state.checks, k, q.id)) || (!!g.workouts && (S.sessionsOn(k).length > 0 || S.isFootball(k)));
  return did ? 'd' : k === today && g.status === 'active' ? 't' : 'o';
}

export function snapshotOf(g: Goal, { name = false, now = Date.now() }: { name?: boolean; now?: number } = {}): L.Snapshot {
  const today = S.todayKey();
  const start = S.addDays(today, -27);
  const from = g.created > today ? today : g.created > start ? g.created : start;
  let days = '';
  for (let k = from; k <= today; k = S.addDays(k, 1)) days += mark(g, k, today);
  const snap: L.Snapshot = {
    v: 1,
    title: g.title,
    area: G.CATEGORIES[g.category].label,
    status: g.status,
    streak: S.currentStreak(),
    quests: g.quests
      .filter((q) => !q.archived)
      .map((q) => ({ title: q.title, when: G.scheduleText(q.schedule), streak: S.questStreak(q, today), ...(q.schedule.kind === 'weekly' ? { weekly: true as const } : {}) })),
    from,
    days,
    measures: g.measures.map((m) => {
      const series = S.measureSeries(m.id);
      const last = series[series.length - 1];
      return { name: m.name, unit: m.unit, ...(last ? { value: last.v, on: last.date } : {}), ...(m.target != null ? { target: m.target } : {}) };
    }),
    milestones: g.milestones.flatMap((m) => (m.done ? [{ title: m.title, done: m.done }] : [])),
    milestonesOf: g.milestones.length,
    updated: now,
  };
  const first = name ? firstName() : '';
  if (first) snap.name = first;
  return snap;
}

// What a snapshot says, apart from when it was made: if that's the same, there's nothing to send.
const bodyOf = (snap: L.Snapshot) => JSON.stringify({ ...snap, updated: 0 });

// ---------- the page in the cloud

// How the page of each share was last updated from this device: when, or what went wrong.
const notes = new Map<string, { at?: number; error?: string }>();
const sent = new Map<string, string>(); // share id -> what its page says, as last sent from here
export const note = (id: string) => notes.get(id) || {};

const pageRef = (id: string) => {
  const { fb, db } = A.firebase();
  return fb.doc(db, 'shares', id);
};

function signedIn() {
  const u = SYNC.status.user;
  if (!u) throw new A.AccountError('signed-out', 'Sharing needs an account. Make one, or sign in, under Settings, Account.');
  return u;
}

// The page as the cloud keeps it: the snapshot sealed with the link's key.
async function sealPage(ref: L.ShareRef, snap: L.Snapshot, owner: string): Promise<L.ShareDoc> {
  const sealed = await L.sealSnapshot(ref, snap);
  if (sealed.ct.length > L.MAX_CT) throw new Error('This goal has too much in it to share. Try it with fewer quests, measures or milestones.');
  return { owner, iv: sealed.iv, ct: sealed.ct, v: 1, updated: snap.updated };
}
async function page(g: Goal, ref: L.ShareRef, owner: string) {
  const snap = snapshotOf(g, { name: !!ref.name });
  return { doc: await sealPage(ref, snap, owner), body: bodyOf(snap) };
}

const denied = (err: unknown) => /permission-denied/.test(String((err as { code?: string })?.code));

// What to tell the Player when something didn't work.
export function problem(err: unknown): string {
  const code = String((err as { code?: string })?.code || '');
  if (/unavailable|network|deadline/.test(code)) return "Couldn't reach the cloud. Check your internet connection and try again.";
  return A.friendly(err);
}

// The goal no longer has this link (turned off or replaced on another device, or its page is
// another account's). Only if it still is the goal's link: a newer one may have come in meanwhile.
function forget(goalId: string, id: string) {
  sent.delete(id);
  notes.delete(id);
  const g = S.goalById(goalId);
  if (g?.share?.id === id) S.saveGoal({ ...g, share: undefined });
}

// ---------- what the Player does

// Makes the link: the page goes up first, so a link the goal keeps always has one.
export async function start(goalId: string, { name = false } = {}): Promise<L.ShareRef | null> {
  const user = signedIn();
  const g = S.goalById(goalId);
  if (!g) return null;
  if (g.share) return g.share;
  const ref: L.ShareRef = { ...(await L.newShareRef()), ...(name ? { name: true as const } : {}) };
  const { doc, body } = await page(g, ref, user.uid);
  const { fb } = A.firebase();
  await fb.setDoc(pageRef(ref.id), doc);
  const now = S.goalById(goalId);
  if (!now || now.share) {
    // Deleted while the page went up, or shared from another device meanwhile: that link stays,
    // and this one's page is turned off (nobody has its link yet).
    await fb.setDoc(pageRef(ref.id), L.SHARE_OFF).catch(() => {});
    return now?.share ?? null;
  }
  sent.set(ref.id, body);
  notes.set(ref.id, { at: doc.updated });
  S.saveGoal({ ...now, share: ref });
  return ref;
}

// A new link for the same page. The old one stops working for good: its page is turned off in the
// same go.
export async function newLink(goalId: string): Promise<L.ShareRef | null> {
  const user = signedIn();
  const g = S.goalById(goalId);
  if (!g?.share) return start(goalId);
  const old = g.share;
  const ref: L.ShareRef = { ...(await L.newShareRef()), ...(old.name ? { name: true as const } : {}) };
  const { doc, body } = await page(g, ref, user.uid);
  const { fb, db } = A.firebase();
  const batch = fb.writeBatch(db);
  batch.set(pageRef(ref.id), doc);
  batch.set(pageRef(old.id), L.SHARE_OFF);
  try {
    await batch.commit();
  } catch (err) {
    // The old page is off already, or another account's (this data joined this account from
    // it): only that account can turn it off. The new one goes up anyway.
    if (!denied(err)) throw err;
    await fb.setDoc(pageRef(ref.id), doc);
  }
  sent.delete(old.id);
  notes.delete(old.id);
  sent.set(ref.id, body);
  notes.set(ref.id, { at: doc.updated });
  const now = S.goalById(goalId);
  if (now) S.saveGoal({ ...now, share: ref });
  return ref;
}

// Turns the page off for good, so the link stops working, and forgets the link.
export async function stop(goalId: string) {
  const g = S.goalById(goalId);
  if (!g?.share) return;
  signedIn();
  const { id } = g.share;
  try {
    const { fb } = A.firebase();
    await fb.setDoc(pageRef(id), L.SHARE_OFF);
  } catch (err) {
    // Off already, or another account's page (see newLink): this one can only forget it.
    if (!denied(err)) throw err;
  }
  forget(goalId, id);
}

// "Show my name": the page changes straight away. True once it has, false if the link was turned
// off meanwhile. Throws if the page couldn't be updated: the choice stays, and the page follows
// with a later update (the share sheet says so, and offers to try again).
export async function showName(goalId: string, on: boolean): Promise<boolean> {
  signedIn();
  const g = S.goalById(goalId);
  if (!g?.share) return false;
  S.saveGoal({ ...g, share: { ...g.share, name: on || undefined } });
  return updatePage(goalId);
}

// Brings this goal's page up to date now (with every other's). True once it is, false if the
// goal has no link any more. Throws what went wrong if it couldn't be.
export async function updatePage(goalId: string): Promise<boolean> {
  signedIn();
  await refresh();
  const id = S.goalById(goalId)?.share?.id;
  if (!id) return false;
  const { error } = note(id);
  if (error) throw new A.AccountError('share-update', error);
  return true;
}

// ---------- keeping the pages up to date

let timer: ReturnType<typeof setTimeout> | null = null;
let running: Promise<void> | null = null;
let next: Promise<void> | null = null;

// Brings every shared goal's page up to date after `ms`, unless asked again before then.
export function soon(ms = DELAY) {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!SYNC.status.user || !S.state.goals.some((g) => g.share)) return;
  timer = setTimeout(() => void refresh(), ms);
}

// Done once a round that began after this call has brought every page up to date: one already
// under way may have read the goals before the change it's for.
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
    for (const g of S.state.goals) if (g.share) await update(g, g.share);
  })().finally(() => {
    running = null;
  });
  return running;
}

// Only while the page is up and this account's: one that's off (or gone) was turned off or
// replaced on another device, and stays off.
async function update(g: Goal, ref: L.ShareRef) {
  const user = SYNC.status.user;
  if (!user) return;
  try {
    const snap = snapshotOf(g, { name: !!ref.name });
    const body = bodyOf(snap);
    if (sent.get(ref.id) === body) {
      // The page says this already. (An update that failed since was for a change undone.)
      const { at } = note(ref.id);
      notes.set(ref.id, at ? { at } : {});
      return;
    }
    const doc = await sealPage(ref, snap, user.uid);
    const { fb, db } = A.firebase();
    const result = await fb.runTransaction(db, async (tx) => {
      const now = await tx.get(pageRef(ref.id));
      if (!now.exists() || (now.data() as { off?: boolean }).off) return 'gone';
      if ((now.data() as L.ShareDoc).owner !== user.uid) return 'other';
      tx.set(pageRef(ref.id), doc);
      return 'ok';
    });
    if (result === 'ok') {
      sent.set(ref.id, body);
      notes.set(ref.id, { at: doc.updated });
    } else forget(g.id, ref.id);
  } catch (err) {
    notes.set(ref.id, { ...notes.get(ref.id), error: problem(err) });
  }
}

export function initSharing() {
  S.onSave(() => soon());
  SYNC.onSynced(() => soon(AFTER_SYNC));
  // About to be put away: now, rather than after the wait.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && timer) void refresh();
  });
}
