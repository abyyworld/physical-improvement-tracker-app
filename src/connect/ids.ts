// Which life events came from which linked account, so "Delete what Arise got from it" can take
// exactly those back out of the life log (a Gmail message and a Google search share the source
// 'google' there; only this list tells them apart). Event ids only, kept in IndexedDB on this
// device, or in memory where IndexedDB isn't available (private browsing, tests).

import type { ServiceId } from './state';

const DB = 'arise-connect';
const STORE = 'ids';

let memory: Map<string, ServiceId> | null = null;
let db: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (!db) {
    db = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE).createIndex('by', 's', { unique: false });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.catch(() => {
      db = null;
    });
  }
  return db;
}

const usable = () => !memory && typeof indexedDB !== 'undefined';

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const d = await open();
  return new Promise<T | undefined>((resolve, reject) => {
    const tx = d.transaction(STORE, mode);
    const r = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(r ? r.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// Falls back to memory for good once IndexedDB fails, so the counts stay consistent this visit.
async function safely<T>(idb: () => Promise<T>, mem: (m: Map<string, ServiceId>) => T): Promise<T> {
  if (usable()) {
    try {
      return await idb();
    } catch {
      memory = new Map();
    }
  }
  return mem((memory ??= new Map()));
}

export async function add(service: ServiceId, ids: readonly string[]): Promise<void> {
  if (!ids.length) return;
  await safely(
    () => run('readwrite', (s) => void ids.forEach((id) => s.put({ s: service }, id))).then(() => undefined),
    (m) => void ids.forEach((id) => m.set(id, service)),
  );
}

export async function list(service: ServiceId): Promise<string[]> {
  return safely(
    async () => ((await run('readonly', (s) => s.index('by').getAllKeys(IDBKeyRange.only(service)))) || []).map(String),
    (m) => [...m].filter(([, s]) => s === service).map(([id]) => id),
  );
}

export async function count(service: ServiceId): Promise<number> {
  return safely(
    async () => (await run('readonly', (s) => s.index('by').count(IDBKeyRange.only(service)))) || 0,
    (m) => [...m.values()].filter((s) => s === service).length,
  );
}

export async function drop(ids: readonly string[]): Promise<void> {
  if (!ids.length) return;
  await safely(
    () => run('readwrite', (s) => void ids.forEach((id) => s.delete(id))).then(() => undefined),
    (m) => void ids.forEach((id) => m.delete(id)),
  );
}

export async function forget(service: ServiceId): Promise<void> {
  await drop(await list(service));
}

// For tests: start again, in memory.
export function resetForTests() {
  memory = new Map();
  db = null;
}
