# Arise: Physical Improvement Tracker

A home-workout tracker built to help you lock in every day, wherever you are. It works on a phone, tablet or laptop and can be saved to the home screen like an app.

Every day the app gives you a **daily quest** (that day's workout). You tick off sets one at a time, the rest timer starts on its own, and you earn XP, levels and ranks (E → S) as you stay consistent.

## What's inside

- **Today**: the day's quest, a football toggle (on leg days it swaps in the next session), a daily log, your status window (level, rank, STR / AGI / VIT, streak), this week at a glance, and a quote for the day.
- **Focus-mode workouts**: one exercise and one big button at a time. Your reps from last time are filled in already. The rest timer beeps (and vibrates on Android). A built-in countdown handles timed holds. The screen stays awake while you train.
- **How-to for every exercise**: a YouTube tutorial you can play inside the app, extra videos, start and finish photos where available, and how to make the exercise harder.
- **Progression**: when you hit the top of the rep range on every set, the app tells you to make that exercise harder next time.
- **Progress**: streaks, weekly count, a 4-week consistency score, a 16-week calendar, a chart for each exercise, and your full history.
- **Easy weeks**: every 6–8 weeks the app suggests a week with half the sets.
- **Reminders**: adds one calendar event per training day for the next 6 months, each with a different message, so your phone notifies you without needing a server.
- **Backup**: save or load a backup file. Loading a backup merges it with what's already there, so you can combine your phone and tablet logs.
- **Works offline** once it has been opened. Videos still need internet.

## The plan

| Day | Session |
|---|---|
| Mon, Fri | Back & width (the V-taper day) |
| Tue | Legs, heavy |
| Wed, Sun | Push & shoulders |
| Thu | Rest |
| Sat | Legs & core |

The full exercise list and the rules are on the **Plan** tab. To change the plan, edit `js/program.js`.

## Put it online (GitHub Pages)

1. On GitHub, open the repository and go to **Settings → Pages**.
2. Under **Build and deployment**, set **Source** to **Deploy from a branch**.
3. Pick the branch that has the app on it (for example `main`) and the **/ (root)** folder, then click **Save**.
4. After a minute the app is live at `https://abyyworld.github.io/physical-improvement-tracker-app/`.

## Add it to your home screen

- **iPhone / iPad**: open the link in **Safari**, tap **Share**, then **Add to Home Screen**.
- **Android**: open the link in **Chrome**, tap **⋮**, then **Install app** (or **Add to Home screen**).

Your log is stored **on the device, inside whichever app you opened it in**. On iPhone, the home-screen app and Safari keep separate logs, so pick the home-screen app and stick with it. Use **Settings → Backup** to move data between devices.

## Run it locally

It's a static site with no build step:

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

## Files

```
index.html            page shell
css/app.css           styles
js/program.js         workouts, exercises, video + photo sources, quotes
js/store.js           saved data, streaks, XP, progress maths
js/app.js             screens and interactions
sw.js                 offline support
manifest.webmanifest  home-screen app settings
icons/, fonts/        app icon and self-hosted fonts
```

## Credits

- **Videos**: YouTube tutorials by their creators. Each exercise's how-to screen shows the video title and links to it. Every video was taken from real search results; exercises without a good match don't show one.
- **Photos**: [Free Exercise DB](https://github.com/yuhonas/free-exercise-db) (public domain).
- **Fonts**: Bebas Neue, Rajdhani and Cormorant Garamond, under the SIL Open Font License.
