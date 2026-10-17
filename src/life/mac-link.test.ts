// @vitest-environment jsdom
// Arise and the Mac helper: linking with the pairing code, the switches, and pulling events into
// the life log through lifeStore(), acknowledging each page only once it's saved, against a fake
// helper. (mac-helper/test/arise-link.test.ts runs it against the real one.)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LifeEvent } from './types';
import { helperFetch, type Asked } from '../test/fake-mac-helper';

type Link = typeof import('./mac-link');
type Port = typeof import('./store-port');

const CODE = 'ABCDE12345FGHJK67890';
const MAC_CHROME = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36', maxTouchPoints: 0 };
const MAC_SAFARI = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15', maxTouchPoints: 0 };
const MAC_EDGE = { userAgent: `${MAC_CHROME.userAgent} Edg/141.0.0.0`, maxTouchPoints: 0 };
const IPAD = { userAgent: MAC_SAFARI.userAgent, maxTouchPoints: 5 };
const IPHONE = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' };
const WINDOWS = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36' };

// Fresh copies of the life log's port and the link for each test (both keep state in the module).
async function load() {
  vi.resetModules();
  const port: Port = await import('./store-port');
  const mac: Link = await import('./mac-link');
  return { port, mac };
}

// A life log that keeps what it's given (by id, like the real one).
function lifeLog() {
  const got = new Map<string, LifeEvent>();
  return {
    got,
    addEvents: vi.fn(async (events: LifeEvent[]) => {
      let n = 0;
      for (const e of events) if (!got.has(e.id)) got.set(e.id, e), n++;
      return n;
    }),
  };
}

const status = (over: Record<string, unknown> = {}) => ({
  app: 'arise-helper',
  version: 1,
  node: '/Users/me/.arise-helper/bin/arise-helper',
  fullDiskAccess: true,
  settings: { calls: true, notifications: false, messages: true, text: false, safari: false, apps: false },
  sources: { calls: { state: 'ok', found: 2, last: 1, waiting: 2 }, messages: { state: 'ok', found: 1, last: 1, waiting: 1 } },
  waiting: 3,
  ...over,
});

const event = (id: string, kind = 'call', over: Record<string, unknown> = {}) => ({ id: `mac:${id}`, source: 'mac', kind, at: Date.parse('2025-06-01T09:00:00Z'), title: `Something ${id}`, tier: 3, ...over });

// A pretend helper: answers like the real one (proof of the code both ways), from a queue of events.
// `calls` has each request but the one-time numbers.
function fakeHelper(queue: unknown[], { code = CODE, st = status() as Record<string, unknown> } = {}) {
  const calls: Asked[] = [];
  let items = queue.map((ev, i) => ({ seq: i + 1, ev }));
  const f = vi.fn(
    helperFetch(
      code,
      ({ path, body }) => {
        const u = new URL(path, 'http://127.0.0.1');
        if (u.pathname === '/v1/status') return { body: st };
        if (u.pathname === '/v1/settings') return { body: { ...st, settings: { ...(st.settings as object), ...(body as object) } } };
        if (u.pathname === '/v1/events') {
          const page = items.slice(0, 2);
          return { body: { events: page.map((i) => i.ev), next: page.length ? page[page.length - 1].seq : 0, more: items.length > 2 } };
        }
        if (u.pathname === '/v1/ack') {
          items = items.filter((i) => i.seq > (body as { upTo: number }).upTo);
          return { body: { waiting: items.length } };
        }
        return { status: 404, body: { error: 'not found' } };
      },
      calls,
    ),
  );
  return { f, calls, left: () => items.length };
}

beforeEach(() => localStorage.clear());
afterEach(() => vi.useRealTimers());

describe('where it works', () => {
  it('installs with one command from GitHub', async () => {
    const { mac } = await load();
    expect(mac.INSTALL_COMMAND).toContain('github.com/abyyworld/physical-improvement-tracker-app/archive/refs/heads/main.tar.gz');
    expect(mac.INSTALL_COMMAND).toContain('bash physical-improvement-tracker-app-main/mac-helper/install.sh');
  });

  it('is for a browser on a Mac, not an iPad or an iPhone', async () => {
    const { mac } = await load();
    expect(mac.isMac(MAC_CHROME)).toBe(true);
    expect(mac.isMac(MAC_SAFARI)).toBe(true);
    expect(mac.isMac(IPAD)).toBe(false);
    expect(mac.isMac(IPHONE)).toBe(false);
    expect(mac.isMac(WINDOWS)).toBe(false);
    expect([MAC_CHROME, MAC_EDGE, MAC_SAFARI].map((n) => mac.browser(n))).toEqual(['chromium', 'chromium', 'safari']);
  });

  it('tells Safari users to use Chrome or Edge, since Safari blocks it', async () => {
    const { mac } = await load();
    expect(mac.problemText('unreachable', MAC_SAFARI)).toMatch(/Safari doesn't let websites reach a helper.*Chrome or Edge/);
    expect(mac.problemText('unreachable', MAC_CHROME)).toMatch(/Allow/);
  });
});

describe('linking', () => {
  it('links with the code however it was typed, and keeps it on this device only', async () => {
    const { mac } = await load();
    const h = fakeHelper([]);
    mac.useHelper(h.f as typeof fetch);
    const st = await mac.link(' abcde-12345 fghjk-67890 ');
    expect(st.settings.calls).toBe(true);
    expect(h.calls[0]).toMatchObject({ method: 'GET', path: '/v1/status', auth: expect.stringMatching(/^Arise [0-9a-f]{32}\.[0-9a-f]{32}\.[0-9a-f]{64}$/) });
    expect(h.f.mock.calls.map((c) => c[0])).toEqual([`http://127.0.0.1:${mac.PORT}/v1/hello`, `http://127.0.0.1:${mac.PORT}/v1/status`]);
    for (const c of h.f.mock.calls) expect(c[1]).toMatchObject({ credentials: 'omit', cache: 'no-store' });
    // The code itself is never sent.
    expect(JSON.stringify(h.f.mock.calls)).not.toContain(CODE);
    expect(mac.linked()).toBe(true);
    expect(JSON.parse(localStorage.getItem('arise-mac')!).code).toBe(CODE);
    mac.unlink();
    expect(mac.linked()).toBe(false);
  });

  it("says what went wrong, and doesn't link", async () => {
    const { mac } = await load();
    mac.useHelper(fakeHelper([]).f as typeof fetch);
    await expect(mac.link('WRONG-WRONG-WRONG-WRONG')).rejects.toMatchObject({ problem: 'code' });
    await expect(mac.link('short')).rejects.toMatchObject({ problem: 'code' });
    mac.useHelper((async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch);
    await expect(mac.link(CODE)).rejects.toMatchObject({ problem: 'unreachable' });
    mac.useHelper((async () => new Response('{}', { status: 429 })) as typeof fetch);
    await expect(mac.link(CODE)).rejects.toMatchObject({ problem: 'busy' });
    expect(mac.linked()).toBe(false);
  });

  it("never sends the code, and won't take answers from something that only pretends to be the helper", async () => {
    const { mac, port } = await load();
    const log = lifeLog();
    port.setLifeStore(log);
    mac.useHelper(fakeHelper([]).f as typeof fetch);
    await mac.link(CODE);
    // Something else on the port, while the helper isn't running: it doesn't know the code, so it
    // can only answer without proof, or prove a code of its own.
    const sent: string[] = [];
    for (const proof of [null, 'f'.repeat(64)]) {
      mac.useHelper((async (url: string | URL | Request, init: RequestInit = {}) => {
        sent.push(`${String(url)} ${JSON.stringify(init)}`);
        const body = String(url).endsWith('/v1/hello') ? { nonce: 'a'.repeat(32) } : { ...status(), events: [event('call:fake')], next: 1, more: false };
        return new Response(JSON.stringify(body), { status: 200, headers: proof ? { 'X-Arise-Proof': proof } : {} });
      }) as typeof fetch);
      await expect(mac.refresh()).rejects.toMatchObject({ problem: 'failed' });
      await expect(mac.pull()).rejects.toMatchObject({ problem: 'failed' });
      await expect(mac.link(CODE)).rejects.toMatchObject({ problem: 'failed' });
    }
    expect(log.addEvents).not.toHaveBeenCalled();
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.join('\n')).not.toContain(CODE);
    expect(sent.join('\n')).not.toContain('ABCDE-12345');
  });

  it('asks again once if the helper started again between its two steps', async () => {
    const { mac } = await load();
    const h = fakeHelper([]);
    let first = true;
    mac.useHelper((async (url: string | URL | Request, init?: RequestInit) => {
      if (first && !String(url).endsWith('/v1/hello')) {
        first = false;
        return new Response(JSON.stringify({ error: 'nonce' }), { status: 401 });
      }
      return h.f(url, init);
    }) as typeof fetch);
    expect((await mac.link(CODE)).settings.calls).toBe(true);
  });

  it('cleans what the helper says about itself', async () => {
    const { mac } = await load();
    mac.useHelper(fakeHelper([], { st: { settings: { calls: 'yes', text: true }, sources: { calls: { state: 'hacked', found: -3 } }, node: 42 } }).f as typeof fetch);
    const st = await mac.link(CODE);
    expect(st.settings).toEqual({ calls: false, notifications: false, messages: false, text: true, safari: false, apps: false });
    expect(st.sources.calls).toEqual({ state: 'off', found: 0, last: null, waiting: 0 });
    expect(st.node).toBe('');
    expect(st.fullDiskAccess).toBeNull();
  });

  it('turns sources on and off in the helper', async () => {
    const { mac } = await load();
    const h = fakeHelper([]);
    mac.useHelper(h.f as typeof fetch);
    await mac.link(CODE);
    const st = await mac.setSwitches({ safari: true });
    expect(h.calls.at(-1)).toMatchObject({ method: 'POST', path: '/v1/settings', body: { safari: true } });
    expect(st.settings.safari).toBe(true);
    expect(mac.lastStatus()?.settings.safari).toBe(true);
  });
});

describe('bringing events in', () => {
  it('adds every page to the life log, then acknowledges it', async () => {
    const { mac, port } = await load();
    const log = lifeLog();
    port.setLifeStore(log);
    const h = fakeHelper([event('call:1'), event('msg:1', 'message'), event('call:2'), event('app:x:1', 'app', { tier: 2 }), event('call:3')]);
    mac.useHelper(h.f as typeof fetch);
    await mac.link(CODE);
    expect(await mac.pull()).toBe(5);
    expect([...log.got.keys()]).toEqual(['mac:call:1', 'mac:msg:1', 'mac:call:2', 'mac:app:x:1', 'mac:call:3']);
    expect(h.left()).toBe(0);
    // Each acknowledgement comes after its page was saved.
    const order = h.calls.filter((c) => c.path !== '/v1/status').map((c) => (c.method === 'POST' ? `ack ${(c.body as { upTo: number }).upTo}` : 'page'));
    expect(order).toEqual(['page', 'ack 2', 'page', 'ack 4', 'page', 'ack 5']);
    expect(log.addEvents).toHaveBeenCalledTimes(3);
    expect(mac.lastNew()).toBe(5);
    expect(mac.totals()).toEqual({ calls: 3, messages: 1, apps: 1 });
    expect(mac.lastPull()).toBeGreaterThan(0);
    expect(mac.lastProblem()).toBe('');
    // Nothing new the next time.
    expect(await mac.pull()).toBe(0);
  });

  it("doesn't acknowledge what the life log couldn't save", async () => {
    const { mac, port } = await load();
    port.setLifeStore({ addEvents: vi.fn(async () => Promise.reject(new Error('full'))) });
    const h = fakeHelper([event('call:1')]);
    mac.useHelper(h.f as typeof fetch);
    await mac.link(CODE);
    await expect(mac.pull()).rejects.toThrow('full');
    expect(h.calls.some((c) => c.path === '/v1/ack')).toBe(false);
    expect(h.left()).toBe(1);
    expect(mac.lastProblem()).toBe('failed');
  });

  it('waits for the life log, and says so if it never comes', async () => {
    const { mac, port } = await load();
    port.setLifeStore(null); // as if this build had no life log yet
    const h = fakeHelper([event('call:1')]);
    mac.useHelper(h.f as typeof fetch);
    await mac.link(CODE);
    vi.useFakeTimers();
    const p = mac.pull();
    const seen = expect(p).rejects.toMatchObject({ problem: 'not-ready' });
    await vi.advanceTimersByTimeAsync(15_000);
    await seen;
    expect(h.left()).toBe(1);
    expect(mac.lastProblem()).toBe('not-ready');
  });

  it('does nothing until linked, and one pull at a time', async () => {
    const { mac, port } = await load();
    port.setLifeStore(lifeLog());
    expect(await mac.pull()).toBe(0);
    const h = fakeHelper([event('call:1')]);
    mac.useHelper(h.f as typeof fetch);
    await mac.link(CODE);
    const [a, b] = [mac.pull(), mac.pull()];
    expect(a).toBe(b);
    expect(await a).toBe(1);
  });

  it('remembers when the helper is out of reach', async () => {
    const { mac, port } = await load();
    port.setLifeStore(lifeLog());
    mac.useHelper(fakeHelper([]).f as typeof fetch);
    await mac.link(CODE);
    mac.useHelper((async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch);
    await expect(mac.pull()).rejects.toMatchObject({ problem: 'unreachable' });
    expect(mac.lastProblem()).toBe('unreachable');
    await expect(mac.refresh()).rejects.toMatchObject({ problem: 'unreachable' });
  });
});

describe('checking each event', () => {
  it('keeps good events, with the tier their kind needs', async () => {
    const { mac } = await load();
    const at = Date.parse('2025-06-01T09:00:00Z');
    expect(mac.cleanEvent({ ...event('call:1'), tier: 1, end: at + 60_000, value: 1, unit: 'min', meta: { direction: 'in', missed: true, n: 2 } }, false)).toEqual({
      id: 'mac:call:1',
      source: 'mac',
      kind: 'call',
      at,
      end: at + 60_000,
      title: 'Something call:1',
      value: 1,
      unit: 'min',
      tier: 3,
      meta: { direction: 'in', missed: true, n: 2 },
    });
    expect(mac.cleanEvent(event('app:1', 'app', { tier: 3 }), false)?.tier).toBe(2);
    expect(mac.cleanEvent(event('safari:1', 'visit', { url: 'https://example.com/a', detail: 'On your iPhone or another device' }), false)).toMatchObject({ url: 'https://example.com/a', detail: 'On your iPhone or another device' });
  });

  it('keeps the words of messages and notifications only with text on', async () => {
    const { mac } = await load();
    expect(mac.cleanEvent(event('msg:1', 'message', { detail: 'secret' }), false)).not.toHaveProperty('detail');
    expect(mac.cleanEvent(event('note:1', 'notification', { detail: 'secret' }), false)).not.toHaveProperty('detail');
    expect(mac.cleanEvent(event('msg:1', 'message', { detail: 'hello' }), true)?.detail).toBe('hello');
  });

  it('turns away anything odd', async () => {
    const { mac } = await load();
    const bad = [
      null,
      'x',
      event('call:1', 'call', { id: 'google:1' }),
      event('call:1', 'call', { source: 'google' }),
      event('x:1', 'purchase'),
      event('call:1', 'call', { at: 5 }),
      event('call:1', 'call', { at: Date.now() + 3 * 86_400_000 }),
      event('call:1', 'call', { at: 'soon' }),
      event('call:1', 'call', { title: '   ' }),
    ];
    for (const b of bad) expect(mac.cleanEvent(b, true)).toBeNull();
    const odd = mac.cleanEvent(event('safari:1', 'visit', { url: 'javascript:alert(1)', end: 1, value: 'x', meta: { 'bad key': 1, ok: { deep: 1 }, fine: 'yes', n: NaN } }), true)!;
    expect(odd).not.toHaveProperty('url');
    expect(odd).not.toHaveProperty('end');
    expect(odd).not.toHaveProperty('value');
    expect(odd.meta).toEqual({ fine: 'yes' });
    expect(mac.cleanEvent(event('call:1', 'call', { title: 'x'.repeat(500) }), true)!.title).toHaveLength(200);
  });
});
