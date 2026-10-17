// The conversation between the page and the import worker (host.ts, client.ts), with the
// worker's side running here: messages go through structured cloning, as between real threads.

import { describe, expect, it, vi } from 'vitest';
import { serve, type FromWorker, type Impl, type ToWorker } from './host';
import { createImporter, type WorkerLike } from './client';
import { detect, importFile } from './index';
import type { LifeEvent } from '../types';
import { fileOf, zipBlob } from '../../test/life-fixtures';

// Copies a message the way postMessage does (the file is passed as it is, like a real File).
const clone = <T extends object>(m: T): T => {
  const file = (m as { file?: Blob }).file;
  const copy = structuredClone({ ...m, file: undefined });
  return (file ? { ...copy, file } : copy) as T;
};

function fakeWorker(impl: Impl = { detect, importFile }) {
  const toPage = new EventTarget();
  const toWorker = new EventTarget();
  const sent: ToWorker[] = [];
  const received: FromWorker[] = [];
  serve(
    {
      postMessage: (m) => {
        received.push(m);
        const data = clone(m);
        setTimeout(() => toPage.dispatchEvent(new MessageEvent('message', { data })));
      },
      addEventListener: (type, fn) => toWorker.addEventListener(type, fn as EventListener),
    },
    impl,
  );
  const worker: WorkerLike & { crash(): void } = {
    postMessage: (m) => {
      sent.push(m);
      const data = clone(m);
      setTimeout(() => toWorker.dispatchEvent(new MessageEvent('message', { data })));
    },
    addEventListener: (type, fn) => toPage.addEventListener(type, fn as EventListener),
    terminate: () => {},
    crash: () => toPage.dispatchEvent(new Event('error')),
  };
  return { worker, sent, received };
}

const activity = (n: number) =>
  JSON.stringify(Array.from({ length: n }, (_, i) => ({ header: 'Search', title: `Searched for ${i}`, titleUrl: `https://www.google.com/search?q=${i}`, time: new Date(Date.UTC(2020, 0, 1) + i * 1000).toISOString(), products: ['Search'] })));

describe('the import worker', () => {
  it('detects, then imports in batches, waiting for each to be stored before reading on', async () => {
    const { worker, sent, received } = fakeWorker();
    const imp = createImporter(() => worker);
    const file = fileOf([zipBlob({ 'Takeout/My Activity/Search/MyActivity.json': activity(1234) })], 'takeout.zip');
    const d = await imp.detect(file);
    expect(d.found.map((f) => f.label)).toEqual(['Google activity: Search']);

    const kept: LifeEvent[] = [];
    let storing = 0;
    let overlapped = false;
    const progress: string[] = [];
    const r = await imp.run(file, {
      detection: d,
      onEvents: async (batch) => {
        if (storing) overlapped = true;
        storing++;
        await new Promise((res) => setTimeout(res, 5));
        kept.push(...batch);
        storing--;
        return batch.length - 1; // pretend one of each batch was already there
      },
      onProgress: (p) => progress.push(p.label),
    });
    expect(overlapped).toBe(false);
    expect(kept.length).toBe(1234);
    expect(r).toMatchObject({ found: 1234, added: 1234 - 3, labels: ['Google activity: Search'] });
    expect(progress).toContain('Google activity: Search');
    // Every batch was acknowledged, with how many were new.
    expect(sent.filter((m) => m.t === 'ack').map((m) => (m as { added: number }).added)).toEqual([499, 499, 233]);
    expect(received.filter((m) => m.t === 'events').length).toBe(3);
  });

  it('cancels: the worker stops reading and says so', async () => {
    const { worker, sent } = fakeWorker();
    const imp = createImporter(() => worker);
    const file = fileOf([activity(3000)], 'MyActivity.json');
    const ctrl = new AbortController();
    let batches = 0;
    const r = await imp.run(file, {
      signal: ctrl.signal,
      onEvents: async (b) => {
        batches++;
        ctrl.abort();
        return b.length;
      },
    });
    expect(r).toMatchObject({ cancelled: true, added: 500 });
    expect(batches).toBe(1);
    expect(sent.some((m) => m.t === 'cancel')).toBe(true);
  });

  it('cancels looking at a file: the page stops waiting, and the worker stops looking', async () => {
    let seen: AbortSignal | undefined;
    const { worker, sent } = fakeWorker({
      detect: (_file, signal) => {
        seen = signal;
        return new Promise(() => {}); // a zip that takes forever to look through
      },
      importFile,
    });
    const imp = createImporter(() => worker);
    const ctrl = new AbortController();
    const pending = imp.detect(fileOf(['x'], 'takeout.zip'), ctrl.signal);
    while (!seen) await new Promise((r) => setTimeout(r, 1));
    ctrl.abort();
    expect(await pending).toMatchObject({ name: 'takeout.zip', found: [], cancelled: true });
    expect(sent.some((m) => m.t === 'cancel')).toBe(true);
    while (!seen.aborted) await new Promise((r) => setTimeout(r, 1));
    expect(seen.aborted).toBe(true);
  });

  it('passes on what goes wrong', async () => {
    const { worker } = fakeWorker({ detect: async () => Promise.reject(new Error('Disk said no')), importFile: async () => Promise.reject(new Error('Nope')) });
    const imp = createImporter(() => worker);
    await expect(imp.detect(fileOf(['x'], 'x.json'))).rejects.toThrow('Disk said no');
    await expect(imp.run(fileOf(['x'], 'x.json'), { onEvents: () => 0 })).rejects.toThrow('Nope');
  });

  it('stops the worker when the store fails, and says why', async () => {
    const { worker, sent } = fakeWorker();
    const imp = createImporter(() => worker);
    await expect(imp.run(fileOf([activity(600)], 'MyActivity.json'), { onEvents: async () => Promise.reject(new Error('Storage is full')) })).rejects.toThrow('Storage is full');
    expect(sent.some((m) => m.t === 'cancel')).toBe(true);
  });

  it('runs on the page when there is no worker, or it fails to start', async () => {
    const none = createImporter(() => null);
    const file = fileOf([activity(10)], 'MyActivity.json');
    const kept: LifeEvent[] = [];
    expect(await none.run(file, { onEvents: (b) => kept.push(...b) })).toMatchObject({ found: 10 });
    expect(kept.length).toBe(10);

    const { worker } = fakeWorker({ detect: () => new Promise(() => {}), importFile: () => new Promise(() => {}) });
    const failing = createImporter(() => worker);
    const pending = failing.detect(file);
    worker.crash();
    expect((await pending).found.length).toBe(1);
    const throwing = createImporter(() => {
      throw new Error('blocked');
    });
    expect((await throwing.detect(file)).found.length).toBe(1);
  });

  it('never sends the page’s callbacks to the worker', async () => {
    const { worker, sent } = fakeWorker();
    const spy = vi.fn(() => 0);
    await createImporter(() => worker).run(fileOf([activity(2)], 'MyActivity.json'), { onEvents: spy, onProgress: () => {} });
    const msg = sent.find((m) => m.t === 'import') as Extract<ToWorker, { t: 'import' }>;
    expect(Object.values(msg.choices).some((v) => typeof v === 'function')).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
