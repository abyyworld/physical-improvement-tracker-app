// @vitest-environment jsdom
// The Coach tab: quick actions about the whole of life, each looking up the right stretch of the
// life log; the workout plan's button only with the plan; a quest bar that welcomes talk; and
// small print that says what the coach reads.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { version } from '../package.json';

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

// Starts the app on `view` with this saved data and one AI key the Player said yes to.
async function boot(view: string, data: object = {}) {
  for (const [target, type, fn, opts] of added.splice(0)) target.removeEventListener(type, fn, opts as EventListenerOptions);
  vi.resetModules();
  localStorage.clear();
  localStorage.setItem('pit-data-v1', JSON.stringify({ sessions: [], profile: { name: 'Sam', onboarded: true }, ...data, settings: { aiEngine: 'own', ...((data as { settings?: object }).settings || {}) } }));
  localStorage.setItem('arise-ai-keys', JSON.stringify([{ id: 'k1', key: 'gsk_aaaa1111', provider: 'groq', model: 'llama-3.3-70b-versatile' }]));
  localStorage.setItem('arise-ai-consent', 'groq');
  localStorage.setItem('arise-version-seen', version); // no "What's new" on top
  localStorage.setItem('arise-look-hint', 'seen');
  document.documentElement.removeAttribute('data-theme');
  document.body.innerHTML = '<nav id="tabs"></nav><main id="app"></main><div id="restbar" hidden></div><div id="sheet" hidden><div class="sheet-panel"><button class="sheet-close"></button><div class="sheet-body"></div></div></div><div id="toast"></div><input type="file" id="importFile" hidden>';
  history.replaceState(null, '', `#${view}`);
  await import('./app.js');
  const AI = await import('./ai.js');
  const SYS = await import('./system.js');
  return { AI, SYS };
}
const $ = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const $$ = (sel: string) => [...document.querySelectorAll(sel)] as HTMLElement[];
const text = (sel: string) => ($(sel)?.textContent || '').replace(/\s+/g, ' ').trim();
const tick = () => new Promise((r) => setTimeout(r, 0));
const tap = async (sel: string) => {
  $(sel)!.click();
  await tick();
  await tick();
};

const PLAN = [{ id: 'g1', title: 'Get strong', category: 'fitness', workouts: true, quests: [] }];
const READING = [{ id: 'g2', title: 'Read more', category: 'learning', quests: [{ id: 'q1', title: 'Read 10 pages', schedule: { kind: 'daily' }, created: '2026-10-01' }] }];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 9, 12)); // Friday 9 October 2026
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  window.scrollTo = () => {};
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('the Coach tab', () => {
  it('offers quick actions about the whole of life, and the workout plan only to people who use it', async () => {
    await boot('coach');
    expect($$('.quick [data-act="ai-quick"]').map((b) => b.textContent!.trim())).toEqual([
      'Review my week',
      'What helps me?',
      'Deep review of everything all data',
      'What would help me most?',
      'Is my goal right for me?',
      'Hard day',
      'Busy week',
      'I missed days',
    ]);
    expect($('.quick [data-v="plan"]')).toBeNull();
    expect(document.body.textContent).not.toContain('Personalise my workout plan');

    await boot('coach', { goals: PLAN });
    expect(text('.quick [data-v="plan"]')).toBe('Personalise my workout plan →');
  });

  it('welcomes any question in an empty chat', async () => {
    await boot('coach');
    expect(text('.chat-empty p:not(.sys-line)')).toBe(
      "Ask me anything: your goals, your days or what's on your mind. I look at the whole picture: your check-ins, how you rate your life, your goals, quests and workouts, and your life log as far as your privacy settings let this AI read it.",
    );
  });

  it("doesn't push quests: no goal is fine in the Arise look, and the System look keeps its push", async () => {
    await boot('coach');
    expect(text('.banner b')).toBe('No goal right now.');
    expect(text('.banner small')).toBe("That's fine. Ask me anything, or set one when you're ready.");
    expect(text('.banner .go')).toBe('Goals →');

    await boot('coach', { goals: READING });
    expect(text('.quest-bar b')).toBe("Today's quest: Read 10 pages");
    expect(text('.quest-bar small')).toBe("Still open today. Whenever you're ready.");

    await boot('coach', { goals: READING, settings: { look: 'system' } });
    expect(text('.quest-bar small')).toBe('Not done yet. Doing beats talking.');

    await boot('coach', { settings: { look: 'system' } });
    expect(text('.banner b')).toBe('No quests yet.');
  });

  it('looks up the right stretch of the life log for each quick action', async () => {
    const { AI } = await boot('coach');
    const chat = vi.spyOn(AI, 'chat').mockResolvedValue('Noted.');
    await tap('[data-act="ai-quick"][data-i="1"]');
    expect(chat).toHaveBeenLastCalledWith(expect.stringContaining('what goes with my good days and my hard days?'), expect.objectContaining({ full: false, recallAs: 'the last 6 weeks' }));
    await tap('[data-act="ai-quick"][data-i="2"]');
    expect(chat).toHaveBeenLastCalledWith(expect.stringContaining('Do a deep review of everything you know about me'), expect.objectContaining({ full: true, recallAs: 'the last 3 months' }));
    await tap('[data-act="ai-quick"][data-i="5"]');
    expect(chat).toHaveBeenLastCalledWith(expect.stringContaining('Today is hard.'), expect.objectContaining({ recallAs: 'the last 2 days' }));
    // Without one, the question's own words are looked up.
    await tap('[data-act="ai-quick"][data-i="6"]');
    expect(chat.mock.lastCall![1]).not.toHaveProperty('recallAs');
  });

  it('passes a question from another screen on with what to look up, and says when the coach is busy', async () => {
    const { AI, SYS } = await boot('today');
    let answer: (t: string) => void = () => {};
    const chat = vi.spyOn(AI, 'chat').mockImplementation(() => new Promise((r) => (answer = r)));
    expect(SYS.askCoach('Arise noticed: something. What do you make of it?', { recallAs: 'the last 6 weeks' })).toBe(true);
    expect(location.hash).toBe('#coach');
    expect(chat).toHaveBeenCalledWith('Arise noticed: something. What do you make of it?', expect.objectContaining({ recallAs: 'the last 6 weeks' }));
    expect(SYS.askCoach('And another thing?')).toBe(false);
    expect(text('#toast')).toBe('Your coach is still answering. Try again in a moment.');
    answer('Done.');
    await tick();
  });

  it("says what the coach reads in the small print and in Settings", async () => {
    const { AI } = await boot('coach');
    expect(text('.small-print')).toContain('Less private: your goals, check-ins, life check-in, workouts and notes are sent to');
    expect(text('.small-print')).toContain('whenever the coach answers you, here or on Today. Your life log goes too only if you allowed it.');

    vi.spyOn(AI, 'engine').mockReturnValue('free');
    await tap('#tabs [data-v="today"]');
    await tap('#tabs [data-v="coach"]');
    expect(text('.small-print')).toContain("Less private: your goals, check-ins, life check-in, workouts and notes go to Cloudflare's servers, which can read them, whenever the coach answers you, here or on Today.");

    vi.restoreAllMocks();
    await tap('#tabs [data-v="settings"]');
    expect(text('#aiSettings')).toContain('Your profile, life check-in, check-ins, plan, workouts and weigh-ins go to');
    expect(text('#aiSettings')).not.toContain('daily log');
  });

  it('reflects on the day with nothing rated or written, in both looks', async () => {
    const { AI, SYS } = await boot('coach');
    const reflect = vi.spyOn(AI, 'reflect').mockResolvedValue('A full day: 6,400 steps.');
    const block = document.createElement('div');
    document.body.append(block);
    block.innerHTML = SYS.reflectionBlock('2026-10-09');
    const btn = block.querySelector('[data-act="ai-reflect"]') as HTMLButtonElement;
    expect(btn.textContent!.trim()).toBe('Reflect on today with your coach');
    expect(btn.hasAttribute('title')).toBe(false); // nothing to write first
    await tap('[data-act="ai-reflect"]');
    expect(reflect).toHaveBeenCalledWith('2026-10-09', expect.any(Object));
    expect(text('#toast')).toBe('');
    block.remove();

    const sys = await boot('coach', { settings: { look: 'system' } });
    block.innerHTML = sys.SYS.reflectionBlock('2026-10-09');
    expect(block.querySelector('[data-act="ai-reflect"]')!.textContent!.trim()).toBe('Reflect on today with the System');
  });
});
