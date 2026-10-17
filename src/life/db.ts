// The life log's database on this device: IndexedDB 'arise-life'. Nothing here is synced yet.
//
//   events     one LifeEvent each, by id, plus `w` (its words, for search). Indexes: at,
//              source_at ([source, at]) and w (one entry per word).
//   summaries  LifeSummary by id ('d:2026-10-16', 'w:…', 'm:…')
//   facts      LifeFact by id
//   kv         small bits of state for the memory (which days need summing up again, …)

export const DB_NAME = 'arise-life';
const VERSION = 1;

export class LifeLogError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

let opening: Promise<IDBDatabase> | null = null;

export function open(): Promise<IDBDatabase> {
  if (opening) return opening;
  opening = new Promise<IDBDatabase>((resolve, reject) => {
    const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    if (!idb) {
      reject(new LifeLogError('unavailable', "This browser can't keep a life log (it has no on-device database)."));
      return;
    }
    let r: IDBOpenDBRequest;
    try {
      r = idb.open(DB_NAME, VERSION);
    } catch (err) {
      reject(new LifeLogError('unavailable', `The life log couldn't open: ${(err as Error)?.message || 'unknown error'}.`));
      return;
    }
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('events')) {
        const ev = db.createObjectStore('events', { keyPath: 'id' });
        ev.createIndex('at', 'at');
        ev.createIndex('source_at', ['source', 'at']);
        ev.createIndex('w', 'w', { multiEntry: true });
      }
      if (!db.objectStoreNames.contains('summaries')) db.createObjectStore('summaries', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('facts')) db.createObjectStore('facts', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'k' });
    };
    r.onsuccess = () => {
      const db = r.result;
      // Another tab upgrading or deleting it: let go, and open again next time.
      db.onversionchange = () => {
        db.close();
        opening = null;
      };
      db.onclose = () => {
        opening = null;
      };
      resolve(db);
    };
    r.onerror = () => reject(new LifeLogError('unavailable', `The life log couldn't open: ${r.error?.message || 'unknown error'}.`));
    r.onblocked = () => reject(new LifeLogError('blocked', 'The life log is busy in another tab. Close it and try again.'));
  }).catch((err) => {
    opening = null;
    throw err;
  });
  return opening;
}

// Forget the open connection (tests, and after deleting the database).
export function closeDB() {
  const o = opening;
  opening = null;
  o?.then((db) => db.close()).catch(() => {});
}

export const req = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

export const done = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new LifeLogError('aborted', 'The life log change was stopped.'));
  });

// Other tabs and windows of the app on this device keep their own copy of the memory, so they're
// told when the log is emptied or the memory changes. A storage event, as src/store.ts uses: it
// reaches every other tab, never this one.
const PING = 'arise-life-ping';
export function tellOtherTabs(type: 'clear' | 'memory') {
  try {
    localStorage.setItem(PING, JSON.stringify({ type, n: `${Date.now()}${Math.random()}` }));
  } catch {}
}
export function onOtherTabs(cb: (type: string) => void): () => void {
  const fn = (e: StorageEvent) => {
    if (e.key !== PING || !e.newValue) return;
    try {
      cb(String(JSON.parse(e.newValue)?.type || ''));
    } catch {}
  };
  if (typeof window === 'undefined') return () => {};
  window.addEventListener('storage', fn);
  return () => window.removeEventListener('storage', fn);
}

// A small value kept in 'kv'.
export async function getKV<T>(k: string): Promise<T | undefined> {
  const db = await open();
  const row = await req(db.transaction('kv').objectStore('kv').get(k));
  return (row as { v?: T } | undefined)?.v;
}

export async function setKV(k: string, v: unknown) {
  const db = await open();
  const tx = db.transaction('kv', 'readwrite');
  tx.objectStore('kv').put({ k, v });
  await done(tx);
}
