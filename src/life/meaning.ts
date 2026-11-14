// Search by meaning, on this device: a question's words widened to the words that mean much the
// same in a life log, so "exercise" also finds workouts, runs and the gym, and "food" finds lunch,
// restaurants and coffee. No AI and nothing sent anywhere: a fixed list of related words, kept
// here. Each word is matched as the start of a word in the log (log.ts), so "run" finds
// "running" too.

// Groups of words that go together, each with a short name for the screen. A word matches itself
// and its plain forms (run, runs, running); one ending in * matches any word it starts (exercis*:
// exercise, exercising). Short words are whole words only, so "car" never finds "career".
export const GROUPS: readonly { name: string; words: readonly string[] }[] = [
  { name: 'exercise', words: ['exercis*', 'workout', 'train', 'gym', 'run', 'jog', 'walk', 'hike', 'hiking', 'steps', 'swim', 'cycl*', 'bike', 'yoga', 'pilates', 'stretch', 'strength', 'weights', 'cardio', 'football', 'soccer', 'tennis', 'basketball', 'climb', 'sport', 'fitness', 'squat', 'pushup*'] },
  { name: 'sleep', words: ['sleep', 'slept', 'nap', 'bed', 'bedtime', 'woke', 'wake', 'tired', 'insomnia'] },
  { name: 'food', words: ['food', 'eat', 'meal', 'breakfast', 'lunch', 'dinner', 'brunch', 'snack', 'restaurant*', 'cafe', 'coffee', 'pizza', 'sushi', 'burger', 'cook', 'recipe*', 'grocer*', 'supermarket', 'takeaway', 'kitchen'] },
  { name: 'music', words: ['music', 'song', 'listen*', 'album', 'artist', 'playlist*', 'spotify', 'concert', 'podcast*', 'radio'] },
  { name: 'watching', words: ['watch', 'film', 'movie', 'cinema', 'series', 'episode', 'netflix', 'youtube', 'video', 'tv'] },
  { name: 'people', words: ['friend', 'family', 'mum', 'mom', 'mother', 'dad', 'father', 'sister', 'brother', 'partner', 'wife', 'husband', 'girlfriend', 'boyfriend', 'kids', 'son', 'daughter', 'grandma', 'grandpa', 'call', 'message', 'chat', 'whatsapp', 'party'] },
  { name: 'work', words: ['work', 'job', 'office', 'meeting', 'email', 'project', 'deadline', 'client', 'boss', 'colleague*', 'presentation', 'report', 'slack', 'zoom'] },
  { name: 'money', words: ['money', 'spend', 'spent', 'pay', 'paid', 'buy', 'bought', 'purchase', 'shop*', 'bill', 'rent', 'bank', 'salary', 'price', 'cost', 'subscription*', 'amazon'] },
  { name: 'travel', words: ['travel*', 'trip', 'flight', 'fly', 'flew', 'airport', 'plane', 'station', 'hotel', 'holiday', 'vacation', 'journey', 'drive', 'drove', 'taxi', 'uber', 'abroad'] },
  { name: 'health', words: ['health*', 'doctor', 'dentist', 'hospital', 'clinic', 'pharmacy', 'medicine', 'pill', 'sick', 'flu', 'headache', 'weight', 'weigh', 'therapy', 'checkup'] },
  { name: 'learning', words: ['learn*', 'study', 'studied', 'course', 'class', 'lesson', 'lecture', 'exam', 'homework', 'school', 'university', 'read', 'book', 'duolingo', 'language', 'practice', 'quiz'] },
  { name: 'games', words: ['game', 'gaming', 'steam', 'playstation', 'psn', 'xbox', 'nintendo'] },
  { name: 'mood', words: ['mood', 'feel', 'happy', 'sad', 'stress*', 'anxious', 'anxiety', 'calm', 'angry', 'upset', 'lonely', 'grateful', 'energy', 'motivat*', 'overwhelm*', 'relax*'] },
  { name: 'outdoors', words: ['outdoor*', 'outside', 'park', 'beach', 'lake', 'mountain', 'forest', 'garden', 'nature', 'hike'] },
  { name: 'screens', words: ['screen', 'instagram', 'tiktok', 'twitter', 'reddit', 'browse*', 'scroll*', 'social'] },
];

// Past tenses and other forms the trim in log.ts queryWords can't undo.
const FORMS: Record<string, string> = {
  ran: 'run',
  swam: 'swim',
  ate: 'eat',
  bought: 'buy',
  spent: 'spend',
  paid: 'pay',
  flew: 'fly',
  drove: 'drive',
  felt: 'feel',
  studi: 'study',
  watche: 'watch',
  movi: 'movie',
  hik: 'hike',
};

const norm = (w: string) => FORMS[w] || w;
// What a trimmed question word may have come from: "runn" (running) is "run".
const forms = (w: string) => {
  const out = [w];
  if (w.length > 3 && w.at(-1) === w.at(-2)) out.push(w.slice(0, -1));
  if (w.length > 3 && w.endsWith('e')) out.push(w.slice(0, -1));
  return out;
};

// Whether a group word (x, maybe with *) is the question word w.
function same(x: string, w: string) {
  if (x.endsWith('*')) return w.startsWith(x.slice(0, -1));
  return forms(w).includes(x) || forms(w).includes(`${x.replace(/e$/, '')}`);
}

// The groups a question word belongs to.
export function groupsOf(word: string): number[] {
  const w = norm(word.toLowerCase());
  const out: number[] = [];
  GROUPS.forEach((g, i) => {
    if (g.words.some((x) => same(x, w))) out.push(i);
  });
  return out;
}

export interface Widened {
  words: string[]; // the question's own words (as prefixes, with *) first, then the related ones
  related: string[]; // only the related ones
  groups: string[]; // the names of the groups used
}

// A question's words (already trimmed: log.ts queryWords) widened by meaning, up to `max` words.
// A word in several groups widens to all of them, but only the groups of the question's own words.
export function widen(words: readonly string[], max = 24): Widened {
  const own = words.map((w) => `${norm(w)}*`);
  const seen = new Set(own);
  const related: string[] = [];
  const groups: string[] = [];
  for (const w of words) {
    for (const i of groupsOf(w)) {
      if (!groups.includes(GROUPS[i].name)) groups.push(GROUPS[i].name);
      for (const x of GROUPS[i].words) {
        if (seen.has(x) || seen.has(`${x}*`)) continue;
        seen.add(x);
        related.push(x);
      }
    }
  }
  const room = Math.max(0, max - own.length);
  return { words: [...own, ...related.slice(0, room)], related: related.slice(0, room), groups };
}
