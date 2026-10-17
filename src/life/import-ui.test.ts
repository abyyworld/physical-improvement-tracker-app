// @vitest-environment jsdom
// The Import screen on its own: the sources and their steps, choosing a file, the questions it
// asks first, progress and Cancel, and the result. The store is a fake in memory.

import { beforeEach, describe, expect, it } from 'vitest';
import { _reset, handleAction, importButton, PRIVATE, renderImport, SOURCES } from './import-ui.js';
import { createImporter, type Importer } from './import/client';
import type { Detection, ImportOptions, ImportResult } from './import/types';
import type { LifeEvent } from './types';

const $ = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const text = (sel: string) => ($(sel)?.textContent ?? '').replace(/\s+/g, ' ').trim();
const tap = (sel: string) => $(sel)!.click();
const tick = () => new Promise((r) => setTimeout(r, 0));
async function until(check: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

document.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
  if (el) handleAction(el.dataset.act);
});

function choose(...files: File[]) {
  const input = $('#lifeImportFile') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function memoryStore() {
  const kept = new Map<string, LifeEvent>();
  return {
    kept,
    addEvents: async (events: LifeEvent[]) => {
      let n = 0;
      for (const e of events) if (!kept.has(e.id)) (kept.set(e.id, e), n++);
      return n;
    },
  };
}

const searches = JSON.stringify([
  { header: 'Search', title: 'Searched for a', titleUrl: 'https://www.google.com/search?q=a', time: '2019-05-01T10:00:00Z', products: ['Search'] },
  { header: 'Search', title: 'Searched for b', titleUrl: 'https://www.google.com/search?q=b', time: '2023-05-01T10:00:00Z', products: ['Search'] },
  { header: 'Search', title: 'Searched for c', titleUrl: 'https://www.google.com/search?q=c', time: '2026-05-01T10:00:00Z', products: ['Search'] },
]);

let root: HTMLElement;
beforeEach(() => {
  _reset();
  document.body.innerHTML = '<main id="app"></main>';
  root = $('#app')!;
});

describe('the Import screen', () => {
  it('lists every source with its steps, says nothing leaves the device, and has a way back', async () => {
    renderImport(root, { store: memoryStore(), back: 'settings' });
    expect(text('h1')).toBe('Your history');
    expect(document.querySelectorAll('#importHow details').length).toBe(SOURCES.length);
    for (const s of SOURCES) {
      const steps = document.querySelectorAll(`details[data-source="${s.id}"] li`).length;
      expect(steps).toBeGreaterThanOrEqual(3);
      expect(steps).toBeLessThanOrEqual(5);
    }
    expect(text('details[data-source="google"]')).toContain('takeout.google.com');
    expect(text('details[data-source="google"]')).toContain('JSON');
    expect(text('details[data-source="health"]')).toContain('Export All Health Data');
    expect(text('#importPanel')).toContain(PRIVATE);
    expect($('[data-act="nav"][data-v="settings"]')).not.toBeNull();
    expect(($('[data-act="life-import-pick"]') as HTMLButtonElement).disabled).toBe(false);
    expect(importButton()).toContain('data-v="life-import"');
  });

  it('reads a file into the store and says how much, from which years; again, nothing new', async () => {
    const store = memoryStore();
    renderImport(root, { store, importer: createImporter(() => null) });
    choose(new File([searches], 'MyActivity.json'));
    await until(() => !!$('#importResult'));
    expect(text('#importResult')).toBe('Added 3 events from 2019-2026.');
    expect(text('#importStatus')).toContain('From: Google activity.');
    expect(store.kept.size).toBe(3);
    expect(text('[data-act="life-import-pick"]')).toBe('Choose another file');

    choose(new File([searches], 'MyActivity.json'));
    await until(() => text('#importResult').startsWith('Nothing new'));
    expect(text('#importResult')).toBe('Nothing new: you already have all 3 events from 2019-2026.');
  });

  it('shows progress with Cancel, and stopping keeps what was added', async () => {
    let opts: ImportOptions | null = null;
    let finish: (r: ImportResult) => void = () => {};
    const det: Detection = { name: 'export.zip', size: 1000, zip: true, found: [{ kind: 'apple-health', path: 'apple_health_export/export.xml', size: 1000, label: 'Apple Health' }] };
    const fake: Importer = {
      detect: async () => det,
      run: (_f, o) => {
        opts = o;
        return new Promise((res) => (finish = res));
      },
    };
    renderImport(root, { store: memoryStore(), importer: fake });
    choose(new File(['x'], 'export.zip'));
    await until(() => !!$('#importBar'));
    expect(text('#importNow')).toContain('Apple Health');
    opts!.onProgress!({ read: 100, total: 1000, found: 0, label: 'Apple Health' });
    expect(text('#importCount')).toBe('10% read');
    expect(text('#importNow')).toBe('Reading Apple Health…');
    opts!.onProgress!({ read: 420, total: 1000, found: 1234, label: 'Apple Health' });
    expect(($('#importBar') as HTMLElement).style.width).toBe('42%');
    expect(text('#importCount')).toBe('42% read · 1,234 events found so far');
    expect($('[role="progressbar"]')!.getAttribute('aria-valuenow')).toBe('42');
    tap('[data-act="life-import-cancel"]');
    expect(opts!.signal!.aborted).toBe(true);
    finish({ found: 500, added: 500, labels: ['Apple Health'], cancelled: true });
    await until(() => !!$('#importResult'));
    expect(text('#importResult')).toBe('Stopped. Added 500 events before that.');
  });

  it('explains what to do with an HTML Takeout', async () => {
    renderImport(root, { store: memoryStore(), importer: createImporter(() => null) });
    choose(new File(['<html><body><div class="mdl-grid"><div class="outer-cell mdl-cell"><div class="content-cell">Searched</div></div></div></body></html>'], 'MyActivity.html'));
    await until(() => text('#importStatus').includes('HTML'));
    expect(text('#importStatus')).toContain('Arise needs JSON');
    expect(text('#importStatus')).toContain('Multiple formats');
  });

  it('asks which columns a bank statement has, shows an example, and uses the answer', async () => {
    let used: ImportOptions | null = null;
    const real = createImporter(() => null);
    const spy: Importer = {
      detect: real.detect,
      run: (f, o) => {
        used = o;
        return real.run(f, o);
      },
    };
    const store = memoryStore();
    renderImport(root, { store, importer: spy });
    choose(new File(['Date,Description,Money out,Money in,Balance\n02/01/2024,TESCO,12.30,,100.00\n03/01/2024,SALARY,,2000.00,2100.00\n'], 'statement.csv'));
    await until(() => !!$('#importMap'));
    const amount = $('select[data-k="amount"]') as HTMLSelectElement;
    expect(amount.value).toBe('two');
    expect($('#importTwo')!.hidden).toBe(false);
    expect(($('select[data-k="out"]') as HTMLSelectElement).value).toBe('2');
    expect(text('#importPreview')).toContain('TESCO');
    // Pointing Amount at a single column hides money out / in.
    amount.value = '4';
    amount.dispatchEvent(new Event('change', { bubbles: true }));
    expect($('#importTwo')!.hidden).toBe(true);
    amount.value = 'two';
    amount.dispatchEvent(new Event('change', { bubbles: true }));
    const order = $('select[data-k="dateOrder"]') as HTMLSelectElement;
    order.value = 'dmy';
    order.dispatchEvent(new Event('change', { bubbles: true }));
    // A redraw (a sync, say) keeps the answers.
    renderImport(root, { store, importer: spy });
    expect(($('select[data-k="amount"]') as HTMLSelectElement).value).toBe('two');
    tap('[data-act="life-import-go"]');
    await until(() => !!$('#importResult'));
    expect(used!.csv).toMatchObject({ date: 0, description: 1, out: 2, in: 3 });
    expect([...store.kept.values()].map((e) => e.title)).toEqual(['Spent 12.30 at TESCO', 'Received 2,000.00: SALARY']);
  });

  it('asks whose Netflix viewing it is', async () => {
    const real = createImporter(() => null);
    let used: ImportOptions | null = null;
    const spy: Importer = { detect: real.detect, run: (f, o) => ((used = o), real.run(f, o)) };
    const store = memoryStore();
    renderImport(root, { store, importer: spy });
    const csv = 'Profile Name,Start Time,Duration,Attributes,Title,Supplemental Video Type,Device Type,Bookmark,Latest Bookmark,Country\nAnna,2024-01-01 10:00:00,00:30:00,,Show A,,TV,00:30:00,00:30:00,GB\nKids,2024-01-01 11:00:00,00:30:00,,Show B,,TV,00:30:00,00:30:00,GB\n';
    choose(new File([csv], 'ViewingActivity.csv'));
    await until(() => !!$('#importProfiles'));
    const boxes = [...document.querySelectorAll('input[name="importProfile"]')] as HTMLInputElement[];
    expect(boxes.map((b) => [b.value, b.checked])).toEqual([['Anna', true], ['Kids', false]]);
    boxes[0].checked = false;
    tap('[data-act="life-import-go"]');
    expect($('#importAskErr')!.hidden).toBe(false);
    boxes[1].checked = true;
    tap('[data-act="life-import-go"]');
    await until(() => !!$('#importResult'));
    expect(used!.profiles).toEqual(['Kids']);
    expect([...store.kept.values()].map((e) => e.title)).toEqual(['Watched Show B']);
  });

  it('says when the life log isn’t on this device yet', async () => {
    renderImport(root, { store: async () => null });
    await tick();
    await tick();
    expect(text('#importNoStore')).toContain('life log isn’t on this device yet');
    expect(($('[data-act="life-import-pick"]') as HTMLButtonElement).disabled).toBe(true);
  });
});
