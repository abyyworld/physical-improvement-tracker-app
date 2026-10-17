// @vitest-environment jsdom
// Your AI keys in Settings, for the memory: a key whose model is too small says so, and one Arise
// doesn't know can be trusted to write the memory, on this device only. One start of the app.

import { describe, expect, it, vi } from 'vitest';
import { version } from '../package.json';

vi.mock('./lib/firebase', () => import('./test/fake-firebase'));

const $ = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const text = (el: Element | null) => (el?.textContent || '').replace(/\s+/g, ' ').trim();
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('Your AI keys and the memory', () => {
  it('says which keys may write the memory, and trusts one it does not know when asked', async () => {
    window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    window.scrollTo = () => {};
    const confirm = vi.fn(() => true);
    window.confirm = confirm;
    localStorage.setItem('pit-data-v1', JSON.stringify({ sessions: [], settings: { aiEngine: 'own' }, profile: { onboarded: true } }));
    localStorage.setItem(
      'arise-ai-keys',
      JSON.stringify([
        { id: 'k1', key: 'gsk_aaaa1111', provider: 'groq', model: 'llama-3.1-8b-instant' },
        { id: 'k2', key: 'mistralkey2222', provider: 'mistral', model: 'mistral-medium-latest' },
        { id: 'k3', key: 'AIzaCCCC3333', provider: 'google', model: 'gemini-2.5-pro' },
      ]),
    );
    localStorage.setItem('arise-ai-consent', 'groq,mistral,google');
    localStorage.setItem('arise-version-seen', version);
    document.body.innerHTML = '<nav id="tabs"></nav><main id="app"></main><div id="restbar" hidden></div><div id="sheet" hidden><div class="sheet-panel"><button class="sheet-close" data-act="sheet-close"></button><div class="sheet-body"></div></div></div><div id="toast"></div><input type="file" id="importFile" hidden>';
    history.replaceState(null, '', '/#settings');
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    await import('./app.js');
    await tick();

    const row = (n: number) => document.querySelectorAll('#aiSettings .key-row')[n];
    expect(text(row(0).querySelector('.key-memory'))).toBe('Too small to write your memory. It still answers you.');
    expect(row(0).querySelector('[data-act="ai-key-trust"]')).toBeNull();
    expect(text(row(1).querySelector('[data-act="ai-key-trust"] b'))).toBe('Trust this model to write my memory');
    expect(text(row(1).querySelector('[data-act="ai-key-trust"] small'))).toContain("Arise doesn't know mistral-medium-latest.");
    expect(row(1).querySelector('[data-act="ai-key-trust"]')!.getAttribute('aria-pressed')).toBe('false');
    expect(row(2).querySelector('.key-memory, [data-act="ai-key-trust"]')).toBeNull(); // strong: nothing to say

    (row(1).querySelector('[data-act="ai-key-trust"]') as HTMLElement).click();
    await tick();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(row(1).querySelector('[data-act="ai-key-trust"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(JSON.parse(localStorage.getItem('arise-ai-trust')!)).toEqual({ k2: 'mistral-medium-latest' });
    expect(localStorage.getItem('pit-data-v1')).not.toContain('mistral-medium-latest');
    // And off again, with no question.
    (row(1).querySelector('[data-act="ai-key-trust"]') as HTMLElement).click();
    await tick();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem('arise-ai-trust')!)).toEqual({});
    expect($('#aiSettings')).not.toBeNull();
  });
});
