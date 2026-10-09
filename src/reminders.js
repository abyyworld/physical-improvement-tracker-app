// Reminder texts, shared by the calendar file (web), the web app's notifications
// (web-reminders.ts) and the iPhone app's (native.js).
// The text for a date depends only on the date, so rescheduling never repeats yesterday's line.

import * as S from './store';
import { QUOTES } from './program.js';

const NUDGES = [
  (w) => `[Daily Quest: ${w}] has arrived.`,
  (w) => `Arise. ${w} is waiting.`,
  (w) => `${w} today. Lock in.`,
  (w) => `The System has assigned: ${w}.`,
  (w) => `No excuses today: ${w}.`,
  (w) => `${w}. Your future self is watching.`,
  (w) => `Daily Quest: ${w}. Keep the streak alive.`,
  (w) => `Level up today: ${w}.`,
  Object.assign((w) => `${w}. Small reps, every day, add up.`, { gym: true }),
  (w) => `Wherever you are today, ${w} still happens.`,
  (w) => `Get ${w} done early and the day is already a win.`,
  (w) => `${w}. Nobody's coming to do it for you.`,
  (w) => `Motivation is optional. ${w} isn't.`,
  Object.assign((w) => `The body you want is built on days like this one. ${w}.`, { gym: true }),
  (w) => `Quest unlocked: ${w}.`,
  (w) => `${w}. Show up first, feel like it later.`,
  (w) => `One more day in the streak. ${w}.`,
  Object.assign((w) => `Hotel room, bedroom, park. ${w} works anywhere.`, { gym: true }),
  (w) => `Discipline is doing it on the boring days. ${w}.`,
  (w) => `${w}. Earn today's XP.`,
  (w) => `You don't need a perfect day. You need ${w}.`,
  (w) => `Hunters don't skip. ${w}.`,
  Object.assign((w) => `${w}. Last time's numbers are there to be beaten.`, { gym: true }),
  (w) => `Stay the course. ${w} today.`,
];

// Evening check, only sent on days that aren't done yet.
const EVENING = [
  (w) => `Today isn't done yet. ${w} is still on.`,
  Object.assign((w) => `Streak check: ${w} or a rest day. Pick one before bed.`, { gym: true }),
  (w) => `Still time. A short version of ${w} beats a zero.`,
  (w) => `You said you'd lock in. ${w} is waiting.`,
  (w) => `The day's almost over. Get ${w} done and keep the streak.`,
  (w) => `Tired is fine. Skipping isn't. ${w}.`,
  Object.assign((w) => `One session between you and an unbroken streak: ${w}.`, { gym: true }),
  Object.assign((w) => `Before you sleep: ${w}. Twenty minutes still counts.`, { gym: true }),
  (w) => `Your streak is still alive. ${w} keeps it that way.`,
  Object.assign((w) => `Not done yet. Start the first exercise of ${w} and see where it goes.`, { gym: true }),
  (w) => `Future you is asking about ${w}.`,
  (w) => `The day isn't over. ${w}, then rest.`,
];

const EPOCH = '2024-01-01';
const dayNum = (k) => Math.max(0, S.daysBetween(EPOCH, k));
// "your next session" needs a capital letter when it starts a sentence.
const fix = (t, name) => (/^[a-z]/.test(name) ? t.replace(/(^|[.!?]\s+)([a-z])/g, (m, a, b) => a + b.toUpperCase()) : t);

export function quoteFor(k) {
  const q = QUOTES[dayNum(k) % QUOTES.length];
  return `${q.text}${q.by ? ` (${q.by})` : ''}`;
}

// What to call the day's session. A rotation plan can't know future sessions yet (it depends on
// what gets done before then), so only `exact` days use the real name.
export function questName(k, exact) {
  // Without the workout plan, or once that day's training is done: what's left of the quests.
  if (!S.workoutsOn() || S.sessionsOn(k).length || S.isFootball(k)) return openQuests(k);
  let w;
  if (S.planMode() === 'rotation') {
    if (!exact) return 'your next session';
    w = S.suggestedFor(k);
  } else w = S.plannedFor(k);
  return w === 'rest' ? openQuests(k) : S.workouts()[w]?.name || 'your next session';
}

// The quest still open that day by name, or "your daily quest" for several. Nothing to remind
// about when none are.
function openQuests(k) {
  const open = S.questsFor(k).filter((x) => !x.done);
  if (!open.length) return null;
  return open.length === 1 ? open[0].quest.title : 'your daily quest';
}

// Lines marked `gym` only fit a workout; quests from other goals skip them.
const isWorkout = (name) => name === 'your next session' || Object.values(S.workouts()).some((w) => w.name === name);
const linesFor = (list, name) => (isWorkout(name) ? list : list.filter((l) => !l.gym));

// Morning line for a date.
export function morningLine(k, name) {
  const n = dayNum(k);
  const ai = S.state.ai.nudges?.messages;
  if (ai?.length) return fix(ai[n % ai.length].replace(/\{quest\}/g, name), name);
  const list = linesFor(NUDGES, name);
  return fix(list[n % list.length](name), name);
}

export function eveningLine(k, name) {
  const list = linesFor(EVENING, name);
  return fix(list[dayNum(k) % list.length](name), name);
}

const EVENING_BODY = "Log it in the app when you're done.";
const EVENING_BODY_REST = "Log it in the app when you're done, or take a rest day if you have one left.";

// The reminders for each of the next `n` days from today: the morning line (with the day's
// quote) and the evening check. Both are null on a day with nothing to remind about: done, or
// nothing due. Done days, rest days and football days stay quiet.
export function days(n, today = S.todayKey()) {
  // Rest days only come with the workout plan.
  const rest = S.workoutsOn() && S.planMode() === 'rotation' && S.restAllowance() > 0;
  const out = [];
  // On a rotation, the real session name is only known for the first day that isn't done yet.
  let open = false;
  for (let i = 0; i < n; i++) {
    const k = S.addDays(today, i);
    const done = S.covered(k);
    // A covered day gets nothing, unless a weekly quest still needs doing that week.
    if (done && !S.questsFor(k).some((x) => !x.done && x.quest.schedule.kind === 'weekly')) {
      out.push({ date: k, done, morning: null, evening: null });
      continue;
    }
    const name = questName(k, !open);
    // Only a day that still owes training uses up the exact session name.
    if (!S.trainingCovered(k)) open = true;
    out.push({
      date: k,
      done,
      morning: name ? { title: morningLine(k, name), body: quoteFor(k) } : null,
      evening: name ? { title: eveningLine(k, name), body: rest ? EVENING_BODY_REST : EVENING_BODY } : null,
    });
  }
  return out;
}
