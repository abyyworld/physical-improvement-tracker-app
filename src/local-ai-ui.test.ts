// @vitest-environment jsdom
// "Your computer's AI" in Settings, AI coach: its card, what it says while Ollama isn't letting
// Arise in yet, the one command to copy, and the model picker once it answers. One start of the
// app for the whole story (a second one in the same file would answer the same taps too).

import { describe, expect, it, vi } from 'vitest';
import { version } from '../package.json';

vi.mock('./lib/firebase', () => import('./test/fake-firebase'));

const $ = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const text = (el: Element | null) => (el?.textContent || '').replace(/\s+/g, ' ').trim();
const tick = () => new Promise((r) => setTimeout(r, 0));
const tap = async (el: HTMLElement | null | undefined) => {
  el!.click();
  await tick();
  await tick();
};
const card = () => $('#aiSettings .engine[data-v="local"]');

describe("Your computer's AI in Settings", () => {
  it('is picked in one tap, says what to do while Ollama keeps Arise out, and offers the models once it answers', async () => {
    window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    window.scrollTo = () => {};
    const copied: string[] = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t: string) => void copied.push(t) } });
    localStorage.setItem('pit-data-v1', JSON.stringify({ sessions: [], settings: { aiDaily: false }, profile: { onboarded: true } }));
    localStorage.setItem('arise-version-seen', version);
    localStorage.setItem('arise-ai-v2', '1');
    document.body.innerHTML = '<nav id="tabs"></nav><main id="app"></main><div id="restbar" hidden></div><div id="sheet" hidden><div class="sheet-panel"><button class="sheet-close" data-act="sheet-close"></button><div class="sheet-body"></div></div></div><div id="toast"></div><input type="file" id="importFile" hidden>';
    history.replaceState(null, '', '/#settings');
    // Ollama is running, but at first doesn't let Arise's website in (CORS): only a request that
    // needs no OK gets through.
    const ollama = { lets: false };
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      calls.push(url);
      if (url.startsWith('http://localhost:11434/')) {
        if (init.mode === 'no-cors') return new Response(null, { status: 200 });
        if (!ollama.lets) throw new TypeError('Failed to fetch');
        if (url.endsWith('/api/tags'))
          return new Response(JSON.stringify({ models: [{ name: 'llama3.2:3b', details: { parameter_size: '3.2B' } }, { name: 'qwen2.5:14b', details: { parameter_size: '14.8B' } }] }));
      }
      throw new TypeError('Failed to fetch');
    });
    await import('./app.js');
    await tick();

    // Offered on a computer, and nothing on it is asked until it's picked.
    expect(text(card())).toContain("Your computer's AI");
    expect(text(card())).toContain('Pick it to set it up. On a Mac it takes one command.');
    expect(calls).toEqual([]);
    expect(text($('#aiSettings > p'))).toContain('Right now it picks for you: the private AI, then this device.');

    await tap(card());
    await vi.waitFor(() => expect(text(card())).toContain("Ollama is running, but doesn't let Arise in yet."));
    expect(card()?.getAttribute('aria-pressed')).toBe('true');
    expect(text($('#localAI'))).toContain('Ollama is running, but only answers apps it trusts. Run the command below once');
    const command = 'curl -fsSL https://raw.githubusercontent.com/abyyworld/physical-improvement-tracker-app/main/scripts/local-ai-mac.sh | bash';
    expect(text($('#localCmd'))).toBe(command);
    expect(text($('#localAI'))).toContain('setx OLLAMA_ORIGINS "https://abyyworld.github.io"');
    await tap($('#localAI [data-act="local-copy"]'));
    expect(copied).toEqual([command]);
    expect(calls.every((u) => u.startsWith('http://localhost:'))).toBe(true);

    // The command was run: Check again finds it, with the best model picked.
    ollama.lets = true;
    await tap($('#localAI [data-act="local-check"]'));
    await vi.waitFor(() => expect(text(card())).toContain('✓ Ready: qwen2.5:14b in Ollama.'));
    const select = $('#localModel') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(['Best one here (qwen2.5:14b)', 'qwen2.5:14b (14.8B)', 'llama3.2:3b (3.2B)']);
    expect(text($('#localAI'))).toContain('This model is too small to write your memory');
    expect(text($('#aiSettings'))).toContain('Let the app pick (your computer first)');

    // Another model.
    select.value = 'ollama|llama3.2:3b';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    expect(text(card())).toContain('Ready: llama3.2:3b in Ollama.');

    // Back to the app picking: it still comes first while it answers.
    await tap($('#aiSettings [data-act="ai-engine"][data-v=""]'));
    expect(text($('#aiSettings > p'))).toContain("Right now it picks for you: your computer's AI, then the private AI, then this device.");
    expect(card()?.getAttribute('aria-pressed')).toBe('true');

    // Stop using it: off, and not looked for any more.
    await tap($('#localAI [data-act="local-off"]'));
    expect($('#localAI')).toBeNull();
    expect(text(card())).toContain('Pick it to set it up.');
    expect(card()?.getAttribute('aria-pressed')).toBe('false');
  });
});
