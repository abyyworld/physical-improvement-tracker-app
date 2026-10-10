// @vitest-environment jsdom
// Sharing a goal from the Goals tab: the whole app started, the Player tapping through "Share
// progress", with the simulated cloud behind it. One start of the app for the whole story (a
// second one in the same file would answer the same taps too).

import { describe, expect, it, vi } from 'vitest';
import { cloud, resetCloud, restFetch } from './test/fake-firebase';
import * as L from './lib/share';

vi.mock('./lib/firebase', () => import('./test/fake-firebase'));
vi.mock('./lib/crypto', async (orig) => {
  const real = await orig<typeof import('./lib/crypto')>();
  return { ...real, deriveMaster: (p: string, id: string) => real.deriveMaster(p, id, 1000) };
});

const PW = 'correct horse battery';
const goal = { id: 'g1', title: 'Learn Spanish', category: 'learning', created: '2026-10-01', updated: 1, quests: [{ id: 'q1', title: 'Study', schedule: { kind: 'daily' }, created: '2026-10-01' }] };

const $ = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const sheet = () => $('#sheet .sheet-body')!.textContent!.replace(/\s+/g, ' ');
const tap = (sel: string) => $(sel)!.click();
// The pages that are up (one that's turned off stays, empty).
const shares = () => [...cloud.docs].filter(([p, d]) => p.startsWith('shares/') && !d.off).map(([p]) => p);
const toasted = () => $('#toast')!.textContent;
const link = () => ($('#shareLinkIn') as HTMLInputElement | null)?.value;
const opened = async (share: { id: string; key: string }) => {
  const sealed = await L.fetchShare(share.id, { projectId: 'p', apiKey: 'k' }, restFetch as typeof fetch);
  return sealed && L.openSnapshot(share, sealed);
};

describe('Share progress, on the Goals tab', () => {
  it('needs an account, then makes a link, copies it, replaces it, keeps it through edits, and turns it off', async () => {
    resetCloud();
    window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    window.scrollTo = () => {};
    localStorage.setItem('pit-data-v1', JSON.stringify({ sessions: [], goals: [goal], settings: { name: 'Akbar Juraev' }, profile: { onboarded: true } }));
    document.body.innerHTML = '<nav id="tabs"></nav><main id="app"></main><div id="restbar" hidden></div><div id="sheet" hidden><div class="sheet-panel"><button class="sheet-close" data-act="sheet-close"></button><div class="sheet-body"></div></div></div><div id="toast"></div><input type="file" id="importFile" hidden>';
    history.replaceState(null, '', '/physical-improvement-tracker-app/#goals');
    await import('./app.js');
    const S = await import('./store');
    const SYNC = await import('./sync');

    // Signed out: it says what it is and that it needs an account, and makes nothing.
    expect($('[data-act="g-share"]')!.textContent).toContain('Share progress');
    tap('[data-act="g-share"]');
    expect(sheet()).toContain('Sharing needs an account');
    expect(sheet()).toContain('Never your journal, your chats with the coach, your other goals');
    expect($('[data-act="share-make"]')).toBeNull();
    expect($('#sheet [data-act="nav"][data-v="settings"]')).not.toBeNull();
    tap('#sheet [data-act="sheet-close"]');
    expect(shares()).toEqual([]);

    await SYNC.submit('up', { email: 'me@example.com', password: PW, password2: PW });
    expect(SYNC.status.error).toBe('');

    // "Show my name" starts off; turned on, it's the first name only.
    tap('[data-act="g-share"]');
    expect(sheet()).toContain('What they see');
    // Not only what the page shows: what else anyone with the link can see.
    expect(sheet()).toContain('With the link, they can also see a random ID for your account (not your email or account code) and when the page was updated.');
    expect($('[data-act="share-name"]')!.getAttribute('aria-pressed')).toBe('false');
    expect(sheet()).toContain('Your first name, Akbar,');
    tap('[data-act="share-name"]');
    expect($('[data-act="share-name"]')!.getAttribute('aria-pressed')).toBe('true');
    tap('[data-act="share-make"]');
    await vi.waitFor(() => expect(link()).toBeTruthy());
    const first = S.goalById('g1')!.share!;
    expect(link()).toBe(`${location.origin}/physical-improvement-tracker-app/#share=${first.id}.${first.key}`);
    expect(shares()).toEqual([`shares/${first.id}`]);
    expect(await opened(first)).toMatchObject({ title: 'Learn Spanish', name: 'Akbar' });
    expect($('[data-act="g-share"]')!.textContent).toContain('Shared with a link');

    // Copy link.
    const copied: string[] = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t: string) => void copied.push(t) } });
    tap('[data-act="share-copy"]');
    await vi.waitFor(() => expect(copied).toEqual([link()]));

    // Show my name, turned off while the cloud can't be reached: it doesn't say it's off the
    // page, but that the page still shows it, and why, with a way to try again.
    cloud.hook = (_op, path) => {
      if (String(path).includes('shares/')) throw Object.assign(new Error('unavailable'), { code: 'unavailable' });
    };
    tap('[data-act="share-name"]');
    await vi.waitFor(() => expect(sheet()).toContain("The page still shows your name. Couldn't reach the cloud."));
    expect($('[data-act="share-name"]')!.getAttribute('aria-pressed')).toBe('false');
    expect(toasted()).not.toContain('Your name is off the page now.');
    cloud.hook = null;
    expect(await opened(first)).toMatchObject({ name: 'Akbar' });
    tap('[data-act="share-retry"]');
    await vi.waitFor(() => expect(toasted()).toBe('Page updated.'));
    expect((await opened(first))!.name).toBeUndefined();
    expect($('[data-act="share-retry"]')).toBeNull();
    expect(sheet()).not.toContain('still shows your name');
    // Back on: said once the page shows it.
    tap('[data-act="share-name"]');
    await vi.waitFor(() => expect(toasted()).toBe('Your first name shows on the page now.'));
    expect(await opened(first)).toMatchObject({ name: 'Akbar' });

    // New link: the old one stops working.
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const old = link();
    tap('[data-act="share-new"]');
    await vi.waitFor(() => expect(link()).not.toBe(old));
    const second = S.goalById('g1')!.share!;
    expect(second.name).toBe(true);
    expect(shares()).toEqual([`shares/${second.id}`]);
    expect(await opened(first)).toBeNull();
    tap('#sheet [data-act="sheet-close"]');

    // Editing the goal keeps its link, and the page follows.
    tap('[data-act="g-edit"]');
    ($('[data-gf="title"]') as HTMLTextAreaElement).value = 'Learn Spanish well';
    $('[data-gf="title"]')!.dispatchEvent(new Event('input', { bubbles: true }));
    tap('[data-act="g-save"]');
    expect(S.goalById('g1')).toMatchObject({ title: 'Learn Spanish well', share: second });
    const SHARE = await import('./share');
    await SHARE.refresh();
    expect(await opened(second)).toMatchObject({ title: 'Learn Spanish well' });

    // Stop sharing: the page goes, and the sheet offers to make a link again.
    tap('[data-act="g-share"]');
    tap('[data-act="share-stop"]');
    await vi.waitFor(() => expect($('[data-act="share-make"]')).not.toBeNull());
    expect(shares()).toEqual([]);
    expect(S.goalById('g1')!.share).toBeUndefined();

    // Shared again, then the goal deleted: its page goes with it.
    tap('[data-act="share-make"]');
    await vi.waitFor(() => expect(link()).toBeTruthy());
    expect(shares()).toHaveLength(1);
    tap('#sheet [data-act="sheet-close"]');
    tap('[data-act="g-edit"]');
    tap('[data-act="g-delete"]');
    await vi.waitFor(() => expect(S.goalById('g1')).toBeNull());
    expect(shares()).toEqual([]);
    expect(confirm).toHaveBeenCalledTimes(3);
    SYNC.status.user = null;
  });
});
