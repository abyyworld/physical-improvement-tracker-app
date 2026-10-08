// What changed in each version, newest first. Shown once after an update ("What's new").
// Add an entry and bump "version" in package.json when a change is worth telling people about.
// Plain, short sentences: these are read by Players, not developers.

export const CHANGES: { version: string; notes: string[] }[] = [
  {
    version: '2.0.0',
    notes: [
      'Arise now updates itself. New versions download in the background and switch over when you leave the app, never in the middle of a workout.',
      'Your synced data is now end-to-end encrypted. Only your devices can read it.',
      'Safer backups: a backup file can no longer change how the app works.',
    ],
  },
];
