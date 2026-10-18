// The words that change with the look (src/look.ts). The Arise look talks plainly: the coach is
// "your coach" and the person is "you" or their name. The System look keeps the Solo Leveling
// words: the System, the Player, quests and hunters.
//
// w('coach') gives the word for the look in use. Each entry is [Arise look, System look].

import { currentLook } from './look';

export const isSystem = () => currentLook() === 'system';

const WORDS = {
  // The AI coach, mid-sentence and at the start of one.
  coach: ['your coach', 'the System'],
  Coach: ['Your coach', 'The System'],
  // Its own screen and its tab.
  coachTitle: ['Coach', 'The System'],
  coachTab: ['Coach', 'System'],
  // The line above something the coach wrote.
  coachTag: ['Your coach', '[System]'],
  dailyMessage: ['From your coach', '[System message]'],
  brandSub: ['Your whole life, written down', 'Level up in every part of life'],
  // The person, on their own panel in Settings.
  player: ['You', 'Player'],
  nameLabel: ['Your name', 'Name on your status window'],
  namePlaceholder: ['Your name', 'Hunter'],
  status: ['Your progress', 'Status'],
  // The day's workout from the plan.
  dailyQuest: ["Today's workout", 'Daily quest'],
  objectives: ['Exercises', 'Goals'],
  startQuest: ['Start workout', 'Start quest'],
  resumeQuest: ['Resume workout', 'Resume quest'],
  inProgress: ['Workout in progress', 'Quest in progress'],
  questCleared: ['Workout done', 'Quest cleared'],
  questComplete: ['Workout done', 'Quest complete'],
  nextQuest: ['Next up', 'Next quest'],
  questLog: ['Exercises', 'Quest log'],
  complete: ['Finish workout', 'Complete quest'],
  abandon: ['End without saving', 'Abandon quest'],
  history: ['Workouts', 'Quest history'],
  historyEmpty: ['Nothing yet. Your workouts will show up here.', 'Nothing yet. Your cleared quests will show up here.'],
  allCleared: ['All done for today. See you tomorrow.', '[All quests cleared] Come back tomorrow.'],
  // The whole person: the daily check-in, the life check-in, the Me tab and what it noticed.
  checkin: ['How are you today?', 'Daily check-in'],
  lifeTitle: ['Your life', 'Life status'],
  youTab: ['Me', 'Progress'],
  youKicker: ['Everything about you', 'Consistency + improvement'],
  youTitle: ['Me', 'Progress'],
  noticed: ['What Arise noticed', '[System analysis]'],
  // Under the quest bar on the Coach tab while something is still open.
  questBarSub: ["Still open today. Whenever you're ready.", 'Not done yet. Doing beats talking.'],
} as const satisfies Record<string, readonly [string, string]>;

export type Word = keyof typeof WORDS;
export const w = (k: Word): string => WORDS[k][isSystem() ? 1 : 0];
