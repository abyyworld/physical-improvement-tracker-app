// What changed in each version, newest first. Shown once after an update ("What's new").
// Add an entry and bump "version" in package.json when a change is worth telling people about.
// Plain, short sentences: these are read by Players, not developers.

export const CHANGES: { version: string; notes: string[] }[] = [
  {
    version: '1.3.0',
    notes: [
      "Share a goal's progress with a friend. On the Goals tab, tap Share progress on a goal to make a link. It needs an account.",
      'Your friend sees a page with that goal: your streak, its quests and their streaks, its last 28 days, your measures and the milestones you reached. It keeps itself up to date. Never your journal, your chats, your other goals or your weigh-ins.',
      "It's end-to-end encrypted. The key is in the link, so only people with the link can see the page. Not even the people who run Arise can.",
      'Your first name only shows if you turn on Show my name. You can stop sharing, or make a new link, any time.',
    ],
  },
  {
    version: '1.2.0',
    notes: [
      'App lock: Arise can ask for a passcode, or Face ID or Touch ID, when it opens and after time away. It\'s off unless you turn it on, in Settings, App lock. It\'s for this device only.',
      'In the iPhone app the lock uses a passcode. Face ID or Touch ID works in the web app.',
      "In the iPhone app, while the lock is on, the copy of your data is kept inside the app. The Files app doesn't show it.",
      'Forgot the passcode? You can erase Arise on this device and sign in again to get your data back.',
    ],
  },
  {
    version: '1.1.0',
    notes: [
      'Free AI: a free coach for anyone who minds privacy less. Settings, AI coach. Tap Learn more to see what each option can see.',
      'Pick the AI model for the private AI and the free AI.',
      'New accounts can choose Email reset instead of a recovery code, so a forgotten password can be reset by email. It\'s less private; Learn more explains.',
    ],
  },
  {
    version: '1.0.0',
    notes: [
      'Arise 1.0: the first full release, so the version numbers start again here.',
      'Notifications in the web app: a reminder every morning at the time you pick, and an evening check on days that aren\'t done yet. Turn them on in Settings, Reminders, on each device. On iPhone and iPad, open Arise from your Home Screen first.',
      'The private AI coach now works on every phone and computer once you\'re signed in, with nothing to set up.',
      'Deleting your account and making it again with the same email keeps everything on your devices, and asks before adding a device\'s data to it.',
    ],
  },
];
