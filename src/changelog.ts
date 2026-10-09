// What changed in each version, newest first. Shown once after an update ("What's new").
// Add an entry and bump "version" in package.json when a change is worth telling people about.
// Plain, short sentences: these are read by Players, not developers.

export const CHANGES: { version: string; notes: string[] }[] = [
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
