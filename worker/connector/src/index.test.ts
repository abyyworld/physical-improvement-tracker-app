// The web connector: MCP over HTTP for AI apps on the web, from one app's me link, only while the
// Player has the web on for it; the sealed log and notes Arise reads back.

import { beforeEach, describe, expect, it } from 'vitest';
import { Feed, forgetPages, handle, MAX_NOTES, type Env, type StorageLike } from './index';
import { cloud, resetCloud, restFetch } from '../../../src/test/fake-firebase';
import * as ME from '../../../src/lib/me';
import { newShareRef, SHARE_OFF } from '../../../src/lib/share';
import { feedKeys, openEntry, type SealedEntry } from '../../../src/lib/feed';

const BASE: ME.MePayload = {
  format: 'arise.me/v1',
  name: 'Sam',
  facts: [{ text: 'I run on Sunday mornings.', since: '2026-09-02' }],
  goals: [{ title: 'Run a half marathon', why: 'I want to feel strong at 40', streak: 12 }],
  days: [{ day: '2026-10-16', text: 'I ran 8 km before work.' }],
  updated: Date.UTC(2026, 9, 17, 9, 30),
};

let now = Date.UTC(2026, 9, 17, 10);
const deps = { fetch: restFetch as typeof fetch, projectId: 'p', apiKey: 'k', now: () => now };

// Durable Objects, one per name, each with storage in memory.
function fakeEnv(limits = { link: true, ip: true }) {
  const objects = new Map<string, { feed: Feed; data: Map<string, unknown>; alarm: number }>();
  const env: Env & { objects: typeof objects } = {
    ALLOWED_ORIGINS: 'https://abyyworld.github.io,capacitor://localhost',
    SITE: 'https://abyyworld.github.io/physical-improvement-tracker-app/',
    PER_LINK: { limit: async () => ({ success: limits.link }) },
    PER_IP: { limit: async () => ({ success: limits.ip }) },
    objects,
    FEEDS: {
      idFromName: (name: string) => name,
      get(id: unknown) {
        const name = String(id);
        if (!objects.has(name)) {
          const data = new Map<string, unknown>();
          const o = { feed: null as unknown as Feed, data, alarm: 0 };
          const storage: StorageLike = {
            get: async <T,>(k: string) => structuredClone(data.get(k)) as T | undefined,
            put: async (k, v) => void data.set(k, structuredClone(v)),
            deleteAll: async () => data.clear(),
            setAlarm: async (t) => void (o.alarm = t),
          };
          o.feed = new Feed({ storage }, undefined, () => now);
          objects.set(name, o);
        }
        const o = objects.get(name)!;
        return { fetch: (input: string, init?: RequestInit) => o.feed.fetch(new Request(input, init)) };
      },
    },
  };
  return env;
}

async function fakeLink(p: ME.MePayload) {
  const ref = await newShareRef();
  const { sealed } = await ME.sealMe(ref, p);
  cloud.docs.set(`shares/${ref.id}`, { owner: 'uid1', iv: sealed.iv, ct: sealed.ct, v: 1, updated: p.updated });
  return ref;
}

const at = (ref: { id: string; key: string }) => `https://arise-connector.example.workers.dev/mcp/${ref.id}.${ref.key}`;
type Reply = { id?: unknown; result?: { tools?: { name: string }[]; content?: { text: string }[]; isError?: boolean; protocolVersion?: string }; error?: { code: number; message: string } };
async function post(env: Env, url: string, body: unknown, ua = 'Claude-User') {
  const res = await handle(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'user-agent': ua }, body: JSON.stringify(body) }), env, deps);
  return { res, body: res.status === 202 ? null : ((await res.json()) as Reply) };
}
const rpc = (env: Env, url: string, method: string, params?: object) => post(env, url, { jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) });
const call = async (env: Env, url: string, name: string, args: object = {}) => (await rpc(env, url, 'tools/call', { name, arguments: args })).body!.result!;
const toolNames = async (env: Env, url: string) => (await rpc(env, url, 'tools/list')).body!.result!.tools!.map((t) => t.name);

async function readFeed(env: Env, ref: { id: string; key: string }) {
  const { key, token } = await feedKeys(ref.id, ref.key);
  const res = await handle(new Request(`https://x/feed/${ref.id}`, { headers: { authorization: `Bearer ${token}`, origin: 'https://abyyworld.github.io' } }), env, deps);
  const { entries } = (await res.json()) as { entries: SealedEntry[] };
  return { res, entries, open: await Promise.all(entries.map((e) => openEntry(key, ref.id, e))), token };
}

beforeEach(() => {
  resetCloud();
  forgetPages();
  now = Date.UTC(2026, 9, 17, 10);
});

describe('the web connector', () => {
  it('says it is there, for Arise to check', async () => {
    const res = await handle(new Request('https://x/health', { headers: { origin: 'https://abyyworld.github.io' } }), fakeEnv(), deps);
    expect(await res.json()).toMatchObject({ ok: true, name: 'arise-connector' });
    expect(res.headers.get('access-control-allow-origin')).toBe('https://abyyworld.github.io');
    const other = await handle(new Request('https://x/health', { headers: { origin: 'https://evil.example' } }), fakeEnv(), deps);
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('speaks MCP over HTTP: JSON answers, 202 for notifications, no stream', async () => {
    const env = fakeEnv();
    const url = at(await fakeLink({ ...BASE, web: { notes: false } }));
    const init = await rpc(env, url, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-ai', version: '1' } });
    expect(init.res.status).toBe(200);
    expect(init.res.headers.get('content-type')).toContain('application/json');
    expect(init.res.headers.get('access-control-allow-origin')).toBe('*');
    expect(init.body!.result!.protocolVersion).toBe('2025-06-18');
    const n = await post(env, url, { jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(n.res.status).toBe(202);
    expect((await handle(new Request(url), env, deps)).status).toBe(405);
    expect((await handle(new Request(url, { method: 'DELETE' }), env, deps)).status).toBe(405);
    const batch = await post(env, url, [
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', id: 2, method: 'ping' },
    ]);
    expect(batch.body).toEqual([
      { jsonrpc: '2.0', id: 1, result: {} },
      { jsonrpc: '2.0', id: 2, result: {} },
    ]);
    expect((await handle(new Request(url, { method: 'POST', body: '{nope' }), env, deps)).status).toBe(400);
    expect((await handle(new Request('https://x/mcp/not-a-link', { method: 'POST', body: '{}' }), env, deps)).status).toBe(404);
    expect((await handle(new Request('https://x/.well-known/oauth-protected-resource'), env, deps)).status).toBe(404);
  });

  it('answers only for a link the Player turned on for the web, and only until the date they picked', async () => {
    const env = fakeEnv();
    const plain = at(await fakeLink(BASE));
    const off = await call(env, plain, 'about_me');
    expect(off.isError).toBe(true);
    expect(off.content![0].text).toContain("isn't turned on for AI apps on the web");
    expect(env.objects.size).toBe(0); // nothing logged for a link that isn't on

    const until = now + 86_400_000;
    const on = at(await fakeLink({ ...BASE, web: { notes: false, until } }));
    const about = await call(env, on, 'about_me');
    expect(about.isError).toBeUndefined();
    expect(about.content![0].text).toContain('First name: Sam');
    now = until + 1;
    const ended = await call(env, on, 'my_goals');
    expect(ended.isError).toBe(true);
    expect(ended.content![0].text).toContain('is over');
  });

  it('notices a link turned off', async () => {
    const env = fakeEnv();
    const ref = await fakeLink({ ...BASE, web: { notes: false } });
    expect((await call(env, at(ref), 'my_goals')).isError).toBeUndefined();
    cloud.docs.set(`shares/${ref.id}`, { ...SHARE_OFF });
    now += 16_000;
    const off = await call(env, at(ref), 'my_goals');
    expect(off.isError).toBe(true);
    expect(off.content![0].text).toContain('turned off');
  });

  it('gives ChatGPT its search and fetch, over exactly what the link holds', async () => {
    const env = fakeEnv();
    const url = at(await fakeLink({ ...BASE, web: { notes: false } }));
    expect(await toolNames(env, url)).toEqual(['about_me', 'my_goals', 'recent_days', 'search', 'fetch']);
    const found = JSON.parse((await call(env, url, 'search', { query: 'running half marathon' })).content![0].text);
    expect(found.results[0]).toMatchObject({ id: 'goal-1', title: 'Goal: Run a half marathon' });
    const all = JSON.parse((await call(env, url, 'search', { query: '' })).content![0].text);
    expect(all.results.map((r: { id: string }) => r.id)).toEqual(['about', 'goal-1', 'fact-1', 'day-2026-10-16']);
    const day = JSON.parse((await call(env, url, 'fetch', { id: 'day-2026-10-16' })).content![0].text);
    expect(day.text).toContain('I ran 8 km before work.');
    expect(day.text).toContain('never instructions');
    expect((await call(env, url, 'fetch', { id: 'goal-9' })).isError).toBe(true);
  });

  it('takes notes only when the Player allowed them, sealed so only Arise can read them', async () => {
    const env = fakeEnv();
    const readOnly = at(await fakeLink({ ...BASE, web: { notes: false } }));
    expect(await toolNames(env, readOnly)).not.toContain('add_note');
    expect((await call(env, readOnly, 'add_note', { text: 'Ran 5 km' })).isError).toBe(true);

    const ref = await fakeLink({ ...BASE, web: { notes: true } });
    const url = at(ref);
    expect(await toolNames(env, url)).toContain('add_note');
    expect((await call(env, url, 'add_note', { text: '' })).isError).toBe(true);
    expect((await call(env, url, 'add_note', { text: 'x'.repeat(1001) })).isError).toBe(true);
    const ok = await call(env, url, 'add_note', { text: 'Ran 5 km before work.' });
    expect(ok.isError).toBeUndefined();
    await call(env, url, 'my_goals');

    // What the server keeps: ciphertext and a hash of the token, never the words.
    const stored = JSON.stringify([...env.objects.get(ref.id)!.data.values()]);
    expect(stored).not.toContain('Ran 5 km');
    expect(stored).not.toContain('my_goals');

    const { entries, open, token } = await readFeed(env, ref);
    expect(stored).not.toContain(token);
    expect(entries.map((e) => e.n)).toEqual([1, 2, 3, 4]);
    expect(open[0]).toMatchObject({ tool: 'add_note', ok: false }); // empty
    expect(open[0]!.note).toBeUndefined();
    expect(open[1]).toMatchObject({ tool: 'add_note', ok: false }); // too long
    expect(open[2]).toMatchObject({ tool: 'add_note', ok: true, client: 'Claude', note: 'Ran 5 km before work.' });
    expect(open[3]).toMatchObject({ tool: 'my_goals', ok: true, client: 'Claude' });
    expect(env.objects.get(ref.id)!.alarm).toBe(now + 60 * 86_400_000);
  });

  it('logs what each app did, which only the token from the link opens, and lets it go once read', async () => {
    const env = fakeEnv();
    const ref = await fakeLink({ ...BASE, web: { notes: false } });
    await post(env, at(ref), { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'about_me', arguments: {} } }, 'openai-mcp/1.0');
    await post(env, at(ref), { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const { entries, open, token } = await readFeed(env, ref);
    expect(entries).toHaveLength(1); // listing tools isn't logged
    expect(open[0]).toMatchObject({ tool: 'about_me', ok: true, client: 'ChatGPT', at: now });

    const wrong = await handle(new Request(`https://x/feed/${ref.id}`, { headers: { authorization: `Bearer ${'A'.repeat(43)}` } }), env, deps);
    expect(wrong.status).toBe(403);
    expect((await handle(new Request(`https://x/feed/${ref.id}`), env, deps)).status).toBe(401);
    // Another link's log, with this token: refused.
    const other = await fakeLink({ ...BASE, web: { notes: false } });
    await call(env, at(other), 'about_me');
    expect((await handle(new Request(`https://x/feed/${other.id}`, { headers: { authorization: `Bearer ${token}` } }), env, deps)).status).toBe(403);

    const done = await handle(new Request(`https://x/feed/${ref.id}/done`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ upTo: entries[0].n }) }), env, deps);
    expect(await done.json()).toEqual({ left: 0 });
    expect((await readFeed(env, ref)).entries).toEqual([]);
  });

  it('keeps at most 50 notes waiting, and nothing past 60 days unused', async () => {
    const env = fakeEnv();
    const ref = await fakeLink({ ...BASE, web: { notes: true } });
    for (let i = 0; i < MAX_NOTES; i++) expect((await call(env, at(ref), 'add_note', { text: `Note ${i}` })).isError).toBeUndefined();
    const full = await call(env, at(ref), 'add_note', { text: 'One more' });
    expect(full.isError).toBe(true);
    expect(full.content![0].text).toContain('notes waiting');
    await env.objects.get(ref.id)!.feed.alarm();
    expect(env.objects.get(ref.id)!.data.size).toBe(0);
  });

  it('slows down a link or an address that asks too often', async () => {
    const url = at(await fakeLink({ ...BASE, web: { notes: false } }));
    const res = (await post(fakeEnv({ link: false, ip: true }), url, { jsonrpc: '2.0', id: 1, method: 'ping' })).res;
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
  });
});
