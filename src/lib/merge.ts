// Combining two copies of the Player's data when both devices changed something since they last
// synced. Nothing either device added is lost, and nothing either device deleted comes back.
//
// Lists (workouts, football days, rest days, easy weeks, weigh-ins) carry change stamps
// (state.stamps: collection -> key -> time, positive for "added", negative for "removed"). For
// each item the latest stamp from either copy wins. Items from before stamps existed have none and
// are kept if either copy has them.
//
// Single values (settings, profile, the custom plan) come from whichever copy changed last, with
// finer stamps where there are any: the profile's own `updated` time, and the plan's stamp.

import type { BodyEntry, Session, Stamps, State } from './validate';
import type { Checks, Goal, Values } from './goals';

export type CloudCopy = Omit<State, 'active' | 'updatedAt'>;

const KEEP_STAMPS_FOR = 400 * 86400 * 1000;

// ---------- when the workout plan was on (stamps.planDays, see store.ts)

type Notes = Record<string, number>;
const pad = (n: number) => String(n).padStart(2, '0');
const dateKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayBefore = (k: string) => {
  const d = new Date(`${k}T12:00`);
  d.setDate(d.getDate() - 1);
  return dateKey(d);
};
// The plan's state on day k by these notes; `now` is the state when there are none.
function planOnDay(notes: Notes, now: boolean, k: string) {
  const days = Object.keys(notes).sort();
  if (!days.length) return now;
  let on = notes[days[0]] > 0;
  for (const d of days) {
    if (d > k) break;
    on = notes[d] > 0;
  }
  return on;
}
export const planOn = (c: Pick<CloudCopy, 'goals'>) => c.goals.some((g) => g.workouts && g.status === 'active');
export const neverPlanned = (c: Pick<CloudCopy, 'goals' | 'stamps'>) => !Object.keys(c.stamps.planDays || {}).length && !c.goals.some((g) => g.workouts);

// The first day a copy has anything on record.
export function firstDayOf(c: CloudCopy): string | null {
  const days = [...c.sessions.map((s) => s.date), ...c.football, ...c.rests, ...Object.keys(c.checks), ...Object.keys(c.logs), ...c.body.entries.map((e) => e.date), ...c.goals.flatMap((g) => g.quests.map((q) => q.created))];
  return days.length ? days.reduce((a, b) => (b < a ? b : a)) : null;
}

// One record of when the plan was on, from two that each know their own days: `before` for the
// days before `from`, `after` from `from` on. Each is its notes plus its plan's state now (which
// applies all along when it has no notes). Made-up notes get the smallest time, so a real switch
// of the same day from elsewhere wins over them.
export function splicePlanDays(before: Notes, beforeOn: boolean, after: Notes, afterOn: boolean, from: string): Notes {
  if (!Object.keys(before).length && !Object.keys(after).length && beforeOn === afterOn) return {};
  const out: Notes = {};
  for (const [d, t] of Object.entries(before)) if (d < from) out[d] = t;
  const edge = dayBefore(from);
  if (!(edge in out)) out[edge] = planOnDay(before, beforeOn, edge) ? 1 : -1;
  for (const [d, t] of Object.entries(after)) if (d >= from) out[d] = t;
  if (!(from in out)) out[from] = planOnDay(after, afterOn, from) ? 1 : -1;
  return out;
}

function mergeStamps(a: Stamps, b: Stamps, now: number): Stamps {
  const out: Stamps = {};
  for (const c of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const m: Record<string, number> = {};
    for (const src of [a[c] || {}, b[c] || {}]) {
      for (const [k, v] of Object.entries(src)) if (!m[k] || Math.abs(v) > Math.abs(m[k])) m[k] = v;
    }
    // Old stamps are dropped together on every device, so an old delete never outlives the add after it.
    // When the workout plan was on is history the streak keeps reading, so those stay.
    if (c !== 'planDays') for (const [k, v] of Object.entries(m)) if (now - Math.abs(v) > KEEP_STAMPS_FOR) delete m[k];
    out[c] = m;
  }
  return out;
}

// Is this key present after the merge? `inA`/`inB`: does each copy have it.
function present(stamps: Stamps, c: string, k: string, inA: boolean, inB: boolean) {
  const s = stamps[c]?.[k];
  if (s == null) return inA || inB;
  return s > 0 && (inA || inB);
}

const dateSet = (c: 'football' | 'rests' | 'easyWeeks', a: CloudCopy, b: CloudCopy, st: Stamps) =>
  [...new Set([...a[c], ...b[c]])].filter((k) => present(st, c, k, a[c].includes(k), b[c].includes(k))).sort();

const bySessionTime = (x: Session, y: Session) => (x.date === y.date ? x.started - y.started : x.date < y.date ? -1 : 1);

// Weigh-ins on the same day from two devices: each number comes from whichever entry has it,
// preferring the later entry when both do.
function mergeEntry(x: BodyEntry | undefined, y: BodyEntry | undefined): BodyEntry {
  if (!x) return y!;
  if (!y) return x;
  const [late, early] = (x.at || 0) >= (y.at || 0) ? [x, y] : [y, x];
  return {
    date: late.date,
    weight: late.weight ?? early.weight,
    waist: late.waist ?? early.waist,
    shoulders: late.shoulders ?? early.shoulders,
    ...(late.at || early.at ? { at: Math.max(late.at || 0, early.at || 0) } : {}),
  };
}

// Goals: the copy edited last wins for each goal (or the cloud's, with `cloudWins`); a goal
// deleted on either device stays deleted. Only one goal uses the workout plan: if each device had
// its own, the cloud's (with `cloudWins`) or the one edited last keeps it.
function mergeGoals(local: Goal[], remote: Goal[], stamps: Stamps, cloudWins: boolean, now: number): Goal[] {
  const byId = new Map<string, Goal>();
  for (const g of [...local, ...remote]) {
    const have = byId.get(g.id);
    if (!have || g.updated > have.updated || (cloudWins && remote.includes(g))) byId.set(g.id, g);
  }
  // A goal's share link stays, whichever copy wins: only a newer link (made later) replaces it.
  // So a link made on one device is never lost to an edit on another, and its page never left
  // without a way to turn it off. One turned off elsewhere comes back here, but only until its
  // page is found gone (share.ts).
  for (const [id, g] of byId) {
    const newest = [local.find((x) => x.id === id)?.share, remote.find((x) => x.id === id)?.share].reduce((a, b) => (b && (!a || b.at > a.at) ? b : a), undefined);
    if (newest && newest.id !== g.share?.id) byId.set(id, { ...g, share: newest });
  }
  const localIds = new Set(local.map((g) => g.id));
  const remoteIds = new Set(remote.map((g) => g.id));
  const order = [...local.map((g) => g.id), ...remote.map((g) => g.id).filter((id) => !localIds.has(id))];
  const goals = order.map((id) => byId.get(id)!).filter((g) => present(stamps, 'goals', g.id, localIds.has(g.id), remoteIds.has(g.id)));
  const plans = goals.filter((g) => g.workouts);
  if (plans.length < 2) return goals;
  const keep = (cloudWins && plans.find((g) => remoteIds.has(g.id))) || plans.reduce((a, b) => (b.updated > a.updated ? b : a));
  return goals.map((g) => {
    if (!g.workouts || g === keep) return g;
    const { workouts: _w, ...rest } = g;
    return { ...rest, updated: now };
  });
}

// Each tick on its own: the later one wins, so unticking on one device carries over too.
function mergeChecks(a: Checks, b: Checks): Checks {
  const out: Checks = structuredClone(a);
  for (const [k, day] of Object.entries(b)) {
    const d = (out[k] ||= {});
    for (const [qid, c] of Object.entries(day)) if (!d[qid] || c.at > d[qid].at) d[qid] = c;
  }
  return out;
}

function mergeValues(a: Values, b: Values): Values {
  const out: Values = structuredClone(a);
  for (const [mid, days] of Object.entries(b)) {
    const m = (out[mid] ||= {});
    for (const [k, v] of Object.entries(days)) if (!m[k] || v.at > m[k].at) m[k] = v;
  }
  return out;
}

type AI = CloudCopy['ai'];

// Coach chat: every message from both, minus anything from before the last "clear" (the later of
// the two, in the stamps already merged).
export function mergeChat(older: AI['chat'], newer: AI['chat'], stamps: Stamps): AI['chat'] {
  const cleared = Math.max(0, stamps.chat?.cleared || 0);
  const seen = new Set<string>();
  return [...older, ...newer]
    .filter((m) => m.at > cleared)
    .filter((m) => {
      const key = `${m.at}|${m.role}|${m.text.length}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.at - b.at)
    .slice(-200);
}

// The System's message of each day: the later one (the newer copy's when they're as old).
export function mergeDaily(older: AI['daily'], newer: AI['daily']): AI['daily'] {
  const daily = { ...older };
  for (const [k, d] of Object.entries(newer)) if (!daily[k] || d.at >= daily[k].at) daily[k] = d;
  return daily;
}

// `cloudWins`: the remote copy wins every single value and same-id goal, whatever the times (a
// device's first sign-in to an account that already has data).
export function merge(local: CloudCopy, localAt: number, remote: CloudCopy, remoteAt: number, now = Date.now(), { cloudWins = false } = {}): CloudCopy {
  const [newer, older] = !cloudWins && localAt >= remoteAt ? [local, remote] : [remote, local];
  const stamps = mergeStamps(local.stamps, remote.stamps, now);
  // When the workout plan was on: the account's record for the days it has, this device's own for
  // the days before those.
  // An account that never had the plan (no notes, no plan goal) says nothing about it.
  if (cloudWins && neverPlanned(remote)) stamps.planDays = { ...(local.stamps.planDays || {}) };
  else if (cloudWins) stamps.planDays = splicePlanDays(local.stamps.planDays || {}, planOn(local), remote.stamps.planDays || {}, planOn(remote), firstDayOf(remote) || dateKey(new Date(now)));

  const sessions = new Map<string, Session>();
  for (const s of [...older.sessions, ...newer.sessions]) sessions.set(s.id, s);
  const localIds = new Set(local.sessions.map((s) => s.id));
  const remoteIds = new Set(remote.sessions.map((s) => s.id));

  const entries = new Map<string, BodyEntry>();
  for (const e of [...local.body.entries, ...remote.body.entries]) entries.set(e.date, mergeEntry(entries.get(e.date), e));
  const localDates = new Set(local.body.entries.map((e) => e.date));
  const remoteDates = new Set(remote.body.entries.map((e) => e.date));

  const logs = { ...older.logs };
  for (const [k, l] of Object.entries(newer.logs)) if (!logs[k] || (l.at || 0) >= (logs[k].at || 0)) logs[k] = l;

  // The custom plan: the latest "applied" or "reset" stamp decides. Without one, keep a plan over none.
  const planStamp = stamps.plan?.custom;
  let customPlan = newer.customPlan || older.customPlan;
  if (planStamp != null && planStamp < 0) customPlan = null;
  else if (planStamp != null) {
    const fromLocal = local.stamps.plan?.custom === planStamp;
    customPlan = (fromLocal ? local.customPlan : remote.customPlan) || customPlan;
  }

  const localP = Number(local.profile?.updated) || 0;
  const remoteP = Number(remote.profile?.updated) || 0;
  const profile = !cloudWins && localP >= remoteP ? (local.profile ?? remote.profile) : (remote.profile ?? local.profile);

  const chat = mergeChat(older.ai.chat, newer.ai.chat, stamps);
  const daily = mergeDaily(older.ai.daily, newer.ai.daily);

  // An account that never had the workout plan has only the default plan settings: a device's
  // own plan keeps its template and sessions a week.
  const settings = cloudWins && neverPlanned(remote) && !neverPlanned(local) ? { ...newer.settings, template: local.settings.template, perWeek: local.settings.perWeek } : newer.settings;

  return {
    ...newer,
    settings,
    stamps,
    sessions: [...sessions.values()].filter((s) => present(stamps, 'sessions', s.id, localIds.has(s.id), remoteIds.has(s.id))).sort(bySessionTime),
    football: dateSet('football', local, remote, stamps),
    rests: dateSet('rests', local, remote, stamps),
    easyWeeks: dateSet('easyWeeks', local, remote, stamps),
    logs,
    body: {
      ...newer.body,
      entries: [...entries.values()].filter((e) => present(stamps, 'body', e.date, localDates.has(e.date), remoteDates.has(e.date))).sort((a, b) => (a.date < b.date ? -1 : 1)),
    },
    profile: profile || null,
    customPlan,
    ai: { ...newer.ai, chat, daily },
    goals: mergeGoals(local.goals, remote.goals, stamps, cloudWins, now),
    checks: mergeChecks(local.checks, remote.checks),
    values: mergeValues(local.values, remote.values),
  };
}
