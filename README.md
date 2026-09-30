# Arise

A home workout tracker for locking in every day, wherever you are. Every day there's one quest: the next workout. You tick off your sets, the rest timer starts by itself, and you earn XP and level up the more consistent you are. An AI coach (the System) knows your long-term goal and your history.

## Try it

**[Open Arise](https://abyyworld.github.io/physical-improvement-tracker-app/)** (the same link works on a laptop and a phone)

<img src="docs/qr-web-app.svg" alt="QR code that opens Arise" width="160">

On a laptop, scan this with your phone's camera to open it there too.

| On | Do this |
| --- | --- |
| Laptop | Open the link in Chrome, Edge, Safari or Firefox. In Chrome or Edge you can also install it as an app: tap **Install** on the banner on the Today screen. |
| iPhone or iPad | Open the link in **Safari**, tap Share (inside the ⋯ menu on newer iOS), then **Add to Home Screen**, and open it from the new icon from then on. |
| Android | Open the link in **Chrome** and tap **Install** on the banner, or ⋮ then **Add to Home screen** (**Install app** in some Chrome versions). |
| iPhone app (optional) | Needs a Mac or Windows PC. [Download Arise.ipa](https://github.com/abyyworld/physical-improvement-tracker-app/releases/download/ios-latest/Arise.ipa) and follow [the iPhone app steps](#the-iphone-app). |

Everything you do is saved on that device. To have the same history on your laptop and phone, make a free account: Settings, **Account**, **New here? Create an account** (any email and a password of at least 6 characters). Then sign in with it on each device. On iPhone, Safari and the home screen app count as two separate places, so sign in on both, or just use the home screen one.

When a new version is out, close the app or browser tab completely and open it again. It picks up the new version by itself, sometimes with one quick reload. The iPhone app is the exception: install the new Arise.ipa over it the same way (see [the iPhone app steps](#the-iphone-app)), and your data stays.

### What to test (about 10 minutes)

1. **The intro.** Tap **Begin** and answer the questions (you can skip most of them). On **Connect your AI**, leave the key empty and tap **Save and continue**.
2. **How-to videos.** On Today, tap an exercise in the **Daily quest** card (the list under **Goals**). Check the video plays, and that the photos show for exercises that have them (a few, like band rows, only have a video).
3. **A workout.** Tap **Start quest**. Change the reps with − and +, tap **Set 1 done** and check the **Rest** bar counts down. Let one rest run out with the app open: you should hear a beep (on iPhone, the ringer switch must be on). Then tap **Complete quest**.
4. **Progress.** Check your streak, the 16-week calendar, your workout under Quest history, and the chart for an exercise.
5. **An account.** Settings, **Account**, **New here? Create an account**. You should see **Signed in as** your email.
6. **Sync.** Open the link on a second device. On the intro, tap **Already have an account? Sign in** and sign in. Your workout should be there. Write something in the **Daily log** on one device and wait about 10 seconds (or switch away from the app). Then tap **Sync now** in Settings on the other device and go back to Today to see it.
7. **The home screen app** (on a phone). Add it to your home screen, open it from the icon and sign in.
8. **The AI coach** (optional). Get a free key at [Google AI Studio](https://aistudio.google.com/apikey), paste it in Settings, **AI coach**, **API key**, and tap **Save key**. Wait for **Connected**, then go to the **System** tab and tap **Review my week**.

### Found a problem?

[Open an issue](https://github.com/abyyworld/physical-improvement-tracker-app/issues/new) and say which device and browser you used, what you tapped, what you expected and what happened. A screenshot helps a lot.

### Privacy

- Everything you enter is saved on your device: workouts, the daily log, weigh-ins and body measurements, your goal and intro answers, settings, and your AI coach chats. With an account, a copy of all of it is also kept in the app's Firebase project so it can sync. Other people using the app can't see it.
- Passwords are never visible to anyone. The owner of this project can see the email you signed up with, and could technically open the stored data in the Firebase console, but won't.
- Your AI key stays on your device. It's never synced or put in backups.
- When the AI coach is on, your profile, plan, workouts, weigh-ins and daily log go to the AI service you picked: when you use a feature, and once a day for the daily message on the Today screen (turn that off in Settings, **Daily System message**).
- You can delete your account and its cloud copy any time: Settings, **Account**, **More**.

## Working on it together

For collaborators changing the code:

- **Access.** The owner adds you on GitHub under the repo's Settings, **Collaborators**, using your GitHub username.
- **Everything goes live from `main`.** Every push to `main` updates the website within a couple of minutes, and a push that changes the app also builds a new iPhone app. So make a branch from `main`, open a pull request into `main` (check the base branch, since GitHub may suggest another one), and merge once it's tested.
- **Run it locally.** There's no build step: run `python3 -m http.server 8000` in the repo folder and open http://localhost:8000.
- **Nothing to set up.** The repo is already connected to the Arise Firebase project. Your own AI key goes into the app's Settings, never into the code.
- **Keep the app's text plain and human.** Short sentences, everyday words, and no long dashes in anything a person reads. The AI coach's replies are filtered for long dashes too.

## The plan

Three workouts, A, B and C, done in turn on whatever days you can. 6 a week is ideal (each one twice), 4 is the minimum. No fixed weekdays, so a busy week or a trip doesn't wreck it. You just do the next one.

A and B build a V-taper upper body, arms and abs. C builds your legs and your first-step speed for football. It follows what the research says works: sets taken close to failure, every muscle trained about twice a week, exercises that load the muscle in its stretched position, and short all-out sprints and jumps with full rest. In C, acceleration sprints come right after a short warm-up, because the first 5 m is where most wingers lose races. Hill sprints and partner band sprints make those first steps harder to push, and horizontal jumps and single-leg strength back them up.

**A: Back and biceps.** Wide-grip pull-ups, band straight-arm pulldowns, band rows, band lateral raises, chin-ups, band curls, hanging leg raises.

**B: Shoulders, chest and triceps.** Pike push-ups (working up to wall handstand push-ups), deep decline push-ups, chair dips, band overhead triceps extensions, band lateral raises, band face pulls, band kneeling crunches.

**C: Speed and legs.** Pogo hops, acceleration sprints, broad jumps, flying sprints, Bulgarian split squats, single-leg Romanian deadlifts, single-leg hip thrusts, single-leg calf raises. The sprints need a bit of space outside; skip them if you can't get out.

**Bulk and cut versions.** Bulking and maintaining use the full plan. Pick Cut (on the Plan screen or under Progress) and the app switches to the cut version: the same exercises and effort with about a sixth fewer sets. One set comes off curls, leg raises, pike push-ups, dips, triceps extensions, crunches and the four strength exercises in C, because football already loads your legs and you recover less while eating less. Pull-ups, pulldowns, rows, lateral raises, face pulls, sprints and jumps stay full. Hard sets are what keep muscle on a cut; the extra sets pay off when you're eating enough to grow.

**Equipment.** A doorway pull-up bar, resistance bands with a door anchor, a backpack you can put weight in, a bed, a couple of chairs and a step. Get bands in 3-4 strengths, because lateral raises need a light one and rows and pulldowns need a heavy one. Nothing else is required. If you want to spend money, the upgrades worth it, in order:

1. Adjustable dumbbells (up to about 20-25 kg each). Heavy leg work is the one thing a backpack can't fully replace, and it matters for size and your first steps.
2. A sprint resistance harness, so a mate can hold you back on acceleration sprints. A band round your waist works too.
3. Parallettes or dip bars, for deeper dips and push-ups than chairs allow.
4. A weight vest, only if the backpack gets uncomfortable. It does the same job.

On a football day, if C is next, the app gives you A or B instead and keeps C for another day. Try to do C at least two days before a match.

If you aim for 5 sessions a week, you get 2 rest days. Taking one from the Today screen keeps your streak going. Skipping without one breaks it.

Food and sleep matter as much as the sessions: 1.6-2.2 g of protein per kg of bodyweight a day (near the top on a cut) and 7-9 hours of sleep. The target is about 10-12% body fat all year, so abs show and you keep your speed. For a winger around 178 cm that means building up to roughly 74-78 kg over a few years. Above 13%, cut first. At 10-12%, bulk slowly and cut back when you pass 13%. Keep the effort the same in both; food decides the direction.

The original weekly split (four workouts over six fixed weekdays, Thursday off) is still there under Plan, Plan type. That picker is hidden while a plan the AI coach redesigned is in use.

## What else it does

- Shows a how-to video for every exercise, photos for most, and what to do when it gets too easy.
- Fills in your reps from last time and tells you when you've hit the top of the range on every set, so you know to make it harder.
- Tracks streaks, a 16-week calendar, a chart for each exercise and your full history.
- Suggests an easy week (half the sets) every 6 to 8 weeks.
- Bulk or cut: log a weekly weigh-in (weight, waist, shoulders) and it shows whether you're gaining or losing at the right pace, plus your shoulder to waist ratio.
- Played football? Tap it and a legs session gets moved to another day.
- Reminds you every day with a different message. The iPhone app sends real notifications (a morning reminder, plus an evening check if the day isn't done). On the web, tap **Add reminders to my calendar** in Settings to add 6 months of reminders to your calendar app.
- Works offline once it's been opened (videos, photos you haven't viewed yet, the AI coach and sync still need internet).
- Lets you save a backup and load it on another device. Loading adds the workouts, logs, weigh-ins, football days and rest days from the file to what's already there. The plan and settings on that device stay as they are, except that a device with no goal or no bulk/cut phase yet takes them from the file. With an account you don't need this, because sync does it for you.

## The AI coach

The coach works with an API key from Claude (Anthropic), Gemini (Google), OpenAI, OpenRouter or Groq, or any other service that uses the OpenAI format (you add its address in Settings). Paste a key and the app works out which service it's for. Claude goes through Anthropic's JavaScript SDK, which is bundled in `vendor/`; the others are plain web requests. Everything else in the app works without a key.

- A short intro when you first open the app asks about your big goal, why it matters, where you're starting from, your schedule and what usually gets in the way.
- A personal message on the Today screen each day.
- A quick read on your daily log if you want one.
- A chat with quick buttons for a weekly review, a deep review of all your data, travel weeks and getting back on track after missed days.
- It can redesign your plan around your goal or situation. You see it first and nothing changes until you hit Apply.
- It can write your reminder texts.

It's built to get you training, not chatting. Replies are short and always end with one thing to do next, and today's workout stays one tap away.

To turn it on, create an API key with one of them ([Claude](https://console.anthropic.com/settings/keys), [Gemini](https://aistudio.google.com/apikey), [OpenAI](https://platform.openai.com/api-keys), [OpenRouter](https://openrouter.ai/keys), [Groq](https://console.groq.com/keys)) and paste it into Settings, **AI coach**. Gemini and Groq have free tiers with daily limits, which is plenty for trying it out. On OpenRouter without credit, pick a model ending in `:free`. Claude and OpenAI need paid credit, usually a few cents a day here.

Each service has a recommended model. On Gemini that's the newest stable Flash model your key can use, and if it's busy another one stands in for a while. The **Model** list in Settings shows every model your key can use, or you can type any model name; each one is tested as soon as you pick it. Settings shows a cost estimate for Claude's default model (Claude Opus 5.5) and token counts for everything else.

## Accounts and sync

Accounts are switched on. They're optional: without one, everything stays on the device.

With one, your data still lives on your device first, and a copy is kept in your own private space in the cloud, so the same history shows up on every device where you sign in, and a lost phone doesn't mean lost progress. Sign in under Settings, **Account**, or on the intro screen with **Already have an account? Sign in**. The database rules (`firestore.rules`) only let a signed-in person read and write their own data. The AI key, the notification switch and a workout in progress stay on each device.

How syncing works: every change is stamped. A few seconds after a change it's sent up, and when the app opens or comes back to the front it checks whether another device changed something. If only one side changed, that side wins, so deletes carry over. If both changed, workouts, logs and weigh-ins from both are kept, and settings and the plan come from whichever changed last. **Sync now** in Settings does it straight away. Big histories are split across several cloud documents and written in one go, so nobody ever reads half a version.

It runs on Firebase's free Spark plan, which allows about 1 GB of data and tens of thousands of reads and writes a day.

**Using your own Firebase project (forks only).** This repo is already connected, so collaborators don't need this. For a fork: create a project at [console.firebase.google.com](https://console.firebase.google.com) (skip Google Analytics). Under **Security**, **Authentication**, turn on Email/Password. Under **Databases & Storage**, **Firestore**, create a database in production mode, then paste `firestore.rules` into its Rules tab and Publish. Finally, under Settings, **Project settings**, **Your apps**, add a Web app and copy its config into `js/firebase-config.js`. The config isn't secret; the rules are what keep each person's data private.

## The iPhone app

The same app, wrapped as a real iPhone app with [Capacitor](https://capacitorjs.com). On top of the web version it gets:

- Real notifications. One every morning at the time you pick, with a different message each day, and an evening check on days you haven't trained yet. Done days, rest days and football days stay quiet. Morning reminders are planned about 6 weeks ahead and evening checks 2 weeks ahead, and both are topped up every time you open the app.
- A copy of your data in the Files app (On My iPhone, Arise), which the app loads back if iOS ever clears its storage.
- Backups go through the share sheet (Save to Files, AirDrop, Mail), and videos open in the YouTube app.

Every push to `main` that changes the app builds it on GitHub (see `.github/workflows/ios.yml`) and puts `Arise.ipa` on the [ios-latest release](https://github.com/abyyworld/physical-improvement-tracker-app/releases/tag/ios-latest). The file isn't signed yet. An iPhone only installs apps signed with an Apple ID, so you sign it with your own when you install it. The free way:

1. [Download Arise.ipa](https://github.com/abyyworld/physical-improvement-tracker-app/releases/download/ios-latest/Arise.ipa).
2. Install [Sideloadly](https://sideloadly.io) on a Mac or Windows PC. On Windows you also need iTunes and iCloud from Apple's website (not the Microsoft Store versions).
3. Plug in your iPhone, unlock it and tap Trust.
4. Drag `Arise.ipa` into Sideloadly, type your Apple ID and press Start.
5. On the iPhone, go to Settings, General, VPN & Device Management and trust your Apple ID. Then turn on Settings, Privacy & Security, Developer Mode and restart when it asks.
6. Open Arise and tap **Turn on** under daily reminders.

With a free Apple ID the app stops opening after 7 days until you sign it again. Run the same steps again (Sideloadly can also refresh it for you over Wi-Fi) and your data stays, as long as you don't delete the app first. If you install it with [AltStore](https://altstore.io) instead, AltStore refreshes it over Wi-Fi. A paid Apple Developer account ($99 a year) makes a build last a year and lets you use TestFlight.

The iPhone app keeps its own data, separate from the web app. Sign in to the same account in both to share one history, or use Save backup in one and Load backup in the other.

To build it yourself on a Mac with Xcode:

```sh
npm install
npm run ios:sync
npx cap open ios
```

Then pick your iPhone in Xcode, set your Apple ID under Signing & Capabilities, and press Run.

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
js/firebase-config.js the Firebase project's config
firestore.rules       database rules: each person can only reach their own data
vendor/               Anthropic JavaScript SDK (MIT), Firebase JavaScript SDK (Apache 2.0)
sw.js                 offline support
manifest.webmanifest  home screen settings
icons/, fonts/        app icon and fonts
docs/                 the QR code above
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
