// What changed in each version, newest first. Shown once after an update ("What's new").
// Add an entry and bump "version" in package.json when a change is worth telling people about.
// Plain, short sentences: these are read by Players, not developers.

export const CHANGES: { version: string; notes: string[] }[] = [
  {
    version: '2.3.0',
    notes: [
      'Notifications in the web app: a reminder every morning at the time you pick, and an evening check on days that aren\'t done yet. Turn them on in Settings, Reminders, on each device you want them on. On iPhone and iPad, open Arise from your Home Screen first.',
      'They stay private: the server that sends them never knows what they say. The words stay on your device.',
    ],
  },
  {
    version: '2.2.0',
    notes: [
      'A weekly day off: the first day you miss each week no longer breaks your streak (you can turn this off in Settings). Falling one short of a weekly target counts as one missed day.',
      'A quest done a few times a week now starts counting from its first full week, so adding one late in a week no longer breaks your streak.',
    ],
  },
  {
    version: '2.1.0',
    notes: [
      'New in Settings: App updates. See which version you have, check for a new one and update straight away.',
      'The iPhone app (Arise.ipa) now updates itself too, like the web app. After this version, new ones arrive without reinstalling.',
    ],
  },
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
