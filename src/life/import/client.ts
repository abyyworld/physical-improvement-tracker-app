// The page's side of importing: hands the file to the import worker (worker.ts) and passes its
// batches to the store, its progress to the screen, and a Cancel back. Where a worker can't run,
// the same code runs on the page instead.

import type { Detection, ImportOptions, ImportResult } from './types';
import type { FromWorker, ToWorker } from './host';

export interface WorkerLike {
  postMessage(m: ToWorker): void;
  addEventListener(type: 'message' | 'error', fn: (e: MessageEvent & ErrorEvent) => void): void;
  terminate(): void;
}

export interface Importer {
  // `signal` stops it: then it says `cancelled` straight away, and the worker stops looking.
  detect(file: File | Blob, signal?: AbortSignal): Promise<Detection>;
  run(file: File | Blob, opts: ImportOptions): Promise<ImportResult>;
}

function defaultWorker(): WorkerLike | null {
  if (typeof Worker === 'undefined') return null;
  return new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike;
}

type Handler = (m: FromWorker | { t: 'crashed' }) => void;

export function createImporter(make: () => WorkerLike | null = defaultWorker): Importer {
  let worker: WorkerLike | null = null;
  let broken = false;
  let seq = 0;
  const handlers = new Map<number, Handler>();

  const get = (): WorkerLike | null => {
    if (broken) return null;
    if (worker) return worker;
    try {
      worker = make();
    } catch {
      worker = null;
    }
    if (!worker) {
      broken = true;
      return null;
    }
    worker.addEventListener('message', (e) => {
      const m = e.data as FromWorker;
      handlers.get(m?.id)?.(m);
    });
    // The worker couldn't start (or died): what's waiting is done on the page.
    worker.addEventListener('error', () => {
      broken = true;
      try {
        worker?.terminate();
      } catch {}
      worker = null;
      for (const h of [...handlers.values()]) h({ t: 'crashed' });
    });
    return worker;
  };

  const inPage = () => import('./index');

  const detect = (file: File | Blob, signal?: AbortSignal): Promise<Detection> => {
    const stopped = (): Detection => ({ name: (file as File).name ?? 'file', size: file.size, zip: false, found: [], cancelled: true });
    if (signal?.aborted) return Promise.resolve(stopped());
    const w = get();
    if (!w) return inPage().then((lib) => lib.detect(file, signal));
    return new Promise((resolve, reject) => {
      const id = ++seq;
      const finish = () => {
        handlers.delete(id);
        signal?.removeEventListener('abort', cancel);
      };
      // Stopped: the worker is told, and the page doesn't wait for it to get there.
      const cancel = () => {
        worker?.postMessage({ t: 'cancel', id });
        finish();
        resolve(stopped());
      };
      signal?.addEventListener('abort', cancel, { once: true });
      handlers.set(id, (m) => {
        if (m.t === 'detected') resolve(m.detection);
        else if (m.t === 'error') reject(new Error(m.message));
        else if (m.t === 'crashed') inPage().then((lib) => lib.detect(file, signal)).then(resolve, reject);
        else return;
        finish();
      });
      w.postMessage({ t: 'detect', id, file });
    });
  };

  const run = (file: File | Blob, opts: ImportOptions): Promise<ImportResult> => {
    if (opts.signal?.aborted) return Promise.resolve({ found: 0, added: 0, labels: [], cancelled: true });
    const w = get();
    if (!w) return inPage().then((lib) => lib.importFile(file, opts));
    const { detection, paths, profiles, csv } = opts;
    return new Promise((resolve, reject) => {
      const id = ++seq;
      let started = false;
      let tally = 0; // how many the store said were new, counted here (a cancel can cross an ack)
      const cancel = () => worker?.postMessage({ t: 'cancel', id });
      opts.signal?.addEventListener('abort', cancel, { once: true });
      const finish = () => {
        handlers.delete(id);
        opts.signal?.removeEventListener('abort', cancel);
      };
      handlers.set(id, async (m) => {
        switch (m.t) {
          case 'events': {
            started = true;
            let added: unknown;
            try {
              added = await (m.replace ? opts.onEvents(m.batch, { replace: true }) : opts.onEvents(m.batch));
            } catch (err) {
              cancel();
              finish();
              reject(err);
              return;
            }
            const n = typeof added === 'number' && Number.isFinite(added) ? added : m.batch.length;
            tally += n;
            worker?.postMessage({ t: 'ack', id, added: n });
            break;
          }
          case 'progress':
            opts.onProgress?.(m.p);
            break;
          case 'done':
            finish();
            resolve({ ...m.result, added: tally });
            break;
          case 'error':
            finish();
            reject(new Error(m.message));
            break;
          case 'crashed':
            finish();
            // Before anything arrived it simply runs here instead; after, it stopped part way.
            if (!started) inPage().then((lib) => lib.importFile(file, opts)).then(resolve, reject);
            else reject(new Error('The import stopped part way. What it read so far is kept. Try again to read the rest.'));
            break;
        }
      });
      w.postMessage({ t: 'import', id, file, choices: { detection, paths, profiles, csv } });
    });
  };

  return { detect, run };
}

let shared: Importer | null = null;
export const importer = (): Importer => (shared ??= createImporter());
