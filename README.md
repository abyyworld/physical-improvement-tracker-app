# Arise

Daily quests toward any goal, styled after the System in Solo Leveling. Pick what you're working toward (getting fit, a language, money, your career, your mind, a habit to break) and it turns into small daily quests you tick off. You earn XP, level up and keep a streak the more consistent you are. An AI coach (the System) knows your goals and your history, and keeps them private. For fitness there's a full home workout plan with sets, reps, a rest timer and how-to videos.

It's private by design: synced data is end-to-end encrypted, and the AI runs in a verified secure enclave or on your own device. Nobody else can read what you put in, including the people who run Arise.

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

Everything you do is saved on that device. To have the same history on your laptop and phone, make a free account: Settings, **Account**, **New here? Create an account**, with an email or with no email at all (you get an account code instead), and a password of at least 10 characters. Save the recovery code it shows you. Then sign in with it on each device. On iPhone, Safari and the home screen app count as two separate places, so sign in on both, or just use the home screen one.

Arise updates itself. New versions download in the background and switch over when you open the app or leave it, never in the middle of a workout. If you keep it open for a long time, an **Update ready** button appears at the top; tap it whenever you like. After an update, **What's new** says what changed. The sideloaded iPhone app is the exception: install the new Arise.ipa over it the same way (see [the iPhone app steps](#the-iphone-app)), and your data stays.

### What to test (about 10 minutes)

1. **The intro.** Tap **Begin**, pick an area (say Learning), write a goal, and pick a couple of quests. On **Your AI coach**, tap **Save and continue**.
2. **Quests.** On Today, tick a quest off and type an amount into one that has one (like 30 min). Check the XP, the streak and the INT/SEN stats in Status.
3. **Goals.** On the Goals tab, tap **Edit**: add a quest from the ideas, a measure (set a target) and a milestone, then **Save**. Tap the measure to log a number, and tap the milestone to mark it done. Make a second goal with **+ New goal**.
4. **The workout plan.** Make a Fitness goal and switch on **Use Arise's home workout plan**. On Today, tap an exercise to check the how-to video and photos, then tap **Start quest**. Change the reps with − and +, tap **Set 1 done** and check the **Rest** bar counts down. Let one rest run out with the app open: you should hear a beep (on iPhone, the ringer switch must be on). Then tap **Complete quest**.
5. **Progress.** Check your streak, the 16-week calendar, each goal's quests and measures, and the chart for an exercise.
6. **An account.** Settings, **Account**, **New here? Create an account**. Try **No email** too, on another browser. You should see your recovery code (and account code), then **Signed in as** and **End-to-end encrypted**.
7. **Sync.** Open the link on a second device. On the intro, tap **Already have an account? Sign in** and sign in. Your workout should be there. Tick a quest or write in the **Daily log** on one device and wait about 10 seconds (or switch away from the app). Then tap **Sync now** in Settings on the other device and go back to Today to see it.
8. **The home screen app** (on a phone). Add it to your home screen, open it from the icon and sign in.
9. **The AI coach.** In Settings, **AI coach**: on a laptop with Chrome 148 or later, pick **On this device**. Or pick **Your own AI service**, get a free key at [Google AI Studio](https://aistudio.google.com/apikey), paste it, tap **Save key** and say yes to the privacy question. Then on the **System** tab tap **Review my week**, and in a goal's editor tap **Suggest quests**.

### Found a problem?

[Open an issue](https://github.com/abyyworld/physical-improvement-tracker-app/issues/new) and say which device and browser you used, what you tapped, what you expected and what happened. A screenshot helps a lot.

### Privacy

- Everything you enter is saved on your device: workouts, the daily log, weigh-ins and body measurements, your goal and intro answers, settings, and your AI coach chats.
- With an account, an **end-to-end encrypted** copy is kept in the cloud so it can sync. It's encrypted on your device with a key that only your devices have, before it leaves. Nobody else can read it: not the people who run Arise, not Google (who host it), and not anyone who asks either of them for it. The database itself refuses anything that isn't encrypted.
- What the server can see: your sign-in email (none at all with a no-email account), when you sync, and roughly how much data you have. Not what it says.
- Your password never leaves your device either; the sign-in service only gets a value derived from it. That's why nobody can reset it for you: if you forget it, your recovery code is the only way back in.
- Your AI key stays on your device. It's never synced or put in backups.
- The AI coach is private by default: the private AI's requests are encrypted to a verified enclave nobody can read, and the on-device AI never sends anything anywhere. Only if you pick your own AI service (Claude, ChatGPT, Gemini…) does your profile, plan, workouts, weigh-ins and daily log go to that company, who can read them: when you use a feature, and once a day for the daily message (turn that off in Settings, **Daily System message**). The app asks before it ever does this.
- You can delete your account and its cloud copy any time: Settings, **Account**, **More**.

## Working on it together

For collaborators changing the code:

- **Access.** The owner adds you on GitHub under the repo's Settings, **Collaborators**, using your GitHub username.
- **Everything goes live from `main`.** Every push to `main` is checked, built and published to the website within a few minutes (`.github/workflows/deploy.yml`), and everyone's installed app updates itself. A push that changes the app also builds a new iPhone app. So make a branch from `main`, open a pull request into `main` (check the base branch, since GitHub may suggest another one), and merge once the **Checks** pass and it's tested.
- **Run it locally.** Needs Node 22 or newer. Run `npm install` once, then `npm run dev` and open the address it prints. `npm test` runs the tests, `npm run typecheck` checks types, and `npm run check` does both plus a production build, the same as CI.
- **Telling people what changed.** For a change worth mentioning, bump `version` in `package.json` and add a short, plain entry at the top of `src/changelog.ts`. Installed apps show it once after they update.
- **Nothing to set up.** The repo is already connected to the Arise Firebase project. Your own AI key goes into the app's Settings, never into the code.
- **Keep the app's text plain and human.** Short sentences, everyday words, and no long dashes in anything a person reads. The AI coach's replies are filtered for long dashes too.

## Goals and quests

A goal can be anything: fitness, learning, career, money, health, mind, creative work, relationships or a habit. Each one has:

- **Quests**: the small actions you tick off. Every day, on set weekdays (weekdays, weekends or your own pick), or a number of times a week on any days. A quest can have an amount, like 30 min or 20 pages. Each area comes with ideas to start from, and the AI coach can suggest quests for any goal.
- **Measures** (optional): numbers that show progress, like savings, a test score or your weight, with a start and a target. Log them whenever you like and they get a chart.
- **Milestones** (optional): checkpoints with a date.

Today shows every quest due across your goals. A day counts for your streak when everything due that day is done (and, with the workout plan, the day's training or a rest day). Quests done "a few times a week" don't break the streak on any one day; they count by the week. You earn 10 XP a quest (+5 for reaching its amount), 100 a milestone, 5 a measure logged and 300 for a goal you achieve. Stats grow with the kind of quest: VIT for fitness, INT for learning, career, money and creative work, SEN for health, mind, people and habits (plus STR and AGI from the workout plan).

Goals can be paused (their quests leave your list) or marked achieved. Workouts from before goals existed become a Fitness goal using the workout plan, with all their history.

## The home workout plan (optional)

For a Fitness goal you can switch on Arise's home workout plan. Three workouts, A, B and C, done in turn on whatever days you can. 6 a week is ideal (each one twice), 4 is the minimum. No fixed weekdays, so a busy week or a trip doesn't wreck it. You just do the next one.

A and B build a V-taper upper body, arms and abs. C builds your legs and your first-step speed for football. It follows what the research says works: sets taken close to failure, every muscle trained about twice a week, exercises that load the muscle in its stretched position, and short all-out sprints and jumps with full rest. In C, acceleration sprints come right after a short warm-up, because the first 5 m is where most wingers lose races. Hill sprints and partner band sprints make those first steps harder to push, and horizontal jumps and single-leg strength back them up.

**A: Back and biceps.** Wide-grip pull-ups, band straight-arm pulldowns, band rows, band lateral raises, chin-ups, band curls, hanging leg raises. Without a bar: band lat pulldowns, band underhand pulldowns and reverse crunches instead of the three bar exercises.

**B: Shoulders, chest and triceps.** Pike push-ups (working up to wall handstand push-ups), deep decline push-ups, chair dips, band overhead triceps extensions, band lateral raises, band face pulls, band kneeling crunches.

**C: Speed and legs.** Pogo hops, acceleration sprints, broad jumps, flying sprints, Bulgarian split squats, single-leg Romanian deadlifts, single-leg hip thrusts, single-leg calf raises. The sprints need a bit of space outside; skip them if you can't get out.

**Bulk and cut versions.** Bulking and maintaining use the full plan. Pick Cut (on the Plan screen or under Progress) and the app switches to the cut version: the same exercises and effort with about a sixth fewer sets. One set comes off curls, leg raises, pike push-ups, dips, triceps extensions, crunches and the four strength exercises in C, because football already loads your legs and you recover less while eating less. Pull-ups, pulldowns, rows, lateral raises, face pulls, sprints and jumps stay full. Hard sets are what keep muscle on a cut; the extra sets pay off when you're eating enough to grow.

**Equipment.** Resistance bands with a door anchor (a knotted towel shut in the door works too), a backpack you can put weight in, a bed, a couple of chairs and a step. Get bands in 3-4 strengths, because lateral raises need a light one and rows and pulldowns need a heavy one. A pull-up bar is best for A, but it doesn't have to be at home: set **Pull-up bar** in Settings to **Near home** (say, one in a park) and A asks whether you're at the bar or at home. At home, or with **None**, pull-ups, chin-ups and hanging leg raises become band lat pulldowns, band underhand pulldowns and reverse crunches, with the same sets. Nothing else is required. If you want to spend money, the upgrades worth it, in order:

1. Adjustable dumbbells (up to about 20-25 kg each). Heavy leg work is the one thing a backpack can't fully replace, and it matters for size and your first steps.
2. A sprint resistance harness, so a mate can hold you back on acceleration sprints. A band round your waist works too.
3. Parallettes or dip bars, for deeper dips and push-ups than chairs allow.
4. A weight vest, only if the backpack gets uncomfortable. It does the same job.

On a football day, if C is next, the app gives you A or B instead and keeps C for another day. Try to do C at least two days before a match.

If you aim for 5 sessions a week, you get 2 rest days. Taking one from the Today screen keeps your streak going. Skipping without one breaks it.

Food and sleep matter as much as the sessions: 1.6-2.2 g of protein per kg of bodyweight a day (near the top on a cut) and 7-9 hours of sleep. The target is about 10-12% body fat all year, so abs show and you keep your speed. For a winger around 178 cm that means building up to roughly 74-78 kg over a few years. Above 13%, cut first. At 10-12%, bulk slowly and cut back when you pass 13%. Keep the effort the same in both; food decides the direction.

The original weekly split (four workouts over six fixed weekdays, Thursday off) is still there under Plan, Plan type. That picker is hidden while a plan the AI coach redesigned is in use.

## What else it does

- For the workout plan: shows a how-to video for every exercise, photos for most, and what to do when it gets too easy.
- Fills in your reps from last time and tells you when you've hit the top of the range on every set, so you know to make it harder.
- Tracks streaks, a 16-week calendar, each quest's own streak and rate, a chart for every measure and exercise, and your full history.
- Suggests an easy week (half the sets) every 6 to 8 weeks.
- Bulk or cut: log a weekly weigh-in (weight, waist, shoulders) and it shows whether you're gaining or losing at the right pace, plus your shoulder to waist ratio.
- Played football? Tap it and a legs session gets moved to another day.
- A daily log with your energy (1-5) and notes, which the coach can reflect on.
- Reminds you every day with a different message. The iPhone app sends real notifications (a morning reminder, plus an evening check if the day isn't done). On the web, tap **Add reminders to my calendar** in Settings to add 6 months of reminders to your calendar app.
- Works offline once it's been opened (videos, photos you haven't viewed yet, the AI coach and sync still need internet).
- Lets you save a backup and load it on another device. On a new or erased device, loading a backup restores everything. Otherwise it adds the goals, ticks, measures, workouts, logs, weigh-ins, football days and rest days from the file to what's already there, and the plan and settings on that device stay as they are. With an account you don't need this, because sync does it for you.

## The AI coach

The coach can think in three places. Pick one in Settings, **AI coach**; by default the app picks the first private one that's ready.

- **Private AI** (recommended). An open model in [Tinfoil](https://tinfoil.sh)'s secure enclaves. Before anything is sent, the app checks the enclave is running the exact published code on genuine confidential-computing hardware, then encrypts the request to it. Nobody in between can read it, including the people who run Arise. Free with an account, with a daily limit. It goes live once the proxy in `worker/ai-proxy/` is deployed (see its README).
- **On this device.** Chrome's built-in model on laptops and desktops (Chrome 148 or later; not phones yet). Nothing leaves the computer and it works offline.
- **Your own AI service.** An API key from Claude (Anthropic), Gemini (Google), OpenAI, OpenRouter or Groq, or any other service that uses the OpenAI format (you add its address in Settings). **Not private**: that company can read what the coach sends it, so the app asks you to say yes to that first, naming the company. Paste a key and the app works out which service it's for. Claude goes through Anthropic's JavaScript SDK; the others are plain web requests.

Everything else in the app works without any AI.

- A short intro when you first open the app asks about your big goal, why it matters, where you're starting from, your schedule and what usually gets in the way.
- A personal message on the Today screen each day.
- A quick read on your daily log if you want one.
- A chat with quick buttons for a weekly review, a deep review of all your data, travel weeks and getting back on track after missed days.
- It can redesign your plan around your goal or situation. You see it first and nothing changes until you hit Apply.
- It can write your reminder texts.

It's built to get you training, not chatting. Replies are short and always end with one thing to do next, and today's workout stays one tap away.

To use your own service, create an API key with one of them ([Claude](https://console.anthropic.com/settings/keys), [Gemini](https://aistudio.google.com/apikey), [OpenAI](https://platform.openai.com/api-keys), [OpenRouter](https://openrouter.ai/keys), [Groq](https://console.groq.com/keys)) and paste it into Settings, **AI coach**. Gemini and Groq have free tiers with daily limits, which is plenty for trying it out. On OpenRouter without credit, pick a model ending in `:free`. Claude and OpenAI need paid credit, usually a few cents a day here.

Each service has a recommended model. On Gemini that's the newest stable Flash model your key can use, and if it's busy another one stands in for a while. The **Model** list in Settings shows every model your key can use, or you can type any model name; each one is tested as soon as you pick it. Settings shows a cost estimate for Claude's default model (Claude Opus 5.5) and token counts for everything else.

## Accounts and sync

Accounts are switched on. They're optional: without one, everything stays on the device.

With one, your data still lives on your device first, and an end-to-end encrypted copy is kept in your own private space in the cloud, so the same history shows up on every device where you sign in, and a lost phone doesn't mean lost progress. Sign in under Settings, **Account**, or on the intro screen with **Already have an account? Sign in**. The AI key and AI service settings, the notification switch, AI usage counts and a workout in progress stay on each device.

How the encryption works (`src/lib/crypto.ts`, `src/account.ts`): your password is stretched on your device (PBKDF2, 600,000 rounds, salted with your email or account code) into two separate keys. One is what Firebase gets as your password; the other unlocks a random data key (AES-256-GCM) that encrypts everything you sync. The data key is also locked with your recovery code, which is how a forgotten password gets reset without anyone else being able to. The database rules (`firestore.rules`) only let a signed-in person reach their own data, and only accept it encrypted.

Accounts made before encryption are upgraded the next time they sign in: the plain cloud copy is replaced with an encrypted one and a recovery code is shown.

How syncing works: every change is stamped, and so is every delete. A few seconds after a change it's sent up, and when the app opens or comes back to the front it checks whether another device changed something. If only one side changed, that side wins. If both changed, everything added on either device is kept, everything deleted on either device stays deleted, and settings and the plan come from whichever changed last. **Sync now** in Settings does it straight away. Big histories are split across several cloud documents and written in one go, so nobody ever reads half a version. A device with an older app never touches data saved by a newer one; it updates itself first.

**Before this version goes live,** the new database rules must be published, or new accounts can't save their keys: `npx firebase-tools deploy --only firestore:rules` (or paste `firestore.rules` into the Firebase console, Firestore, Rules, and Publish). Older app versions can't upload after that, which is intended: they update themselves.

It runs on Firebase's free Spark plan, which allows about 1 GB of data and tens of thousands of reads and writes a day.

**Using your own Firebase project (forks only).** This repo is already connected, so collaborators don't need this. For a fork: create a project at [console.firebase.google.com](https://console.firebase.google.com) (skip Google Analytics). Under **Security**, **Authentication**, turn on Email/Password. Under **Databases & Storage**, **Firestore**, create a database in production mode, then paste `firestore.rules` into its Rules tab and Publish. Finally, under Settings, **Project settings**, **Your apps**, add a Web app and copy its config into `src/firebase-config.js`. The config isn't secret; the rules are what keep each person's data private.

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
index.html               page shell (Vite builds it into dist/)
src/main.ts              entry point
src/store.ts             saved data: goals, quests, workouts, streaks, XP, body tracking
src/lib/goals.ts         what a goal, quest, measure and milestone are; ideas for each area
src/goals-ui.js          goals on screen: today's quests, the Goals tab, the goal editor
src/program.js           the workout plans, exercises, videos, photos, quotes
src/app.js               screens and interactions (Today, workouts, Progress, Settings)
src/chart.js             line charts
src/ui.js                shared bits: icons, pop-ups, toasts, safe Markdown
src/ai.js                the AI coach: engines, prompts, what it knows about you
src/ai-config.ts         where the private AI lives
src/lib/on-device.ts     Chrome's built-in AI model
src/system.js            AI screens and the intro: daily message, chat, plan changes, AI settings
src/reminders.js         reminder texts for notifications and the calendar file
src/native.js            iPhone app extras: notifications, data file, share sheet
src/account.ts           accounts and their encryption keys
src/sync.ts              encrypted sync, and the Account panel
src/lib/merge.ts         combining two devices' changes
src/firebase-config.js   the Firebase project's config
src/update.ts            automatic updates and "What's new"
src/changelog.ts         the notes "What's new" shows
src/sw.ts                offline support (the service worker)
src/lib/validate.ts      checks every piece of data that comes from a file or the cloud
src/lib/clean.ts         cleans AI plans and text
src/lib/crypto.ts        end-to-end encryption
src/lib/keystore.ts      keeps this device's encryption key
src/styles/, src/assets/ styles and fonts
public/icons/            app icons
worker/ai-proxy/         the private AI proxy (a Cloudflare Worker)
firestore.rules          database rules: each person can only reach their own data
docs/                    the QR code above
ios/                     the iPhone app's Xcode project
```

## Credits

- Videos are YouTube tutorials by their creators. Each how-to screen shows the title and links to the original.
- Photos come from [Free Exercise DB](https://github.com/yuhonas/free-exercise-db) (public domain).
- Fonts: Bebas Neue, Rajdhani and Cormorant Garamond (SIL Open Font License).
- AI: [Anthropic TypeScript SDK](https://github.com/anthropics/anthropic-sdk-typescript) (MIT) for Claude. Gemini and OpenAI-format services are called directly.
- Accounts and sync: [Firebase JavaScript SDK](https://github.com/firebase/firebase-js-sdk) (Apache 2.0).
- iPhone app: [Capacitor](https://capacitorjs.com) and its notification, share and file plugins (MIT).
