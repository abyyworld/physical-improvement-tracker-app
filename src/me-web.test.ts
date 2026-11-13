// @vitest-environment jsdom
// Connected apps on the web, end to end: the Player turns the web connector on for one app, an AI
// app on the web uses it (the connector Worker, run here against the same in-memory cloud), and
// Arise reads back what the app did and takes its notes into the day.

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetCloud, restFetch } from './test/fake-firebase';
import { readMe } from '../public/me.js';
import { LINK_DEFAULT } from './lib/me';
import { Feed, forgetPages, handle, type Env, type StorageLike } from '../worker/connector/src/index';
import { CONNECTOR } from './connector-config';
import type { LifeEvent } from './life/types';

vi.mock('./lib/firebase', () => import('./test/fake-firebase'));
vi.mock('./lib/crypto', async (orig) => {
  const real = await orig<typeof import('./lib/crypto')>();
  return { ...real, deriveMaster: (p: string, id: string) => real.deriveMaster(p, id, 1000) };
});

const PW = 'correct horse battery';
const DAY = 86_400_000;
const read = (l: { id: string; key: string }) => readMe(`${l.id}.${l.key}`, { fetch: restFetch as typeof fetch, projectId: 'p', apiKey: 'k' });

// The connector, with its Durable Objects in memory.
function connector() {
  const data = new Map<string, Map<string, unknown>>();
  const feeds = new Map<string, Feed>();
  const env: Env = {
    ALLOWED_ORIGINS: 'http://localhost:3000',
    PER_LINK: { limit: async () => ({ success: true }) },
    PER_IP: { limit: async () => ({ success: true }) },
    FEEDS: {
      idFromName: (n: string) => n,
      get(id: unknown) {
        const name = String(id);
        if (!feeds.has(name)) {
          const m = new Map<string, unknown>();
          data.set(name, m);
          const storage: StorageLike = { get: async <T,>(k: string) => structuredClone(m.get(k)) as T, put: async (k, v) => void m.set(k, structuredClone(v)), deleteAll: async () => m.clear(), setAlarm: async () => {} };
          feeds.set(name, new Feed({ storage }));
        }
        return { fetch: (input: string, init?: RequestInit) => feeds.get(name)!.fetch(new Request(input, init)) };
      },
    },
  };
  const deps = { fetch: restFetch as typeof fetch, projectId: 'p', apiKey: 'k' };
  // What Arise's fetch reaches: the connector, as the browser would.
  const fetchStub = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith(CONNECTOR.server)) throw new Error(`Unexpected fetch: ${url}`);
    return handle(new Request(url, init), env, deps);
  });
  vi.stubGlobal('fetch', fetchStub);
  const ask = async (address: string, name: string, args: object = {}, ua = 'Claude-User') => {
    const res = await handle(new Request(address, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': ua }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }), env, deps);
    return ((await res.json()) as { result: { isError?: boolean; content: { text: string }[] } }).result;
  };
  return { env, data, ask, fetchStub };
}

async function device() {
  vi.resetModules();
  const S = await import('./store');
  const SYNC = await import('./sync');
  const ME = await import('./me');
  const PORT = await import('./life/store-port');
  const added: LifeEvent[] = [];
  PORT.setLifeStore({
    addEvents: async (events) => {
      const fresh = events.filter((e) => !added.some((a) => a.id === e.id));
      added.push(...fresh);
      return fresh.length;
    },
  });
  await SYNC.initSync({ render: () => {}, changed: () => {}, checkForUpdate: () => {} });
  ME.initMe();
  await SYNC.submit('up', { email: 'me@example.com', password: PW, password2: PW });
  expect(SYNC.status.error).toBe('');
  SYNC.status.locked = true;
  S.saveGoal({ id: 'g1', title: 'Run a half marathon', category: 'fitness', why: 'Feel strong at 40', created: '2026-10-01', quests: [] });
  return { S, SYNC, ME, added };
}

beforeEach(() => {
  resetCloud();
  forgetPages();
  localStorage.clear();
  globalThis.indexedDB = new IDBFactory();
  document.body.innerHTML = '<div id="sheet" hidden><div class="sheet-panel"><button class="sheet-close"></button><div class="sheet-body"></div></div></div><div id="toast"></div><main id="app"></main>';
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('an app on the web', () => {
  it('is off until the Player turns it on, and then gets only what that app gets', async () => {
    const c = connector();
    const a = await device();
    const l = await a.ME.connect('Claude', LINK_DEFAULT);
    expect(await read(l)).not.toHaveProperty('web');
    const address = a.ME.connectorAddress(l);
    expect(address).toBe(`${CONNECTOR.server}/mcp/${l.id}.${l.key}`);
    expect((await c.ask(address, 'my_goals')).isError).toBe(true);

    expect(await a.ME.setWeb(l.id, { notes: false, until: Date.now() + 30 * DAY })).toBe(true);
    expect((await read(l)).web).toEqual({ notes: false, until: a.ME.links()[0].web!.until });
    forgetPages();
    const goals = await c.ask(address, 'my_goals');
    expect(goals.isError).toBeUndefined();
    expect(goals.content[0].text).toContain('Run a half marathon');
    expect((await c.ask(address, 'add_note', { text: 'Ran 5 km' })).isError).toBe(true);

    // Off again: the address stops working, the link itself doesn't.
    await a.ME.setWeb(l.id, null);
    forgetPages();
    expect((await c.ask(address, 'my_goals')).isError).toBe(true);
    expect((await read(l)).goals[0].title).toBe('Run a half marathon');
    expect(a.ME.links()[0]).not.toHaveProperty('web');
  });

  it('stops by itself on the date the Player picked', async () => {
    connector();
    const a = await device();
    const l = await a.ME.connect('ChatGPT', LINK_DEFAULT);
    const until = Date.now() + 7 * DAY;
    await a.ME.setWeb(l.id, { notes: true, until });
    expect(a.ME.webNow(a.ME.links()[0], until - 1)).toEqual({ notes: true, until });
    expect(a.ME.webNow(a.ME.links()[0], until + 1)).toBeNull();
    // The next update after that date takes it off the page.
    const later = Date.now() + 8 * DAY;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    a.S.tick('nothing', { done: true });
    await a.ME.refresh();
    expect(await read(l)).not.toHaveProperty('web');
    expect(a.ME.links()[0].web).toEqual({ notes: true, until }); // and Arise still says when it ended
  });

  it("takes the app's notes into the day and keeps a log of what it did", async () => {
    const c = connector();
    const a = await device();
    const l = await a.ME.connect('Claude', LINK_DEFAULT);
    await a.ME.setWeb(l.id, { notes: true });
    const address = a.ME.connectorAddress(l);
    expect((await c.ask(address, 'about_me')).isError).toBeUndefined();
    expect((await c.ask(address, 'add_note', { text: 'Ran 5 km before work.\nFelt great.' })).isError).toBeUndefined();

    expect(await a.ME.pullFeeds({ force: true })).toBe(1);
    expect(a.added).toEqual([
      {
        id: expect.stringMatching(new RegExp(`^other:ai-note-${l.id}-\\d+$`)),
        source: 'other',
        kind: 'note',
        at: expect.any(Number),
        title: 'Claude: Ran 5 km before work.',
        detail: 'Ran 5 km before work.\nFelt great.\n\nAdded by Claude, through the web connector.',
        tier: 2,
        meta: { from: 'Claude' },
      },
    ]);
    expect(a.ME.feedOf(l.id).map((e) => e.tool)).toEqual(['about_me', 'add_note']);
    // The connector let them go once Arise had them: nothing comes twice.
    expect(await a.ME.pullFeeds({ force: true })).toBe(0);
    expect(a.ME.feedOf(l.id)).toHaveLength(2);
    expect(c.data.get(l.id)!.get('e')).toEqual([]);

    // Turning the link off forgets its log here.
    await a.ME.turnOff(l.id);
    expect(a.ME.feedOf(l.id)).toEqual([]);
  });

  it('asks the connector nothing when no app is on the web', async () => {
    const c = connector();
    const a = await device();
    await a.ME.connect('Buddy', LINK_DEFAULT);
    expect(await a.ME.pullFeeds({ force: true })).toBe(0);
    expect(c.fetchStub).not.toHaveBeenCalled();
  });
});
