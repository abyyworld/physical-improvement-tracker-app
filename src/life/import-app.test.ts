// @vitest-environment jsdom
// Getting to the Import screen in the whole app: from Settings, and back. The life log isn't in
// this build, so the store comes through the port (store-port.ts), set here to one in memory.

import { describe, expect, it, vi } from 'vitest';
import type { LifeEvent } from './types';

vi.mock('../lib/firebase', () => import('../test/fake-firebase'));

const $ = (sel: string) => document.querySelector(sel) as HTMLElement | null;

describe('Import in the app', () => {
  it('is reached from Settings, keeps the Settings tab lit, reads into the store it is given, and goes back', async () => {
    window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    window.scrollTo = () => {};
    localStorage.setItem('pit-data-v1', JSON.stringify({ sessions: [], goals: [], settings: {}, profile: { onboarded: true } }));
    document.body.innerHTML = '<nav id="tabs"></nav><main id="app"></main><div id="restbar" hidden></div><div id="sheet" hidden><div class="sheet-panel"><button class="sheet-close" data-act="sheet-close"></button><div class="sheet-body"></div></div></div><div id="toast"></div><input type="file" id="importFile" hidden>';
    history.replaceState(null, '', '#settings');
    const kept: LifeEvent[] = [];
    const port = await import('./store-port');
    expect(await port.loadLifeStore()).toBeNull(); // no life log in this build yet
    port.setLifeStore({ addEvents: async (e) => (kept.push(...e), e.length) });
    await import('../app.js');

    const btn = $('[data-act="nav"][data-v="life-import"]');
    expect(btn?.textContent).toBe('Bring in your history');
    btn!.click();
    expect(location.hash).toBe('#life-import');
    expect($('h1')!.textContent).toBe('Your history');
    expect(document.body.dataset.view).toBe('life-import');
    expect($('#tabs [data-v="settings"]')!.classList.contains('on')).toBe(true);

    const input = $('#lifeImportFile') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [new File([JSON.stringify({ 'Browser History': [{ title: 'Arise', url: 'https://example.com/', time_usec: 1700000000000000 }] })], 'BrowserHistory.json')], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    const end = Date.now() + 2000;
    while (!$('#importResult') && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
    expect($('#importResult')!.textContent).toBe('Added 1 event from 2023.');
    expect(kept.map((e) => e.title)).toEqual(['Visited Arise']);
    // The app's own "Load backup" is untouched by it.
    expect($('#importFile')).not.toBeNull();

    $('[data-act="nav"][data-v="settings"]')!.click();
    expect($('h1')!.textContent).toBe('Settings');
  });
});
