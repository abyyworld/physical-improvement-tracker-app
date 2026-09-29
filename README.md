# Arise

A home workout tracker for locking in every day, wherever you are. It runs in the browser on a phone, tablet or laptop, and you can add it to your home screen so it opens like an app.

The idea is simple. Every day there's one quest: the next workout. You tick off your sets, the rest timer starts by itself, and you earn XP and level up the more consistent you are. There's also an AI coach (the System) that knows your long-term goal and your history.

## The plan

Two workouts, A and B, done in turn 4 to 6 times a week on whatever days you can. No fixed weekdays, so a busy week or a trip doesn't wreck it. You just do the next one.

**A: Pull and hinge.** Wide-grip pull-ups, band rows, band lateral raises, single-leg Romanian deadlifts, Nordic curls, hanging leg raises.

**B: Push and squat.** Pike push-ups (working up to wall handstand push-ups), chin-ups, decline push-ups, band lateral raises, Bulgarian split squats, band face pulls, hollow body hold.

Lats and side delts get hit every session because that's what builds the V-taper. All you need is a doorway pull-up bar, a few resistance bands with a door anchor, a backpack you can put weight in, a bed, a chair and a step.

If you aim for 5 sessions a week, you get 2 rest days. Taking one from the Today screen keeps your streak going. Skipping without one breaks it.

The original four-session weekly split is still there under Plan, Plan type.

## What else it does

- Shows a how-to video and photos for every exercise, plus what to do when it gets too easy.
- Fills in your reps from last time and tells you when you've hit the top of the range on every set, so you know to make it harder.
- Tracks streaks, a 16-week calendar, a chart for each exercise and your full history.
- Suggests an easy week (half the sets) every 6 to 8 weeks.
- Bulk or cut: log a weekly weigh-in (weight, waist, shoulders) and it shows whether you're gaining or losing at the right pace, plus your shoulder to waist ratio.
- Played football? Tap it and that day's leg exercises get skipped.
- Adds reminders to your phone's calendar for the next 6 months, with a different message each day.
- Works offline once it's been opened (videos still need internet).
- Lets you save a backup and load it on another device. Loading merges the two, so phone and tablet can share one history.

## The AI coach

The coach uses Claude through Anthropic's JavaScript SDK, which is bundled in `vendor/`. Everything else works without it.

- A short intro when you first open the app asks about your big goal, why it matters, where you're starting from, your schedule and what usually gets in the way.
- A personal message on the Today screen each day.
- A quick read on your daily log if you want one.
- A chat with quick buttons for a weekly review, a deep review of all your data, travel weeks and getting back on track after missed days.
- It can redesign your plan around your goal or situation. You see it first and nothing changes until you hit Apply.
- It can write your reminder texts.

It's built to get you training, not chatting. Replies are short and always end with one thing to do next, and today's workout stays one tap away.

To turn it on, create an API key at [console.anthropic.com](https://console.anthropic.com/settings/keys) and paste it into Settings. Anthropic bills per use, usually a few cents a day here, and Settings shows a running estimate. The key stays on your device and never goes into backups. Your data only goes to Anthropic when you use one of the AI features.

## Putting it online

1. On GitHub, open the repo and go to Settings, then Pages.
2. Set the source to "Deploy from a branch", pick `main` and the root folder, then Save.
3. After a minute it's live at `https://abyyworld.github.io/physical-improvement-tracker-app/`.

On iPhone or iPad, open that link in Safari, tap Share, then Add to Home Screen. On Android, open it in Chrome, tap the menu, then Install app.

Your data lives on the device, inside whichever app you opened it in. On iPhone, Safari and the home screen app keep separate data, so pick the home screen one and stick with it.

## Running it locally

There's no build step:

```sh
python3 -m http.server 8000
```

Then open http://localhost:8000.

## Files

```
index.html            page shell
css/app.css           styles
js/program.js         plans, exercises, videos, photos, quotes
js/store.js           saved data, schedule, streaks, XP, body tracking
js/app.js             screens and interactions
js/ui.js              shared bits: icons, pop-ups, toasts, safe Markdown
js/ai.js              the AI coach: requests, what it knows about you, plan checks
js/system.js          AI screens: intro, daily message, chat, plan changes
vendor/               Anthropic JavaScript SDK (MIT)
sw.js                 offline support
manifest.webmanifest  home screen settings
icons/, fonts/        app icon and fonts
```

## Credits

- Videos are YouTube tutorials by their creators. Each how-to screen shows the title and links to the original.
- Photos come from [Free Exercise DB](https://github.com/yuhonas/free-exercise-db) (public domain).
- Fonts: Bebas Neue, Rajdhani and Cormorant Garamond (SIL Open Font License).
- AI: [Anthropic TypeScript SDK](https://github.com/anthropics/anthropic-sdk-typescript) (MIT).
