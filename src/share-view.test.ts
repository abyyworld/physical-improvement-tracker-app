// @vitest-environment jsdom
// The page a friend sees when they open a shared goal's link: drawn from the cloud copy, opened
// with the key in the link, for someone who never used Arise. No intro, no account, and nothing
// is kept on their device.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cloud, resetCloud, restFetch } from './test/fake-firebase';
import * as L from './lib/share';

const XSS = '"><img src=x onerror=alert(1)>';

const snapshot = (over: Partial<L.Snapshot> = {}): L.Snapshot => ({
  v: 1,
  title: 'Run a half marathon',
  area: 'Fitness',
  status: 'active',
  name: 'Akbar',
  streak: 12,
  quests: [
    { title: 'Run', when: '3 times a week', streak: 4, weekly: true },
    { title: 'Stretch', when: 'every day', streak: 9 },
    { title: 'Ice bath', when: 'weekends', streak: 0 },
  ],
  from: '2026-09-12', // a Saturday
  days: 'dddmodddddoodddddmddddddddot',
  measures: [
    { name: 'Longest run', unit: 'km', value: 14.5, on: '2026-10-08', target: 21.1 },
    { name: 'Weight', unit: 'kg' },
  ],
  milestones: [{ title: 'First 10 km', done: '2026-09-20' }],
  milestonesOf: 3,
  updated: new Date(2026, 9, 9, 18, 30).getTime(),
  ...over,
});

// A page in the cloud, as the Player's app leaves it, and the link to it.
async function shared(snap: L.Snapshot) {
  const ref = await L.newShareRef();
  const sealed = await L.sealSnapshot(ref, snap);
  cloud.docs.set(`shares/${ref.id}`, { owner: 'uid1', iv: sealed.iv, ct: sealed.ct, v: 1, updated: snap.updated });
  return ref;
}

const text = () => document.getElementById('app')!.textContent!.replace(/\s+/g, ' ');
let touched: string[] = [];

// Opens the page at `hash`, as a browser with nothing of Arise in it.
async function open(hash: string) {
  history.replaceState(null, '', `/physical-improvement-tracker-app/${hash}`);
  vi.resetModules();
  const view = await import('./share-view');
  return view.shown;
}

beforeEach(() => {
  resetCloud();
  localStorage.clear();
  sessionStorage.clear();
  document.body.innerHTML = '<nav id="tabs"></nav><main id="app"></main><div id="sheet" hidden><div class="sheet-panel"><button class="sheet-close"></button><div class="sheet-body"></div></div></div><div id="toast"></div>';
  document.body.className = '';
  delete document.body.dataset.view;
  vi.stubGlobal('fetch', vi.fn(restFetch));
  // Anything that would keep something on the device is noted.
  touched = [];
  for (const store of [localStorage, sessionStorage]) vi.spyOn(Object.getPrototypeOf(store), 'setItem').mockImplementation(() => touched.push('storage'));
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, get: () => (touched.push('indexedDB'), undefined) });
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { register: () => (touched.push('service worker'), Promise.resolve()) } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (globalThis as { indexedDB?: unknown }).indexedDB;
});

describe("a friend's view of a shared goal", () => {
  it('shows the goal, read-only, in the Arise style', async () => {
    const ref = await shared(snapshot());
    expect(await open(`#share=${ref.id}.${ref.key}`)).toBe('shown');
    const t = text();
    expect(t).toContain('Shared from Arise');
    expect(t).toContain("Akbar's progress");
    expect(t).toContain('Run a half marathon');
    expect(t).toContain('Fitness');
    expect(t).toMatch(/Streak\s*12\s*days in a row/);
    expect(t).toMatch(/Last 28 days\s*21\s*days done/);
    expect(t).toMatch(/Milestones\s*1\s*of 3/);
    // Quests, with their streaks: weeks for a weekly one.
    expect(t).toContain('Run3 times a week');
    expect(t).toContain('4 weeks');
    expect(t).toContain('9 days');
    expect(t).toContain('no streak yet');
    // Measures: the latest number and the target.
    expect(t).toContain('14.5 km');
    expect(t).toContain('target 21.1 km');
    expect(t).toContain('nothing logged yet');
    expect(t).toContain('First 10 km');
    // The 28 days, Monday first: the first day was a Saturday.
    const cells = [...document.querySelectorAll('.sdays .sd')];
    expect(cells.filter((c) => c.classList.contains('before'))).toHaveLength(5);
    const days = cells.filter((c) => !c.classList.contains('before'));
    expect(days).toHaveLength(28);
    expect(days.map((c) => c.className.replace('sd ', '')).join(',')).toBe(
      [...'dddmodddddoodddddmddddddddot'].map((m) => ({ d: 'done', m: 'missed', o: 'off', t: 'today' })[m]).join(','),
    );
    expect(days[3].getAttribute('aria-label')).toMatch(/: missed$/);
    // Nothing to tap that changes anything: just the way to get Arise.
    expect(document.querySelectorAll('#app button, #app input, #app [data-act]')).toHaveLength(0);
    const get = [...document.querySelectorAll('#app a')];
    expect(get.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([['Get Arise', '/physical-improvement-tracker-app/']]);
    expect(document.getElementById('tabs')!.hidden).toBe(true);
    expect(document.body.dataset.view).toBe('share');
  });

  it('leaves the name off when the Player chose to', async () => {
    const ref = await shared(snapshot({ name: undefined }));
    await open(`#share=${ref.id}.${ref.key}`);
    expect(document.querySelector('h1')!.textContent).toBe('Progress');
    expect(text()).not.toContain('Akbar');
  });

  it("shows what's in it as text, never as HTML", async () => {
    const ref = await shared(snapshot({ title: XSS, name: XSS, area: XSS, quests: [{ title: XSS, when: XSS, streak: 1 }], measures: [{ name: XSS, unit: XSS, value: 1 }], milestones: [{ title: XSS, done: '2026-10-01' }] }));
    await open(`#share=${ref.id}.${ref.key}`);
    expect(document.querySelector('#app img')).toBeNull();
    expect(text()).toContain(XSS.slice(0, 20));
  });

  it('says so when the link was turned off or replaced', async () => {
    const ref = await L.newShareRef();
    expect(await open(`#share=${ref.id}.${ref.key}`)).toBe('gone');
    expect(text()).toContain('This link was turned off or replaced.');
    expect(text()).toContain('Get Arise');
    // As the app leaves it: the page there is empty, for good.
    const was = await shared(snapshot());
    cloud.docs.set(`shares/${was.id}`, { ...L.SHARE_OFF });
    expect(await open(`#share=${was.id}.${was.key}`)).toBe('gone');
    expect(text()).toContain('This link was turned off or replaced.');
    expect(text()).not.toContain('marathon');
  });

  it("says so when the link isn't complete, or its key isn't this page's", async () => {
    const ref = await shared(snapshot());
    const other = await L.newShareRef();
    expect(await open(`#share=${ref.id}.${other.key}`)).toBe('broken');
    expect(text()).toContain("This link isn't complete.");
    expect(text()).not.toContain('marathon');
    vi.mocked(fetch).mockClear();
    expect(await open(`#share=${ref.id}.${ref.key.slice(0, 30)}`)).toBe('broken');
    expect(fetch).not.toHaveBeenCalled();
  });

  it("offers to try again when the cloud can't be reached", async () => {
    const ref = await shared(snapshot());
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await open(`#share=${ref.id}.${ref.key}`)).toBe('offline');
    expect(text()).toContain('Check your internet connection');
    (document.querySelector('[data-share-retry]') as HTMLElement).click();
    await vi.waitFor(() => expect(text()).toContain('Run a half marathon'));
  });

  it('keeps nothing on the device, and sends the key nowhere', async () => {
    const ref = await shared(snapshot());
    await open(`#share=${ref.id}.${ref.key}`);
    expect(touched).toEqual([]);
    expect(document.cookie).toBe('');
    const urls = vi.mocked(fetch).mock.calls.map((c) => String(c[0]));
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain(`/documents/shares/${ref.id}?`);
    expect(urls.join()).not.toContain(ref.key);
  });
});

describe('opening the site with a share link', () => {
  it('shows only the shared page: no app, no intro, nothing saved', async () => {
    const ref = await shared(snapshot());
    history.replaceState(null, '', `/physical-improvement-tracker-app/#share=${ref.id}.${ref.key}`);
    vi.resetModules();
    await import('./main');
    await vi.waitFor(() => expect(text()).toContain('Run a half marathon'));
    // The app never started: its tabs aren't drawn, the intro didn't open, and the address
    // still has the link (the app would have changed it to its own view).
    expect(document.getElementById('tabs')!.innerHTML).toBe('');
    expect(document.body.classList.contains('onboarding')).toBe(false);
    expect(location.hash).toBe(`#share=${ref.id}.${ref.key}`);
    expect(touched).toEqual([]);
    expect(localStorage.length).toBe(0);
  });
});
