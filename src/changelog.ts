// What changed in each version, newest first. Shown once after an update ("What's new").
// Add an entry and bump "version" in package.json when a change is worth telling people about.
// Plain, short sentences: these are read by Players, not developers.

export const CHANGES: { version: string; notes: string[] }[] = [
  {
    version: '2.0.0',
    notes: [
      'Goals for any part of life: fitness, learning, money, career, health, your mind, habits. Each one gets daily quests to tick off, plus measures and milestones if you like.',
      'Your workouts are now a Fitness goal, with all your history. Everything works as before.',
      'Your synced data is now end-to-end encrypted. Only your devices can read it. You can also make an account without an email.',
      'The AI coach is private by default: it runs in a sealed, verified enclave or on your own computer. Your own Claude, ChatGPT or Gemini key still works if you choose it.',
      'Arise now updates itself. New versions download in the background and switch over when you leave the app, never in the middle of a workout.',
    ],
  },
];
