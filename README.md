# Arise: Physical Improvement Tracker

A home-workout tracker built to help you lock in every day, wherever you are. It works on a phone, tablet or laptop and can be saved to the home screen like an app.

Every day the app gives you a **daily quest** (that day's workout). You tick off sets one at a time, the rest timer starts on its own, and you earn XP, levels and ranks (E → S) as you stay consistent. **The System**, an AI coach powered by Claude, knows your long-term goal and your history and helps you get there.

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

## The System (Claude AI)

The AI coach runs on **Claude Opus 5.5** through Anthropic's official JavaScript SDK (bundled in `vendor/`). Everything outside the AI features works without it.

- **Goal intro**: on first launch, a 2-minute intro records your long-term goal, why it matters, your starting level, equipment, schedule, what gets in your way and how you want to be spoken to.
- **Daily System message**: a short personal message on the Today screen, grounded in your streak, progress, energy and goal.
- **Journal reflections**: tap *Reflect with the System* under your daily log for a short read on your day and one thing to do tomorrow.
- **Coach chat** (the *System* tab): ask anything, or use quick actions: weekly review, a deep review of all your data, travel mode, restarting after missed days, what to focus on.
- **Personalised plan**: the System can redesign your weekly plan around your goal, schedule or situation (for example "travelling 2 weeks with only bands"). You preview it first; nothing changes until you tap Apply, and you can always go back to the original plan. Your history keeps the exercises you actually did.
- **Personal reminder texts**: the calendar reminders can use notification texts written for your goal.

### Connecting it

1. Create an API key in the [Anthropic Console](https://console.anthropic.com/settings/keys). Usage is billed per request by Anthropic, usually a few cents a day for this app. **Settings → Claude AI** shows a running estimate.
2. Paste it in **Settings → Claude AI** (or during the intro) and tap *Test connection*.

### Privacy

- The API key is stored only on the device where you enter it. It is never included in backups.
- Your data is sent to Anthropic only when you use an AI feature. The context includes your profile, current plan, the last 4 weeks of workouts, a monthly summary of older history, exercise trends and recent daily log entries. The *Deep review* sends your full daily log.
- Requests go directly from your device to Anthropic's API. There is no other server.

## The plan

| Day | Session |
|---|---|
| Mon, Fri | Back & width (the V-taper day) |
| Tue | Legs, heavy |
| Wed, Sun | Push & shoulders |
| Thu | Rest |
| Sat | Legs & core |

The full exercise list and the rules are on the **Plan** tab. To change the default plan, edit `js/program.js`, or let the System personalise it from the Plan tab.

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
js/program.js         default plan, exercises, video + photo sources, quotes
js/store.js           saved data, plan (default or personalised), streaks, XP, progress maths
js/app.js             screens and interactions
js/ui.js              shared helpers: icons, pop-up sheet, toasts, safe Markdown
js/ai.js              Claude integration: requests, the coach's context, plan checks
js/system.js          AI screens: goal intro, System message, reflections, coach chat, plan personalisation
vendor/               Anthropic JavaScript SDK (MIT), bundled for the browser
sw.js                 offline support
manifest.webmanifest  home-screen app settings
icons/, fonts/        app icon and self-hosted fonts
```

## Credits

- **Videos**: YouTube tutorials by their creators. Each exercise's how-to screen shows the video title and links to it. Every video was taken from real search results; exercises without a good match don't show one.
- **Photos**: [Free Exercise DB](https://github.com/yuhonas/free-exercise-db) (public domain).
- **Fonts**: Bebas Neue, Rajdhani and Cormorant Garamond, under the SIL Open Font License.
- **AI**: [Anthropic TypeScript SDK](https://github.com/anthropics/anthropic-sdk-typescript) (MIT License), bundled in `vendor/`.
