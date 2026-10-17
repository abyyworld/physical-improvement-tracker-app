// The import worker's side of the conversation with the page. The page sends a file; the worker
// reads it and sends back events in batches, waiting for each batch to be stored ("ack") before
// reading on, so a slow store slows the reading instead of filling memory. "cancel" stops it, or
// stops looking at what a file holds ("detect").

import type { LifeEvent } from '../types';
import type { Detection, ImportChoices, ImportOptions, ImportResult, Progress } from './types';

export type ToWorker =
  | { t: 'detect'; id: number; file: Blob }
  | { t: 'import'; id: number; file: Blob; choices: ImportChoices }
  | { t: 'ack'; id: number; added: number }
  | { t: 'cancel'; id: number };

export type FromWorker =
  | { t: 'detected'; id: number; detection: Detection }
  | { t: 'events'; id: number; batch: LifeEvent[] }
  | { t: 'progress'; id: number; p: Progress }
  | { t: 'done'; id: number; result: ImportResult }
  | { t: 'error'; id: number; message: string };

export interface Port {
  postMessage(m: FromWorker): void;
  addEventListener(type: 'message', fn: (e: MessageEvent) => void): void;
}

export interface Impl {
  detect(file: Blob, signal?: AbortSignal): Promise<Detection>;
  importFile(file: Blob, opts: ImportOptions): Promise<ImportResult>;
}

const message = (err: unknown) => (err instanceof Error && err.message ? err.message : 'The file could not be read.');

export function serve(port: Port, impl: Impl): void {
  const jobs = new Map<number, { ctrl: AbortController; ack?: (added: number) => void }>();
  port.addEventListener('message', async (e: MessageEvent) => {
    const m = e.data as ToWorker;
    if (!m || typeof m !== 'object') return;
    switch (m.t) {
      case 'detect': {
        const job = { ctrl: new AbortController() };
        jobs.set(m.id, job);
        try {
          port.postMessage({ t: 'detected', id: m.id, detection: await impl.detect(m.file, job.ctrl.signal) });
        } catch (err) {
          port.postMessage({ t: 'error', id: m.id, message: message(err) });
        } finally {
          jobs.delete(m.id);
        }
        break;
      }
      case 'import': {
        const job: { ctrl: AbortController; ack?: (added: number) => void } = { ctrl: new AbortController() };
        jobs.set(m.id, job);
        try {
          const result = await impl.importFile(m.file, {
            ...m.choices,
            signal: job.ctrl.signal,
            onEvents: (batch) =>
              new Promise<number>((resolve) => {
                job.ack = resolve;
                port.postMessage({ t: 'events', id: m.id, batch });
              }),
            onProgress: (p) => port.postMessage({ t: 'progress', id: m.id, p }),
          });
          port.postMessage({ t: 'done', id: m.id, result });
        } catch (err) {
          port.postMessage({ t: 'error', id: m.id, message: message(err) });
        } finally {
          jobs.delete(m.id);
        }
        break;
      }
      case 'ack': {
        const job = jobs.get(m.id);
        const ack = job?.ack;
        if (job) job.ack = undefined;
        ack?.(m.added);
        break;
      }
      case 'cancel': {
        const job = jobs.get(m.id);
        if (!job) break;
        job.ctrl.abort();
        const ack = job.ack;
        job.ack = undefined;
        ack?.(0); // don't wait for a batch nobody will store
        break;
      }
    }
  });
}
