// The training plan, plus the how-to media for every exercise.
//
// Videos: every YouTube ID below came from a real web search result (the title is
// the one YouTube shows). Nothing here is invented; if no good match was found,
// the field is left out and the app simply doesn't show that section.
//
// Photos: from Free Exercise DB (https://github.com/yuhonas/free-exercise-db),
// released into the public domain. Each folder has 0.jpg (start) and 1.jpg (finish).

export const IMG_BASE = 'https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/';

// kind: 'big' = 1.5-2 min rest, 'small' = ~1 min rest (bands and core)
// stat: which player stat the reps count toward (STR = push/pull, AGI = legs, VIT = core)
export const EXERCISES = {
  wide_pullup: {
    name: 'Wide-grip pull-ups',
    kind: 'big', stat: 'str',
    harder: 'When you get 12+ reps on every set, wear the backpack with a little weight in it. Or lower yourself slowly (3 seconds).',
    video: { id: '9A6NPVPzkqQ', title: 'How to Do Wide Grip Pullups | Perfect Form in 30 Seconds' },
    more: [{ id: 'bHC16skSN6Q', title: 'Top 5 Wide Grip Pullup Form Tips!' }],
    photos: { id: 'Pullups', caption: 'Standard pull-up. Take your hands wider than your shoulders.' },
  },
  chinup: {
    name: 'Chin-ups',
    kind: 'big', stat: 'str',
    harder: 'When you get 12+ reps on every set, wear the weighted backpack. Or lower yourself slowly (3 seconds).',
    video: { id: 'e1YSApl-QcM', title: "PERFECT CHIN-UPS | The Only Chin-up Tutorial You'll Ever Need (Full Guide)" },
    more: [{ id: 'brhRXlOhsAM', title: 'How to Perform Chin-Ups | Bodyweight Exercise Tutorial' }],
    photos: { id: 'Chin-Up', caption: 'Palms facing you, hands about shoulder width apart.' },
  },
  band_row: {
    name: 'Band rows',
    kind: 'small', stat: 'str',
    harder: 'Use a thicker band or step further back from the door.',
    video: { id: 'k7EPhs1i9mU', title: 'Standing Back Row Using Resistance Band with Door Anchor' },
    more: [
      { id: 'ysAjxPSFC7M', title: 'Resistance Band Rows (Exercise Library)' },
      { id: 'cYF1mlR7yR8', title: 'How to Use a Resistance Band Door Anchor (Setup, Safety & 5 Exercises)' },
    ],
  },
  band_lateral: {
    name: 'Band lateral raises',
    kind: 'small', stat: 'str',
    harder: 'Use a thicker band, or stand on the band so it starts shorter.',
    video: { id: 'gfEyrmxbCbw', title: 'How To: Resistance Band Lateral Raise' },
    more: [{ id: 'zC2NAwqtXyI', title: 'Banded Lateral Raise - Top 3 Variations for Growth!' }],
    photos: { id: 'Lateral_Raise_-_With_Bands', caption: 'Stand on the band and raise your arms out to the sides.' },
  },
  face_pull: {
    name: 'Band face pulls',
    kind: 'small', stat: 'str',
    harder: 'Use a thicker band or step further back from the door.',
    video: { id: 'AlTGQrDOd98', title: 'Banded Face Pulls Tutorial - Proper Form and Technique' },
    more: [{ id: 'Fe37Ll4VDfI', title: 'Face pulls for Rear Delts with Tribe Lifting Door Anchor for Resistance Bands' }],
    photos: { id: 'Face_Pull', caption: 'Shown with a cable. It is the same movement with a band anchored high on the door.' },
  },
  band_curl: {
    name: 'Band bicep curls',
    kind: 'small', stat: 'str',
    harder: 'Use a thicker band or stand on it so it starts shorter.',
    video: { id: '0Q5AxBF6f0M', title: 'Bicep Curl (bands) | Technique and 3 Most Common Mistakes' },
    more: [{ id: 'PGgtHXscXs4', title: 'Bicep Curls w/ Resistance Bands Explained (Muscle-Building Masterclass)' }],
  },
  bulgarian: {
    name: 'Bulgarian split squats',
    kind: 'big', stat: 'agi',
    harder: 'Add weight to the backpack.',
    video: { id: 'QD4P9Di7L20', title: 'How to Perform a Bulgarian Split Squat at Home' },
    more: [{ id: 'oGTVhFgRnes', title: 'Bodyweight Bulgarian Split Squat / Torokhtiy Weightlifting Library' }],
    photos: { id: 'Split_Squat_with_Dumbbells', caption: 'Rear foot up behind you. Shown with dumbbells; you wear the backpack instead.' },
  },
  pistol: {
    name: 'Pistol squat progression',
    kind: 'big', stat: 'agi',
    harder: 'Move to the next step: sit down to the bed on one leg → hold a door frame → full pistol → pistol with backpack.',
    video: { id: '6dV4hFahrpU', title: '6 Pistol Squat Progressions - Beginner to Advanced' },
    more: [{ id: 'T74bU2vNWG4', title: 'Pistol Squat Tutorial for Beginners (Full Progression)' }],
    photos: { id: 'Kettlebell_Pistol_Squat', caption: 'Full pistol squat, shown holding a kettlebell for balance.' },
  },
  nordic: {
    name: 'Nordic curls',
    kind: 'big', stat: 'agi',
    harder: 'Lower more slowly, and push off the floor less at the bottom. The goal is to lower all the way and come back up without your hands.',
    video: { id: 'ie7yQ5k5ZyU', title: "How To Master the Nordic Hamstring Curl from Home - It's Easier Than You Think!" },
    more: [{ id: 'pJSxW9Vi4K8', title: 'Nordic Hamstring: Home-Based Workout' }],
    photos: { id: 'Natural_Glute_Ham_Raise', caption: 'Same movement: ankles locked in, lower yourself slowly. At home, your heels go under the bed frame.' },
  },
  hip_thrust: {
    name: 'Hip thrusts',
    kind: 'big', stat: 'agi',
    harder: 'Add weight to the backpack, or do them on one leg.',
    video: { id: 'mmscrqxCl8w', title: 'Sofa Hip Thrusts' },
    more: [{ id: 'hYT-qCKQwPc', title: '10 Ways To HIP THRUST At HOME' }],
    photos: { id: 'Barbell_Hip_Thrust', caption: 'Shoulders on the bench and weight on the hips. You use the bed and a backpack.' },
  },
  calf_raise: {
    name: 'Single-leg calf raises',
    kind: 'small', stat: 'agi',
    harder: 'Wear the backpack, and pause for 1-2 seconds at the bottom stretch.',
    video: { id: '5hkhz_nMuws', title: 'Single leg calf raise off step' },
    more: [{ id: 'ElcvJ0kjt6c', title: 'Single Leg Calf Raise Tutorial - Proper Form and Technique' }],
  },
  pike: {
    name: 'Pike push-ups → wall handstand push-ups',
    kind: 'big', stat: 'str',
    harder: 'Raise your feet higher. Next step: wall handstand push-ups, starting with part of the way down and working toward the full range.',
    video: { id: '8URA3YSur2M', title: 'PIKE PUSH UP FEET ELEVATED | Technique Demo' },
    more: [
      { id: '6MdyYIRS7FY', title: 'HOW TO WALL HANDSTAND PUSH UP | School of Calisthenics' },
      { id: 'abdkULQ2ZWQ', title: 'Master Wall Handstand Push-Ups | Beginner to Pro Progression Tutorial' },
    ],
    photos: { id: 'Handstand_Push-Ups', caption: 'The goal: wall handstand push-ups.' },
  },
  decline: {
    name: 'Decline push-ups',
    kind: 'big', stat: 'str',
    harder: 'Raise your feet higher, wear the backpack, or switch to a harder variation such as archer push-ups.',
    video: { id: 'SKPab2YC8BE', title: 'How To: Decline Push-Up' },
    more: [{ id: '4aUUcfwyfE0', title: 'Feet Elevated Push-ups (Exercise Library)' }],
    photos: { id: 'Decline_Push-Up', caption: 'Feet up on a bench. You use the bed.' },
  },
  chair_dips: {
    name: 'Chair dips',
    kind: 'big', stat: 'str',
    harder: 'Put your feet up on the bed, then put the backpack on your lap.',
    video: { id: 'AWz_7B1cch0', title: 'How To Properly Do Tricep Chair Dips - 3 Common Mistakes' },
    more: [{ id: 'rjdpMVtMehw', title: 'How to do a Triceps Dip on a Chair at Home' }],
    photos: { id: 'Bench_Dips', caption: 'Shown on a bench. Use a chair pushed against the wall so it cannot slide.' },
  },
  pushdown: {
    name: 'Band tricep pushdowns',
    kind: 'small', stat: 'str',
    harder: 'Use a thicker band or step further back.',
    video: { id: 'gOq6Ig1skxA', title: 'Resistance Band Tricep Push Down (w/ Door Anchor)' },
    more: [{ id: 'BI7NaJ3qPRU', title: 'Band Dual Tricep Pushdown (Using a Door Strap Anchor)' }],
    photos: { id: 'Triceps_Pushdown', caption: 'Shown with a cable. It is the same movement with a band anchored at the top of the door.' },
  },
  jump_squat: {
    name: 'Jump squats',
    kind: 'big', stat: 'agi',
    harder: 'Jump higher and land softly, then hold the backpack.',
    video: { id: 'tZSYZdtbONc', title: 'How to do a Squat Jump | Proper Form & Technique | NASM' },
    more: [{ id: '5qqAUsHmAMU', title: 'How to PROPERLY Jump Squat (Great At Home Leg Exercise)' }],
    photos: { id: 'Freehand_Jump_Squat', caption: 'Squat down, then jump straight up.' },
  },
  sl_rdl: {
    name: 'Single-leg Romanian deadlifts',
    kind: 'big', stat: 'agi',
    harder: 'Add weight to the backpack and lower more slowly.',
    video: { id: 'Zfr6wizR8rs', title: 'The BEST Single-Leg RDL Tutorial (Romanian Deadlift)' },
    more: [{ id: 'gz9l8UA_KXs', title: 'How to Perform Single Leg Romanian Deadlifts | Bodyweight Exercise Tutorial' }],
    photos: { id: 'Kettlebell_One-Legged_Deadlift', caption: 'Shown with a kettlebell. You hold the backpack instead.' },
  },
  hanging_leg_raise: {
    name: 'Hanging leg raises',
    kind: 'small', stat: 'vit',
    harder: 'Knee raises → straight-leg raises → toes to bar.',
    video: { id: 'rbOJSK07AGA', title: 'Hanging Leg Raise Tutorial - Proper Form and Technique' },
    more: [{ id: 'EYe6dc_i4L0', title: 'HANGING LEG RAISE Progressions (Beginner to Advanced)' }],
    photos: { id: 'Hanging_Leg_Raise', caption: 'Hang from the bar and raise your legs.' },
  },
  band_pulldown: {
    name: 'Band straight-arm pulldowns',
    kind: 'small', stat: 'str',
    harder: 'Use a thicker band or step further back from the door.',
    video: { id: 'K4VAFznrNLk', title: 'HOW TO DO Straight Arm Lat Pulldown with Resistance Bands' },
    more: [
      { id: 'suDvuvet9zU', title: 'Banded Straight Arm Lat Pulldown' },
      { id: '5gHyAq4O-sQ', title: 'Resistance Band Straight Arm Lat Pulldown (At Home): How To' },
    ],
    photos: { id: 'Straight-Arm_Pulldown', caption: 'Shown on a cable. With a band anchored high on the door it is the same movement.' },
  },
  band_tri_ext: {
    name: 'Band overhead triceps extensions',
    kind: 'small', stat: 'str',
    harder: 'Use a thicker band or hold it shorter.',
    video: { id: 'pYODt0gyBKI', title: 'Tutorial | Overhead Triceps Extension with Resistance Bands' },
    more: [
      { id: 'CcyY35T2XF0', title: 'Overhead Band Tricep Extension | Top 3 Variations with Bands' },
      { id: 'KQfZ80gGEj4', title: 'Resistance Bands Arm Exercise: Overhead Triceps Extension' },
    ],
    photos: { id: 'Speed_Band_Overhead_Triceps', caption: 'Band behind your head, elbows up, straighten your arms.' },
  },
  band_crunch: {
    name: 'Band kneeling crunches',
    kind: 'small', stat: 'vit',
    harder: 'Use a thicker band, pause for a second at the bottom and go slower.',
    video: { id: 'imWlkp8w1I4', title: 'HOW TO DO Kneeling Abs Crunch With Resistance Bands' },
    more: [
      { id: 'sCG0Zpcm8TA', title: 'Learn how to do Kneeling Abs Crunch (Back to Door) with resistance bands' },
      { id: 'SJRcceBnr84', title: 'Best Abs Exercise: Banded Ab Crunch (Standing or Kneeling)' },
    ],
    photos: { id: 'Cable_Crunch', caption: 'Shown with a cable. With a band anchored high on the door it is the same movement.' },
  },
  hollow: {
    name: 'Hollow body hold',
    kind: 'small', stat: 'vit', timed: true,
    harder: 'Straighten your legs and move your arms overhead, lower both closer to the floor, and hold longer.',
    video: { id: 'hf00_b2sRdc', title: "How to Perfect Your Hollow Hold | Form Check | Men's Health" },
    more: [{ id: 'HAfUt2Cco74', title: 'HOLLOW BODY HOLD Progressions (Beginner to Advanced)' }],
  },
};

// Each slot: sets, rep range (min/max). amrap = as many reps as possible.
// unit 'sec' = timed hold. perLeg = reps are counted per leg.
export const WORKOUTS = {
  back: {
    name: 'Back & width',
    short: 'Back',
    tag: 'The V-taper day',
    days: 'Mon · Fri',
    slots: [
      { ex: 'wide_pullup', sets: 4, amrap: true },
      { ex: 'chinup', sets: 3, amrap: true },
      { ex: 'band_row', sets: 3, min: 12, max: 15, note: 'Anchor the band at door handle height' },
      { ex: 'band_lateral', sets: 4, min: 15, max: 20, note: 'These widen your shoulders' },
      { ex: 'face_pull', sets: 3, min: 15, max: 20 },
      { ex: 'band_curl', sets: 2, min: 12, max: 15 },
    ],
  },
  legs_heavy: {
    name: 'Legs, heavy',
    short: 'Legs',
    tag: 'Heavy leg day',
    days: 'Tue',
    legs: true,
    slots: [
      { ex: 'bulgarian', sets: 4, min: 8, max: 12, perLeg: true, note: 'Back foot on the bed, backpack on' },
      { ex: 'pistol', sets: 3, min: 5, max: 8, perLeg: true },
      { ex: 'nordic', sets: 3, min: 4, max: 8, note: 'Heels under the bed frame' },
      { ex: 'hip_thrust', sets: 3, min: 10, max: 15, note: 'Shoulders on the bed, backpack on hips' },
      { ex: 'calf_raise', sets: 4, min: 15, max: 15, perLeg: true, note: 'On a step' },
    ],
  },
  push: {
    name: 'Push & shoulders',
    short: 'Push',
    tag: 'Shoulders, chest, triceps',
    days: 'Wed · Sun',
    slots: [
      { ex: 'pike', sets: 4, min: 6, max: 12, note: 'Feet on the bed, working up to wall handstand push-ups' },
      { ex: 'decline', sets: 4, min: 8, max: 15, note: 'Feet on the bed, or a harder variation' },
      { ex: 'chair_dips', sets: 3, min: 8, max: 12, note: 'Chair against the wall' },
      { ex: 'band_lateral', sets: 4, min: 15, max: 20 },
      { ex: 'pushdown', sets: 2, min: 12, max: 15, note: 'Anchor the band at the top of the door' },
    ],
  },
  legs_core: {
    name: 'Legs & core',
    short: 'Legs + core',
    tag: 'Power, balance, abs',
    days: 'Sat',
    legs: true,
    slots: [
      { ex: 'jump_squat', sets: 3, min: 10, max: 10 },
      { ex: 'bulgarian', sets: 3, min: 10, max: 10, perLeg: true },
      { ex: 'sl_rdl', sets: 3, min: 10, max: 10, perLeg: true, note: 'Backpack in hand' },
      { ex: 'hanging_leg_raise', sets: 3, min: 10, max: 15, note: 'On the bar' },
      { ex: 'hollow', sets: 3, min: 30, max: 45, unit: 'sec' },
    ],
  },
};

export const WORKOUT_ORDER = ['back', 'legs_heavy', 'push', 'legs_core'];

// Monday-first week. Thursday is the rest day.
export const WEEK = ['back', 'legs_heavy', 'push', 'rest', 'back', 'legs_core', 'push'];

export const RULES = [
  'Rest 1.5-2 minutes between sets on the big exercises and about 1 minute on bands and core.',
  'End every set with only 1-2 reps left in the tank.',
  'Write your reps down. When you hit the top of the range on every set, make it harder next time: add weight to the backpack, use a thicker band, or move to the next variation.',
  'If you played football that day, skip leg day and do the next session instead.',
  'Every 6-8 weeks, take an easy week with half the sets.',
];

// The A/B rotation (the default plan): two sessions done in order, A, B, A, B..., 4-6 times a week on
// whatever days you can. Built for a V-taper, arms and abs: lats, side delts and abs get work every
// session, every muscle is trained 2-3 times a week, and exercises load muscles in the stretched position.
export const AB_WORKOUTS = {
  a: {
    name: 'A · Back & biceps',
    short: 'A',
    tag: 'Lats, mid back, biceps, hamstrings, abs',
    slots: [
      { ex: 'wide_pullup', sets: 3, amrap: true, note: 'Full dead hang at the bottom. Once you get 12+ on every set, wear the backpack' },
      { ex: 'band_pulldown', sets: 2, min: 12, max: 20, note: 'Arms straight, pull the band to your thighs, big stretch at the top' },
      { ex: 'band_row', sets: 2, min: 10, max: 15, note: 'Door handle height, squeeze your shoulder blades together' },
      { ex: 'band_lateral', sets: 4, min: 15, max: 25, note: 'The V-taper maker. Last set: finish with half reps' },
      { ex: 'chinup', sets: 2, amrap: true, note: 'Slow on the way down' },
      { ex: 'band_curl', sets: 3, min: 10, max: 15, note: 'Stand on the band so it is tight at the bottom' },
      { ex: 'sl_rdl', sets: 3, min: 8, max: 12, perLeg: true, note: 'Backpack in hand' },
      { ex: 'hanging_leg_raise', sets: 3, min: 10, max: 15, note: 'On a doorway bar, bend your knees and curl your hips up' },
    ],
  },
  b: {
    name: 'B · Shoulders, chest & triceps',
    short: 'B',
    tag: 'Delts, chest, triceps, quads, abs',
    slots: [
      { ex: 'pike', sets: 4, min: 6, max: 12, note: 'Feet on the bed. Next step: wall handstand push-ups' },
      { ex: 'decline', sets: 3, min: 8, max: 15, note: 'Feet on the bed, hands on two chairs or books so you can go deeper' },
      { ex: 'chair_dips', sets: 3, min: 8, max: 12, note: 'Chair against the wall. Go deep only if your shoulders feel good' },
      { ex: 'band_tri_ext', sets: 3, min: 10, max: 15, note: 'Elbows up by your ears, full stretch behind your head' },
      { ex: 'band_lateral', sets: 4, min: 15, max: 25 },
      { ex: 'face_pull', sets: 2, min: 15, max: 20, note: 'Rear delts, for the 3D shoulder look' },
      { ex: 'bulgarian', sets: 3, min: 8, max: 12, perLeg: true, note: 'Back foot on the bed, backpack on' },
      { ex: 'band_crunch', sets: 3, min: 10, max: 15, note: 'Kneel with your back to the door, curl your ribs down to your hips' },
    ],
  },
};

export const RULES_AB = [
  'Do the next session in order: A, B, A, B... 5 or 6 times a week works best, 4 is the minimum. Any days you like. Missed a day? Just do the next one.',
  'Take every set to 1-2 reps short of failure. On band and ab exercises, take the last set all the way.',
  'Use the full range, especially the stretch: dead hang on pull-ups, deep push-ups, elbows by your ears on triceps. When you can\u2019t do another full rep, add a few half reps in the stretched part.',
  'Rest about 2 minutes on the big exercises and about 1 minute on bands and abs.',
  'Write your reps down. When you hit the top of the range on every set, make it harder next time: more weight in the backpack, a thicker band, or the next variation.',
  'Played football today? Skip the leg exercises and do the rest of the session.',
  'Every 6-8 weeks, take an easy week with half the sets.',
  'Eat 1.6-2.2 g of protein per kg of bodyweight a day and sleep 7-9 hours. Abs show when body fat is low, so bulk to build and cut to reveal. Train the same way in both.',
];

// Plans the app can run. 'rotation' plans follow the order on any day; 'week' plans use fixed weekdays.
export const TEMPLATES = {
  ab: { id: 'ab', label: 'A/B rotation', mode: 'rotation', workouts: AB_WORKOUTS, order: ['a', 'b'], rules: RULES_AB },
  weekly: { id: 'weekly', label: 'Weekly split (the original plan)', mode: 'week', workouts: WORKOUTS, order: WORKOUT_ORDER, week: WEEK, rules: RULES },
};

// Lines taken from the motivation pics this app's look is based on.
export const QUOTES = [
  { text: 'Discipline: the practice of doing what you don\u2019t want to do.' },
  { text: 'Your maximum is someone else\u2019s minimum.' },
  { text: 'Self discipline is what separates you.' },
  { text: 'Don\u2019t stop until you win.' },
  { text: 'Become so relentless in your craft that the world has no choice but to give in.' },
  { text: 'Nobody cares. Work harder.' },
  { text: 'I failed. I learned.' },
  { text: 'Keep trying, even when it feels pointless.' },
  { text: 'No rich parents, just hard work.' },
  { text: 'Alter your thinking.' },
  { text: 'Ego. Discipline. Talent. Hard work. Genius.' },
  { text: 'Take it easy, it\u2019s just dunya.' },
  { text: 'I prayed for what I wanted, then I left it to Allah.' },
  { text: 'Speak good or be silent.', by: 'Prophet Muhammad \uFDFA' },
  { text: 'Don\u2019t be sad, Allah is with us.', ar: '\u0644\u064E\u0627 \u062A\u064E\u062D\u0652\u0632\u064E\u0646\u0652 \u0625\u0650\u0646\u0651\u064E \u0627\u0644\u0644\u0651\u064E\u0647\u064E \u0645\u064E\u0639\u064E\u0646\u064E\u0627', by: 'Quran 9:40' },
];
