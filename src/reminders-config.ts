// Reminders for the web app come from the small server in worker/reminders (the iPhone app makes
// its own on the phone).
//
// `server` is that Worker's address once it's deployed (see worker/reminders/README.md), like
// https://arise-reminders.<you>.workers.dev. Until then it's empty, and Settings only offers the
// calendar file.

export const REMINDERS = {
  server: '',
};
