// @vitest-environment jsdom
// Arise as "me" for other apps, on screen in What Arise knows: the About me text (what goes in,
// how private, the exact words before copying) and Connected apps (what each app gets, making a
// link, turning it off).

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LifeFact } from '../lib/validate';

vi.mock('../lib/firebase', () => import('../test/fake-firebase'));
vi.mock('../lib/crypto', async (orig) => {
  const real = await orig<typeof import('../lib/crypto')>();
  return { ...real, deriveMaster: (p: string, id: string) => real.deriveMaster(p, id, 1000) };
});

const FACTS: LifeFact[] = [
  { id: 'f1', text: 'You run before work most days.', since: '2026-09-01', from: 'ai', tier: 1, share: 1, sources: ['2026-09-01', '2026-09-02'], at: 1 },
  { id: 'f2', text: 'You love jazz.', since: '2026-09-03', from: 'ai', tier: 2, share: 2, sources: ['2026-09-03'], at: 1 },
  { id: 'f3', text: 'You look up knee pain most weeks.', since: '2026-09-05', from: 'ai', tier: 3, share: 3, sources: ['2026-09-05'], at: 1 },
];
const GOAL = { id: 'g1', title: 'Run a half marathon', category: 'fitness', why: 'Feel strong at 40', created: '2026-10-01', quests: [{ id: 'q1', title: 'Run', schedule: { kind: 'daily' }, created: '2026-10-01' }] };
const LINK = { id: 'a'.repeat(22), key: 'b'.repeat(43), app: 'Buddy', at: 1, choice: { sections: ['name', 'goals'], tier: 1 }, sent: new Date(2026, 9, 17, 9, 30).getTime() };

// Each boot starts the whole app again: the listeners the last one added go first.
const added: [EventTarget, string, EventListenerOrEventListenerObject, unknown][] = [];
for (const target of [document, window]) {
  const add = target.addEventListener.bind(target);
  target.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: unknown) => {
    added.push([target, type, fn, opts]);
    add(type, fn, opts as AddEventListenerOptions);
  }) as typeof target.addEventListener;
}

async function boot({ links = [] as object[] } = {}) {
  for (const [target, type, fn, opts] of added.splice(0)) target.removeEventListener(type, fn, opts as EventListenerOptions);
  vi.resetModules();
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
  localStorage.setItem('pit-data-v1', JSON.stringify({ sessions: [], profile: { onboarded: true, skipped: true }, settings: { name: 'Sam Lee' }, goals: [GOAL] }));
  if (links.length) localStorage.setItem('arise-me-links', JSON.stringify(links));
  document.body.innerHTML = '<nav id="tabs"></nav><main id="app"></main><div id="restbar" hidden></div><div id="sheet" hidden><div class="sheet-panel"><button class="sheet-close"></button><div class="sheet-body"></div></div></div><div id="toast"></div><input type="file" id="importFile" hidden>';
  history.replaceState(null, '', '#knows');
  const db = await (await import('./db')).open();
  const tx = db.transaction('facts', 'readwrite');
  for (const f of FACTS) tx.objectStore('facts').put(f);
  await new Promise((r) => (tx.oncomplete = r));
  await import('../app.js');
  return { M: await import('./memory'), SYNC: await import('../sync'), ME: await import('../me') };
}
const box = () => document.getElementById('aboutMeText') as HTMLTextAreaElement;
const click = (sel: string) => (document.querySelector(sel) as HTMLElement).click();
const text = (sel: string) => document.querySelector(sel)?.textContent?.replace(/\s+/g, ' ').trim() || '';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 17, 10)); // Saturday 17 October 2026
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  window.scrollTo = () => {};
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('About me', () => {
  it('turns what Arise knows into a short text in the Player’s voice, with nothing sensitive until they pick it', async () => {
    await boot();
    await vi.waitFor(() => expect(box().value).toContain('I love jazz.'));
    expect(box().value).toBe(
      ['My name is Sam.', "What I'm working toward:\n- Run a half marathon. Why: Feel strong at 40.", 'My routines:\n- I run before work most days.', 'What I like:\n- I love jazz.'].join('\n\n'),
    );
    expect([...document.querySelectorAll('#aboutMe [data-act="me-about-sec"]')].map((b) => [b.textContent, b.getAttribute('aria-pressed')])).toEqual([
      ['Your first name', 'true'],
      ['Your goals', 'true'],
      ['Your routines', 'true'],
      ['What you like', 'true'],
      ['What helps you', 'true'],
      ['Other facts', 'true'],
    ]);
    expect(text('#aboutMe [data-act="me-about-tier"][aria-pressed="true"]')).toBe('Everyday');
    expect(text('#aboutMe')).toContain('ChatGPT: Settings, Personalization, Custom instructions.');
    expect(text('#aboutMe')).toContain('Claude: Settings, Profile.');
    expect(text('#aboutMe')).toContain('Nothing leaves Arise until you copy or share it.');

    // Sensitive things only when picked; what's unpicked goes. The choice is remembered.
    click('#aboutMe [data-act="me-about-tier"][data-t="3"]');
    expect(box().value).toContain('I look up knee pain most weeks.');
    click('#aboutMe [data-act="me-about-sec"][data-s="name"]');
    expect(box().value).not.toContain('My name is');
    expect(document.querySelector('#aboutMe [data-s="name"]')?.getAttribute('aria-pressed')).toBe('false');
    expect(JSON.parse(localStorage.getItem('arise-about-me')!)).toEqual({ sections: ['goals', 'routines', 'likes', 'helps', 'other'], tier: 3 });
  });

  it('copies exactly the words in the box, changes included, and keeps them while Arise learns', async () => {
    const { M } = await boot();
    await vi.waitFor(() => expect(box().value).toContain('I love jazz.'));
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    box().value = 'I am Sam. I like short, kind check-ins.';
    box().dispatchEvent(new Event('input', { bubbles: true }));
    expect(text('#aboutMeCount')).toBe('39 characters.');
    await M.addFact('You like mornings.');
    await new Promise((r) => setTimeout(r, 400));
    expect(box().value).toBe('I am Sam. I like short, kind check-ins.');
    click('[data-act="me-about-copy"]');
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('I am Sam. I like short, kind check-ins.'));
    expect(text('#toast')).toBe('Copied. Paste it into the app.');
  });
});

describe('Connected apps', () => {
  it('lists each app with what it gets and when it was last updated, with the warning', async () => {
    await boot({ links: [LINK] });
    expect(text('#meApps .fact-text')).toBe('Buddy');
    expect(text('#meApps .fact')).toContain('Gets: First name, goals. Only what comes from your goals and quests.');
    expect(text('#meApps .fact')).toContain(`Updated ${new Date(LINK.sent).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}`);
    expect([...document.querySelectorAll('#meApps .fact-acts button')].map((b) => b.textContent)).toEqual(['See what it gets', 'New link', 'Turn off']);
    expect(text('#meApps')).toContain("The app you give this link to can read what's in it and keep a copy.");

    // What it gets, exactly.
    click('#meApps [data-act="me-app"]');
    await vi.waitFor(() => expect(text('.sheet-body .me-preview')).toContain('Run a half marathon'));
    expect(text('.sheet-body h2')).toBe('Buddy');
    expect((document.getElementById('meLinkIn') as HTMLInputElement).value).toMatch(new RegExp(`#me=${LINK.id}\\.${LINK.key}$`));
    expect(text('.sheet-body .me-preview')).not.toContain('jazz');
    const exact = JSON.parse(document.querySelector('.sheet-body .me-json')!.textContent!);
    expect(Object.keys(exact)).toEqual(['format', 'name', 'about', 'facts', 'goals', 'updated']);
    expect(exact).toMatchObject({ format: 'arise.me/v1', name: 'Sam', facts: [], goals: [{ title: 'Run a half marathon', why: 'Feel strong at 40' }] });
  });

  it('shows exactly what a new app would get, and asks for an account first', async () => {
    await boot();
    expect(text('#meAppList')).toBe('No apps connected yet.');
    click('[data-act="me-connect"]');
    expect(text('.sheet-body h2')).toBe('Connect an app');
    await vi.waitFor(() => expect(text('.sheet-body .me-preview')).toContain('I love jazz.'));
    expect(document.querySelectorAll('.sheet-body [data-act="me-sec"]')).toHaveLength(8);
    expect(text('.sheet-body .me-preview')).not.toContain('knee');
    expect(text('.sheet-body .me-preview')).not.toContain("Today's quests");
    (document.getElementById('meAppName') as HTMLInputElement).value = 'Buddy';
    click('.sheet-body [data-act="me-sec"][data-s="today"]');
    expect([...document.querySelectorAll('.sheet-body .me-preview .label')].map((x) => x.textContent)).toEqual(['First name', 'About me', 'Goals', 'Facts', "Today's quests"]);
    expect([...document.querySelectorAll('.sheet-body .me-preview .sum-list:last-of-type li > span')].map((x) => x.textContent)).toEqual(['Run', 'not yet']);
    expect((document.getElementById('meAppName') as HTMLInputElement).value).toBe('Buddy');
    expect(text('.sheet-body')).toContain('Connecting an app needs an account');
    expect(document.querySelector('.sheet-body [data-act="me-make"]')).toBeNull();
  });

  it('makes a link for an app, then turns it off', { timeout: 30_000 }, async () => {
    const { SYNC, ME } = await boot();
    await SYNC.submit('up', { email: 'me@example.com', password: 'correct horse battery', password2: 'correct horse battery' });
    expect(SYNC.status.error).toBe('');
    click('#tabs [data-v="today"]');
    click('#tabs [data-v="days"]');
    click('[data-act="nav"][data-v="knows"]');
    click('[data-act="me-connect"]');
    (document.getElementById('meAppName') as HTMLInputElement).value = 'My buddy app';
    click('.sheet-body [data-act="me-make"]');
    await vi.waitFor(() => expect(document.getElementById('meLinkIn')).not.toBeNull(), { timeout: 5000 });
    const [l] = ME.links();
    expect(l.app).toBe('My buddy app');
    expect((document.getElementById('meLinkIn') as HTMLInputElement).value).toContain(`#me=${l.id}.${l.key}`);
    expect(text('#meApps .fact-text')).toBe('My buddy app');

    vi.spyOn(window, 'confirm').mockReturnValue(true);
    click('.sheet-body [data-act="me-app-off"]');
    await vi.waitFor(() => expect(ME.links()).toEqual([]));
    await vi.waitFor(() => expect(text('#meAppList')).toBe('No apps connected yet.'));
    expect(document.getElementById('sheet')!.hidden).toBe(true);
  });
});
