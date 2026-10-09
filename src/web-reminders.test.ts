// @vitest-environment jsdom
// Notifications for the web app: turning them on and off, what the reminders server is told and
// what it never is, and the texts left on the device for the service worker. The browser's push
// and notification APIs, its cache and the server are simulated.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CACHE, readTexts } from './lib/reminder-texts';

vi.mock('./lib/firebase', () => import('./test/fake-firebase'));

const SERVER = 'https://arise-reminders.example.workers.dev';
const SCOPE = 'https://abyyworld.github.io/physical-improvement-tracker-app/';
const VAPID_BYTES = Uint8Array.from({ length: 65 }, (_, i) => (i ? i : 4));
const VAPID = Buffer.from(VAPID_BYTES).toString('base64url');
const TODAY = '2026-10-09'; // a Friday

interface Call {
  path: string;
  body: Record<string, unknown> | null;
}

// A browser with push and notifications, and a reminders server that answers like the real one.
function device({
  permission = 'default' as NotificationPermission,
  answer = 'granted' as NotificationPermission,
  push = true,
  ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36',
  standalone = false,
  server = (_path: string): Response | Promise<Response> | null => null,
} = {}) {
  const calls: Call[] = [];
  let n = 0;
  let sub: ReturnType<typeof subscription> | null = null;
  const subscription = (key: ArrayBuffer, endpoint: string) => ({
    endpoint,
    options: { applicationServerKey: key },
    toJSON: () => ({ endpoint, expirationTime: null, keys: { p256dh: 'BKey', auth: 'secret' } }),
    unsubscribe: vi.fn(async () => {
      sub = null;
      return true;
    }),
  });
  const pushManager = {
    getSubscription: async () => sub,
    subscribe: vi.fn(async (o: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }) => {
      sub = subscription(new Uint8Array(o.applicationServerKey).buffer, `https://fcm.googleapis.com/fcm/send/device-${++n}`);
      return sub;
    }),
  };
  const reg = { scope: SCOPE, pushManager, addEventListener() {}, update: async () => {} };
  const sw = { ready: Promise.resolve(reg), controller: null, getRegistration: async () => reg, register: async () => reg, addEventListener() {}, removeEventListener() {} };
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: sw });
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: ua });
  Object.defineProperty(navigator, 'standalone', { configurable: true, value: standalone });
  if (push) vi.stubGlobal('PushManager', class {});
  else delete (window as { PushManager?: unknown }).PushManager;
  const notification = {
    permission,
    requestPermission: vi.fn(async () => {
      notification.permission = answer;
      return answer;
    }),
  };
  vi.stubGlobal('Notification', notification);
  window.matchMedia = ((q: string) => ({ matches: standalone && q.includes('standalone'), addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;

  const stores = new Map<string, Map<string, string>>();
  vi.stubGlobal('caches', {
    open: async (name: string) => {
      const m = stores.get(name) ?? new Map<string, string>();
      stores.set(name, m);
      return {
        put: async (url: string, res: Response) => void m.set(url, await res.text()),
        match: async (url: string) => (m.has(url) ? new Response(m.get(url)) : undefined),
      };
    },
    delete: async (name: string) => stores.delete(name),
  });

  let ids = 0;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const path = url.replace(`${SERVER}/`, '');
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ path, body });
    const custom = server(path);
    if (custom) return custom;
    if (path === 'v1/vapid') return Response.json({ key: VAPID });
    if (path === 'v1/subscribe') return Response.json({ id: `device-${++ids}`.padEnd(22, '0'), token: `token-${ids}`.padEnd(43, 'x') });
    return Response.json({ ok: true });
  });
  return { calls, pushManager, notification, stores, sub: () => sub, sent: (p: string) => calls.filter((c) => c.path === `v1/${p}`) };
}

// The app's modules, fresh, with the reminders server at `server`.
async function load(server = SERVER) {
  vi.resetModules();
  vi.doMock('./reminders-config', () => ({ REMINDERS: { server } }));
  const S = await import('./store');
  const R = await import('./reminders.js');
  const WR = await import('./web-reminders');
  return { S, R, WR };
}

// A goal with a daily quest, and one on weekdays only.
function studying(S: typeof import('./store')) {
  S.saveGoal({
    id: 'g1',
    title: 'Learn Spanish',
    category: 'learning',
    quests: [
      { id: 'q1', title: 'Study', schedule: { kind: 'daily' }, created: '2026-10-01' },
      { id: 'q2', title: 'Class', schedule: { kind: 'days', days: [0, 1, 2, 3, 4] }, created: '2026-10-01' },
    ],
  });
}

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 9, 12)); // Friday 9 October 2026, noon
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.doUnmock('./reminders-config');
});

describe('where it is offered', () => {
  it('in browsers with push, once the server is set up', async () => {
    device();
    expect((await load()).WR.supported()).toBe(true);
    expect((await load('')).WR.supported()).toBe(false);
    expect((await load('')).WR.needsHomeScreen()).toBe(false);
  });

  it('on iPhone and iPad, only in the app on the Home Screen', async () => {
    const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
    // Safari itself has no push, and says so.
    device({ ua: iphone, push: false });
    let { WR } = await load();
    expect(WR.supported()).toBe(false);
    expect(WR.needsHomeScreen()).toBe(true);
    expect(WR.HOME_SCREEN).toBe('Add Arise to your Home Screen first (Share, then Add to Home Screen), then turn this on there.');
    // The Home Screen app has it.
    device({ ua: iphone, standalone: true });
    ({ WR } = await load());
    expect(WR.supported()).toBe(true);
    expect(WR.needsHomeScreen()).toBe(false);
    expect(WR.blockedHelp()).toMatch(/Settings app, under Notifications, then Arise/);
  });

  it('never in the iPhone app, which has its own', async () => {
    device();
    (globalThis as { Capacitor?: unknown }).Capacitor = { isNativePlatform: () => true, PluginHeaders: [] };
    try {
      const { WR } = await load();
      expect(WR.supported()).toBe(false);
      expect(WR.needsHomeScreen()).toBe(false);
    } finally {
      delete (globalThis as { Capacitor?: unknown }).Capacitor;
    }
  });
});

describe('turning it on', () => {
  it('asks for permission first thing, straight from the tap', async () => {
    const d = device();
    const { WR } = await load();
    const on = WR.turnOn();
    // Nothing else may come before the question, or iPhone and iPad won't ask at all.
    expect(d.notification.requestPermission).toHaveBeenCalledTimes(1);
    expect(d.calls).toEqual([]);
    expect(await on).toEqual({ result: 'on' });
  });

  it("subscribes with the server's key and sends only the schedule", async () => {
    const d = device();
    const { S, WR } = await load();
    studying(S);
    S.state.settings.remindAt = '06:45';
    expect((await WR.turnOn()).result).toBe('on');

    expect(d.pushManager.subscribe).toHaveBeenCalledTimes(1);
    const opts = d.pushManager.subscribe.mock.calls[0][0];
    expect(opts.userVisibleOnly).toBe(true);
    expect(new Uint8Array(opts.applicationServerKey)).toEqual(VAPID_BYTES);

    const [signUp] = d.sent('subscribe');
    expect(signUp.body).toEqual({
      subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/device-1', expirationTime: null, keys: { p256dh: 'BKey', auth: 'secret' } },
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      morning: '06:45',
      evening: '20:30',
      days: [0, 1, 2, 3, 4, 5, 6],
    });
    // Nothing about the person or their goals.
    expect(JSON.stringify(d.calls)).not.toMatch(/Spanish|Study|Class/);
    expect(WR.isOn()).toBe(true);
    expect(WR.settings()).toMatchObject({ on: true, morning: '06:45', evening: true, eveningAt: '20:30' });
  });

  it("keeps the server's id and token on this device only: never synced or in a backup", async () => {
    device();
    const { S, WR } = await load();
    await WR.turnOn();
    const kept = JSON.parse(localStorage.getItem('arise-push')!);
    expect(kept).toMatchObject({ id: expect.stringMatching(/^device-1/), token: expect.stringMatching(/^token-1/) });
    expect(S.snapshot()).not.toContain(kept.token);
    expect(JSON.stringify(S.exportData())).not.toContain(kept.token);
    expect(localStorage.getItem('pit-data-v1') || '').not.toContain(kept.token);
  });

  it('stays off when notifications are blocked or not allowed', async () => {
    for (const answer of ['denied', 'default'] as const) {
      const d = device({ answer });
      const { WR } = await load();
      expect((await WR.turnOn()).result).toBe(answer === 'denied' ? 'denied' : 'dismissed');
      expect(d.calls).toEqual([]);
      expect(d.pushManager.subscribe).not.toHaveBeenCalled();
      expect(WR.isOn()).toBe(false);
    }
    expect((await load()).WR.blockedHelp()).toMatch(/address bar/);
  });

  it("says what went wrong when the server can't be reached", async () => {
    device({ server: (p) => (p === 'v1/subscribe' ? Response.json({ error: { message: 'Reminders are full right now. Try again another day.' } }, { status: 503 }) : null) });
    const { WR } = await load();
    expect(await WR.turnOn()).toEqual({ result: 'error', message: 'Reminders are full right now. Try again another day.' });
    expect(WR.isOn()).toBe(false);
  });

  it("says so in plain words when the browser can't set it up", async () => {
    const d = device();
    d.pushManager.subscribe.mockRejectedValueOnce(new DOMException('Registration failed - push service error', 'AbortError'));
    const { WR } = await load();
    expect(await WR.turnOn()).toEqual({ result: 'error', message: "This browser couldn't set up notifications. Try another browser, or use the calendar below." });
    expect(WR.isOn()).toBe(false);
  });

  it("leaves nothing subscribed when the sign-up's answer is lost", async () => {
    // The server may have stored it: without the subscription, the push service tells it the
    // address is gone, instead of reminders coming while the switch says off.
    const d = device({ server: (p) => (p === 'v1/subscribe' ? Promise.reject(new TypeError('Failed to fetch')) : null) });
    const { WR } = await load();
    expect(await WR.turnOn()).toEqual({ result: 'error', message: "Couldn't reach the reminders server. Are you online?" });
    expect(d.sent('subscribe')).toHaveLength(1);
    expect(d.sub()).toBeNull();
    expect(d.stores.has(CACHE)).toBe(false);
    expect(WR.isOn()).toBe(false);
  });

  it('replaces a subscription made with another key', async () => {
    const d = device();
    const old = { endpoint: 'https://fcm.googleapis.com/fcm/send/old', options: { applicationServerKey: new Uint8Array(65).buffer }, unsubscribe: vi.fn(async () => true) };
    d.pushManager.getSubscription = async () => old as never;
    const { WR } = await load();
    await WR.turnOn();
    expect(old.unsubscribe).toHaveBeenCalled();
    expect(d.pushManager.subscribe).toHaveBeenCalled();
  });
});

describe('the texts for the service worker', () => {
  it('keeps the next two weeks of morning and evening lines on the device', async () => {
    device();
    const { S, R, WR } = await load();
    studying(S);
    await WR.turnOn();
    const texts = (await readTexts(SCOPE))!;
    const dates = Object.keys(texts.days);
    expect(dates).toHaveLength(14);
    expect(dates[0]).toBe(TODAY);
    expect(dates[13]).toBe('2026-10-22');
    // The same words the iPhone app would use, from reminders.js.
    expect(texts.days[TODAY]).toEqual({
      done: false,
      morning: { title: R.morningLine(TODAY, 'your daily quest'), body: R.quoteFor(TODAY) },
      evening: { title: R.eveningLine(TODAY, 'your daily quest'), body: "Log it in the app when you're done." },
    });
    // Saturday has only Study left: the quest by name.
    expect(texts.days['2026-10-10'].morning!.title).toBe(R.morningLine('2026-10-10', 'Study'));
  });

  it('marks the day done, with nothing left to remind about, once the quests are ticked', async () => {
    device();
    const { S, WR } = await load();
    studying(S);
    await WR.turnOn();
    S.tick('q1', { done: true });
    S.tick('q2', { done: true });
    await WR.refreshNow();
    expect((await readTexts(SCOPE))!.days[TODAY]).toEqual({ done: true, morning: null, evening: null });
    expect((await readTexts(SCOPE))!.days['2026-10-10'].done).toBe(false);
  });

  it('is deleted when reminders are turned off', async () => {
    const d = device();
    const { WR } = await load();
    await WR.turnOn();
    expect(d.stores.has(CACHE)).toBe(true);
    await WR.turnOff();
    expect(d.stores.has(CACHE)).toBe(false);
  });
});

describe('keeping the server up to date', () => {
  it('tells it once when the day is done, and again only if it is undone', async () => {
    const d = device();
    const { S, WR } = await load();
    studying(S);
    await WR.turnOn();
    expect(d.sent('done')).toEqual([]);

    S.tick('q1', { done: true });
    await WR.refreshNow();
    expect(d.sent('done')).toEqual([]); // Class is still to do
    S.tick('q2', { done: true });
    await WR.refreshNow();
    await WR.refreshNow();
    expect(d.sent('done').map((c) => c.body)).toEqual([{ id: expect.any(String), token: expect.any(String), date: TODAY, done: true }]);

    S.tick('q2', { done: false });
    await WR.refreshNow();
    expect(d.sent('done').map((c) => c.body!.done)).toEqual([true, false]);
  });

  it('sends only the weekdays with something due', async () => {
    const d = device();
    const { S, WR } = await load();
    S.saveGoal({ id: 'g1', title: 'Career', category: 'career', quests: [{ id: 'q1', title: 'Deep work', schedule: { kind: 'days', days: [0, 1, 2, 3, 4] }, created: '2026-10-01' }] });
    await WR.turnOn();
    expect(d.sent('subscribe')[0].body!.days).toEqual([1, 2, 3, 4, 5]); // Monday to Friday
  });

  it('sends new times, and only an evening check later than the morning', async () => {
    const d = device();
    const { WR } = await load();
    await WR.turnOn();
    WR.setTimes({ morning: '06:15', eveningAt: '21:00' });
    await WR.refreshNow();
    expect(d.sent('update').at(-1)!.body).toMatchObject({ morning: '06:15', evening: '21:00' });

    WR.setTimes({ morning: '22:00' });
    expect(WR.settings().eveningTooEarly).toBe(true);
    await WR.refreshNow();
    expect(d.sent('update').at(-1)!.body).toMatchObject({ morning: '22:00', evening: null });

    WR.setTimes({ evening: false, morning: 'nonsense' });
    await WR.refreshNow();
    expect(d.sent('update').at(-1)!.body).toMatchObject({ morning: '22:00', evening: null });
    expect(WR.settings()).toMatchObject({ evening: false, eveningTooEarly: false });

    // Nothing new: nothing sent.
    const before = d.calls.length;
    await WR.refreshNow();
    expect(d.calls.length).toBe(before);
  });

  it('keeps a change made while the last one is still on its way to the server', async () => {
    let answer: () => void = () => {};
    let slow = false;
    const d = device({ server: (p) => (p === 'v1/update' && slow ? new Promise<Response>((r) => (answer = () => r(Response.json({ ok: true })))) : null) });
    const { WR } = await load();
    await WR.turnOn();
    slow = true;
    WR.setTimes({ morning: '06:30' });
    const first = WR.refreshNow();
    await vi.waitFor(() => expect(d.sent('update')).toHaveLength(1));
    // The evening check turned off (or the minutes picked after the hour) meanwhile.
    WR.setTimes({ evening: false, eveningAt: '21:00' });
    slow = false;
    answer();
    await first;
    expect(WR.settings()).toMatchObject({ morning: '06:30', evening: false, eveningAt: '21:00' });
    await WR.refreshNow();
    expect(d.sent('update').map((c) => [c.body!.morning, c.body!.evening])).toEqual([
      ['06:30', '20:30'],
      ['06:30', null],
    ]);
  });

  it('signs up again if the server has forgotten this device', async () => {
    let forgotten = true;
    const d = device({ server: (p) => (p === 'v1/update' && forgotten ? ((forgotten = false), Response.json({ error: { message: 'gone' } }, { status: 404 })) : null) });
    const { WR } = await load();
    await WR.turnOn();
    WR.setTimes({ morning: '05:30' });
    await WR.refreshNow();
    expect(d.sent('subscribe')).toHaveLength(2);
    expect(d.sent('subscribe')[1].body!.morning).toBe('05:30');
    expect(JSON.parse(localStorage.getItem('arise-push')!).id).toMatch(/^device-2/);
  });

  it('subscribes again if the server lost everything, its key included', async () => {
    let lost = false;
    const other = Buffer.from(Uint8Array.from({ length: 65 }, (_, i) => (i ? 200 - i : 4))).toString('base64url');
    const d = device({
      server: (p) => {
        if (lost && p === 'v1/done') return ((lost = false), Response.json({ error: { message: 'gone' } }, { status: 404 }));
        return p === 'v1/vapid' && d?.sent('subscribe').length ? Response.json({ key: other }) : null;
      },
    });
    const { S, WR } = await load();
    studying(S);
    await WR.turnOn();
    lost = true;
    S.tick('q1', { done: true });
    S.tick('q2', { done: true });
    await WR.refreshNow();
    expect(d.pushManager.subscribe).toHaveBeenCalledTimes(2);
    expect(Buffer.from(d.pushManager.subscribe.mock.calls[1][0].applicationServerKey).toString('base64url')).toBe(other);
    expect(d.sent('subscribe').map((c) => (c.body!.subscription as { endpoint: string }).endpoint)).toEqual(['https://fcm.googleapis.com/fcm/send/device-1', 'https://fcm.googleapis.com/fcm/send/device-2']);
    // And the day still gets marked done, for the new record.
    expect(d.sent('done').at(-1)!.body).toMatchObject({ id: expect.stringMatching(/^device-2/), date: TODAY, done: true });
  });

  it('picks up a new subscription when the browser drops the old one', async () => {
    const d = device();
    const { WR } = await load();
    await WR.turnOn();
    await d.sub()!.unsubscribe();
    await WR.refreshNow();
    expect(d.pushManager.subscribe).toHaveBeenCalledTimes(2);
    expect((d.sent('update').at(-1)!.body!.subscription as { endpoint: string }).endpoint).toBe('https://fcm.googleapis.com/fcm/send/device-2');
  });

  it('stops the reminders when notifications are blocked later in the browser', async () => {
    const d = device();
    const { WR } = await load();
    await WR.turnOn();
    d.notification.permission = 'denied';
    await WR.refreshNow();
    expect(d.sent('unsubscribe')).toHaveLength(1);
    expect(WR.isOn()).toBe(false);
  });

  it('stops them on the server later if it was offline when notifications got blocked', async () => {
    let offline = false;
    const d = device({ server: () => (offline ? Promise.reject(new TypeError('Failed to fetch')) : null) });
    const { WR } = await load();
    await WR.turnOn();
    const { id, token } = JSON.parse(localStorage.getItem('arise-push')!);
    d.notification.permission = 'denied';
    offline = true;
    await WR.refreshNow();
    expect(WR.isOn()).toBe(false);
    offline = false;
    await WR.refreshNow();
    expect(d.sent('unsubscribe').map((c) => c.body)).toEqual([
      { id, token },
      { id, token },
    ]);
    expect(localStorage.getItem('arise-push')).not.toContain(token);
  });

  it('keeps going when offline, and catches up later', async () => {
    let offline = false;
    const d = device({ server: () => (offline ? (() => { throw new TypeError('Failed to fetch'); })() : null) });
    const { S, WR } = await load();
    studying(S);
    await WR.turnOn();
    offline = true;
    S.tick('q1', { done: true });
    S.tick('q2', { done: true });
    await WR.refreshNow();
    offline = false;
    await WR.refreshNow();
    expect(d.sent('done').filter((c) => c.body!.done)).toHaveLength(2); // the first one never arrived
  });
});

describe('turning it off', () => {
  it('forgets the device on the server and in the browser, and keeps the times', async () => {
    const d = device();
    const { WR } = await load();
    await WR.turnOn();
    WR.setTimes({ morning: '06:00' });
    const { id, token } = JSON.parse(localStorage.getItem('arise-push')!);
    const sub = d.sub()!;
    await WR.turnOff();
    expect(d.sent('unsubscribe').map((c) => c.body)).toEqual([{ id, token }]);
    expect(sub.unsubscribe).toHaveBeenCalled();
    expect(WR.isOn()).toBe(false);
    expect(localStorage.getItem('arise-push')).not.toContain(token);
    expect(WR.settings().morning).toBe('06:00');
  });

  it("deletes the server's record once it can, if it couldn't when they were turned off", async () => {
    let down = false;
    const d = device({ server: (p) => (down ? (p === 'v1/unsubscribe' ? Response.json({ error: { message: 'Busy' } }, { status: 503 }) : Promise.reject(new TypeError('Failed to fetch'))) : null) });
    const { WR } = await load();
    await WR.turnOn();
    const { id, token } = JSON.parse(localStorage.getItem('arise-push')!);
    down = true;
    vi.mocked(d.sub()!.unsubscribe).mockRejectedValueOnce(new Error('offline'));
    await WR.turnOff();
    expect(WR.isOn()).toBe(false);
    expect(WR.settings().on).toBe(false);
    await WR.refreshNow(); // still down: kept for later
    down = false;
    // The next visit (or any change) tries again.
    WR.refresh(0);
    await vi.waitFor(() => expect(d.sent('unsubscribe')).toHaveLength(3));
    expect(d.sent('unsubscribe').at(-1)!.body).toEqual({ id, token });
    await vi.waitFor(() => expect(localStorage.getItem('arise-push')).not.toContain(token));
    // Once deleted, nothing more is sent.
    const before = d.calls.length;
    WR.refresh(0);
    await WR.refreshNow();
    expect(d.calls.length).toBe(before);
  });

  it("stops trying once the server says it's already gone", async () => {
    let down = true;
    const d = device({ server: (p) => (p === 'v1/unsubscribe' ? (down ? Promise.reject(new TypeError('Failed to fetch')) : Response.json({ error: { message: 'gone' } }, { status: 404 })) : null) });
    const { WR } = await load();
    await WR.turnOn();
    await WR.turnOff();
    down = false;
    await WR.refreshNow();
    await WR.refreshNow();
    expect(d.sent('unsubscribe')).toHaveLength(2);
    expect(JSON.parse(localStorage.getItem('arise-push')!).gone).toEqual([]);
  });
});

describe('in Settings', () => {
  // The whole app, started on Settings. (Each start adds the app's listeners to the page again,
  // so the test that taps comes first.)
  async function boot(server = SERVER) {
    vi.resetModules();
    vi.doMock('./reminders-config', () => ({ REMINDERS: { server } }));
    document.body.innerHTML = '<nav id="tabs"></nav><main id="app"></main><div id="restbar" hidden></div><div id="sheet" hidden><div class="sheet-panel"><button class="sheet-close"></button><div class="sheet-body"></div></div></div><div id="toast"></div><input type="file" id="importFile" hidden>';
    history.replaceState(null, '', '#settings');
    await import('./app.js');
    return import('./web-reminders');
  }
  const $ = (sel: string) => document.querySelector<HTMLElement>(sel);

  it('turns them on from the switch, asking for permission in the tap itself', async () => {
    const d = device();
    const WR = await boot();
    expect($('[data-act="push-toggle"]')!.textContent).toContain('Notifications on this device');
    expect($('#pushMorningIn')).toBeNull();
    $('[data-act="push-toggle"]')!.click();
    expect(d.notification.requestPermission).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect($('#toast')!.textContent).toBe('Reminders on. Every morning at 07:00, plus an evening check at 20:30.'));
    expect(WR.isOn()).toBe(true);
    expect(($('#pushMorningIn') as HTMLInputElement).value).toBe('07:00');
    expect($('[data-act="push-toggle"]')!.getAttribute('aria-pressed')).toBe('true');
    // The calendar is still there.
    expect($('[data-act="calendar"]')).not.toBeNull();
  });

  it('only offers the calendar until the server is set up', async () => {
    device();
    await boot('');
    expect($('[data-act="push-toggle"]')).toBeNull();
    expect($('[data-act="calendar"]')!.className).toContain('primary');
  });

  it('on an iPhone in Safari, says to add it to the Home Screen first', async () => {
    device({ ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', push: false });
    await boot();
    expect($('[data-act="push-toggle"]')).toBeNull();
    expect($('#app')!.textContent).toContain('Add Arise to your Home Screen first (Share, then Add to Home Screen), then turn this on there.');
  });

  it('says how to allow notifications when they are blocked', async () => {
    device({ permission: 'denied' });
    await boot();
    expect($('#app')!.textContent).toContain("Notifications are blocked for Arise. Allow them in the browser's settings for this site");
  });

  it('only mentions rotation training days to someone with the workout plan', async () => {
    device();
    // Only a goal like learning Spanish: no training days at all.
    vi.resetModules();
    studying(await import('./store'));
    await boot();
    expect($('#remindersPanel')!.textContent).not.toMatch(/rotation|training/);
    expect($('#remindersPanel')!.textContent).toContain('Days with nothing due stay free.');
    // With it (the plan is a rotation unless picked otherwise).
    vi.resetModules();
    (await import('./store')).saveGoal({ id: 'g2', title: 'Get strong', category: 'fitness', workouts: true, quests: [] });
    await boot();
    expect($('#remindersPanel')!.textContent).toContain('On a rotation plan any day can be a training day');
  });

  it('says in the privacy sheet everything the reminders server keeps', async () => {
    device();
    await boot();
    $('[data-act="privacy"]')!.click();
    await vi.waitFor(() => expect($('#sheet')!.textContent).toContain('Reminders'));
    expect($('#sheet')!.textContent).toContain("this device's push address, its time zone, your reminder times, which weekdays have anything due and the last day you finished");
  });
});
