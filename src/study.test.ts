// @vitest-environment jsdom
// Study on screen: opening a study link, the Study card on Today with the next test, a round of
// questions (a miss comes back at the end, the first answer is the one that counts), XP and the
// streak from rounds, and nothing at all for someone without a study link.

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { linkKey, newLinkKey, seal } from './lib/crypto';

vi.mock('./lib/firebase', () => import('./test/fake-firebase'));

const ID = 'AbCdEfGhIjKlMnOpQrStUv';
const PACK = {
  format: 'arise.study/v1',
  updated: '2026-10-20',
  modules: [
    {
      id: 'databases',
      module: 'Databases and Web Programming',
      short: 'Databases',
      tests: [{ title: 'Class test 2', date: '2026-10-26', covers: 'Weeks 1-4', note: '', source: 'slide 5' }],
      topics: [{ id: 'db-w1-er', week: 1, title: 'ER modelling' }],
      cards: [
        { id: 'db-w1-er-01', topic: 'db-w1-er', type: 'mcq', q: 'One customer, many orders: which cardinality?', choices: ['1:1', '1:M', 'M:M'], answer: 1, explain: 'One side has many.', source: 'Week 1 slides, slide 61' },
        { id: 'db-w1-er-02', topic: 'db-w1-er', type: 'recall', q: 'What does M:M need?', back: 'A junction table.', explain: 'It holds two foreign keys.', source: 'Week 1 slides, slide 85' },
      ],
    },
  ],
};

const added: [EventTarget, string, EventListenerOrEventListenerObject, unknown][] = [];
for (const target of [document, window]) {
  const add = target.addEventListener.bind(target);
  target.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: unknown) => {
    added.push([target, type, fn, opts]);
    add(type, fn, opts as AddEventListenerOptions);
  }) as typeof target.addEventListener;
}

async function boot(hash: string, data: object) {
  for (const [target, type, fn, opts] of added.splice(0)) target.removeEventListener(type, fn, opts as EventListenerOptions);
  vi.resetModules();
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
  localStorage.setItem('arise-look-hint', 'seen');
  localStorage.setItem('pit-data-v1', JSON.stringify(data));
  document.body.innerHTML = '<nav id="tabs"></nav><main id="app"></main><div id="restbar" hidden></div><div id="sheet" hidden><div class="sheet-panel"><button class="sheet-close"></button><div class="sheet-body"></div></div></div><div id="toast"></div><input type="file" id="importFile" hidden>';
  history.replaceState(null, '', hash);
  const S = await import('./store');
  await import('./app.js');
  return S;
}
const $ = (sel: string) => document.querySelector<HTMLElement>(sel);
const $$ = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
const text = (sel: string) => $(sel)?.textContent?.replace(/\s+/g, ' ').trim() || '';
const click = (sel: string) => $(sel)!.click();
const settle = () => new Promise((r) => setTimeout(r, 0));
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 100 && !ok(); i++) await settle();
};
// The button for a choice by its text (choices are shuffled in each round).
const choice = (label: string) => $$('.st-choice').find((b) => b.textContent!.includes(label))!;

const profile = { profile: { name: 'Sam', onboarded: true } };
let key = '';
let fetched: string[] = [];

beforeEach(async () => {
  key = await newLinkKey();
  const sealed = await seal(await linkKey(key), JSON.stringify(PACK), `study/${ID}`);
  fetched = [];
  globalThis.fetch = vi.fn(async (url: string) => {
    fetched.push(String(url));
    return String(url).endsWith(`/${ID}.json`) ? new Response(JSON.stringify(sealed)) : new Response('', { status: 404 });
  }) as unknown as typeof fetch;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 20, 12)); // Tuesday 20 October 2026, noon
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  window.scrollTo = () => {};
});
afterEach(() => vi.useRealTimers());

describe('Study', () => {
  it("shows nothing for someone without a study link, apart from a place for one in Settings", async () => {
    await boot('#today', profile);
    expect($('.st-today')).toBeNull();
    expect(fetched).toEqual([]);
    click('#tabs [data-v="settings"]');
    expect(text('#studyPanel')).toContain('Paste the study link');
  });

  it('opens a study link, keeps it without the key in the address, and shows the next test on Today', async () => {
    const S = await boot(`#study=${ID}.${key}`, profile);
    expect(location.hash).toBe('#study');
    expect(S.state.study.link).toBe(`${ID}.${key}`);
    await until(() => !!$('.st-module'));
    expect(fetched[0]).toBe(`https://raw.githubusercontent.com/abyyworld/physical-improvement-tracker-app/study-packs/${ID}.json`);
    expect(text('.st-module')).toContain('0 of 2 known');
    click('#tabs [data-v="today"]');
    expect(text('.st-today')).toContain('Databases · Class test 2 in 6 days');
  });

  it('plays a round: a miss comes back at the end, the first answer counts, and the round earns XP and the day', async () => {
    const S = await boot('#settings', profile);
    ($('#studyLink') as HTMLInputElement).value = `https://abyyworld.github.io/physical-improvement-tracker-app/#study=${ID}.${key}`;
    click('[data-act="study-link"]');
    await until(() => text('#studyPanel').includes('2 questions'));
    click('#tabs [data-v="today"]');
    const xp = S.totalXP();
    expect(S.active('2026-10-20')).toBe(false);

    click('.st-today [data-act="study-play"]');
    expect(location.hash).toBe('#quiz');
    expect(text('.st-q')).toBe('One customer, many orders: which cardinality?');
    choice('M:M').click();
    expect(text('.st-explain')).toContain('Not quite. One side has many.');
    expect(text('.st-explain')).toContain('From Week 1 slides, slide 61');
    expect(S.state.study.cards['db-w1-er-01']).toMatchObject({ b: 0, w: 1 });
    click('[data-act="study-next"]');

    expect(text('.st-q')).toBe('What does M:M need?');
    click('[data-act="study-reveal"]');
    expect(text('.st-back')).toBe('A junction table.');
    click('[data-act="study-grade"][data-ok="1"]');
    click('[data-act="study-next"]');

    // The missed card again: right this time, but its miss is what counted.
    expect(text('.st-card .kicker')).toContain('again');
    choice('1:M').click();
    expect(S.state.study.cards['db-w1-er-01']).toMatchObject({ b: 0, w: 1, r: 0 });
    click('[data-act="study-next"]');

    expect(text('#sheet .xp-gain')).toBe('1 of 2 right first time · +22 XP');
    expect(S.totalXP()).toBe(xp + 22);
    expect(S.state.study.rounds['2026-10-20']).toMatchObject({ n: 1, right: 1, total: 2 });
    expect(S.active('2026-10-20')).toBe(true);
  });

  it('answers with the number keys on a laptop', async () => {
    const S = await boot(`#study=${ID}.${key}`, profile);
    await until(() => !!$('.st-module'));
    click('.st-module [data-act="study-play"]');
    const n = $$('.st-choice').findIndex((b) => b.textContent!.includes('1:M')) + 1;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: String(n) }));
    expect(text('.st-explain')).toContain('Right.');
    expect(S.state.study.cards['db-w1-er-01']).toMatchObject({ b: 1, r: 1 });
  });

  it("says so when the link's pack can't be opened", async () => {
    await boot(`#study=${ID}.${'b'.repeat(43)}`, profile);
    await until(() => text('#app').includes("doesn't open"));
    expect(text('#app')).toContain("This study link doesn't open its pack.");
  });
});
