// @vitest-environment jsdom
// "Your AI keys" in Settings, AI coach: the whole app started with three keys in different states,
// and the Player tapping through it. One start of the app for the whole story (a second one in the
// same file would answer the same taps too).

import { describe, expect, it, vi } from 'vitest';
import { when } from './lib/free-ai';
import { version } from '../package.json';

vi.mock('./lib/firebase', () => import('./test/fake-firebase'));

const $ = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const $$ = (sel: string) => [...document.querySelectorAll(sel)] as HTMLElement[];
const text = (el: Element | null) => (el?.textContent || '').replace(/\s+/g, ' ').trim();
const rows = () => $$('#aiSettings .key-row').map((r) => `${r.className.replace('key-row ', '')} | ${text(r.querySelector('.key-name'))} | ${text(r.querySelector('.key-status'))}`);
const tick = () => new Promise((r) => setTimeout(r, 0));
// Taps go through the app's own click handling, which finishes after a moment.
const tap = async (el: HTMLElement | null | undefined) => {
  el!.click();
  await tick();
  await tick();
};

describe('Your AI keys, in Settings', () => {
  it('lists the keys in order with their state, and adds, moves, tests and removes them', async () => {
    window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    window.scrollTo = () => {};
    window.confirm = () => true;
    const now = Date.now();
    const back = now + 5 * 3600_000;
    localStorage.setItem('pit-data-v1', JSON.stringify({ sessions: [], settings: { aiEngine: 'own' }, profile: { onboarded: true } }));
    localStorage.setItem(
      'arise-ai-keys',
      JSON.stringify([
        { id: 'k1', key: 'gsk_aaaa1111', provider: 'groq', model: 'llama-3.3-70b-versatile' },
        { id: 'k2', key: 'AIzaBBBB2222', provider: 'google', model: 'gemini-2.5-flash' },
        { id: 'k3', key: 'sk-or-cccc3333', provider: 'openrouter', model: '' },
      ]),
    );
    localStorage.setItem('arise-ai-consent', 'groq,google,openrouter');
    localStorage.setItem('arise-version-seen', version); // no "What's new" on top
    localStorage.setItem('arise-ai-cool', JSON.stringify({ k2: { why: 'day', until: back, at: now }, k3: { why: 'key', until: 0, at: now } }));
    localStorage.setItem('arise-ai-last', JSON.stringify({ keyId: 'k1', provider: 'groq', model: 'llama-3.3-70b-versatile', at: now }));
    document.body.innerHTML = '<nav id="tabs"></nav><main id="app"></main><div id="restbar" hidden></div><div id="sheet" hidden><div class="sheet-panel"><button class="sheet-close" data-act="sheet-close"></button><div class="sheet-body"></div></div></div><div id="toast"></div><input type="file" id="importFile" hidden>';
    history.replaceState(null, '', '/#settings');
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init: { method?: string; body?: string }) => {
      calls.push(`${init.method || 'GET'} ${url}`);
      if (url.includes('api.cerebras.ai') && init.method === 'GET') return new Response(JSON.stringify({ data: [{ id: 'gpt-oss-120b' }, { id: 'llama3.1-8b' }] }));
      if (url.includes('api.cerebras.ai')) return new Response(JSON.stringify({ choices: [{ message: { content: 'System online.' }, finish_reason: 'stop' }] }));
      throw new TypeError('Failed to fetch');
    });
    await import('./app.js');
    await tick();

    // The three keys, in order, each with its state.
    expect(rows()).toEqual([
      `ready | 1. Groq llama-3.3-70b-versatile | ✓ Ready · Answered last at ${when(now, Date.now())}`,
      `resting | 2. Gemini gemini-2.5-flash | Limit reached until ${when(back, Date.now())}`,
      'off | 3. OpenRouter best free model | Key not working. Check it, then test it again.',
    ]);
    // Labelled less private, with the highlighted Learn more under the card.
    expect(text($('#aiSettings .keys-head b'))).toBe('Your AI keys');
    expect(text($('#aiSettings .keys-head .tag.gold'))).toBe('Less private');
    expect(text($('#aiSettings .engine[data-v="own"] .tag.gold'))).toBe('Less private');
    expect(text($('#aiSettings .engine[data-v="own"]'))).toContain('Using 2 keys, in your order. Last answer: Groq · llama-3.3-70b-versatile.');
    // The first can't go up, the last can't go down.
    expect(($$('#aiSettings [data-act="ai-key-up"]')[0] as HTMLButtonElement).disabled).toBe(true);
    expect(($$('#aiSettings [data-act="ai-key-down"]')[2] as HTMLButtonElement).disabled).toBe(true);

    await tap($('#aiSettings .learn-more[data-v="keys"]'));
    expect(text($('#sheet .sheet-body'))).toContain('The free AIs you can link');
    expect(text($('#sheet .sheet-body'))).toContain('Gemini: Free Flash models');
    expect(text($('#sheet .sheet-body'))).toContain('Google may use what you send to improve its products, and people may read it.');
    await tap($('#sheet .sheet-close'));

    // Down, then up again.
    await tap($$('#aiSettings [data-act="ai-key-down"]')[0]);
    expect(rows().map((r) => r.split(' | ')[1].split(' ')[1])).toEqual(['Gemini', 'Groq', 'OpenRouter']);
    await tap($$('#aiSettings [data-act="ai-key-up"]')[1]);
    expect(rows().map((r) => r.split(' | ')[1].split(' ')[1])).toEqual(['Groq', 'Gemini', 'OpenRouter']);

    // Adding a key: the free AIs, best first, each with where to get a key, its limits and privacy.
    await tap($('#aiSettings [data-act="ai-key-add"]'));
    const items = $$('#aiSettings .key-add .free-item');
    expect(items.map((i) => text(i.querySelector('b')))).toEqual(['Gemini', 'Groq', 'OpenRouter', 'Cerebras', 'Mistral', 'GitHub Models', 'SambaNova', 'Hugging Face', 'Cohere', 'NVIDIA']);
    expect(items[0].querySelector('a')!.getAttribute('href')).toBe('https://aistudio.google.com/apikey');
    expect(text(items[0])).toContain('Get a free key');
    expect(text(items[9])).toContain('iPhone app only');
    // "Add my Cerebras key", then paste it and save: asked once for Cerebras, then tested.
    await tap($('#aiSettings [data-act="ai-key-pick"][data-v="cerebras"]'));
    expect(($('#keyProvider') as HTMLSelectElement).value).toBe('cerebras');
    const input = $('#keyIn') as HTMLInputElement;
    input.value = 'csk-dddd4444';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const asked: string[] = [];
    window.confirm = (q?: string) => (asked.push(String(q)), true);
    await tap($('#aiSettings [data-act="ai-key-save"]'));
    expect(asked).toEqual([expect.stringMatching(/^Use Cerebras for the coach\? It's less private: Cerebras can read/)]);
    await vi.waitFor(() => expect(text($$('#aiSettings .key-row')[3])).toContain('✓ Answered by Cerebras · gpt-oss-120b. Your coach is ready.')); // the System look says "The System is online."
    expect(rows()[3]).toMatch(/^ready \| 4\. Cerebras gpt-oss-120b \| ✓ Ready · Answered last at/);
    expect(calls.filter((c) => c.startsWith('POST')).map((c) => c.split(' ')[1])).toEqual(['https://api.cerebras.ai/v1/chat/completions']);

    // Editing a key opens its form with the model list; removing one asks first.
    await tap($$('#aiSettings [data-act="ai-key-edit"]')[3]);
    await vi.waitFor(() => expect(text($('#aiSettings .key-form'))).toContain('2 models on this key.'));
    await tap($('#aiSettings [data-act="ai-key-cancel"]'));
    expect($('#aiSettings .key-form')).toBeNull();
    await tap($$('#aiSettings [data-act="ai-key-remove"]')[2]);
    expect(rows().map((r) => r.split(' | ')[1].split(' ')[1])).toEqual(['Groq', 'Gemini', 'Cerebras']);
  });
});
