// For the tests: a browser's side of Web Push (its keys, and decrypting what it receives, written
// out separately from the server's code) and a Durable Object's storage on Node's own SQLite.

import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { StateLike } from '../index';
import { toB64url } from '../webpush';

const subtle = () => globalThis.crypto.subtle;
const te = new TextEncoder();
const P256 = { name: 'ECDH', namedCurve: 'P-256' } as const;

async function hkdf(salt: Uint8Array<ArrayBuffer>, ikm: ArrayBuffer, info: Uint8Array<ArrayBuffer>, length: number) {
  const key = await subtle().importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8);
}

export interface Browser {
  keys: CryptoKeyPair;
  publicKey: Uint8Array<ArrayBuffer>;
  auth: Uint8Array<ArrayBuffer>;
  subscription(endpoint: string): { endpoint: string; keys: { p256dh: string; auth: string } };
}

export async function browser(): Promise<Browser> {
  const keys = (await subtle().generateKey(P256, true, ['deriveBits'])) as CryptoKeyPair;
  const publicKey = new Uint8Array(await subtle().exportKey('raw', keys.publicKey));
  const auth = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return { keys, publicKey, auth, subscription: (endpoint) => ({ endpoint, keys: { p256dh: toB64url(publicKey), auth: toB64url(auth) } }) };
}

// RFC 8291 from the receiving end: what a browser does with a push it gets.
export async function decrypt(body: Uint8Array<ArrayBuffer>, b: Browser): Promise<string> {
  const salt = body.slice(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset).getUint32(16);
  const sender = body.slice(21, 21 + body[20]);
  const sealed = body.slice(21 + body[20]);
  if (rs < 18 || sealed.length > rs) throw new Error('record size');
  const shared = await subtle().deriveBits({ name: 'ECDH', public: await subtle().importKey('raw', sender, P256, false, []) }, b.keys.privateKey, 256);
  const info = new Uint8Array([...te.encode('WebPush: info\0'), ...b.publicKey, ...sender]);
  const ikm = await hkdf(b.auth, shared, info, 32);
  const cek = await subtle().importKey('raw', await hkdf(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16), 'AES-GCM', false, ['decrypt']);
  const nonce = new Uint8Array(await hkdf(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12));
  const padded = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: nonce }, cek, sealed));
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--;
  if (padded[end] !== 2) throw new Error('not the last record');
  return new TextDecoder().decode(padded.slice(0, end));
}

// A Durable Object's storage: SQLite (Node's own, the same engine Cloudflare uses) and the alarm.
// `queries` lists every statement run, and `plan` says how SQLite runs one (which rows it reads).
export function fakeStorage() {
  const db = new DatabaseSync(':memory:');
  const state = {
    alarm: null as number | null,
    queries: [] as { query: string; bindings: (string | number | null)[] }[],
    plan: (query: string, bindings: (string | number | null)[]) => db.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...(bindings as SQLInputValue[])).map((r) => String(r.detail)),
    storage: {
      sql: {
        exec(query: string, ...bindings: (string | number | null)[]) {
          state.queries.push({ query, bindings });
          const st = db.prepare(query);
          const rows = /^\s*SELECT|\bRETURNING\b/i.test(query) ? (st.all(...(bindings as SQLInputValue[])) as Record<string, unknown>[]) : (st.run(...(bindings as SQLInputValue[])), []);
          return { toArray: () => rows.map((r) => ({ ...r })) };
        },
      },
      setAlarm: async (t: number) => {
        state.alarm = t;
      },
      deleteAlarm: async () => {
        state.alarm = null;
      },
    },
  };
  return state satisfies StateLike;
}
