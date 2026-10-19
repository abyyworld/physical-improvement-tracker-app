// @vitest-environment jsdom
// Today, top to bottom: the day so far with what Arise saw (worked out on the device, nothing to
// fill in) and how they feel if they want to say, yesterday, the coach's message, then the to-dos
// (the workout and quests, or a small step or a goal for someone with none). The right column: You
// lately with each part of life worked out from their days, and what matters to them or a quote
// that suits their tone.

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LifeEvent } from './life/types';

vi.mock('./lib/firebase', () => import('./test/fake-firebase'));

const T = (k: string, h = 12, m = 0) => {
  const [y, mo, d] = k.split('-').map(Number);
  return new Date(y, mo - 1, d, h, m).getTime();
};
const TODAY = '2026-10-09'; // a Friday
const session = (date: string, workout = 'a') => ({ id: `s${date.replace(/-/g, '')}`, workout, date, started: 1, finished: 2, easy: false, items: [{ ex: 'band_row', setup: '', sets: [{ r: 10, done: true }] }] });
// Someone with the workout plan (two workouts make it, see store.ts migrate).
const planUser = { sessions: [session('2026-10-07'), session('2026-10-08', 'b')], profile: { name: 'Sam', onboarded: true } };
// Someone who skipped the intro: no goal, no plan.
const skipped = { profile: { onboarded: true, skipped: true } };
const LIFE = { at: TODAY, areas: { sleep: 2, body: 3, mind: 3, people: 5, work: 2, money: 3, fun: 2, meaning: 3 }, grow: ['sleep', 'meaning'], values: ['Family', 'Health', 'Faith'], hope: 'See my family more.' };

// Each boot starts the whole app again: the listeners the last one added go first.
const added: [EventTarget, string, EventListenerOrEventListenerObject, unknown][] = [];
for (const target of [document, window]) {
  const add = target.addEventListener.bind(target);
  target.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: unknown) => {
    added.push([target, type, fn, opts]);
    add(type, fn, opts as AddEventListenerOptions);
  }) as typeof target.addEventListener;
}

// Starts the app on `view` with this saved data. `keep`: this device's storage and life log stay
// as the last boot left them (a reopen, maybe days later).
async function boot(view: string, data: object | null, { events = [] as LifeEvent[], keep = false } = {}) {
  for (const [target, type, fn, opts] of added.splice(0)) target.removeEventListener(type, fn, opts as EventListenerOptions);
  vi.resetModules();
  if (!keep) {
    globalThis.indexedDB = new IDBFactory();
    localStorage.clear();
    localStorage.setItem('arise-look-hint', 'seen');
    if (data) localStorage.setItem('pit-data-v1', JSON.stringify(data));
  }
  document.body.innerHTML = '<nav id="tabs"></nav><main id="app"></main><div id="restbar" hidden></div><div id="sheet" hidden><div class="sheet-panel"><button class="sheet-close"></button><div class="sheet-body"></div></div></div><div id="toast"></div><input type="file" id="importFile" hidden>';
  history.replaceState(null, '', `#${view}`);
  const L = await import('./life/log');
  if (events.length) await L.addEvents(events);
  const S = await import('./store');
  await import('./app.js');
  return { S, L };
}
const $ = (sel: string) => document.querySelector<HTMLElement>(sel);
const $$ = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
const text = (sel: string) => $(sel)?.textContent?.replace(/\s+/g, ' ').trim() || '';
// Each child's text, for a row of small parts (chips, a stat).
const parts = (sel: string) => [...($(sel)?.children || [])].map((c) => c.textContent!.trim());
const click = (sel: string) => $(sel)!.click();
// Reading the life log can take a while on a busy machine.
const SLOW = { timeout: 4000 };
// The last `n` days up to `last`, oldest first.
const daysTo = (last: string, n: number) =>
  Array.from({ length: n }, (_, i) => {
    const d = new Date(T(last));
    d.setDate(d.getDate() - (n - 1 - i));
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
// A night that ended on the morning of `k`, from Apple Health; the day's steps; time in an app on the Mac.
const night = (k: string, min: number): LifeEvent => ({ id: `health:sleep:${k}`, source: 'health', kind: 'sleep', at: T(k, 7) - min * 60000, end: T(k, 7), title: 'Slept', value: min, unit: 'min', tier: 3 });
const steps = (k: string, n: number): LifeEvent => ({ id: `health:day:${k}`, source: 'health', kind: 'steps', at: T(k, 0), end: T(k, 23, 59), title: `${n} steps`, value: n, unit: 'steps', tier: 2 });
const code = (k: string, h: number, min: number): LifeEvent => ({ id: `mac:app:code:${k}:${h}`, source: 'mac', kind: 'app', at: T(k, h), end: T(k, h, min), title: `Used Visual Studio Code for ${min} min`, value: min, unit: 'min', tier: 2, meta: { app: 'com.microsoft.VSCode' } });

// a comes before b on the page.
const before = (a: string, b: string) => !!($(a)!.compareDocumentPosition($(b)!) & Node.DOCUMENT_POSITION_FOLLOWING);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 9, 12)); // Friday 9 October 2026, noon
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  window.scrollTo = () => {};
});
afterEach(() => vi.useRealTimers());

describe('Today, top to bottom', () => {
  it('leads with the day, then yesterday, the coach, and then the workout, with nothing to rate', async () => {
    await boot('today', planUser);
    for (const [a, b] of [
      ['.glance', '#lifeRecap'],
      ['#lifeRecap', '.sysmsg'],
      ['.sysmsg', '#todo .quest'],
    ]) expect(before(a, b), `${a} before ${b}`).toBe(true);
    // No check-in card and no life check-in card: how they feel is one optional row in the day's card.
    expect($('#checkin')).toBeNull();
    expect($('.life-invite')).toBeNull();
    expect($('#dayCard #feel')).not.toBeNull();
    expect(before('#dayCard #daySeen', '#dayCard #feel')).toBe(true);
    expect(before('#dayCard #feel', '#dayCard .journal-entry')).toBe(true);
    expect(document.body.textContent).not.toMatch(/Check in|1 = drained/);
    expect($('#todo .quest')).toBe($('.quest')); // the workout is still the first quest card
    expect(text('.glance-hi')).toBe('Good afternoon, Sam');
    // Next jumps to the to-dos.
    expect(text('.glance-next[data-act="to-todo"]')).toBe('Next C · Speed & legs');
    // The journal's way in is the card's last row, not a banner of its own.
    expect($('#dayCard .journal-entry')).not.toBeNull();
    expect($$('.journal-entry')).toHaveLength(1);
    expect($('.glance-stats')).toBeNull(); // streak and level live in Your progress
    expect(text('#tabs [data-v="progress"]')).toBe('Me');
    // The week, with the plan.
    expect($('.week')).toBeNull(); // on Training now, with the rest of the training
  });

  it('is a plain record in the System look', async () => {
    await boot('today', { ...planUser, settings: { look: 'system' } });
    expect($('.glance')).toBeNull();
    expect($('.sys-day')).not.toBeNull();
    expect($('.sys-day.quest')).toBeNull();
    expect(text('.sys-day .sys-line')).toBe("[Today's record]");
    expect($('.sys-day #dayLine')).not.toBeNull();
    expect($('.sys-day .journal-entry')).not.toBeNull();
    expect(text('.quest .sys-line')).toBe('[Daily Quest: C · Speed & legs] has arrived.');
    expect(text('#tabs [data-v="progress"]')).toBe('Progress');
    // What Arise saw and how they feel, in the record too; no status check to fill in.
    expect($('.sys-day #daySeen')).not.toBeNull();
    expect($$('.sys-day #feel [data-act="feel"]')).toHaveLength(5);
    expect($('.life-invite')).toBeNull();
  });

  it('asks nothing of someone new: no goal card, nothing to rate, and a goal if they want one', async () => {
    await boot('today', skipped);
    expect(document.body.textContent).not.toContain('Your first goal');
    expect($('.quest.glow')).toBeNull();
    expect($('.quest')).toBeNull();
    expect(text('.goal-invite .panel-title')).toBe('A goal, if you want one');
    expect($('.goal-invite [data-act="g-new"]')).not.toBeNull();
    expect($('.week')).toBeNull(); // nothing to show a week of yet
    // No life check-in to do: Arise works it out.
    expect($('.life-invite')).toBeNull();
    expect($('#app [data-act="life-checkin"]')).toBeNull();
    // The day card is there for everyone, with no ring until something is due.
    expect($('.glance')).not.toBeNull();
    expect($('.gring')).toBeNull();
    expect($('.glance-next')).toBeNull();
  });

  it('never asks for a life check-in, even a month after the last one', async () => {
    await boot('today', { profile: { onboarded: true, life: { ...LIFE, at: '2026-09-01' } } });
    expect($('.life-invite')).toBeNull();
    expect(text('#app')).not.toContain("How's life now?");
  });

  it('offers one small step for the part of life they want to grow, as a goal with one quest', async () => {
    const { S } = await boot('today', { profile: { onboarded: true, life: { at: TODAY, areas: { sleep: 2 }, grow: ['sleep'], values: [], hope: '' } } });
    expect($('.goal-invite')).toBeNull();
    expect(text('.step-card .kicker')).toBe('A small step for Sleep?');
    expect(text('.step-card h3')).toBe('Lights out on time');
    expect(text('.step-card p.muted')).toBe('Every day. Small enough for a hard day. You can change or drop it any time.');
    expect($('.step-card.quest')).toBeNull();
    expect(text('.lately .goal-line')).toBe('Growing first: Sleep');
    expect(text('.game-line')).toBe('Level 1 · 0 XP'); // nothing due, so no streak to keep

    click('.step-card [data-act="step-add"]');
    expect(S.state.goals).toHaveLength(1);
    expect(S.state.goals[0]).toMatchObject({ title: 'Sleep better', category: 'health', status: 'active', quests: [{ title: 'Lights out on time', schedule: { kind: 'daily' }, created: TODAY }] });
    expect(S.state.goals[0].workouts).toBeUndefined();
    expect(text('#toast')).toBe("Added. It's on Today now.");
    expect($('.step-card')).toBeNull();
    expect(text('#todo .qtitle')).toBe('Lights out on time');
    expect(text('.lately .goal-line')).toBe('Growing first: Sleep'); // still what they want to grow
    expect(text('.game-line')).toBe('Level 1 · 0 XP · No streak yet'); // a quest is due now: a streak to keep
  });

  it('puts the small step off for a week, with a goal offered meanwhile', async () => {
    await boot('today', { profile: { onboarded: true, life: { at: TODAY, areas: { body: 2 }, grow: ['body'], values: [], hope: '' } } });
    expect(text('.step-card p.muted')).toBe('Every day, 30 min. Small enough for a hard day. You can change or drop it any time.');
    click('.step-card [data-act="step-later"]');
    expect($('.step-card')).toBeNull();
    expect($('.goal-invite')).not.toBeNull();
    expect(localStorage.getItem('arise-step-later')).toBe('2026-10-16');
  });
});

describe('how you feel', () => {
  it('is one optional tap: saved at once, cleared on a second tap, and the day gets its 5 XP once', async () => {
    const { S } = await boot('today', skipped);
    expect(text('#feel .feel-q')).toBe('How do you feel?');
    expect($$('#feel [data-act="feel"]').map((b) => b.getAttribute('aria-label'))).toEqual(['Low', 'Meh', 'Okay', 'Good', 'Great']);
    expect($('#feel [role="group"]')!.getAttribute('aria-labelledby')).toBe('feelQ');
    // Nothing else to rate: no sleep or energy.
    expect($$('[data-act="checkin"]')).toHaveLength(0);
    const meh = '#feel [data-act="feel"][data-n="2"]';

    click(meh);
    expect(S.state.logs[TODAY].m).toBe(2);
    expect(JSON.parse(localStorage.getItem('pit-data-v1')!).logs[TODAY].m).toBe(2);
    expect($(meh)!.getAttribute('aria-pressed')).toBe('true');
    expect($(meh)!.classList.contains('on')).toBe(true);
    expect($$('.xp-pop').map((e) => e.textContent)).toEqual(['+5 XP']);

    // Another face moves it; the same one again clears it.
    click('#feel [data-act="feel"][data-n="4"]');
    expect(S.state.logs[TODAY].m).toBe(4);
    expect($(meh)!.getAttribute('aria-pressed')).toBe('false');
    click('#feel [data-act="feel"][data-n="4"]');
    expect(S.state.logs[TODAY].m).toBeNull();
    expect($$('#feel [aria-pressed="true"]')).toHaveLength(0);
    expect($$('.xp-pop')).toHaveLength(1);

    // The day's 5 XP come with the mood, and go with it.
    const xp = S.levelInfo().xp;
    click('#feel [data-act="feel"][data-n="5"]');
    expect(S.levelInfo().xp).toBe(xp + 5);
    click('#feel [data-act="feel"][data-n="5"]');
    expect(S.levelInfo().xp).toBe(xp);
    // Drawn again, it shows what was picked.
    click('#feel [data-act="feel"][data-n="3"]');
    click('#tabs [data-v="today"]');
    expect($('#feel [data-n="3"]')!.getAttribute('aria-pressed')).toBe('true');
  });

  it('writes a few words in a sheet, saved as they type', async () => {
    const { S } = await boot('today', skipped);
    expect(text('#feel [data-act="feel-write"]')).toBe('Write something');
    click('#feel [data-act="feel-write"]');
    expect($('#sheet')!.hidden).toBe(false);
    expect(text('#sheet .sheet-title')).toBe('Write something');
    expect(document.activeElement).toBe($('#sheet #logText'));
    expect(text('#sheet .log-saved')).toBe('Saved as you type. It goes into your journal, and your coach reads it to see the whole picture.');
    expect($('#sheet .reflect')).not.toBeNull();
    const note = $('#logText') as HTMLTextAreaElement;
    note.value = 'Long walk by the river after work.';
    note.dispatchEvent(new Event('input', { bubbles: true }));
    expect(text('#feel [data-act="feel-write"]')).toBe('Your note');
    click('#sheet [data-act="sheet-close"]');
    expect($('#sheet')!.hidden).toBe(true);
    click('#tabs [data-v="today"]'); // a new screen saves what's being typed at once
    expect(S.state.logs[TODAY].t).toBe('Long walk by the river after work.');
    expect(text('#feel [data-act="feel-write"]')).toBe('Your note');
    click('#feel [data-act="feel-write"]');
    expect(($('#logText') as HTMLTextAreaElement).value).toBe('Long walk by the river after work.');
  });

  it('says less in the System look', async () => {
    await boot('today', { ...skipped, settings: { look: 'system' } });
    click('.sys-day [data-act="feel-write"]');
    expect(text('#sheet .log-saved')).toBe('Saved as you type. +5 XP a day.');
  });
});

describe('what Arise saw', () => {
  it('shows today and last night as chips, with where they came from, worked out on this device', async () => {
    await boot('today', skipped, { events: [night(TODAY, 430), steps(TODAY, 6400), code(TODAY, 9, 50), code(TODAY, 10, 50), code(TODAY, 11, 40)] });
    await vi.waitFor(() => expect(parts('#daySeen .seen-chips')).toEqual(['Slept 7 h 10 min', '6,400 steps', '2 h 20 min focused']), SLOW);
    expect(text('#daySeen .seen-from')).toBe('From your phone and Mac. Worked out on this device. Nobody else can see it, not even Arise.');
    expect($('#daySeen .seen-empty')).toBeNull();
    // Drawn straight away next time.
    click('#tabs [data-v="goals"]');
    click('#tabs [data-v="today"]');
    expect(parts('#daySeen .seen-chips')).toHaveLength(3);
  });

  it('says how to connect before any device has told Arise anything, and nothing more once one has', async () => {
    await boot('today', skipped);
    await vi.waitFor(() => expect(text('#daySeen')).toBe('Connect your phone or Mac and Arise fills this in by itself. Connect →'), SLOW);
    expect($('#daySeen [data-act="nav"][data-v="connect"]')).not.toBeNull();
    // Something from the phone yesterday, nothing yet today: nothing to say.
    await boot('today', skipped, { events: [steps('2026-10-08', 5000)] });
    const INS = await import('./life/insight');
    await vi.waitFor(async () => expect(await INS.get()).not.toBeNull(), SLOW);
    await vi.waitFor(() => expect($('#daySeen')!.innerHTML).toBe(''), SLOW);
  });

  it('shows in the System look too', async () => {
    await boot('today', { ...skipped, settings: { look: 'system' } }, { events: [steps(TODAY, 3200)] });
    await vi.waitFor(() => expect(parts('.sys-day #daySeen .seen-chips')).toEqual(['3,200 steps']), SLOW);
  });

  it("turns the coach's message without an AI to a short night: a lighter day, never a rating", async () => {
    const nights = daysTo('2026-10-08', 20).map((k) => night(k, 480));
    await boot('today', { ...skipped, profile: { onboarded: true, name: 'Sam' } }, { events: [...nights, night(TODAY, 360)] });
    // Before it's worked out, the message doesn't guess.
    expect(text('.sysmsg-text')).toBe('Sam. Arise writes your day as it goes, with nothing to fill in. Set a goal when something matters enough to work on.');
    await vi.waitFor(() => expect(text('.sysmsg-text')).toBe('Sam. Slept 6 h, 2 hours less than usual. Keep today light.'), SLOW);
    expect(text('.sysmsg')).not.toMatch(/rate|check in/i);
  });
});

describe('the day line', () => {
  it('says what Arise does with an empty log, then the day as the journal tells it', async () => {
    const { L } = await boot('today', skipped);
    await vi.waitFor(() => expect(text('#dayLine')).toBe('Arise writes your day here as it happens.'), SLOW);
    // How to connect is said once, under it (what Arise saw).
    await vi.waitFor(() => expect($('#daySeen [data-act="nav"][data-v="connect"]')).not.toBeNull(), SLOW);
    expect($('#dayLine [data-act="nav"]')).toBeNull();
    await L.addEvents([{ id: 'manual:n1', source: 'manual', kind: 'note', at: T(TODAY, 8, 15), title: 'Coffee in the garden', tier: 2 }]);
    await vi.waitFor(() => expect(text('#dayLine')).toBe('So far today, I wrote 1 note.'), SLOW);
    // Drawn straight away next time, from what it said last.
    click('#tabs [data-v="goals"]');
    click('#tabs [data-v="today"]');
    expect(text('#dayLine')).toBe('So far today, I wrote 1 note.');
  });

  it('waits for the day when only earlier days have something', async () => {
    await boot('today', skipped, { events: [{ id: 'manual:n0', source: 'manual', kind: 'note', at: T('2026-10-07', 20), title: 'Pizza night', tier: 2 }] });
    await vi.waitFor(() => expect(text('#dayLine')).toBe('Nothing in your day yet. It fills in as the day goes.'), SLOW);
  });
});

describe('workouts, for people who use the plan', () => {
  it('shows football only to people who play, as a row at the bottom of the workout card', async () => {
    await boot('today', planUser);
    expect($('[data-act="football"]')).toBeNull();
    await boot('today', { ...planUser, football: ['2026-10-05'] });
    expect($('#todo .quest [data-act="football"]')).not.toBeNull();
    expect($('#todo .quest > :last-child')).toBe($('#todo [data-act="football"]'));
    expect($$('[data-act="football"]')).toHaveLength(1); // no card of its own
    await boot('today', { ...planUser, profile: { ...planUser.profile, obstacles: ['Sport or training'] } });
    expect($('#todo .quest [data-act="football"]')).not.toBeNull();
  });

  it('keeps the workout card small: one line, the exercises folded away, Start, and a row of small links', async () => {
    const { S } = await boot('today', planUser);
    const card = $('#todo .quest')!;
    expect(card.classList.contains('panel')).toBe(true);
    expect(text('#todo .quest .panel-title')).toBe("Today's workout");
    expect(text('#todo .quest h3.quest-name')).toBe('C · Speed & legs');
    expect(text('#todo .quest .quest-meta')).toMatch(/^\d+ exercises · about \d+ min · 2 of \d this week$/);
    // The exercises, folded away until asked for.
    const more = $('#todo .quest details.ex-more') as HTMLDetailsElement;
    expect(more.open).toBe(false);
    expect(text('#todo .quest .ex-more summary')).toBe('See the exercises');
    expect(text('#todo .quest .ex-more > p')).toBe(`${S.workouts().c.tag}. In order: whatever day it is, you do the next one. Tap one to see how it's done.`);
    const exercises = $$('#todo .quest .obj');
    expect(exercises.length).toBe(S.workouts().c.slots.length);
    expect(exercises.every((b) => more.contains(b))).toBe(true);
    // Start comes first, then the links: a rest day, another session, and Training.
    const start = $('#todo .quest [data-act="start"]')!;
    expect(start.classList.contains('btn')).toBe(true);
    expect(text('#todo .quest .btn.primary')).toBe('Start workout');
    expect(before('#todo .quest .ex-more', '#todo .quest .btn.primary')).toBe(true);
    expect(before('#todo .quest .btn.primary', '#todo .quest .quest-links')).toBe(true);
    const links = [...$('#todo .quest .quest-links')!.children].map((c) => (c.matches('details') ? c.querySelector('summary') : c)!.textContent!.trim());
    expect(links).toEqual([`Rest day instead (${S.restsLeft()} left)`, 'Other session', 'Your training →']);
    expect($('#todo .quest-links [data-act="rest-day"]')).not.toBeNull();
    expect($$('#todo .quest-links details.other .chip').map((c) => c.textContent)).toEqual(['A · Back & biceps', 'B · Shoulders, chest & triceps']);
    const training = $('#todo .quest-links [data-v="training"]')!;
    expect(training.dataset.act).toBe('nav');
    // The streak warning, as one small line (the weekly free day is still there this week).
    expect(text('#todo .quest .quest-warn')).toBe("Skip without taking a rest day and you use up this week's free day.");
    expect($('#todo .quest .warn')).toBeNull();

    // The exercises still show how they're done, and Start still starts.
    exercises[0].click();
    expect($('#sheet')!.hidden).toBe(false);
    click('#sheet .sheet-close');
    start.click();
    expect(document.body.dataset.view).toBe('workout');
    expect(S.state.active?.workout).toBe('c');
  });

  it('swaps leg day for football from the row in the card', async () => {
    const { S } = await boot('today', { ...planUser, football: ['2026-10-05'] });
    expect(text('#todo .quest h3.quest-name')).toBe('C · Speed & legs');
    expect($('#todo .quest .fb-row')!.getAttribute('aria-pressed')).toBe('false');
    expect(text('#todo .quest .fb-row small')).toBe('Playing today? Tap it and you get an upper-body session instead. Legs stay for another day.');
    click('#todo .quest [data-act="football"]');
    expect(S.isFootball(TODAY)).toBe(true);
    expect($('#todo .quest .fb-row')!.getAttribute('aria-pressed')).toBe('true');
    expect(text('#todo .quest .swap')).toBe('football swap');
    expect(text('#todo .quest h3.quest-name')).not.toBe('C · Speed & legs');
    expect(text('#todo .quest .fb-row small')).toMatch(/^Logged \(\+\d+ XP\)\. C · Speed & legs moves to another day\./);
  });

  it('keeps a rest day and a done workout just as small, with the way to Training', async () => {
    await boot('today', { ...planUser, rests: [TODAY], football: ['2026-10-05'] });
    expect(text('#todo .quest .panel-title')).toBe('Rest day');
    expect(text('#todo .quest h3.quest-name')).toBe('Recover');
    expect(text('#todo .quest .quest-meta')).toMatch(/^Muscles grow while you rest\. Sleep well, eat well and go for a walk\. Rest days count toward your streak\. \d rest days? left this week\.$/);
    expect(text('#todo .quest-links [data-act="rest-day"]')).toBe('Changed my mind: train today');
    expect($('#todo .quest-links [data-v="training"]')).not.toBeNull();
    expect($('#todo .quest > :last-child')!.matches('[data-act="football"]')).toBe(true);

    await boot('today', { ...planUser, sessions: [...planUser.sessions, session(TODAY, 'c')] });
    expect(text('#todo .quest .panel-title')).toBe('Workout done');
    expect(text('#todo .quest h3.quest-name')).toBe('C · Speed & legs');
    expect(text('#todo .quest .quest-meta')).toMatch(/^1 set in 1 min · \+\d+ XP\. Done for today\. Come back tomorrow\. Next up: A · Back & biceps\.$/);
    expect(text('#todo .quest-links [data-act="session"]')).toBe('See what you did');
    expect(text('#todo .quest-links details.other summary')).toBe('Do another session');
    expect($('#todo .quest-links [data-v="training"]')).not.toBeNull();
  });

  it('puts the easy-week and weigh-in banners after the workout card', async () => {
    await boot('today', { ...planUser, easyWeeks: [TODAY], body: { phase: 'cut', entries: [] } });
    expect($('#todo .banner.easy')).not.toBeNull();
    expect($('#todo .banner.weigh')).not.toBeNull();
    expect($('#todo > :first-child')).toBe($('#todo .quest'));
    expect(before('#todo .quest', '#todo .banner.easy')).toBe(true);
    expect(before('#todo .banner.easy', '#todo .banner.weigh')).toBe(true);
    expect(text('#todo .quest .quest-meta')).toMatch(/ · easy week$/);
  });

  it('keeps the System look gamier, with the same small card', async () => {
    const { S } = await boot('today', { ...planUser, football: ['2026-10-05'], settings: { look: 'system' } });
    expect(S.freeDayIn(TODAY)).toBe('2026-10-06');
    expect(text('#todo .quest .sys-line')).toBe('[Daily Quest: C · Speed & legs] has arrived.');
    expect(text('#todo .quest h3.quest-name')).toBe('C · Speed & legs');
    expect(($('#todo .quest details.ex-more') as HTMLDetailsElement).open).toBe(false);
    expect(text('#todo .quest .btn.primary')).toBe('Start quest');
    expect(text('#todo .quest .quest-warn')).toBe('Warning: skip without taking a rest day and your streak ends.'); // this week's free day went on Tuesday
    expect($('#todo .quest-links [data-v="training"]')).not.toBeNull();
    expect($('#todo .quest [data-act="football"]')).not.toBeNull();
  });

  it('opens Goals for a link to the plan without one', async () => {
    await boot('plan', skipped);
    expect(text('h1')).toBe('Goals');
    expect(location.hash).toBe('#goals');
    await boot('plan', planUser);
    expect(text('h1')).toBe('The plan');
  });
});

describe('the right column', () => {
  it('shows each part of life worked out from their days in the Arise look, instead of Stamina, Mind and Wellbeing', async () => {
    // Four weeks of nights and steps from the phone: sleep and body are known, the rest isn't yet.
    const weeks = daysTo('2026-10-08', 28);
    const events = [...weeks.map((k, i) => night(k, i >= 21 ? 400 : 470)), ...weeks.map((k) => steps(k, 8000))];
    await boot('today', { ...skipped, profile: { onboarded: true, life: LIFE } }, { events });
    // You lately, in place of the status window.
    expect($('.status')).toBeNull();
    expect(text('.lately .panel-title')).toBe('You lately');
    await vi.waitFor(() => expect($$('.lately .life-grid .life-cell')).toHaveLength(8), SLOW);
    const cells = $$('.lately .life-cell');
    expect(cells.map((c) => c.querySelector('.k')!.textContent)).toEqual(['Sleep', 'Body', 'Mind', 'People', 'Work', 'Money', 'Fun', 'Purpose']);
    // Sleep: 70 minutes less a night this last week, so lower and down.
    const sleep = cells[0].querySelector('.dots')!;
    expect(sleep.getAttribute('aria-label')).toMatch(/^Sleep: [12] of 5, worse than usual$/);
    expect(cells[0].querySelector('.life-move.down')!.textContent).toBe('↓');
    expect(cells[0].getAttribute('title')).toBe('6 h 40 min a night, 50 min less than usual (phone).');
    expect(cells[1].querySelector('.dots')!.getAttribute('aria-label')).toBe('Body and health: 3 of 5, like usual');
    expect(cells[1].querySelector('.life-move')).toBeNull();
    expect(cells[5].querySelector('.dots')!.getAttribute('aria-label')).toBe('Money: not enough to go on yet');
    expect(cells[5].classList.contains('unknown')).toBe(true);
    expect(cells[5].querySelectorAll('.dots i.on')).toHaveLength(0);
    expect(text('.lately-areas')).toContain('Worked out from your days. Compared with your usual.');
    // Their own ratings stay on Me, not here.
    expect(text('.lately')).not.toMatch(/Stamina|Mind and|Wellbeing|STR|SEN|You said|Check-ins/);
    expect(text('.game-line')).toBe('Level 1 · 0 XP');
    expect(text('.lately .goal-line')).toBe('Growing first: Sleep and Purpose');
    // What matters to them, in place of the quote.
    expect(text('.matters > p')).toBe('Family · Health · Faith');
    expect(text('.matters')).toContain('A great next year, in your words: “See my family more.”');
    expect($('.quote')).toBeNull();
  });

  it('says how to connect there before Arise knows anything, and keeps the streak and the training numbers with the plan', async () => {
    await boot('today', skipped);
    await vi.waitFor(() => expect(text('.lately .lately-empty')).toBe('Connect your phone or Mac and Arise works out how your life is going.'), SLOW);
    expect($('.lately [data-act="nav"][data-v="connect"]')).not.toBeNull();
    expect($('.lately .life-cell')).toBeNull();
    expect($('.lately [data-act="life-checkin"]')).toBeNull();

    // Only Arise's own workouts: what it can say, and that a device would show more.
    const { S } = await boot('today', planUser);
    await vi.waitFor(() => expect(text('.lately-areas')).toContain('Connect your phone or Mac and Arise sees more. Connect →'), SLOW);
    // The game, in one small line under it: level, XP and the streak; and the training numbers.
    const lv = S.levelInfo();
    expect(S.currentStreak()).toBe(2);
    expect(parts('.game-line')).toEqual([`Level ${lv.level} · ${lv.xp.toLocaleString()} XP · 2-day streak`, 'Training: Strength 10 · Agility 10']);
    expect($('.quote')).not.toBeNull();
    // Top to bottom (on a phone, after the rest of Today): You lately, the line, the quote.
    expect(before('#todo', '.lately')).toBe(true);
    expect(before('.lately', '.game-line')).toBe(true);
    expect(before('.game-line', '.quote')).toBe(true);
  });

  it('says the best streak when this one is shorter, and that there is none yet', async () => {
    // Four days in a row last week, then a gap: today's streak is 2, the best 4.
    const { S } = await boot('today', { ...planUser, sessions: ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-07', '2026-10-08'].map((d) => session(d)) });
    expect([S.currentStreak(), S.bestStreak()]).toEqual([2, 4]);
    expect(parts('.game-line')[0]).toMatch(/ · 2-day streak \(best 4\)$/);
    await boot('today', { profile: { onboarded: true }, goals: [{ id: 'g1', title: 'Read more', category: 'learning', quests: [{ id: 'q1', title: 'Read 10 pages', schedule: { kind: 'daily' }, created: TODAY }] }] });
    expect(parts('.game-line')).toEqual(['Level 1 · 0 XP · No streak yet']);
  });

  it('shows the clearest thing Arise noticed in their days, once it is worked out', async () => {
    // Four weeks of check-ins: more energy on the days with a workout.
    const days = [...Array(28)].map((_, i) => new Date(2026, 8, 11 + i)).map((d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    const trained = days.filter((_, i) => i % 2 === 0);
    const logs = Object.fromEntries(days.map((d) => [d, trained.includes(d) ? { s: 3, e: 4, m: 4 } : { s: 3, e: 2, m: 3 }]));
    await boot('today', { ...planUser, sessions: trained.map((d) => session(d)), logs });
    // Worked out when the device is idle, after the rest of Today.
    await vi.waitFor(() => expect(text('#latelyNote .lately-note')).toMatch(/^Your energy is higher on days you work out/), { timeout: 8000 });
    expect($('#latelyNote')!.hidden).toBe(false);
    const more = $('#latelyNote [data-act="nav"][data-v="progress"]')!;
    expect(more.textContent).toBe(`More on ${text('#tabs [data-v="progress"]')} →`);
    // Drawn straight away next time, and the link opens the tab.
    click('#tabs [data-v="goals"]');
    click('#tabs [data-v="today"]');
    expect(text('#latelyNote .lately-note')).toMatch(/^Your energy is higher on days you work out/);
    click('#latelyNote [data-act="nav"]');
    expect(location.hash).toBe('#progress');
  }, 15000);

  it('keeps nothing noticed out of sight until there is something', async () => {
    await boot('today', planUser);
    expect($('#latelyNote')!.hidden).toBe(true);
    // Worked out (from these two days, nothing yet), it stays out of sight.
    const INS = await import('./life/insight');
    await vi.waitFor(async () => expect(await INS.get()).not.toBeNull(), SLOW);
    expect($('#latelyNote')!.hidden).toBe(true);
    expect(text('#latelyNote')).toBe('');
  });

  it('keeps the System look as it was', async () => {
    await boot('today', { ...planUser, profile: { ...planUser.profile, life: LIFE }, settings: { look: 'system' } });
    expect($('.life-grid')).toBeNull();
    expect($$('.status .stat .k').map((e) => e.textContent?.trim())).toEqual(['STR', 'AGI', 'VIT', 'INT', 'SEN', 'Streak']);
    expect(text('.status-meta')).toContain('Rank');
    expect($('.quote')).not.toBeNull();
    expect($('.matters')).toBeNull();
    // No You lately and no game line: the status window is its game. The week is on Training.
    expect($('.lately')).toBeNull();
    expect($('.game-line')).toBeNull();
    expect($('.week')).toBeNull();
  });
});

describe('the level-up sheet', () => {
  // 5 goals achieved (1,500 XP) and 2 football days (60): level 4. One set of a workout (60) makes
  // it level 5, and rank D.
  const nearlyFive = (look: string) => ({
    goals: [
      { id: 'fitness', title: 'Get fit', category: 'fitness', workouts: true },
      ...[1, 2, 3, 4, 5].map((n) => ({ id: `done${n}`, title: `Done ${n}`, category: 'other', status: 'done' })),
    ],
    football: ['2026-10-01', '2026-10-02'],
    profile: { onboarded: true },
    settings: { look },
  });
  const levelUp = async () => {
    window.confirm = () => true;
    click('#todo .quest [data-act="start"]');
    click('[data-act="toggle-set"]');
    click('[data-act="finish"]');
    await vi.waitFor(() => expect($('#sheet .summary')).not.toBeNull(), SLOW);
    return text('#sheet .lvl-change');
  };

  it("doesn't name a rank in the Arise look, and does in the System look", async () => {
    const { S } = await boot('today', nearlyFive('auto'));
    expect(S.levelInfo().level).toBe(4);
    expect(await levelUp()).toBe('4 → 5');
    expect(S.levelInfo().rank).toBe('D');
    await boot('today', nearlyFive('system'));
    expect(await levelUp()).toBe('4 → 5 · Rank D');
  });
});

describe('quotes', () => {
  it('suit the tone they picked, with every line for anyone who never picked one', async () => {
    const { QUOTES, quotesFor } = await import('./program.js');
    const kinds = (list: typeof QUOTES) => [...new Set(list.map((q) => q.kind))].sort();
    expect(quotesFor(undefined, false)).toEqual(QUOTES);
    expect(quotesFor([], false)).toEqual(QUOTES);
    expect(kinds(quotesFor(['Calm and kind'], false))).toEqual(['plain']);
    expect(quotesFor(['Calm and kind'], false).map((q) => q.text)).toContain('Rest is part of the work.');
    expect(kinds(quotesFor(['Strict coach'], false))).toEqual(['grind', 'plain']);
    expect(kinds(quotesFor(['Calm and kind', 'Faith-centred (Islam)'], false))).toEqual(['faith', 'plain']);
    expect(kinds(quotesFor(['Calm and kind'], true))).toEqual(['grind', 'plain']); // the System look
    expect(kinds(quotesFor('The System (Solo Leveling)', false))).toEqual(['grind', 'plain']);
    expect(QUOTES.every((q) => ['grind', 'faith', 'plain'].includes(q.kind))).toBe(true);
  });

  it('pick the morning reminder from the same lines', async () => {
    vi.resetModules();
    localStorage.clear();
    localStorage.setItem('pit-data-v1', JSON.stringify({ profile: { onboarded: true, tone: ['Calm and kind'] } }));
    const S = await import('./store');
    const R = await import('./reminders.js');
    const { quotesFor } = await import('./program.js');
    const calm = quotesFor(['Calm and kind'], false).map((q) => q.text);
    for (let i = 0; i < 30; i++) expect(calm).toContain(R.quoteFor(S.addDays(TODAY, i)));
  });
});
