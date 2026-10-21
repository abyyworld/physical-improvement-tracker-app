// @vitest-environment jsdom
// Arise Private: the app reads the account's plan from the AI proxy and keeps it on this device;
// on the free plan, work nobody asked for never uses the private AI (the daily message, the memory,
// the AI journal); when today's free private questions are used up the coach says so, offers the
// plan, and the AI on this device answers if there is one; and Settings shows the plan.

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./lib/firebase', () => import('./test/fake-firebase'));
const device = vi.hoisted(() => ({ state: 'unavailable' as string, answer: 'From the device.', asked: 0 }));
vi.mock('./lib/on-device', () => ({
  lastKnown: () => device.state,
  availability: async () => device.state,
  ask: vi.fn(async () => {
    device.asked++;
    return device.answer;
  }),
  download: vi.fn(),
}));
vi.mock('./ai-config', () => ({ PRIVATE_AI: { proxy: 'https://ai.example.workers.dev/v1/', model: 'gpt-oss-120b', name: 'Private AI' } }));
// The private AI's verified, encrypting client, as a plain fetch (attestation is Tinfoil's to test).
vi.mock('tinfoil', () => ({
  SecureClient: class {
    async ready() {}
    getBaseURL() {
      return 'https://ai.example.workers.dev/v1';
    }
    fetch = (url: string, init: RequestInit) => fetch(url, init);
  },
}));

const UID = 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9v';
const LINKS = { monthly: 'https://arise.lemonsqueezy.com/buy/monthly-id', yearly: 'https://arise.lemonsqueezy.com/buy/yearly-id' };
const FREE = { plan: 'free', left: 3, limit: 5, renewsAt: null, endsAt: null, portal: '', checkout: LINKS };
const PAID = { plan: 'private', left: 150, limit: 150, renewsAt: '2026-11-18T10:00:00.000000Z', endsAt: null, portal: 'https://arise.lemonsqueezy.com/billing?expires=1&signature=abc', checkout: LINKS };
const USED_UP = "You've used today's 5 free private questions. Arise Private gives you the private AI all day for $5 a month.";

async function load({ uid = UID as string | null, email = 'sam@example.com' } = {}) {
  vi.resetModules();
  const S = await import('./store');
  const AI = await import('./ai.js');
  const PLAN = await import('./plan');
  const UI = await import('./plan-ui.js');
  AI.connectAccount({ signedIn: () => !!uid, idToken: async () => (uid ? 'token' : null) });
  PLAN.connectPlan({ uid: () => uid, email: () => email, idToken: async () => (uid ? 'token' : null) });
  return { S, AI, PLAN, UI };
}

// The AI proxy: its answer about the plan, and the private AI's answers (or its "used up").
const answer = (text: string) => new Response(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3 } }));
const usedUp = () => new Response(JSON.stringify({ error: { message: USED_UP, code: 'plan' }, code: 'plan' }), { status: 429, headers: { 'content-type': 'application/json' } });
function proxy({ plan = (): Response => new Response(JSON.stringify(FREE)), chat = (): Response => answer('From the private AI.') } = {}) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    calls.push(`${init.method || 'GET'} ${u.pathname}`);
    if (u.pathname === '/v1/plan') {
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer token');
      return plan();
    }
    if (u.pathname === '/v1/chat/completions') return chat();
    throw new TypeError('Failed to fetch');
  });
  return calls;
}
const chats = (calls: string[]) => calls.filter((c) => c === 'POST /v1/chat/completions');
const div = (html: string) => {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d;
};
const words = (el: Element | null) => (el?.textContent || '').replace(/\s+/g, ' ').trim();

beforeEach(() => {
  localStorage.clear();
  device.state = 'unavailable';
  device.answer = 'From the device.';
  device.asked = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('the plan', () => {
  it("asks the proxy which plan the account has, and keeps it on this device for that account only", async () => {
    const { PLAN } = await load();
    const calls = proxy();
    expect(PLAN.plan()).toBeNull();
    expect(PLAN.allDay()).toBe(false); // not known yet: nothing is used up before it is
    expect(await PLAN.refreshPlan()).toMatchObject({ plan: 'free', left: 3, limit: 5, checkout: LINKS });
    expect(calls).toEqual(['GET /v1/plan']);
    expect(PLAN.plan()).toMatchObject({ plan: 'free', left: 3 });
    expect(PLAN.allDay()).toBe(false);
    expect(JSON.parse(localStorage.getItem('arise-plan')!)).toMatchObject({ uid: UID, plan: 'free' });
    // Another account on this device, or none: not theirs.
    expect((await load({ uid: 'someoneElse1234567890abcd' })).PLAN.plan()).toBeNull();
    expect((await load({ uid: null })).PLAN.plan()).toBeNull();
    // With the plan: the private AI all day.
    const again = await load();
    proxy({ plan: () => new Response(JSON.stringify(PAID)) });
    await again.PLAN.refreshPlan();
    expect(again.PLAN.allDay()).toBe(true);
    again.PLAN.forgetPlan();
    expect(localStorage.getItem('arise-plan')).toBeNull();
  });

  it('works as before with a proxy that has no plans yet: the private AI all day', async () => {
    const { AI, PLAN } = await load();
    proxy({ plan: () => new Response(JSON.stringify({ error: { message: 'Not found.' } }), { status: 404 }) });
    expect(await PLAN.refreshPlan()).toBeNull();
    expect(PLAN.allDay()).toBe(true);
    expect(PLAN.plan()).toBeNull();
    expect(AI.engine({ background: true })).toBe('private');
  });

  it("keeps what it knew when the proxy can't be reached, or answers nonsense", async () => {
    const { PLAN } = await load();
    proxy();
    await PLAN.refreshPlan();
    proxy({ plan: () => new Response('busy', { status: 503 }) });
    await PLAN.refreshPlan();
    expect(PLAN.plan()).toMatchObject({ plan: 'free', left: 3 });
    proxy({ plan: () => new Response(JSON.stringify({ plan: 'everything', left: 1e9 })) });
    await PLAN.refreshPlan();
    expect(PLAN.plan()).toMatchObject({ plan: 'free', left: 3 });
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('offline');
    });
    await PLAN.refreshPlan();
    expect(PLAN.plan()).toMatchObject({ plan: 'free', left: 3 });
    expect(PLAN.cleanInfo({ ...FREE, portal: 'javascript:alert(1)', checkout: { monthly: 'http://x.example', yearly: 42 } })).toMatchObject({ portal: '', checkout: { monthly: '', yearly: '' } });
  });

  it('asks once after the app starts, then once a day, and from Settings when a minute old', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-19T09:00:00Z'));
    const { PLAN } = await load();
    localStorage.setItem('arise-plan', JSON.stringify({ uid: UID, at: Date.now() - 1000, ...FREE }));
    const calls = proxy();
    PLAN.checkPlan(); // the first time since the app started, even though it's fresh
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    PLAN.checkPlan();
    vi.setSystemTime(new Date('2026-10-19T09:02:00Z'));
    PLAN.checkPlan();
    expect(calls).toHaveLength(1);
    PLAN.checkPlan(60_000); // Settings
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    vi.setSystemTime(new Date('2026-10-20T09:03:00Z'));
    PLAN.checkPlan();
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    // Signed out: never.
    const out = await load({ uid: null });
    out.PLAN.checkPlan();
    expect(calls).toHaveLength(3);
  });

  it('counts the questions left again at midnight UTC', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-19T23:00:00Z'));
    const { PLAN } = await load();
    localStorage.setItem('arise-plan', JSON.stringify({ uid: UID, at: Date.now(), ...FREE, left: 1 }));
    PLAN.usedOne();
    expect(PLAN.plan()!.left).toBe(0);
    PLAN.usedOne();
    expect(PLAN.plan()!.left).toBe(0);
    vi.setSystemTime(new Date('2026-10-20T00:00:01Z'));
    expect(PLAN.plan()!.left).toBe(5);
  });

  it("opens the checkout for this account, with its email unless it's an account code", async () => {
    const { PLAN } = await load();
    proxy();
    await PLAN.refreshPlan();
    const monthly = new URL(PLAN.checkoutUrl('monthly'));
    expect(`${monthly.origin}${monthly.pathname}`).toBe(LINKS.monthly);
    expect(monthly.searchParams.get('checkout[custom][uid]')).toBe(UID);
    expect(monthly.searchParams.get('checkout[email]')).toBe('sam@example.com');
    expect(new URL(PLAN.checkoutUrl('yearly')).searchParams.get('checkout[custom][uid]')).toBe(UID);
    const code = await load({ email: '' });
    const link = new URL(code.PLAN.checkoutUrl('monthly'));
    expect(link.searchParams.get('checkout[custom][uid]')).toBe(UID);
    expect(link.searchParams.has('checkout[email]')).toBe(false);
    // Not on sale yet: no link.
    proxy({ plan: () => new Response(JSON.stringify({ ...FREE, checkout: { monthly: '', yearly: '' } })) });
    await code.PLAN.refreshPlan();
    expect(code.PLAN.checkoutUrl('monthly')).toBe('');
  });

  it('looks for the plan again when the Player comes back from the checkout', async () => {
    vi.useFakeTimers();
    const { PLAN } = await load();
    let plan: object = FREE;
    const calls = proxy({ plan: () => new Response(JSON.stringify(plan)) });
    await PLAN.refreshPlan();
    PLAN.cameBack(); // not from the checkout
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toHaveLength(1);
    PLAN.openedCheckout();
    PLAN.cameBack();
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toHaveLength(2); // the payment hasn't arrived yet
    plan = PAID;
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toHaveLength(3);
    expect(PLAN.plan()!.plan).toBe('private');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(3); // found it: no more asking
  });
});

describe('work nobody asked for, on the free plan', () => {
  const memo = { signal: undefined, engine: undefined as string | undefined, instructions: 'Sum up the day.', prompt: 'The day.', schema: { type: 'object', properties: { summary: { type: 'string' } } } };

  it('never uses the private AI: the AI on this device does it, or it waits', async () => {
    const { AI, PLAN } = await load();
    const calls = proxy();
    expect(AI.engine({ background: true })).toBeNull(); // the plan isn't known yet
    await PLAN.refreshPlan();
    expect(AI.engine()).toBe('private');
    expect(AI.engine({ background: true })).toBeNull();
    expect(AI.ready()).toBe(true);
    expect(AI.ready({ background: true })).toBe(false);
    expect(AI.rationed()).toBe(true);
    expect(AI.memoryStrength()).toBe('strong');
    expect(AI.memoryStrength({ background: true })).toBe('none');
    await expect(AI.askMemory({ ...memo, engine: 'private' })).rejects.toMatchObject({ code: 'changed' });
    await expect(AI.askMemory(memo)).rejects.toMatchObject({ code: 'no-ai', message: AI.PLAN_WAITS });
    await expect(AI.dailyBriefing({ background: true })).rejects.toMatchObject({ message: AI.PLAN_WAITS });
    expect(chats(calls)).toEqual([]);

    // With the AI on this device: that one (too small to write the memory, so learning waits).
    device.state = 'available';
    expect(AI.engine({ background: true })).toBe('device');
    expect(AI.memoryStrength({ background: true })).toBe('weak');
    device.answer = JSON.stringify({ message: 'A calm day.', focus: 'A walk.' });
    expect(await AI.dailyBriefing({ background: true })).toMatchObject({ message: 'A calm day.' });
    expect(device.asked).toBe(1);
    expect(chats(calls)).toEqual([]);
  });

  it("doesn't learn from the days or write the journal with the private AI, until it has Arise Private", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 17, 10));
    globalThis.indexedDB = new IDBFactory();
    const { AI, PLAN } = await load();
    const L = await import('./life/log');
    const M = await import('./life/memory');
    M.initMemory({ delay: -1 });
    await L.addEvents([{ id: 'arise:quest:2026-10-16:q1', source: 'arise', kind: 'quest', at: new Date(2026, 9, 16, 8).getTime(), title: 'Done: Study Spanish', tier: 1 }]);
    const memory = () => answer(JSON.stringify({ summary: 'You studied Spanish.', facts: [], journal: 'I studied Spanish.' }));
    let calls = proxy({ chat: memory });
    await PLAN.refreshPlan();
    expect(AI.ready()).toBe(true);
    expect(await M.learn()).toBe(0);
    expect(await M.canWriteJournal('2026-10-16')).toBe(false);
    expect(chats(calls)).toEqual([]);
    // With Arise Private, it learns.
    calls = proxy({ plan: () => new Response(JSON.stringify(PAID)), chat: memory });
    await PLAN.refreshPlan();
    expect(await M.canWriteJournal('2026-10-16')).toBe(true);
    expect(await M.learn()).toBeGreaterThan(0);
    expect(chats(calls).length).toBeGreaterThan(0);
  });

  it('uses one of the free questions when the Player asks for it', async () => {
    const { AI, PLAN } = await load();
    const calls = proxy({ chat: () => answer(JSON.stringify({ message: 'Hello.', focus: 'Rest.' })) });
    await PLAN.refreshPlan();
    expect(await AI.dailyBriefing({ force: true })).toMatchObject({ message: 'Hello.' });
    expect(chats(calls)).toHaveLength(1);
    expect(PLAN.plan()!.left).toBe(2);
  });

  it('uses the private AI for everything with Arise Private', async () => {
    const { AI, PLAN } = await load();
    const calls = proxy({ plan: () => new Response(JSON.stringify(PAID)), chat: () => answer('{"summary":"A good day."}') });
    await PLAN.refreshPlan();
    expect(AI.engine({ background: true })).toBe('private');
    expect(AI.rationed()).toBe(false);
    expect(AI.memoryStrength({ background: true })).toBe('strong');
    expect(await AI.askMemory({ ...memo, engine: 'private' })).toMatchObject({ json: { summary: 'A good day.' }, by: 'private:gpt-oss-120b' });
    expect(chats(calls)).toHaveLength(1);
  });
});

describe("when today's free private questions are used up", () => {
  it('says so once, without trying again, and offers Arise Private', async () => {
    const { AI, PLAN, UI } = await load();
    const calls = proxy({ chat: usedUp });
    await PLAN.refreshPlan();
    await expect(AI.chat('How was my week?')).rejects.toMatchObject({ code: 'plan', message: USED_UP });
    expect(chats(calls)).toHaveLength(1);
    expect(PLAN.plan()).toMatchObject({ plan: 'free', left: 0 });
    const said = (await import('./store')).state.ai.chat.at(-1)!;
    expect(said).toMatchObject({ role: 'assistant', error: true, text: `⚠️ ${USED_UP}` });
    expect(PLAN.isUsedUp(said.text)).toBe(true);
    const offer = div(UI.upgradeFor(said.text));
    const buy = offer.querySelector('a.btn.primary') as HTMLAnchorElement;
    expect(words(buy)).toBe('Get Arise Private · $5 a month');
    expect(new URL(buy.href).searchParams.get('checkout[custom][uid]')).toBe(UID);
    expect(buy.target).toBe('_blank');
    expect(buy.dataset.act).toBe('plan-checkout');
    expect(words(offer.querySelector('a.link'))).toBe('or $48 a year');
    // Any other error: no offer.
    expect(UI.upgradeFor('Private AI is busy right now.')).toBe('');
  });

  it('lets the AI on this device answer instead, when there is one', async () => {
    const { AI, PLAN } = await load();
    device.state = 'available';
    const calls = proxy({ chat: usedUp });
    await PLAN.refreshPlan();
    expect(await AI.chat('How was my week?')).toBe('From the device.');
    expect(chats(calls)).toHaveLength(1);
    expect(device.asked).toBe(1);
  });

  it('finds out the plan first if this device did not know it, so it can offer it', async () => {
    const { AI, PLAN, UI } = await load();
    const calls = proxy({ chat: usedUp });
    await expect(AI.chat('Hi')).rejects.toMatchObject({ code: 'plan' });
    expect(calls).toEqual(['POST /v1/chat/completions', 'GET /v1/plan']);
    expect(words(div(UI.upgradeFor(USED_UP)))).toContain('Get Arise Private · $5 a month');
    expect(PLAN.plan()!.plan).toBe('free');
  });
});

describe('Settings, AI coach', () => {
  it('shows the free plan, the questions left today and how to get Arise Private', async () => {
    const { PLAN, UI } = await load();
    proxy();
    expect(UI.planRowHTML()).toBe(''); // not known yet
    await PLAN.refreshPlan();
    const row = div(UI.planRowHTML());
    expect(words(row.querySelector('p'))).toBe('Free: 5 private questions a day (3 left today)');
    expect(words(row.querySelector('a.btn.primary'))).toBe('Get Arise Private · $5 a month');
    expect(words(row.querySelector('.plan-buy a.link'))).toBe('or $48 a year');
    expect(row.textContent).not.toContain('Manage subscription');
    // Before it's on sale.
    proxy({ plan: () => new Response(JSON.stringify({ ...FREE, checkout: { monthly: '', yearly: '' } })) });
    await PLAN.refreshPlan();
    const soon = div(UI.planRowHTML());
    expect(words(soon)).toContain('Arise Private is coming soon.');
    expect(soon.querySelector('a.btn')).toBeNull();
    // Signed out: nothing.
    expect((await load({ uid: null })).UI.planRowHTML()).toBe('');
  });

  it('shows Arise Private, when it renews or ends, and where to manage it', async () => {
    const { PLAN, UI } = await load();
    proxy({ plan: () => new Response(JSON.stringify(PAID)) });
    await PLAN.refreshPlan();
    const row = div(UI.planRowHTML());
    const renews = new Date(PAID.renewsAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    expect(words(row.querySelector('p'))).toBe(`Arise Private · renews ${renews}`);
    const manage = row.querySelector('a.link') as HTMLAnchorElement;
    expect(words(manage)).toBe('Manage subscription');
    expect(manage.href).toBe(PAID.portal);
    expect(row.querySelector('[data-act="plan-checkout"]')).toBeNull();
    proxy({ plan: () => new Response(JSON.stringify({ ...PAID, renewsAt: null, endsAt: '2026-11-18T10:00:00.000000Z' })) });
    await PLAN.refreshPlan();
    expect(words(div(UI.planRowHTML()).querySelector('p'))).toBe(`Arise Private · ends ${renews}`);
  });

  it('puts the plan under the private AI, and opening the checkout makes the app look for it on return', async () => {
    const { PLAN } = await load();
    proxy();
    await PLAN.refreshPlan();
    const SYS = await import('./system.js');
    const panel = div(SYS.settingsPanels());
    const group = panel.querySelector('.engine[data-v="private"]')!.parentElement!;
    expect(group.classList.contains('engine-group')).toBe(true);
    expect(words(group.querySelector('#planRow'))).toContain('Free: 5 private questions a day (3 left today)');
    expect(words(panel.querySelector('.engine[data-v="private"]'))).toContain('A few questions a day for free, all day with Arise Private.');
    const opened = vi.spyOn(PLAN, 'openedCheckout');
    expect(await SYS.handleAction('plan-checkout', group.querySelector('[data-act="plan-checkout"]'))).toBe(true);
    expect(opened).toHaveBeenCalledTimes(1);
  });
});

describe('the daily message and the chat on the free plan', () => {
  it("doesn't write the daily message by itself with the private AI, but offers it", async () => {
    const { PLAN } = await load();
    const calls = proxy();
    await PLAN.refreshPlan();
    const SYS = await import('./system.js');
    SYS.afterToday();
    await new Promise((r) => setTimeout(r, 0));
    expect(chats(calls)).toEqual([]);
    const card = div(SYS.systemMessageCard());
    expect(words(card.querySelector('[data-act="ai-daily"]'))).toBe("Get today's message from your coach");
    expect(words(card)).toContain('It uses one of your free private questions.');
  });

  it('writes it by itself with Arise Private', async () => {
    const { PLAN } = await load();
    const calls = proxy({ plan: () => new Response(JSON.stringify(PAID)), chat: () => answer(JSON.stringify({ message: 'Morning.', focus: 'Walk.' })) });
    await PLAN.refreshPlan();
    const SYS = await import('./system.js');
    SYS.afterToday();
    await vi.waitFor(() => expect(chats(calls)).toHaveLength(1));
  });

  it('offers Arise Private under the newest message in the chat when it says the questions are used up', async () => {
    const { AI, PLAN } = await load();
    proxy({ chat: usedUp });
    await PLAN.refreshPlan();
    await AI.chat('Hi').catch(() => {});
    const SYS = await import('./system.js');
    const root = document.createElement('div');
    document.body.append(root);
    SYS.renderCoach(root);
    const last = [...root.querySelectorAll('.msg')].at(-1)!;
    expect(last.classList.contains('err')).toBe(true);
    expect(words(last.querySelector('a.btn.primary'))).toBe('Get Arise Private · $5 a month');
    // Once something else came after it, the old message doesn't offer it any more.
    proxy({ chat: () => answer('Hello again.') });
    await AI.chat('Hi again');
    SYS.renderCoach(root);
    expect(root.querySelector('[data-act="plan-checkout"]')).toBeNull();
    root.remove();
  });
});

describe('when Arise Private ends', () => {
  it('stops using the private AI for work nobody asked for once it reaches its end, and asks again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-19T08:00:00Z'));
    const { AI, PLAN } = await load();
    proxy({ plan: () => new Response(JSON.stringify({ ...PAID, renewsAt: null, endsAt: '2026-10-19T10:00:00.000Z' })) });
    await PLAN.refreshPlan();
    expect(PLAN.allDay()).toBe(true);
    expect(AI.engine({ background: true })).toBe('private');
    vi.setSystemTime(new Date('2026-10-19T10:00:01Z'));
    expect(PLAN.allDay()).toBe(false);
    expect(AI.engine({ background: true })).toBeNull();
    expect(PLAN.plan()).toBeNull(); // not known any more
    // The app asks again, though what it knew is only two hours old.
    const calls = proxy();
    PLAN.checkPlan();
    await vi.waitFor(() => expect(calls).toEqual(['GET /v1/plan']));
    await vi.waitFor(() => expect(PLAN.onFree()).toBe(true));
    expect(AI.engine({ background: true })).toBeNull();
  });

  it('only counts on the plan the AI server gave today for work nobody asked for', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-19T23:00:00Z'));
    const { AI, PLAN } = await load();
    proxy({ plan: () => new Response(JSON.stringify(PAID)) });
    await PLAN.refreshPlan();
    expect(AI.engine({ background: true })).toBe('private');
    // A new day: the free questions start again, and the plan may have ended overnight.
    vi.setSystemTime(new Date('2026-10-20T00:30:00Z'));
    expect(PLAN.plan()).toMatchObject({ plan: 'private' });
    expect(PLAN.allDay()).toBe(false);
    expect(AI.engine({ background: true })).toBeNull();
    const calls = proxy(); // a payment failed: the free plan now
    PLAN.checkPlan();
    await vi.waitFor(() => expect(calls).toEqual(['GET /v1/plan']));
    await vi.waitFor(() => expect(PLAN.onFree()).toBe(true));
    expect(AI.engine({ background: true })).toBeNull();
    // Still Arise Private: all day again.
    proxy({ plan: () => new Response(JSON.stringify(PAID)) });
    await PLAN.refreshPlan();
    expect(AI.engine({ background: true })).toBe('private');
  });
});

describe('Learn more, in Settings', () => {
  it('only names a daily limit and a price for the private AI that the AI server really has', async () => {
    document.body.innerHTML = '<div id="sheet" hidden><div class="sheet-panel"><button class="sheet-close"></button><div class="sheet-body"></div></div></div>';
    const { PLAN } = await load();
    const SYS = await import('./system.js');
    const cost = async () => {
      await SYS.handleAction('ai-learn', { dataset: {} });
      return words([...document.querySelectorAll('#sheet .sheet-body p')].find((p) => p.textContent!.startsWith('Cost:'))!);
    };
    expect(await cost()).toBe('Cost: Free, with a daily limit.'); // not known yet
    // An AI server without plans: the private AI all day for everybody.
    proxy({ plan: () => new Response(JSON.stringify({ error: { message: 'Not found.' } }), { status: 404 }) });
    await PLAN.refreshPlan();
    expect(await cost()).toBe('Cost: Free.');
    // Before it's on sale.
    proxy({ plan: () => new Response(JSON.stringify({ ...FREE, checkout: { monthly: '', yearly: '' } })) });
    await PLAN.refreshPlan();
    expect(await cost()).toBe('Cost: A few questions a day for free. Arise Private, to use it all day, is coming soon.');
    proxy();
    await PLAN.refreshPlan();
    expect(await cost()).toBe('Cost: A few questions a day for free. Arise Private gives you it all day, for $5 a month or $48 a year.');
    proxy({ plan: () => new Response(JSON.stringify({ ...FREE, checkout: { monthly: '', yearly: LINKS.yearly } })) });
    await PLAN.refreshPlan();
    expect(await cost()).toBe('Cost: A few questions a day for free. Arise Private gives you it all day, for $48 a year.');
    proxy({ plan: () => new Response(JSON.stringify(PAID)) });
    await PLAN.refreshPlan();
    expect(await cost()).toBe("Cost: A few questions a day for free. You have Arise Private, so it's yours all day.");
  });
});
