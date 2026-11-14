// Search by meaning, on this device: a question's words widened to the words that mean much the
// same in a life log, so "exercise" also finds workouts, runs and the gym, and "food" finds lunch,
// restaurants and coffee. No AI and nothing sent anywhere: a fixed list of related words, kept
// here. Each word is matched as the start of a word in the log (log.ts), so "run" finds
// "running" too.

// Groups of words that go together, each with a short name for the screen.
export const GROUPS: readonly { name: string; words: readonly string[] }[] = [
  { name: 'exercise', words: ['exercis', 'workout', 'work out', 'train', 'gym', 'run', 'jog', 'walk', 'hike', 'step', 'swim', 'cycl', 'bike', 'ride', 'yoga', 'pilates', 'stretch', 'strength', 'lift', 'weights', 'cardio', 'football', 'soccer', 'tennis', 'basketball', 'climb', 'sport', 'fitness', 'pull', 'push', 'squat'] },
  { name: 'sleep', words: ['sleep', 'slept', 'nap', 'bed', 'woke', 'wake', 'tired', 'rest', 'insomnia', 'night'] },
  { name: 'food', words: ['food', 'eat', 'ate', 'meal', 'breakfast', 'lunch', 'dinner', 'brunch', 'snack', 'restaurant', 'cafe', 'coffee', 'pizza', 'sushi', 'burger', 'cook', 'recipe', 'grocer', 'supermarket', 'takeaway', 'delivery', 'kitchen'] },
  { name: 'music', words: ['music', 'song', 'listen', 'album', 'artist', 'playlist', 'spotify', 'concert', 'band', 'podcast', 'radio'] },
  { name: 'watching', words: ['watch', 'film', 'movie', 'cinema', 'series', 'show', 'episode', 'season', 'netflix', 'youtube', 'video', 'tv', 'stream'] },
  { name: 'people', words: ['friend', 'family', 'mum', 'mom', 'mother', 'dad', 'father', 'sister', 'brother', 'partner', 'wife', 'husband', 'girlfriend', 'boyfriend', 'kid', 'son', 'daughter', 'grandma', 'grandpa', 'call', 'phone', 'message', 'text', 'chat', 'whatsapp', 'visit', 'party', 'date'] },
  { name: 'work', words: ['work', 'job', 'office', 'meeting', 'call', 'email', 'project', 'deadline', 'client', 'boss', 'colleague', 'presentation', 'report', 'focus', 'code', 'slack', 'zoom', 'teams'] },
  { name: 'money', words: ['money', 'spend', 'spent', 'pay', 'paid', 'buy', 'bought', 'purchase', 'shop', 'order', 'bill', 'rent', 'bank', 'salary', 'price', 'cost', 'card', 'transfer', 'subscription', 'amazon'] },
  { name: 'travel', words: ['travel', 'trip', 'flight', 'fly', 'flew', 'airport', 'plane', 'train', 'station', 'hotel', 'holiday', 'vacation', 'journey', 'drive', 'drove', 'car', 'taxi', 'uber', 'bus', 'abroad', 'visit'] },
  { name: 'health', words: ['health', 'doctor', 'dentist', 'hospital', 'clinic', 'pharmacy', 'medicine', 'pill', 'sick', 'ill', 'cold', 'flu', 'pain', 'headache', 'heart', 'weight', 'weigh', 'blood', 'therapy', 'checkup'] },
  { name: 'learning', words: ['learn', 'study', 'studied', 'course', 'class', 'lesson', 'lecture', 'exam', 'test', 'homework', 'school', 'university', 'read', 'book', 'duolingo', 'language', 'practice', 'quiz'] },
  { name: 'games', words: ['game', 'play', 'gaming', 'steam', 'playstation', 'psn', 'xbox', 'nintendo', 'switch', 'match', 'level'] },
  { name: 'mood', words: ['mood', 'feel', 'felt', 'happy', 'sad', 'stress', 'anxious', 'anxiety', 'calm', 'angry', 'upset', 'lonely', 'grateful', 'energy', 'motivat', 'overwhelm', 'relax'] },
  { name: 'outdoors', words: ['outdoor', 'outside', 'park', 'beach', 'sea', 'lake', 'mountain', 'forest', 'garden', 'nature', 'sun', 'walk', 'hike'] },
  { name: 'screens', words: ['screen', 'phone', 'app', 'instagram', 'tiktok', 'twitter', 'reddit', 'browse', 'scroll', 'social', 'notification'] },
];

// Past tenses and other forms a light trim can't undo.
const FORMS: Record<string, string> = {
  ran: 'run',
  swam: 'swim',
  ate: 'eat',
  slept: 'sleep',
  bought: 'buy',
  spent: 'spend',
  paid: 'pay',
  flew: 'fly',
  drove: 'drive',
  rode: 'ride',
  met: 'meet',
  felt: 'feel',
  studi: 'study',
  watche: 'watch',
  movi: 'movie',
};

const norm = (w: string) => FORMS[w] || w;

// The groups a word belongs to: one of their words starts it, or it starts one of theirs (four
// letters or more, so "re" doesn't count).
export function groupsOf(word: string): number[] {
  const w = norm(word.toLowerCase());
  const out: number[] = [];
  GROUPS.forEach((g, i) => {
    if (g.words.some((x) => !x.includes(' ') && (w === x || w.startsWith(x) || (w.length >= 4 && x.startsWith(w))))) out.push(i);
  });
  return out;
}

export interface Widened {
  words: string[]; // the question's own words first, then the related ones (one-word ones only)
  related: string[]; // only the related ones
  groups: string[]; // the names of the groups used
}

// A question's words (already trimmed: log.ts queryWords) widened by meaning, up to `max` words.
// A word in several groups widens to all of them, but only the groups of the question's own words.
export function widen(words: readonly string[], max = 24): Widened {
  const own = words.map((w) => norm(w));
  const seen = new Set(own);
  const related: string[] = [];
  const groups: string[] = [];
  for (const w of own) {
    for (const i of groupsOf(w)) {
      if (!groups.includes(GROUPS[i].name)) groups.push(GROUPS[i].name);
      for (const x of GROUPS[i].words) {
        if (x.includes(' ') || seen.has(x)) continue;
        seen.add(x);
        related.push(x);
      }
    }
  }
  const room = Math.max(0, max - own.length);
  return { words: [...own, ...related.slice(0, room)], related: related.slice(0, room), groups };
}
