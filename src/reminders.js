// Reminder texts, shared by the calendar file (web) and phone notifications (iOS app).
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
  (w) => `${w}. Small reps, every day, add up.`,
  (w) => `Wherever you are today, ${w} still happens.`,
  (w) => `Get ${w} done early and the day is already a win.`,
  (w) => `${w}. Nobody's coming to do it for you.`,
  (w) => `Motivation is optional. ${w} isn't.`,
  (w) => `The body you want is built on days like this one. ${w}.`,
  (w) => `Quest unlocked: ${w}.`,
  (w) => `${w}. Show up first, feel like it later.`,
  (w) => `One more day in the streak. ${w}.`,
  (w) => `Hotel room, bedroom, park. ${w} works anywhere.`,
  (w) => `Discipline is doing it on the boring days. ${w}.`,
  (w) => `${w}. Earn today's XP.`,
  (w) => `You don't need a perfect day. You need ${w}.`,
  (w) => `Hunters don't skip. ${w}.`,
  (w) => `${w}. Last time's numbers are there to be beaten.`,
  (w) => `Stay the course. ${w} today.`,
];

// Evening check, only sent on days that aren't done yet.
const EVENING = [
  (w) => `Today isn't done yet. ${w} is still on.`,
  (w) => `Streak check: ${w} or a rest day. Pick one before bed.`,
  (w) => `Still time. A short version of ${w} beats a zero.`,
  (w) => `You said you'd lock in. ${w} is waiting.`,
  (w) => `The day's almost over. Get ${w} done and keep the streak.`,
  (w) => `Tired is fine. Skipping isn't. ${w}.`,
  (w) => `One session between you and an unbroken streak: ${w}.`,
  (w) => `Before you sleep: ${w}. Twenty minutes still counts.`,
  (w) => `Your streak is still alive. ${w} keeps it that way.`,
  (w) => `Not done yet. Start the first exercise of ${w} and see where it goes.`,
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
  if (S.planMode() === 'rotation') {
    if (!exact) return 'your next session';
    const w = S.suggestedFor(k);
    return w === 'rest' ? null : S.workouts()[w]?.name || 'your next session';
  }
  const w = S.plannedFor(k);
  return w === 'rest' ? null : S.workouts()[w].name;
}

// Morning line for a date.
export function morningLine(k, name) {
  const n = dayNum(k);
  const ai = S.state.ai.nudges?.messages;
  if (ai?.length) return fix(ai[n % ai.length].replace(/\{quest\}/g, name), name);
  return fix(NUDGES[n % NUDGES.length](name), name);
}

export const eveningLine = (k, name) => fix(EVENING[dayNum(k) % EVENING.length](name), name);
