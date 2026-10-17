// @vitest-environment jsdom
// "Your AI keys" in Settings, when another AI is in use: picking the keys asks before any company
// gets anything, and the card names the key that really answers. One start of the app for the whole
// story (a second one in the same file would answer the same taps too).

import { describe, expect, it, vi } from 'vitest';
import { version } from '../package.json';

vi.mock('./lib/firebase', () => import('./test/fake-firebase'));
// The AI on this device works, so the app picks it by itself.
vi.mock('./lib/on-device', () => ({ lastKnown: () => 'available', availability: async () => 'available', ask: vi.fn(async () => 'On device.'), download: vi.fn() }));

const $ = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const $$ = (sel: string) => [...document.querySelectorAll(sel)] as HTMLElement[];
const text = (el: Element | null) => (el?.textContent || '').replace(/\s+/g, ' ').trim();
const rows = () => $$('#aiSettings .key-row').map((r) => `${r.className.replace('key-row ', '')} | ${text(r.querySelector('.key-status'))}`);
const tick = () => new Promise((r) => setTimeout(r, 0));
const tap = async (el: HTMLElement | null | undefined) => {
  el!.click();
  await tick();
  await tick();
};

describe('Your AI keys, picked while another AI is in use', () => {
  it('asks before using a key, and says which key answers', async () => {
    window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    window.scrollTo = () => {};
    const asked: string[] = [];
    window.confirm = (q?: string) => (asked.push(String(q)), true);
    const now = Date.now();
    localStorage.setItem('pit-data-v1', JSON.stringify({ sessions: [], settings: { aiDaily: false }, profile: { onboarded: true } }));
    localStorage.setItem(
      'arise-ai-keys',
      JSON.stringify([
        { id: 'k1', key: 'gsk_aaaa1111', provider: 'groq', model: 'llama-3.3-70b-versatile' },
        { id: 'k2', key: 'AIzaBBBB2222', provider: 'google', model: 'gemini-2.5-flash' },
      ]),
    );
    localStorage.setItem('arise-ai-cool', JSON.stringify({ k1: { why: 'key', until: 0, at: now } })); // Groq turned the key down
    localStorage.setItem('arise-version-seen', version);
    localStorage.setItem('arise-ai-v2', '1'); // not a first start since 2.0, when a key alone counted as a yes
    document.body.innerHTML = '<nav id="tabs"></nav><main id="app"></main><div id="restbar" hidden></div><div id="sheet" hidden><div class="sheet-panel"><button class="sheet-close" data-act="sheet-close"></button><div class="sheet-body"></div></div></div><div id="toast"></div><input type="file" id="importFile" hidden>';
    history.replaceState(null, '', '/#settings');
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init: { method?: string }) => {
      calls.push(`${init.method || 'GET'} ${url}`);
      if (url.startsWith('https://generativelanguage.googleapis.com/') && init.method === 'POST') return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'System online.' }] }, finishReason: 'STOP' }] }));
      throw new TypeError('Failed to fetch');
    });
    await import('./app.js');
    await tick();
    expect($('#aiSettings .engine[data-v="device"]')?.getAttribute('aria-pressed')).toBe('true');

    // Picking the keys while the AI on this device answers: asked first, for the first key's company.
    await tap($('#aiSettings .engine[data-v="own"]'));
    expect(asked).toEqual([expect.stringMatching(/^Use Groq for the coach\? It's less private: Groq can read/)]);
    expect(rows()).toEqual(['off | Key not working. Check it, then test it again.', 'off | Waiting for your OK to send data to Google.']);
    // No key can answer yet: Gemini waits for an OK.
    expect(text($('#aiSettings .engine[data-v="own"]'))).toContain('Waiting for your OK to send data to that service.');

    // OK for Google too: the one key that can answer is Gemini, so the card names Gemini, not Groq.
    await tap($('#aiSettings [data-act="ai-key-ok"][data-id="k2"]'));
    expect(asked[1]).toMatch(/^Use Gemini for the coach\?/);
    await vi.waitFor(() => expect(rows()[1]).toMatch(/^ready \| ✓ Ready · Answered last at/));
    expect(text($('#aiSettings .engine[data-v="own"]'))).toContain('Using Gemini (gemini-2.5-flash).');
    expect(calls).toEqual(['POST https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent']);

    // Out of the way: Gemini's key turned down too. Nothing waits for an OK any more.
    localStorage.setItem('arise-ai-cool', JSON.stringify({ k1: { why: 'key', until: 0, at: now }, k2: { why: 'credit', until: 0, at: now } }));
    await tap($('#aiSettings [data-act="ai-key-edit"][data-id="k1"]'));
    expect(text($('#aiSettings .engine[data-v="own"]'))).toContain('None of your keys can answer right now. See below.');
  });
});
