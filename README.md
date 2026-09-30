# Arise

A home workout tracker for locking in every day, wherever you are. It runs in the browser on a phone, tablet or laptop, and you can add it to your home screen so it opens like an app.

The idea is simple. Every day there's one quest: the next workout. You tick off your sets, the rest timer starts by itself, and you earn XP and level up the more consistent you are. There's also an AI coach (the System) that knows your long-term goal and your history.

## The plan

Three workouts, A, B and C, done in turn on whatever days you can. 6 a week is ideal (each one twice), 4 is the minimum. No fixed weekdays, so a busy week or a trip doesn't wreck it. You just do the next one.

A and B build a V-taper upper body, arms and abs. C builds the legs and your first steps for football. It follows what the research says works: sets taken close to failure, every muscle trained about twice a week, exercises that load the muscle in its stretched position, and short all-out sprints and jumps with full rest. Acceleration comes first in C, because the first 5 m is where most wingers lose races. Hill sprints and partner band sprints make those first steps harder to push, and horizontal jumps and single-leg strength back them up.

**A: Back and biceps.** Wide-grip pull-ups, band straight-arm pulldowns, band rows, band lateral raises, chin-ups, band curls, hanging leg raises.

**B: Shoulders, chest and triceps.** Pike push-ups (working up to wall handstand push-ups), deep decline push-ups, chair dips, band overhead triceps extensions, band lateral raises, band face pulls, band kneeling crunches.

**C: Speed and legs.** Pogo hops, acceleration sprints, broad jumps, flying sprints, Bulgarian split squats, single-leg Romanian deadlifts, single-leg hip thrusts, single-leg calf raises. The sprints need a bit of space outside; skip them if you can't get out.

**Bulk and cut versions.** Bulking and maintaining use the full plan. Pick Cut (on the Plan screen or under Progress) and the app switches to the cut version: the same exercises and effort with about a sixth fewer sets, taken from the legs and smaller exercises, because football already loads your legs and you recover less while eating less. Pull-ups, lateral raises and sprints stay full. Hard sets are what keep muscle on a cut; the extra sets pay off when you're eating enough to grow.

**Equipment.** A doorway pull-up bar, resistance bands with a door anchor, a backpack you can put weight in, a bed, a couple of chairs and a step. Get bands in 3-4 strengths, because lateral raises need a light one and rows and pulldowns need a heavy one. Nothing else is required. If you want to spend money, the upgrades worth it, in order:

1. Adjustable dumbbells (up to about 20-25 kg each). Heavy leg work is the one thing a backpack can't fully replace, and it matters for size and your first steps.
2. A sprint resistance harness, so a mate can hold you back on acceleration sprints. A band round your waist works too.
3. Parallettes or dip bars, for deeper dips and push-ups than chairs allow.
4. A weight vest, only if the backpack gets uncomfortable. It does the same job.

On a football day, if C is next, the app gives you A or B instead and keeps C for another day. Try to do C at least two days before a match.

If you aim for 5 sessions a week, you get 2 rest days. Taking one from the Today screen keeps your streak going. Skipping without one breaks it.

Food and sleep matter as much as the sessions: 1.6-2.2 g of protein per kg of bodyweight a day and 7-9 hours of sleep. The target is about 10-12% body fat all year, so abs show and you keep your speed. For a winger around 178 cm that means building up to roughly 74-78 kg over a few years. Above 13%, cut first. At 10-12%, bulk slowly and cut back when you pass 13%. Training stays the same in both.

The original four-session weekly split is still there under Plan, Plan type.

## What else it does

- Shows a how-to video and photos for every exercise, plus what to do when it gets too easy.
- Fills in your reps from last time and tells you when you've hit the top of the range on every set, so you know to make it harder.
- Tracks streaks, a 16-week calendar, a chart for each exercise and your full history.
- Suggests an easy week (half the sets) every 6 to 8 weeks.
- Bulk or cut: log a weekly weigh-in (weight, waist, shoulders) and it shows whether you're gaining or losing at the right pace, plus your shoulder to waist ratio.
- Played football? Tap it and a legs session gets moved to another day.
- Reminds you every day with a different message. The iPhone app sends real notifications (a morning reminder, plus an evening check if the day isn't done). The web version adds reminders to your phone's calendar for the next 6 months.
- Works offline once it's been opened (videos still need internet).
- Lets you save a backup and load it on another device. Loading merges the two, so phone and tablet can share one history.

## The AI coach

The coach works with an API key from Claude (Anthropic), Gemini (Google), OpenAI, OpenRouter or Groq, or any other service that uses the OpenAI format (you add its address in Settings). Paste a key and the app works out which service it's for. Claude goes through Anthropic's JavaScript SDK, which is bundled in `vendor/`; the others are plain web requests. Everything else in the app works without a key.

- A short intro when you first open the app asks about your big goal, why it matters, where you're starting from, your schedule and what usually gets in the way.
- A personal message on the Today screen each day.
- A quick read on your daily log if you want one.
- A chat with quick buttons for a weekly review, a deep review of all your data, travel weeks and getting back on track after missed days.
- It can redesign your plan around your goal or situation. You see it first and nothing changes until you hit Apply.
- It can write your reminder texts.

It's built to get you training, not chatting. Replies are short and always end with one thing to do next, and today's workout stays one tap away.

To turn it on, create an API key with one of them ([Claude](https://console.anthropic.com/settings/keys), [Gemini](https://aistudio.google.com/apikey), [OpenAI](https://platform.openai.com/api-keys), [OpenRouter](https://openrouter.ai/keys), [Groq](https://console.groq.com/keys)) and paste it into Settings. Each service has a sensible default model, and Settings lists every model your key can use if you want another. The service bills per use, usually a few cents a day here. Settings shows a cost estimate for Claude and token counts for the others. The key stays on your device and never goes into backups. Your data only goes to that service when you use one of the AI features.

## Accounts and sync

Optional, free, and switched off until a Firebase project is connected. Without it, everything stays on the device.

With it, people can create an account with email and password. Their data still lives on their device first, and a copy is kept in their own private space in the cloud, so the same history shows up on every device where they sign in, and a lost phone doesn't mean lost progress. The database rules (`firestore.rules`) only let a signed-in person read and write their own data. The AI key and a workout in progress are never synced.

How syncing works: every change is stamped. When the app opens (or after a change, once things are quiet for a few seconds), it checks whether the cloud copy changed on another device. If only one side changed, that side wins, so deletes carry over. If both changed, the two are combined so no workout or log entry is lost. Big histories are split across several cloud documents and written in one go, so nobody ever reads half a version.

To connect it (Firebase's free Spark plan, no card needed):

1. Go to [console.firebase.google.com](https://console.firebase.google.com), create a project and skip Google Analytics.
2. Build, Authentication, Get started. Under Sign-in method, turn on Email/Password.
3. Build, Firestore Database, Create database. Pick a location near you and start in production mode.
4. In Firestore, open Rules, paste in the contents of `firestore.rules` and Publish.
5. On the project's home page, add a Web app (the `</>` icon). Copy the `firebaseConfig` values it shows into `js/firebase-config.js`.

The config values aren't secret; the rules are what keep each person's data private. The free plan allows about 1 GB of data and tens of thousands of reads and writes a day.

## Putting it online

1. On GitHub, open the repo and go to Settings, then Pages.
2. Set the source to "Deploy from a branch", pick `main` and the root folder, then Save.
3. After a minute it's live at `https://abyyworld.github.io/physical-improvement-tracker-app/`.

On iPhone or iPad, open that link in Safari, tap Share, then Add to Home Screen. On Android, open it in Chrome, tap the menu, then Install app.

Your data lives on the device, inside whichever app you opened it in. On iPhone, Safari and the home screen app keep separate data, so pick the home screen one and stick with it.

## The iPhone app

The same app, wrapped as a real iPhone app with [Capacitor](https://capacitorjs.com). On top of the web version it gets:

- Real notifications. One every morning at the time you pick, with a different message each day, and an evening check on days you haven't trained yet. Done days, rest days and football days stay quiet. The next 6 weeks are planned ahead and topped up every time you open the app.
- A copy of your data in the Files app (On My iPhone, Arise), which the app loads back if iOS ever clears its storage.
- Backups and calendar files go through the share sheet, and videos open in the YouTube app.

Every push to `main` builds it on GitHub (see `.github/workflows/ios.yml`) and puts `Arise.ipa` on the [ios-latest release](https://github.com/abyyworld/physical-improvement-tracker-app/releases/tag/ios-latest). The file isn't signed, because Apple only lets you install apps signed with an Apple ID. The free way to do that:

1. Download `Arise.ipa` from the release.
2. Install [Sideloadly](https://sideloadly.io) on a Mac or Windows PC. On Windows you also need iTunes and iCloud from Apple's website (not the Microsoft Store versions).
3. Plug in your iPhone, unlock it and tap Trust.
4. Drag `Arise.ipa` into Sideloadly, type your Apple ID and press Start.
5. On the iPhone, go to Settings, General, VPN & Device Management and trust your Apple ID. Then turn on Settings, Privacy & Security, Developer Mode and restart when it asks.
6. Open Arise and tap Turn on under daily reminders.

With a free Apple ID the app stops opening after 7 days until you sign it again. Run the same steps (or let Sideloadly or [AltStore](https://altstore.io) refresh it over Wi-Fi) and your data stays, as long as you don't delete the app first. A paid Apple Developer account ($99 a year) makes a build last a year and lets you use TestFlight.

The iPhone app and the web app keep separate data. To move your history across, use Save backup in one and Load backup in the other.

To build it yourself on a Mac with Xcode:

```sh
npm install
npm run ios:sync
npx cap open ios
```

Then pick your iPhone in Xcode, set your Apple ID under Signing & Capabilities, and press Run.

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
js/ai.js              the AI coach: Claude, Gemini and OpenAI-format services, what it knows about you, plan checks
js/system.js          AI screens: intro, daily message, chat, plan changes
js/reminders.js       reminder texts for notifications and the calendar file
js/native.js          iPhone app extras: notifications, data file, share sheet
js/sync.js            accounts and sync (Firebase)
js/firebase-config.js your Firebase project's config
firestore.rules       database rules: each person can only reach their own data
vendor/               Anthropic JavaScript SDK (MIT), Firebase JavaScript SDK (Apache 2.0)
sw.js                 offline support
manifest.webmanifest  home screen settings
icons/, fonts/        app icon and fonts
ios/                  the iPhone app's Xcode project
scripts/build-www.mjs copies the web app into www/ for the iPhone app
```

## Credits

- Videos are YouTube tutorials by their creators. Each how-to screen shows the title and links to the original.
- Photos come from [Free Exercise DB](https://github.com/yuhonas/free-exercise-db) (public domain).
- Fonts: Bebas Neue, Rajdhani and Cormorant Garamond (SIL Open Font License).
- AI: [Anthropic TypeScript SDK](https://github.com/anthropics/anthropic-sdk-typescript) (MIT) for Claude. Gemini and OpenAI-format services are called directly.
- Accounts and sync: [Firebase JavaScript SDK](https://github.com/firebase/firebase-js-sdk) (Apache 2.0).
- iPhone app: [Capacitor](https://capacitorjs.com) and its notification, share and file plugins (MIT).
