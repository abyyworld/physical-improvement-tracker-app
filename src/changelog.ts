// What changed in each version, newest first. Shown once after an update ("What's new").
// Add an entry and bump "version" in package.json when a change is worth telling people about.
// Plain, short sentences: these are read by Players, not developers.

export const CHANGES: { version: string; notes: string[] }[] = [
  {
    version: '1.8.0',
    notes: [
      'There is now an Android app (optional; the web app still works everywhere). It updates itself like the iPhone app.',
      'On Android, Arise can note the notifications from your apps, your calls including missed ones, how long you use each app, Health Connect and your calendar. Each one is off until you turn it on, in Settings, Your life, Android.',
    ],
  },
  {
    version: '1.7.0',
    notes: [
      'A browser extension for Chrome, Edge, Brave and Firefox notes the sites you visit, your searches and your time on each site, including the last 90 days. It locks everything for Arise and can never read it back. Settings, Your life, Browser.',
      'A Mac helper: missed and answered calls (from your iPhone too), the notifications your Mac shows, Messages, Safari and the apps you use. Install it with one Terminal command from Settings, Your life, Mac. Everything is off until you turn it on.',
    ],
  },
  {
    version: '1.6.0',
    notes: [
      'The iPhone app can now fill in your days by itself: Apple Health (with your watch), walks, runs and drives, your calendar, and the places you go. Each one is off until you turn it on, in Settings, Your life.',
      'Log to Arise for Shortcuts: automations like "when I open an app", "when I arrive home" or "when a message comes in" can note things down without opening Arise. Settings, Your life, iPhone automations.',
      'This needs the new iPhone app once: install the latest Arise.ipa the same way as before. Your data stays.',
    ],
  },
  {
    version: '1.5.0',
    notes: [
      'A new look: calm, light or dark, in plain words. Prefer the Solo Leveling look? Settings, Look, System.',
      'Days: a timeline of each day, and a search that answers "What did I do…?" (last Tuesday, in March, this morning).',
      'Arise now learns you: it sums up each day, notices routines and what matters to you, and your coach uses it. See, edit or delete all of it in What Arise knows.',
      'A Yesterday card on Today, and Add to your day for a quick note and your mood.',
      'Bring in your history: Google searches, YouTube, Chrome and Maps, Spotify, Netflix, Apple Health, WhatsApp chats and bank statements. Settings, Your history. Files are read on your device and never uploaded.',
      'In the iPhone app, link Steam and PlayStation to see what you played and for how long. Settings, Your life, Accounts.',
      'Only the private AI and the AI on your device read your life log, unless you say otherwise.',
    ],
  },
  {
    version: '1.4.0',
    notes: [
      'Link as many free AI keys as you like: Gemini, Groq, OpenRouter, Cerebras, Mistral, GitHub Models and more. Settings, AI coach, Your AI keys.',
      'When one hits its limit, the next one answers straight away. The first one rests until its limit starts again, and Settings shows when.',
      "Each service shows how to get a free key, its limits, and what it does with what you send. They're less private: those companies can read it.",
    ],
  },
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
