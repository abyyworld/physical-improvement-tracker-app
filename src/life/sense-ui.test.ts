// @vitest-environment jsdom
// Settings, Your life: a switch for each source in the iPhone app, saying what it reads and where
// it goes; "iPhone app only" everywhere else; nothing while there's no life log; and the guide to
// iPhone automations.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Opts = Record<string, unknown>;

function fakeIPhone(handlers: Record<string, (o: Opts) => unknown>) {
  const calls: string[] = [];
  (globalThis as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => true,
    PluginHeaders: [{ name: 'AriseSense' }, { name: 'Health' }],
    nativePromise: async (plugin: string, method: string, options: Opts = {}) => {
      calls.push(`${plugin}.${method}`);
      const fn = handlers[`${plugin}.${method}`];
      if (!fn) throw new Error(`${plugin}.${method} isn't simulated`);
      return fn(options);
    },
  };
  return calls;
}

// `log`: a life log to put what's read in (an in-memory one).
async function load({ log = true } = {}) {
  vi.resetModules();
  (await import('./store-port')).setLifeStore(log ? { addEvents: async (events) => events.length } : null); // null: as if this build had no life log
  return import('./sense-ui');
}

const panel = () => document.getElementById('lifePanel')!;

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = `<div id="app"></div><div id="toast"></div>
    <div id="sheet" hidden><div class="sheet-panel"><button class="sheet-close"></button><div class="sheet-body"></div></div></div>`;
});
afterEach(() => {
  delete (globalThis as { Capacitor?: unknown }).Capacitor;
});

describe('Your life in Settings', () => {
  it('says "iPhone app only" on the web, with no switches', async () => {
    const UI = await load();
    document.getElementById('app')!.innerHTML = UI.settingsPanel();
    expect(panel().textContent).toContain('iPhone app only');
    expect(panel().querySelectorAll('[data-act="life-toggle"]')).toHaveLength(0);
  });

  it('has a switch for each source in the iPhone app, each saying what it reads and where it goes', async () => {
    fakeIPhone({});
    const UI = await load();
    document.getElementById('app')!.innerHTML = UI.settingsPanel();
    const rows = [...panel().querySelectorAll<HTMLElement>('[data-act="life-toggle"]')];
    expect(rows.map((r) => r.dataset.src)).toEqual(['health', 'motion', 'calendar', 'places', 'shortcuts']);
    for (const r of rows) expect(r.textContent).toContain('Stays on this iPhone and in your encrypted sync.');
    // Only Shortcuts is on to start with: it asks iOS for nothing.
    expect(rows.map((r) => r.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'false', 'false', 'true']);
    expect(panel().querySelector('[data-act="life-automations"]')).not.toBeNull();
  });

  it('asks iOS when a switch is turned on, and shows what went wrong', async () => {
    const calls = fakeIPhone({
      'AriseSense.healthAccess': () => {
        throw new Error('Missing com.apple.developer.healthkit entitlement.');
      },
      'AriseSense.calendarAccess': () => ({ status: 'granted' }),
      'AriseSense.calendarEvents': () => ({ events: [] }),
      'AriseSense.inboxTake': () => ({ text: '' }),
      'AriseSense.inboxClear': () => ({}),
    });
    const UI = await load();
    document.getElementById('app')!.innerHTML = UI.settingsPanel();
    const row = (src: string) => panel().querySelector<HTMLElement>(`[data-src="${src}"]`)!;

    expect(await UI.handleAction('life-toggle', row('health'))).toBe(true);
    expect(calls).toContain('AriseSense.healthAccess');
    expect(row('health').getAttribute('aria-pressed')).toBe('false');
    expect(document.getElementById('toast')!.textContent).toContain("Apple Health isn't open to this copy of Arise");

    await UI.handleAction('life-toggle', row('calendar'));
    expect(row('calendar').getAttribute('aria-pressed')).toBe('true');
    expect(document.getElementById('toast')!.textContent).toBe('Calendar on.');
    expect(panel().querySelector('[data-act="life-read"]')).not.toBeNull();
  });

  it("isn't there while this build has no life log to put things in", async () => {
    const UI = await load({ log: false });
    expect(UI.settingsPanel()).toBe('');
    fakeIPhone({});
    expect(UI.settingsPanel()).toBe('');
  });

  it('opens the guide to iPhone automations', async () => {
    fakeIPhone({});
    const UI = await load();
    expect(await UI.handleAction('life-automations', document.body)).toBe(true);
    const sheet = document.querySelector('.sheet-body')!.textContent!;
    for (const words of ['Log to Arise', 'Run Immediately', 'New Blank Automation', 'Is Opened', 'Is Closed', 'Message Contains', 'Shortcut Input', 'When Turning On', 'Is Connected']) expect(sheet).toContain(words);
  });

  it('leaves other taps alone', async () => {
    const UI = await load();
    expect(await UI.handleAction('lock-toggle', document.body)).toBe(false);
  });
});
