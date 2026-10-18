// @vitest-environment jsdom
// Today, top to bottom: the day so far, yesterday, a quick check-in (sleep, energy, mood), the life
// check-in's card, the coach's message, then the to-dos (the workout and quests, or a small step or
// a goal for someone with none). The right column: Your progress with the parts of life, the week,
// and what matters to them or a quote that suits their tone.

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
  it('leads with the day, then yesterday, the check-in, the coach, and then the workout', async () => {
    await boot('today', planUser);
    for (const [a, b] of [
      ['.glance', '#lifeRecap'],
      ['#lifeRecap', '#checkin'],
      ['#checkin', '.sysmsg'],
      ['.sysmsg', '#todo .quest'],
    ]) expect(before(a, b), `${a} before ${b}`).toBe(true);
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
    expect(text('.life-invite .kicker')).toBe('[System] Status check');
    expect(text('.life-invite .btn.primary')).toBe('Begin');
  });

  it('asks nothing of someone new: no goal card, a life check-in they can put off for a week, and a goal if they want one', async () => {
    const { S } = await boot('today', skipped);
    expect(document.body.textContent).not.toContain('Your first goal');
    expect($('.quest.glow')).toBeNull();
    expect($('.quest')).toBeNull();
    expect(text('.goal-invite .panel-title')).toBe('A goal, if you want one');
    expect($('.goal-invite [data-act="g-new"]')).not.toBeNull();
    expect($('.week')).toBeNull(); // nothing to show a week of yet
    expect(text('.life-invite .kicker')).toBe('New in Arise');
    expect(text('.life-invite h3')).toBe('Check in on your whole life');
    expect($('.life-invite [data-act="life-checkin"]')).not.toBeNull();
    // The day card is there for everyone, with no ring until something is due.
    expect($('.glance')).not.toBeNull();
    expect($('.gring')).toBeNull();
    expect($('.glance-next')).toBeNull();

    click('.life-invite [data-act="life-checkin-later"]');
    expect($('.life-invite')).toBeNull();
    expect(localStorage.getItem('arise-life-later')).toBe('2026-10-16');
    expect(S.state.profile).not.toHaveProperty('life'); // only this device's, never synced
    // Six days later it's still away; on the seventh it's back.
    vi.setSystemTime(new Date(2026, 9, 15, 12));
    await boot('today', null, { keep: true });
    expect($('.life-invite')).toBeNull();
    vi.setSystemTime(new Date(2026, 9, 16, 12));
    await boot('today', null, { keep: true });
    expect($('.life-invite')).not.toBeNull();
  });

  it('asks again a month after the last life check-in', async () => {
    await boot('today', { profile: { onboarded: true, life: { ...LIFE, at: '2026-09-01' } } });
    expect(text('.life-invite .kicker')).toBe('Your life check-in');
    expect(text('.life-invite h3')).toBe("How's life now?");
    await boot('today', { profile: { onboarded: true, life: { ...LIFE, at: '2026-09-20' } } });
    expect($('.life-invite')).toBeNull();
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

describe('the check-in', () => {
  it('saves a tap at once, clears it on a second tap, and gives the day its 5 XP once', async () => {
    const { S } = await boot('today', skipped);
    expect(text('#checkin .panel-title')).toBe('How are you today?');
    expect($$('#checkin .log-energy')).toHaveLength(3);
    expect(text('#checkin .label')).toBe('Sleep last night');
    expect(text('#checkin [data-word="e"]')).toBe('· 1 = drained, 5 = unstoppable');
    const sleep2 = '#checkin [data-act="checkin"][data-f="s"][data-n="2"]';
    expect($(sleep2)!.getAttribute('aria-label')).toBe('Sleep last night: Poor');

    click(sleep2);
    expect(S.state.logs[TODAY].s).toBe(2);
    expect(JSON.parse(localStorage.getItem('pit-data-v1')!).logs[TODAY].s).toBe(2);
    expect($(sleep2)!.getAttribute('aria-pressed')).toBe('true');
    expect(text('#checkin [data-word="s"]')).toBe('· Poor');
    expect(text('#dayChips')).toBe('Slept: Poor');
    expect($$('.xp-pop').map((e) => e.textContent)).toEqual(['+5 XP']);

    click(sleep2);
    expect(S.state.logs[TODAY].s).toBeNull();
    expect($(sleep2)!.getAttribute('aria-pressed')).toBe('false');
    expect(text('#checkin [data-word="s"]')).toBe('');
    expect(text('#dayChips')).toBe('');
    expect($$('.xp-pop')).toHaveLength(1); // the day had a check-in already

    // Mood alone is a check-in too: the day's 5 XP.
    const xp = S.levelInfo().xp;
    click('#checkin [data-act="checkin"][data-f="m"][data-n="4"]');
    expect(S.levelInfo().xp).toBe(xp + 5);
    click('#checkin [data-act="checkin"][data-f="m"][data-n="4"]');
    expect(S.levelInfo().xp).toBe(xp);
  });

  it('folds once sleep, energy and mood are in, on the next draw, and opens again with Edit', async () => {
    await boot('today', skipped);
    const tap = (f: string, n: number) => click(`#checkin [data-act="checkin"][data-f="${f}"][data-n="${n}"]`);
    const note = $('#logText') as HTMLTextAreaElement;
    note.value = 'Long walk by the river after work, then an early night with a book.';
    note.dispatchEvent(new Event('input', { bubbles: true }));
    tap('s', 4);
    tap('e', 4);
    tap('m', 3);
    // Still open while it's being filled in.
    expect($('#checkin.done')).toBeNull();
    expect(parts('#dayChips')).toEqual(['Slept: Good', 'Energy 4', 'Mood: Okay']);

    click('#tabs [data-v="today"]');
    expect($('#checkin.done')).not.toBeNull();
    expect(text('#checkin.done .kicker')).toBe('Checked in');
    expect(text('#checkin.done > p')).toBe('Slept: Good · Energy 4 · Mood: Okay · “Long walk by the river after work, then an early night with…”');
    expect($('#logText')).toBeNull();

    click('#checkin [data-act="checkin-edit"]');
    expect($('#checkin.done')).toBeNull();
    expect($('#checkin [data-f="e"][data-n="4"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(($('#logText') as HTMLTextAreaElement).value).toBe('Long walk by the river after work, then an early night with a book.');
    // It stays open for the rest of the day.
    click('#tabs [data-v="today"]');
    expect($('#checkin.done')).toBeNull();
  });

  it('says less in the System look', async () => {
    await boot('today', { ...skipped, settings: { look: 'system' } });
    expect(text('#checkin .panel-title')).toBe('Daily check-in');
    expect(text('#checkin .log-saved')).toBe('Saved as you type. +5 XP a day.');
  });
});

describe('the day line', () => {
  it('says what Arise does with an empty log, then the day as the journal tells it', async () => {
    const { L } = await boot('today', skipped);
    await vi.waitFor(() => expect(text('#dayLine')).toBe('Arise writes your day here as it happens. Check in below, and connect your phone or apps so it fills in the rest. Connect →'), SLOW);
    expect($('#dayLine [data-act="nav"][data-v="connect"]')).not.toBeNull();
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
  it('shows each part of life in the Arise look, with what moved, instead of Stamina, Mind and Wellbeing', async () => {
    await boot('today', { ...skipped, profile: { onboarded: true, life: LIFE, lifeBefore: { at: '2026-09-11', areas: { sleep: 1, money: 3, people: 4 } } } });
    // You lately, in place of the status window.
    expect($('.status')).toBeNull();
    expect(text('.lately .panel-title')).toBe('You lately');
    const cells = $$('.lately .life-grid .life-cell:not(.life-count)');
    expect(cells).toHaveLength(8);
    expect($('.lately .life-cell .dots')!.getAttribute('aria-label')).toBe('Sleep: Not great');
    expect($$('.lately .life-cell')[0].querySelectorAll('.dots i.on')).toHaveLength(2);
    expect(cells.map((c) => c.querySelector('.life-move')?.textContent).filter(Boolean)).toEqual(['↑, up from Hard', '↑, up from Good']);
    expect(text('.lately')).not.toMatch(/Stamina|Mind |Wellbeing|STR|SEN/);
    expect(text('.lately')).toContain('From your life check-in on 9 Oct.');
    // The days checked in; with no quests and no plan, no streak in the line under it.
    expect(parts('.lately .life-count')).toEqual(['Check-ins', '0', 'days in a row']);
    expect(text('.game-line')).toBe('Level 1 · 0 XP');
    expect(text('.lately .goal-line')).toBe('Growing first: Sleep and Purpose');
    // What matters to them, in place of the quote.
    expect(text('.matters > p')).toBe('Family · Health · Faith');
    expect(text('.matters')).toContain('A great next year, in your words: “See my family more.”');
    expect($('.quote')).toBeNull();
  });

  it('asks for a life check-in there before there is one, and keeps the streak and the training numbers with the plan', async () => {
    const { S } = await boot('today', planUser);
    expect($$('.lately .life-cell')).toHaveLength(1);
    expect(parts('.lately .life-count')).toEqual(['Check-ins', '0', 'days in a row']);
    expect(text('.lately')).toContain('See your whole life here: check in (1 minute).');
    expect($('.lately [data-act="life-checkin"]')).not.toBeNull();
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
