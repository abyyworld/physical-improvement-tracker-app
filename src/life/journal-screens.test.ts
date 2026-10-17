// @vitest-environment jsdom
// The journal on screen: each day opens on its journal (with a switch to everything in the log),
// today's fills in as the day goes, editing it, copying and sharing it, the ways into it on Today,
// links and tapped notifications opening a day, asking for notifications once from a tap, the
// journal's switches in Settings, and the plain line when the AI in use is too weak to learn.

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LifeEvent } from './types';

vi.mock('../lib/firebase', () => import('../test/fake-firebase'));
const device = vi.hoisted(() => ({ state: 'unavailable' }));
vi.mock('../lib/on-device', () => ({ lastKnown: () => device.state, availability: async () => device.state, ask: vi.fn(async () => ''), download: vi.fn() }));

const T = (k: string, h = 12, m = 0) => {
  const [y, mo, d] = k.split('-').map(Number);
  return new Date(y, mo - 1, d, h, m).getTime();
};
const YESTERDAY: LifeEvent[] = [
  { id: 'health:sleep:1', source: 'health', kind: 'sleep', at: T('2026-10-15', 23, 30), end: T('2026-10-16', 7, 40), title: 'Slept 8 h 10 min', value: 490, unit: 'min', tier: 2 },
  { id: 'health:workout:w1', source: 'health', kind: 'workout', at: T('2026-10-16', 9), end: T('2026-10-16', 10, 5), title: 'Strength training, 65 min', tier: 2 },
  { id: 'google:s1', source: 'google', kind: 'search', at: T('2026-10-16', 13, 20), title: 'Searched "flights to Rome"', tier: 3 },
];

// Each boot starts the whole app again: the listeners the last one added go first.
const added: [EventTarget, string, EventListenerOrEventListenerObject, unknown][] = [];
for (const target of [document, window]) {
  const add = target.addEventListener.bind(target);
  target.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: unknown) => {
    added.push([target, type, fn, opts]);
    add(type, fn, opts as AddEventListenerOptions);
  }) as typeof target.addEventListener;
}

async function boot(view: string, { events = YESTERDAY, keep = false } = {}) {
  for (const [target, type, fn, opts] of added.splice(0)) target.removeEventListener(type, fn, opts as EventListenerOptions);
  vi.resetModules();
  if (!keep) {
    globalThis.indexedDB = new IDBFactory();
    localStorage.clear();
    localStorage.setItem('pit-data-v1', JSON.stringify({ sessions: [], profile: { onboarded: true, skipped: true } }));
  }
  document.body.innerHTML = '<nav id="tabs"></nav><main id="app"></main><div id="restbar" hidden></div><div id="sheet" hidden><div class="sheet-panel"><button class="sheet-close"></button><div class="sheet-body"></div></div></div><div id="toast"></div><input type="file" id="importFile" hidden>';
  history.replaceState(null, '', `#${view}`);
  const L = await import('./log');
  const M = await import('./memory');
  if (!keep) await L.addEvents(events);
  await import('../app.js');
  return { L, M };
}
const $ = (sel: string) => document.querySelector<HTMLElement>(sel);
const click = (sel: string) => $(sel)!.click();
const text = (sel: string) => $(sel)?.textContent?.replace(/\s+/g, ' ').trim() || '';
const texts = (sel: string) => [...document.querySelectorAll(sel)].map((el) => (el.children.length ? [...el.children].map((c) => c.textContent).join(' ') : el.textContent!).replace(/\s+/g, ' ').trim());
const pane = (v: string) => $(`#lifeDay [data-pane="${v}"]`)!;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 17, 10)); // Saturday 17 October 2026
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  window.scrollTo = () => {};
  device.state = 'unavailable';
});
afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as { Capacitor?: unknown }).Capacitor;
  delete (navigator as { share?: unknown }).share;
});

describe('Your days', () => {
  it('opens each day on its journal, hour by hour, with a switch to everything in the log', async () => {
    await boot('days');
    click('[data-act="life-day"][data-d="-1"]');
    await vi.waitFor(() => expect(text('#lifeDay .journal-intro')).toBe('I slept 8 h 10 min, did a workout (Strength training) and looked up 1 thing.'));
    expect(pane('journal').hidden).toBe(false);
    expect(pane('events').hidden).toBe(true);
    expect(texts('#lifeDay .journal-part-name')).toEqual(['Morning', 'Afternoon']);
    expect(texts('#lifeDay .journal-lines li')).toEqual(['07:40 Woke up after 8 h 10 min of sleep', '09:00 to 10:05 Strength training, 65 min', '13:20 Searched flights to Rome']);
    expect(text('#lifeDay .journal-by')).toBe('Written from your log.');
    expect($('[data-act="life-pane"][data-v="journal"]')!.getAttribute('aria-pressed')).toBe('true');

    click('[data-act="life-pane"][data-v="events"]');
    expect(pane('events').hidden).toBe(false);
    expect(pane('journal').hidden).toBe(true);
    expect(document.querySelectorAll('#lifeDay [data-pane="events"] .tl-ev')).toHaveLength(2);
    expect($('[data-act="life-pane"][data-v="events"]')!.getAttribute('aria-pressed')).toBe('true');
    // The day before keeps showing everything until switched back.
    click('[data-act="life-day"][data-d="-1"]');
    await vi.waitFor(() => expect(text('.life-nav-day b')).not.toBe('Yesterday'));
    await vi.waitFor(() => expect(pane('events').hidden).toBe(false));
  });

  it("fills in today's as the day goes, and asks how today was", async () => {
    const { L } = await boot('days', { events: [] });
    await vi.waitFor(() => expect(text('#lifeDay .journal-empty')).toBe('Nothing in your journal yet today. It fills in as the day goes.'));
    expect(text('#lifeDay .journal-ask-q')).toBe('How was today?');
    expect($('#lifeDay .journal-ask [data-act="life-add"]')).not.toBeNull();
    await L.addEvents([{ id: 'manual:n1', source: 'manual', kind: 'note', at: T('2026-10-17', 8, 15), title: 'Coffee in the garden', tier: 2 }]);
    await vi.waitFor(() => expect(texts('#lifeDay .journal-lines li')).toEqual(['08:15 Coffee in the garden']));
    expect(text('#lifeDay .journal-intro')).toBe('So far today, I wrote 1 note.');
  });

  it('lets you edit a day, and keeps your words as yours', async () => {
    const { M } = await boot('days');
    click('[data-act="life-day"][data-d="-1"]');
    await vi.waitFor(() => expect($('#lifeDay [data-act="life-j-edit"]')).not.toBeNull());
    click('#lifeDay [data-act="life-j-edit"]');
    const box = $('#lifeJournalEdit') as HTMLTextAreaElement;
    expect(box.value.split('\n').slice(0, 4)).toEqual(['I slept 8 h 10 min, did a workout (Strength training) and looked up 1 thing.', '', 'Morning', '07:40 Woke up after 8 h 10 min of sleep']);
    box.value = 'A good, slow day.\n\nMorning\nI ran by the river before work.';
    click('[data-act="life-j-save"]');
    await vi.waitFor(() => expect(text('#lifeDay .journal-intro')).toBe('A good, slow day.'));
    expect(text('#lifeDay .journal-part p')).toBe('I ran by the river before work.');
    expect(text('#lifeDay .journal-by')).toBe("Your own words. Arise won't change them.");
    expect(M.journalFor('2026-10-16')).toMatchObject({ edited: true, text: 'A good, slow day.\n\nMorning\nI ran by the river before work.' });
    expect($('#lifeDay [data-act="life-j-again"]')!.textContent).toContain('Write it again');
  });

  it('says when a day has more in the log than its journal holds', async () => {
    const { M } = await boot('days');
    click('[data-act="life-day"][data-d="-1"]');
    await vi.waitFor(() => expect($('#lifeDay .journal-by')).not.toBeNull());
    expect($('#lifeDay .journal-partial')).toBeNull();
    M.JOURNAL_READ.most = 2; // yesterday has 2 things in it (and the night's sleep before)
    click('[data-act="life-day"][data-d="1"]');
    click('[data-act="life-day"][data-d="-1"]');
    await vi.waitFor(() => expect(text('#lifeDay .journal-partial')).toBe('This day has more in your log than a journal can hold, so the end of it is left out. Everything is still in the log.'));
  });

  it('copies and shares a day as text', async () => {
    const share = vi.fn(async () => {});
    Object.defineProperty(navigator, 'share', { value: share, configurable: true });
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await boot('days');
    click('[data-act="life-day"][data-d="-1"]');
    await vi.waitFor(() => expect($('#lifeDay [data-act="life-j-copy"]')).not.toBeNull());
    click('#lifeDay [data-act="life-j-copy"]');
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copied = (writeText.mock.calls[0] as unknown as [string])[0];
    expect(copied).toMatch(/16/);
    expect(copied).toContain('I slept 8 h 10 min, did a workout (Strength training) and looked up 1 thing.\n\nMorning\n07:40 Woke up after 8 h 10 min of sleep');
    await vi.waitFor(() => expect(text('#toast')).toBe('Copied.'));
    click('#lifeDay [data-act="life-j-share"]');
    await vi.waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    expect(share.mock.calls[0]).toEqual([{ title: expect.stringContaining('My journal'), text: copied }]);
  });
});

describe('the ways into it', () => {
  it('has a way into the journal on Today, and the yesterday card opens yesterday’s', async () => {
    await boot('today');
    expect(text('.journal-entry b')).toBe("Today's journal");
    await vi.waitFor(() => expect(text('#lifeRecap')).toContain('Read your journal'));
    click('#lifeRecap [data-act="life-journal"]');
    await vi.waitFor(() => expect(text('.life-nav-day b')).toBe('Yesterday'));
    expect(text('h1')).toBe('Your days');
    await vi.waitFor(() => expect(pane('journal').hidden).toBe(false));
    click('#tabs [data-v="today"]');
    click('.journal-entry');
    await vi.waitFor(() => expect(text('.life-nav-day b')).toBe('Today'));
  });

  it('opens a day from a link, and from a tapped notification', async () => {
    await boot('journal=2026-10-12', { events: [{ id: 'netflix:n1', source: 'netflix', kind: 'watch', at: T('2026-10-12', 21), title: 'Watched Dark: S1E1', tier: 2 }] });
    expect(text('h1')).toBe('Your days');
    await vi.waitFor(() => expect(texts('#lifeDay .journal-lines li')).toEqual(['21:00 Watched Dark: S1E1']));
    window.dispatchEvent(new CustomEvent('arise:journal', { detail: { day: '2026-10-16' } }));
    await vi.waitFor(() => expect(text('.life-nav-day b')).toBe('Yesterday'));
    // Nothing for a day that isn't one, or one still to come.
    window.dispatchEvent(new CustomEvent('arise:journal', { detail: { day: 'soon' } }));
    expect(text('.life-nav-day b')).toBe('Yesterday');
  });
});

describe('notifications', () => {
  function phone(answer = 'granted') {
    const asked = vi.fn(async () => ({ display: answer }));
    (globalThis as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      PluginHeaders: [{ name: 'LocalNotifications' }],
      nativePromise: async (plugin: string, method: string) => {
        if (plugin !== 'LocalNotifications') throw new Error('not simulated');
        if (method === 'checkPermissions') return { display: 'prompt' };
        if (method === 'requestPermissions') return asked();
        return {};
      },
    };
    return asked;
  }

  it('asks once on Today, only from a tap', async () => {
    const asked = phone();
    await boot('today');
    expect(text('.notify-card h2')).toBe('Get your evening check-in and morning recap');
    expect(text('.notify-card')).toContain('At 21:30');
    // Only the journal's two keep to plain words; Turn on also turns on the daily reminders,
    // which say the quest's name, and the card says so.
    expect(text('.notify-card')).toContain('These two show nothing from your journal on your lock screen unless you choose.');
    expect(text('.notify-card')).toContain("Your daily reminders come on too, and they say your quest's name.");
    expect(text('.notify-card')).not.toMatch(/nothing personal/i);
    expect(asked).not.toHaveBeenCalled();
    click('.notify-card [data-act="journal-notify-on"]');
    await vi.waitFor(() => expect(asked).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect($('.notify-card')).toBeNull());
    expect(JSON.parse(localStorage.getItem('pit-data-v1')!).settings.notify).toBe(true);
    expect(text('#toast')).toBe('On. Your check-in comes at 21:30.');
  });

  it('goes for good once closed, and asks nothing', async () => {
    const asked = phone();
    await boot('today');
    click('.notify-card [data-act="journal-notify-hide"]');
    expect($('.notify-card')).toBeNull();
    await boot('today', { keep: true });
    expect($('.notify-card')).toBeNull();
    expect($('#app')!.textContent).not.toContain('Turn on daily reminders'); // nor the older banner
    expect(asked).not.toHaveBeenCalled();
  });

  it("has the journal's switches in Settings, with details off by default, and the journal's voice", async () => {
    phone();
    await boot('settings');
    localStorage.setItem('arise-notify-card', 'done');
    click('[data-act="notify-toggle"]');
    await vi.waitFor(() => expect($('[data-k="notifyDetails"]')).not.toBeNull());
    expect(texts('[data-act="toggle-setting"][data-k="checkin"] b, [data-act="toggle-setting"][data-k="recap"] b, [data-k="notifyDetails"] b')).toEqual(['Evening check-in', 'Yesterday', 'Show details in notifications']);
    expect($('[data-k="notifyDetails"]')!.getAttribute('aria-pressed')).toBe('false');
    // Off: nothing from the journal on the lock screen, said for what it covers. The daily
    // reminders name the quest either way, and a phone with them planned ahead only follows a
    // change made on another device once Arise opens there.
    const off = text('[data-k="notifyDetails"] small');
    expect(off).toContain('Nothing from your journal shows on your lock screen.');
    expect(off).toContain('Daily reminders still name your quest.');
    expect(off).toContain('Your other devices follow once Arise opens on them.');
    expect(($('#checkinIn') as HTMLInputElement).value).toBe('21:30');
    expect(($('#recapIn') as HTMLInputElement).value).toBe('07:00');
    click('[data-k="notifyDetails"]');
    expect(JSON.parse(localStorage.getItem('pit-data-v1')!).settings.notifyDetails).toBe(true);
    expect($('[data-act="life-voice"][data-v="first"]')!.getAttribute('aria-pressed')).toBe('true');
    click('[data-act="life-voice"][data-v="you"]');
    expect(JSON.parse(localStorage.getItem('pit-data-v1')!).settings.journalVoice).toBe('you');
  });
});

describe('a weak AI', () => {
  it('says plainly that learning waits for a strong one', async () => {
    device.state = 'available'; // the AI on this device: chat yes, memory no
    await boot('knows');
    await vi.waitFor(() => expect(text('#lifeLearn')).toContain('Learning waits for a strong AI: the private AI or a strong key in Your AI keys.'));
    click('[data-act="nav"][data-v="days"]');
    click('[data-act="life-day"][data-d="-1"]');
    await vi.waitFor(() => expect(text('#lifeDay .journal-waits')).toBe('Learning waits for a strong AI: the private AI or a strong key in Your AI keys.'));
    expect($('#lifeDay [data-act="life-j-again"]')).toBeNull();
  });
});
