// Share links and the snapshot a friend sees: the link's format, sealing, what a snapshot may
// hold, and fetching it the way a friend's browser does, under the database rules.

import { beforeEach, describe, expect, it } from 'vitest';
import * as L from './share';
import { cloud, resetCloud, restFetch } from '../test/fake-firebase';

const XSS = '"><img src=x onerror=alert(1)>';
const PROJECT = { projectId: 'arise-test', apiKey: 'key' };

const snapshot = (over: Record<string, unknown> = {}): L.Snapshot => ({
  v: 1,
  title: 'Run a half marathon',
  area: 'Fitness',
  status: 'active',
  streak: 12,
  quests: [{ title: 'Run', when: '3 times a week', streak: 4, weekly: true }],
  from: '2026-09-12',
  days: 'dddmodddddoodddddmddddddddot',
  measures: [{ name: 'Longest run', unit: 'km', value: 14.5, on: '2026-10-08', target: 21.1 }],
  milestones: [{ title: 'First 10 km', done: '2026-09-20' }],
  milestonesOf: 3,
  updated: 1760000000000,
  ...over,
});

beforeEach(() => resetCloud());

describe('the link', () => {
  it('is the site, then the id and key after the #, and reads back', async () => {
    const ref = await L.newShareRef();
    expect(ref.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(ref.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const link = L.shareLink('https://abyyworld.github.io/physical-improvement-tracker-app/#goals', ref);
    expect(link).toBe(`https://abyyworld.github.io/physical-improvement-tracker-app/#share=${ref.id}.${ref.key}`);
    const hash = new URL(link).hash;
    expect(L.isShareHash(hash)).toBe(true);
    expect(L.parseShareHash(hash)).toEqual({ id: ref.id, key: ref.key });
    // The part with the key never goes to a server: it isn't in what a browser requests.
    expect(new URL(link).href.split('#')[0]).not.toContain(ref.key);
  });

  it('is different every time', async () => {
    const refs = await Promise.all(Array.from({ length: 20 }, L.newShareRef));
    expect(new Set(refs.map((r) => r.id)).size).toBe(20);
    expect(new Set(refs.map((r) => r.key)).size).toBe(20);
  });

  it('cut short or changed is still a share link, just not a complete one', () => {
    const ok = `#share=${'a'.repeat(22)}.${'b'.repeat(43)}`;
    for (const h of [ok.slice(0, -1), `${ok}x`, ok.replace('.', ''), `#share=${XSS}`, '#share=']) {
      expect(L.isShareHash(h), h).toBe(true);
      expect(L.parseShareHash(h), h).toBeNull();
    }
    for (const h of ['', '#today', '#settings', '#shared', '?share=x']) expect(L.isShareHash(h), h).toBe(false);
  });
});

describe('the snapshot', () => {
  it('comes back as it was sealed, only with the right key and only for its own share', async () => {
    const a = await L.newShareRef();
    const b = await L.newShareRef();
    const sealed = await L.sealSnapshot(a, snapshot());
    expect(sealed.ct.length).toBeLessThan(L.MAX_CT);
    expect(atob(sealed.ct)).not.toContain('marathon');
    expect(await L.openSnapshot(a, sealed)).toEqual(snapshot());
    // The same key under another share's id (a page copied into another's place), or another key.
    await expect(L.openSnapshot({ id: b.id, key: a.key }, sealed)).rejects.toMatchObject({ code: 'bad-data' });
    await expect(L.openSnapshot({ id: a.id, key: b.key }, sealed)).rejects.toMatchObject({ code: 'bad-data' });
  });

  it('is rebuilt from what a snapshot may hold, capped, so the page can trust it', () => {
    const s = L.cleanSnapshot({
      ...snapshot(),
      journal: 'secret',
      email: 'me@example.com',
      title: 'x'.repeat(500),
      status: XSS,
      streak: -4,
      days: 'ddXmo'.repeat(10),
      quests: [{ title: 'Run', when: 'daily', streak: 'lots', how: 'secret note' }, { title: '' }, null, 'x'],
      measures: [{ name: 'Weight', unit: 'kg', value: 'heavy', on: '2026-10-08', target: 80 }],
      milestones: [{ title: 'Not done yet' }, { title: 'Done', done: '2026-10-01' }],
      milestonesOf: 1,
    })!;
    expect(Object.keys(s).every((k) => (L.SNAPSHOT_FIELDS as readonly string[]).includes(k))).toBe(true);
    expect(s.title).toHaveLength(120);
    expect(s.status).toBe('active');
    expect(s.streak).toBe(0);
    expect(s.days).toBe('ddomoddomoddomoddomoddomoddo');
    expect(s.quests).toEqual([{ title: 'Run', when: 'daily', streak: 0 }]);
    expect(s.measures).toEqual([{ name: 'Weight', unit: 'kg', target: 80 }]);
    expect(s.milestones).toEqual([{ title: 'Done', done: '2026-10-01' }]);
    expect(s.milestonesOf).toBe(1);
  });

  it("isn't one without a version, a title, a first day or a time", () => {
    for (const over of [{ v: 2 }, { title: '' }, { from: 'yesterday' }, { updated: 'now' }]) expect(L.cleanSnapshot({ ...snapshot(), ...over })).toBeNull();
    for (const junk of [null, 'x', 5, []]) expect(L.cleanSnapshot(junk)).toBeNull();
  });
});

describe('fetching it, as a friend does', () => {
  const put = async (ref: L.ShareRef, owner = 'uid1') => {
    const sealed = await L.sealSnapshot(ref, snapshot());
    cloud.docs.set(`shares/${ref.id}`, { owner, iv: sealed.iv, ct: sealed.ct, v: 1, updated: 1760000000000 });
  };

  it('reads the page without signing in, and opens it with the key from the link', async () => {
    const ref = await L.newShareRef();
    await put(ref);
    const requests: string[] = [];
    const get = ((url: string, init: RequestInit) => {
      requests.push(url);
      // Nothing of it is kept in the browser's cache, and no cookies go with it.
      expect(init).toMatchObject({ cache: 'no-store', credentials: 'omit' });
      return restFetch(url);
    }) as typeof fetch;
    const sealed = await L.fetchShare(ref.id, PROJECT, get);
    expect(await L.openSnapshot(ref, sealed!)).toEqual(snapshot());
    expect(requests).toEqual([`https://firestore.googleapis.com/v1/projects/arise-test/databases/(default)/documents/shares/${ref.id}?key=key`]);
    // The key never goes anywhere.
    expect(requests.join()).not.toContain(ref.key);
  });

  it('finds nothing for a link that was turned off, or an id that was never one', async () => {
    const ref = await L.newShareRef();
    expect(await L.fetchShare(ref.id, PROJECT, restFetch as typeof fetch)).toBeNull();
    expect(await L.fetchShare('../users/uid1/arise/meta', PROJECT, restFetch as typeof fetch)).toBeNull();
  });

  it('says so when the cloud refuses or is out of reach', async () => {
    const ref = await L.newShareRef();
    const refused = (async () => new Response('{}', { status: 403 })) as typeof fetch;
    await expect(L.fetchShare(ref.id, PROJECT, refused)).rejects.toMatchObject({ code: 'permission-denied' });
    const offline = (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    await expect(L.fetchShare(ref.id, PROJECT, offline)).rejects.toThrow();
  });
});
