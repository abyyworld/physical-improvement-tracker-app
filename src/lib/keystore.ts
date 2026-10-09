// Where this device keeps the key that opens the Player's cloud copy, so they don't type their
// password every time the app opens.
//
// It's stored in IndexedDB as a CryptoKey that can't be read out, only used: even code running
// in the page can encrypt and decrypt with it, but can never copy the key itself somewhere else.
// Signing out deletes it.

const DB = 'arise-keys';
const STORE = 'keys';

export interface StoredKey {
  uid: string;
  id: string; // the email or account code it was made for
  key: CryptoKey;
}

let memory: StoredKey | null = null; // used when IndexedDB isn't available (private browsing)

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDB();
  try {
    return await new Promise<T>((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } finally {
    db.close();
  }
}

export async function saveKey(k: StoredKey): Promise<void> {
  memory = k;
  try {
    await tx('readwrite', (s) => s.put(k, 'current'));
  } catch {
    // Kept in memory for this visit only; the Player is asked for their password next time.
  }
}

export async function loadKey(uid: string): Promise<StoredKey | null> {
  if (memory?.uid === uid) return memory;
  try {
    const k = (await tx('readonly', (s) => s.get('current'))) as StoredKey | undefined;
    if (k && k.uid === uid && k.key) return (memory = k);
  } catch {}
  return null;
}

export async function forgetKey(): Promise<void> {
  memory = null;
  try {
    await tx('readwrite', (s) => s.delete('current'));
  } catch {}
}
