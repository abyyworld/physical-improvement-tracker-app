// @vitest-environment jsdom
// The intro starts with the person and what Arise can see of their days, with nothing to rate:
// their name, then their phone and computer, then a goal only if they want one, so the workout
// answers are kept only with the workout plan. Then the life check-in on its own (optional, from
// Me), and the coach's message on Today without an AI.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as LC from './lib/life-check';

vi.mock('./lib/firebase', () => import('./test/fake-firebase'));

// Each boot starts the whole app again: the listeners the last one added go first.
const added: [EventTarget, string, EventListenerOrEventListenerObject, unknown][] = [];
for (const target of [document, window]) {
  const add = target.addEventListener.bind(target);
  target.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: unknown) => {
    added.push([target, type, fn, opts]);
    add(type, fn, opts as AddEventListenerOptions);
  }) as typeof target.addEventListener;
}

// Starts the app on Today with this saved data (and anything else already on the device).
async function boot(data: object | null, device: Record<string, string> = {}) {
  for (const [target, type, fn, opts] of added.splice(0)) target.removeEventListener(type, fn, opts as EventListenerOptions);
  vi.resetModules();
  localStorage.clear();
  if (data) localStorage.setItem('pit-data-v1', JSON.stringify(data));
  for (const [k, v] of Object.entries({ 'arise-look-hint': 'seen', ...device })) localStorage.setItem(k, v);
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-mode');
  document.body.innerHTML = '<nav id="tabs"></nav><main id="app"></main><div id="restbar" hidden></div><div id="sheet" hidden><div class="sheet-panel"><button class="sheet-close"></button><div class="sheet-body"></div></div></div><div id="toast"></div><input type="file" id="importFile" hidden>';
  history.replaceState(null, '', '#today');
  const S = await import('./store');
  await import('./app.js');
  return S;
}
const $ = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const $$ = (sel: string) => [...document.querySelectorAll(sel)] as HTMLElement[];
const text = (sel: string) => ($(sel)?.textContent || '').replace(/\s+/g, ' ').trim();
const texts = (sel: string) => $$(sel).map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim());
const click = (sel: string) => $(sel)!.click();
const type = (sel: string, value: string) => {
  const el = $(sel) as HTMLInputElement;
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
const tick = () => new Promise((r) => setTimeout(r, 0));

const next = () => click('#onboard [data-ob="next"]');
const question = () => text('#onboard .ob-q');
const counter = () => text('#onboard .ob-count');
const rate = (area: string, n: number) => click(`#onboard [data-ob="rate"][data-k="${area}"][data-v="${n}"]`);
// What's picked: "sleep 2" for a rating, else the choice itself.
const pressed = (kind: string) => $$(`#onboard [data-ob="${kind}"][aria-pressed="true"]`).map((b) => (kind === 'rate' ? `${b.dataset.k} ${b.dataset.v}` : b.dataset.v));
// Taps "Next" until the question (or the last screen) shows.
const nextUntil = (q: string) => {
  for (let n = 0; n < 12 && question() !== q && !$('#onboard [data-ob="finish"]'); n++) next();
  expect(question()).toBe(q);
};
const toEnd = () => {
  for (let n = 0; n < 12 && !$('#onboard [data-ob="finish"]'); n++) next();
  expect($('#onboard [data-ob="finish"]')).not.toBeNull();
};
// A tap on something on the app's screens, through its own click handling.
const act = async (name: string) => {
  const b = document.createElement('button');
  b.dataset.act = name;
  $('#app')!.append(b);
  b.click();
  await tick();
  await tick();
};
const WORKOUT_ANSWERS = ['pullups', 'pushups', 'pistol', 'equipment'];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 9, 12)); // Friday 9 October 2026
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  window.scrollTo = () => {};
});
afterEach(() => vi.useRealTimers());

describe('the intro', () => {
  it('starts with the person and their devices, and a walk with no goal saves no ratings and no goal', async () => {
    const S = await boot(null);
    expect($('#onboard')!.getAttribute('aria-label')).toBe('Set up Arise');
    expect(text('#onboard .ob-lead')).toBe('A private coach for your whole life, not just one goal.');
    expect($$('#onboard .ob-points li').map((li) => li.textContent!.replace(/\s+/g, ' ').trim())).toEqual([
      'Your days, written for youArise reads what your phone, watch and computer already record. Nothing to fill in.',
      'See what helpsIt finds what goes with your best days: sleep, people, work, screens and more.',
      "A coach that sees the whole youNot just one goal. It's honest, it can question a goal, and it never nags. Nobody else can read it.",
    ]);
    expect(text('#onboard .ob-body')).not.toMatch(/check-in|rate/i);
    next();
    type('#onboard [data-obk="name"]', 'Sam');
    next();

    // What Arise can see, with nothing to fill in: no ratings.
    expect(question()).toBe('Let Arise see your days');
    expect(counter()).toBe('Step 2 of 6');
    expect(text('#onboard .ob-body > p.muted')).toBe('Arise works out how you sleep, move, focus and spend your time from what your devices already record. Nothing to fill in.');
    expect($$('#onboard .ob-rate')).toHaveLength(0);
    expect(text('#onboard .ob-skip')).toBe('Do this later');
    next();

    // The goal is optional.
    expect(question()).toBe("Anything you're working toward?");
    expect(counter()).toBe('Step 3 of 6');
    expect(text('#onboard .ob-skip')).toBe('Not now');
    expect(pressed('pick')).toEqual([]); // no kind of goal picked for them
    next(); // empty: on to the next question, no "write your goal first"
    expect(text('#toast')).toBe('');
    expect(question()).toBe('How your days go');
    expect(text('#onboard .ob-body')).toContain('Best time of day for you');
    nextUntil('Your AI coach');
    expect(text('#onboard .ob-body')).toContain("Your coach's daily message, reflections on your day, chat and quest ideas come from an AI. What Arise sees in your days, and the patterns on the Me tab, are worked out on this device with no AI.");
    toEnd();

    expect(text('#onboard h2')).toBe("You're all set");
    expect(text('#onboard .ob-lead')).toBe("Sam, here's what happens next.");
    expect($('#onboard .ob-read')).toBeNull(); // no ratings to sum up
    expect($$('#onboard .changes li').map((li) => li.textContent)).toEqual([
      'Arise writes your days and works out how your life is going by itself. The more you connect, the more it knows.',
      'After a week or so, the Me tab starts showing what goes with your good days.',
      'Nothing to fill in. Say how you feel on Today only when you want to.',
    ]);
    expect(text('#onboard .ob-body')).toContain('Set a goal any time on the Goals tab.');
    expect(text('#onboard [data-ob="finish"]')).toBe('Start');

    expect(S.state.goals).toEqual([]);
    const p = S.state.profile as Record<string, unknown>;
    expect(p).toMatchObject({ name: 'Sam', goal: '', onboarded: true });
    expect(p.life).toBeUndefined();
    expect(p.lifeBefore).toBeUndefined();
    for (const k of WORKOUT_ANSWERS) expect(p, k).not.toHaveProperty(k);
    expect(S.state.body.entries).toEqual([]);
    expect(S.state.logs).toEqual({}); // the intro writes no check-ins

    click('#onboard [data-ob="finish"]');
    expect($('#onboard')).toBeNull();
  });

  it('shows the phone and the computer: the apps to get, and on a Mac the helper to install', async () => {
    const ua = Object.getOwnPropertyDescriptor(window.navigator, 'userAgent');
    Object.defineProperty(window.navigator, 'userAgent', { value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36', configurable: true });
    try {
      await boot(null);
      next();
      next();
      expect(question()).toBe('Let Arise see your days');
      const rows = $$('#onboard .ob-conn');
      expect(rows.map((r) => r.querySelector('.ob-conn-head')!.textContent!.trim())).toEqual(['Your phone', 'This computer']);
      expect($('#onboard .ob-conn a[href$="#the-iphone-app"]')!.textContent!.trim()).toBe('Get the iPhone app');
      expect($('#onboard .ob-conn a[href$="Arise.apk"]')!.textContent).toBe('Get the Android app');
      expect(text('#onboard #macCmd')).toContain('mac-helper/install.sh');
      expect($('#onboard [data-act="mac-copy"]')).not.toBeNull();
      expect(text('#onboard .ob-connect')).toContain('Browser extension. Notes the sites you visit and your time on each. Add it in Days, Connect.');
      expect(text('#onboard .ob-later')).toBe('You can do this any time in Days, Connect. Everything is worked out on your devices, and nobody else can see it, not even Arise.');
      // Later: on to the goal, nothing saved.
      click('#onboard .ob-skip');
      expect(question()).toBe("Anything you're working toward?");
    } finally {
      if (ua) Object.defineProperty(window.navigator, 'userAgent', ua);
      else delete (window.navigator as { userAgent?: string }).userAgent;
    }
    // Not on a Mac: only the browser extension for this computer.
    await boot(null);
    next();
    next();
    expect($('#onboard #macCmd')).toBeNull();
    expect(text('#onboard .ob-conn:last-of-type .ob-conn-head')).toBe('This computer');
    expect(texts('#onboard .ob-conn:last-of-type p.small')).toEqual(['Browser extension. Notes the sites you visit and your time on each. Add it in Days, Connect.']);
  });

  it('keeps the workout answers and the weigh-in with the workout plan, saved in the old order', async () => {
    const S = await boot(null);
    next();
    nextUntil("Anything you're working toward?");
    click('#onboard [data-ob="pick"][data-k="category"][data-v="fitness"]');
    type('#onboard [data-obk="goal"]', 'Get strong');
    next();
    expect(question()).toBe('Why does it matter to you?');
    next();
    expect(question()).toBe('Your daily quests');
    click('#onboard [data-ob="workouts"]');
    next();
    expect(question()).toBe('Where are you starting?');
    expect(counter()).toBe('Step 6 of 9');
    click('#onboard [data-ob="pick"][data-k="pistol"][data-v="Yes"]');
    type('#onboard [data-obk="weight"]', '72.5');
    toEnd();

    expect(text('#onboard .ob-lead')).toBe('Your goal: Get strong.');
    const g = S.state.goals[0];
    expect(g).toMatchObject({ title: 'Get strong', category: 'fitness', workouts: true });
    const p = S.state.profile as Record<string, unknown>;
    expect(p).toMatchObject({ goal: 'Get strong', pullups: 5, pushups: 20, pistol: 'Yes' });
    expect(p.equipment).toContain('Pull-up bar');
    expect(p.life).toBeUndefined(); // nothing answered about their life
    expect(S.state.body.entries.map((e) => e.weight)).toEqual([72.5]);
    // The weigh-in, then the goal, then the profile: the intro's weigh-in still counts as nothing done.
    expect(S.state.body.entries[0].at!).toBeLessThanOrEqual(g.updated);
    expect(g.updated).toBeLessThanOrEqual(p.updated as number);
    expect(S.nothingDone(S.state)).toBe(true);
    expect(S.introOnly()).toBe(true);
  });

  it("keeps none of the workout answers with another goal, and counts its two extra questions", async () => {
    const S = await boot(null);
    next();
    nextUntil("Anything you're working toward?");
    type('#onboard [data-obk="goal"]', 'Read more');
    next();
    expect(question()).toBe('Why does it matter to you?');
    expect(counter()).toBe('Step 4 of 8');
    toEnd();
    expect(text('#onboard .ob-lead')).toBe('Your goal: Read more.');
    expect(text('#onboard .ob-body')).toContain('Today starts with what Arise saw in your day, then your quests.');
    expect(text('#onboard .ob-body')).not.toMatch(/check-in/);
    expect(S.state.goals.map((g) => [g.title, g.category, !!g.workouts])).toEqual([['Read more', 'other', false]]);
    for (const k of WORKOUT_ANSWERS) expect(S.state.profile, k).not.toHaveProperty(k);
  });

  it('takes "Not now" on the goal as no goal, even one half typed', async () => {
    const S = await boot(null);
    next();
    nextUntil("Anything you're working toward?");
    type('#onboard [data-obk="goal"]', 'Learn');
    click('#onboard .ob-skip');
    expect(question()).toBe('How your days go');
    expect(counter()).toBe('Step 4 of 6');
    toEnd();
    expect(text('#onboard .ob-lead')).toBe("Here's what happens next.");
    expect(S.state.goals).toEqual([]);
  });

  it('clears a rating tapped twice, keeps two parts to grow and three things that matter, in the life check-in', async () => {
    const S = await boot({ sessions: [], profile: { name: 'Sam', onboarded: true } });
    await act('life-checkin');
    expect(question()).toBe('How is your life right now?');
    rate('sleep', 3);
    rate('sleep', 3);
    expect(pressed('rate')).toEqual([]);
    expect(text('#onboard [data-rated="sleep"]')).toBe('Sleep');
    rate('money', 4);
    rate('money', 2); // another number moves it
    expect(pressed('rate')).toEqual(['money 2']);
    next();

    // A third part to grow drops the one picked first.
    for (const a of ['sleep', 'money', 'fun']) click(`#onboard [data-ob="grow"][data-v="${a}"]`);
    expect(pressed('grow')).toEqual(['money', 'fun']);
    // A fourth thing that matters isn't taken.
    for (const v of ['Family', 'Health', 'Faith']) click(`#onboard [data-ob="value"][data-v="${v}"]`);
    click('#onboard [data-ob="value"][data-v="Calm"]');
    expect(text('#toast')).toBe('Pick up to three.');
    expect(pressed('value')).toEqual(['Family', 'Health', 'Faith']);
    click('#onboard [data-ob="value"][data-v="Health"]');
    click('#onboard [data-ob="value"][data-v="Calm"]');
    expect(pressed('value')).toEqual(['Family', 'Faith', 'Calm']);
    toEnd();
    expect((S.state.profile as { life: LC.Life }).life).toMatchObject({ areas: { money: 2 }, grow: ['money', 'fun'], values: ['Family', 'Faith', 'Calm'], hope: '' });
  });

  it('suggests starting small when they said sleep is the hardest part right now, and starts the goal where they want to grow', async () => {
    // Rated before (the life check-in, synced from another device): the intro keeps it as it was.
    const life = { at: '2026-09-15', areas: { sleep: 1 }, grow: ['money'], values: [], hope: '' };
    const S = await boot({ profile: { life } });
    next();
    nextUntil("Anything you're working toward?");
    expect(pressed('pick')).toEqual(['money']); // growing money first: a money goal to start from
    click('#onboard [data-ob="pick"][data-k="category"][data-v="fitness"]');
    type('#onboard [data-obk="goal"]', 'Run a 10k');
    nextUntil('Your daily quests');
    expect(text('#onboard .ob-body')).toContain('You said sleep is rough right now, so start with one or two. You can add more once they stick.');
    toEnd();
    expect(S.state.profile?.life).toEqual(life);
    expect(S.state.profile).not.toHaveProperty('lifeBefore');
  });

  it('asks the same in the System look, in its words', async () => {
    const S = await boot({ settings: { look: 'system' } });
    expect(text('#onboard .ob-body')).toContain('The System reads your whole life, not one goal: it watches your days through your devices and gives you quests your life can carry. Nothing to fill in.');
    expect(text('#onboard [data-ob="next"]')).toBe('Begin');
    next();
    next();
    expect(question()).toBe('Let Arise see your days');
    expect(text('#onboard .sys-line')).toBe('[System] Link your devices');
    expect($$('#onboard .ob-rate')).toHaveLength(0);
    toEnd();
    expect(text('#onboard h2')).toBe('Quest log ready');
    expect(text('#onboard .ob-lead')).toBe("Player, here's what happens next.");
    expect(text('#onboard .ob-body')).toContain('the Progress tab starts showing');
    expect(text('#onboard [data-ob="finish"]')).toBe('Enter');
    expect(S.state.profile?.tone).toEqual(['The System (Solo Leveling)']);
  });

  it('lists the tones with the calm one first', async () => {
    await boot(null);
    next();
    nextUntil('How should your coach talk to you?');
    expect($$('#onboard [data-k="tone"]').map((b) => b.dataset.v)).toEqual(['Calm and kind', 'Strict coach', 'Funny', 'Faith-centred (Islam)', 'The System (Solo Leveling)']);
    expect(pressed('multi')).toEqual(['Calm and kind']);
  });

  it('edits the profile from Settings without ratings, the goal or the workout questions', async () => {
    const S = await boot({ profile: { name: 'Sam', onboarded: true, pullups: 8, equipment: ['Pull-up bar'], life: { at: '2026-09-15', areas: { sleep: 2 }, grow: [], values: [], hope: '' } } });
    await act('onboard');
    expect($('#onboard')!.getAttribute('aria-label')).toBe('Edit your profile');
    expect(counter()).toBe('Step 1 of 3');
    next();
    expect(question()).toBe('How your days go');
    expect($$('#onboard .ob-rate')).toHaveLength(0);
    // The life check-in, left as it was, keeps its date.
    toEnd();
    expect(text('#onboard h2')).toBe('Profile saved');
    expect(S.state.profile).toMatchObject({ pullups: 8, equipment: ['Pull-up bar'], life: { at: '2026-09-15', areas: { sleep: 2 } } });
    expect(S.state.profile).not.toHaveProperty('lifeBefore');
  });
});

describe('the life check-in on its own', () => {
  const sam = (life?: object) => ({ sessions: [], profile: { name: 'Sam', onboarded: true, ...(life ? { life } : {}) } });

  it('asks only the life questions, and shows what changed since the last one', async () => {
    const S = await boot(sam({ at: '2026-09-15', areas: { sleep: 2, money: 3 }, grow: ['sleep'], values: ['Family'], hope: 'Calm' }));
    await act('life-checkin');
    expect($('#onboard')!.getAttribute('aria-label')).toBe('Life check-in');
    expect(counter()).toBe('Step 1 of 2');
    expect(question()).toBe('How is your life right now?');
    expect(pressed('rate')).toEqual(['sleep 2', 'money 3']); // starts from the last one
    expect($('#onboard .ob-close')).not.toBeNull();
    rate('sleep', 3);
    rate('money', 2);
    next();
    expect(counter()).toBe('Step 2 of 2');
    expect(question()).toBe('Where do you want to grow?');
    expect(pressed('grow')).toEqual(['sleep']);
    next();

    expect(text('#onboard h2')).toBe('Saved');
    expect(text('#onboard .ob-lead')).toBe("Here's where you are.");
    expect($$('#onboard .ob-read li').length).toBeGreaterThan(0);
    expect(text('#onboard p.small')).toBe('Since 15 Sep: Sleep 2 → 3, Money 3 → 2.');
    expect(text('#onboard [data-ob="finish"]')).toBe('Done');
    const p = S.state.profile as Record<string, unknown>;
    expect(p.life).toEqual({ at: '2026-10-09', areas: { sleep: 3, money: 2 }, grow: ['sleep'], values: ['Family'], hope: 'Calm' });
    expect(p.lifeBefore).toEqual({ at: '2026-09-15', areas: { sleep: 2, money: 3 } });
    expect(p.name).toBe('Sam');
    click('#onboard [data-ob="finish"]');
    expect($('#onboard')).toBeNull();

    // Again the same day: the one before stays the one from September.
    await act('life-checkin');
    rate('sleep', 4);
    next();
    next();
    expect(text('#onboard p.small')).toBe('Since 15 Sep: Sleep 2 → 4, Money 3 → 2.');
    expect(S.state.profile).toMatchObject({ life: { at: '2026-10-09', areas: { sleep: 4, money: 2 } }, lifeBefore: { at: '2026-09-15' } });
  });

  it('says the same when nothing moved', async () => {
    await boot(sam({ at: '2026-09-15', areas: { sleep: 2 }, grow: [], values: [], hope: '' }));
    await act('life-checkin');
    next();
    next();
    expect(text('#onboard p.small')).toBe('Same as on 15 Sep.');
  });

  it('saves nothing when nothing is answered', async () => {
    const S = await boot(sam());
    await act('life-checkin');
    next();
    next();
    expect(text('#onboard h2')).toBe('Saved');
    expect(text('#onboard .ob-lead')).toBe('Nothing saved. You can check in any time.');
    expect($('#onboard .ob-read')).toBeNull();
    expect(S.state.profile).not.toHaveProperty('life');
  });

  it('closes without saving, with the close button or Escape', async () => {
    const S = await boot(sam({ at: '2026-09-15', areas: { sleep: 2 }, grow: [], values: [], hope: '' }));
    await act('life-checkin');
    rate('sleep', 5);
    click('#onboard [data-ob="cancel"]');
    expect($('#onboard')).toBeNull();
    expect(document.body.classList.contains('onboarding')).toBe(false);

    await act('life-checkin');
    rate('sleep', 5);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect($('#onboard')).toBeNull();
    expect((S.state.profile as { life: LC.Life }).life).toMatchObject({ at: '2026-09-15', areas: { sleep: 2 } });
  });

  it("can't be closed by Escape in the first intro", async () => {
    await boot(null);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect($('#onboard')).not.toBeNull();
    expect($('#onboard .ob-close')).toBeNull();
  });
});

describe("the coach's message without an AI", () => {
  const life = (areas: object, grow: string[] = []) => ({ at: '2026-10-01', areas, grow, values: [], hope: '' });
  const message = () => text('.sysmsg-text');

  it('never asks someone new to rate anything, and adds one line on a part of life they rated low', async () => {
    const NEW = 'Arise writes your day as it goes, with nothing to fill in. Set a goal when something matters enough to work on.';
    await boot({ sessions: [], profile: { name: 'Sam', onboarded: true, life: life({ sleep: 2 }, ['sleep']) } });
    expect(message()).toBe(`Sam. ${NEW} You said sleep is hard right now. Protect tonight's sleep.`);

    await boot({ sessions: [], profile: { name: 'Sam', onboarded: true } });
    expect(message()).toBe(`Sam. ${NEW}`);
    expect(message()).not.toMatch(/check-in|rate/i);

    await boot({ sessions: [], profile: { onboarded: true, life: life({ people: 5 }, ['meaning']) }, logs: { '2026-10-09': { m: 4, at: 1 } } });
    expect(message()).toBe(`${NEW} You picked Purpose to grow first. One small step for it today counts.`);
  });

  it('asks for less on a hard day', async () => {
    await boot({ sessions: [], profile: { name: 'Sam', onboarded: true, life: life({ sleep: 2 }) }, logs: { '2026-10-09': { s: 2, at: 1 } } });
    expect(message()).toBe('Sam. Hard start today. Do the smallest version of one thing that matters, and let the rest wait.');

    // With the workout plan and a session waiting, a rest day is fine too.
    const session = (date: string, workout = 'a') => ({ id: `s${date.replace(/-/g, '')}`, workout, date, started: 1, finished: 2, easy: false, items: [{ ex: 'band_row', setup: '', sets: [{ r: 10, done: true }] }] });
    await boot({ sessions: [session('2026-10-07'), session('2026-10-08', 'b')], profile: { name: 'Sam', onboarded: true }, logs: { '2026-10-09': { e: 1, at: 1 } } });
    expect(message()).toBe('Sam. 2-day streak. Hard start today. Do the smallest version of one thing that matters, and let the rest wait. A rest day is fine if you need one.');
  });

  it('turns to a different low part of life each day', async () => {
    const said = new Set<string>();
    for (const day of [9, 10, 11]) {
      vi.setSystemTime(new Date(2026, 9, day, 12));
      await boot({ sessions: [], profile: { onboarded: true, life: life({ sleep: 2, money: 1 }, ['meaning']) } });
      said.add(message().replace('Arise writes your day as it goes, with nothing to fill in. Set a goal when something matters enough to work on. ', ''));
    }
    expect(said).toEqual(new Set([LC.AREAS.money.said, LC.AREAS.sleep.said, 'You picked Purpose to grow first. One small step for it today counts.']));
  });

  it('names the quests in plain words in the Arise look, and in brackets in the System look', async () => {
    const goals = [{ id: 'g1', title: 'Speak Spanish', category: 'learning', quests: [{ id: 'q1', title: 'Study 20 minutes', schedule: { kind: 'daily' }, created: '2026-10-01' }] }];
    await boot({ sessions: [], goals, profile: { name: 'Sam', onboarded: true } });
    expect(message()).toBe('Sam. Study 20 minutes is waiting.');
    expect(message()).not.toMatch(/\[|Player|System|Everything leads to/);

    await boot({ sessions: [], goals, settings: { look: 'system' }, profile: { onboarded: true } });
    expect(message()).toBe('Player. [Study 20 minutes] is waiting.');
  });
});
