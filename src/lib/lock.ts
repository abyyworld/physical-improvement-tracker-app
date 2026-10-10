// The optional app lock: a passcode, or Face ID / Touch ID through the browser (WebAuthn).
// It belongs to this device only. It's kept under its own key, never in the saved data
// (pit-data-v1), so it's never synced, never in a backup, and a backup can't bring one in.
// The passcode itself is never kept: only a slow hash of it (PBKDF2), with a random salt.

export const KEY = 'arise-lock';
export const ITERATIONS = 310_000;
// Minutes away before it asks again (0: every time the app comes back).
export const AWAY = [0, 1, 5, 15];
const FREE_TRIES = 5;
const FIRST_WAIT = 30_000;
const MAX_WAIT = 60 * 60_000;

export interface Lock {
  salt: string; // base64url
  hash: string; // base64url, PBKDF2-SHA-256 of the passcode
  iter: number;
  digits: number; // the passcode's length, so the number pad goes on by itself (like an iPhone's)
  away: number; // minutes
  bio: string; // the Face ID credential's id (base64url), '' for none
  rp: string; // the site it was made on (a credential only works there)
  fails: number; // wrong passcodes in a row
  until: number; // no tries before this time (after too many wrong ones)
}

const b64u = (b: ArrayBuffer | Uint8Array) => {
  const bytes = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = '';
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromB64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const B64U = /^[\w-]{1,512}$/;

// ---------- the saved lock (null: no lock on this device)

export function read(): Lock | null {
  let raw: unknown;
  try {
    raw = JSON.parse(localStorage.getItem(KEY) || 'null');
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const l = raw as Record<string, unknown>;
  const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : d);
  if (typeof l.salt !== 'string' || !B64U.test(l.salt) || typeof l.hash !== 'string' || !B64U.test(l.hash)) return null;
  return {
    salt: l.salt,
    hash: l.hash,
    iter: num(l.iter, 100_000, 10_000_000, ITERATIONS),
    digits: num(l.digits, 4, 8, 0),
    away: AWAY.includes(l.away as number) ? (l.away as number) : 0,
    bio: typeof l.bio === 'string' && B64U.test(l.bio) ? l.bio : '',
    rp: typeof l.rp === 'string' ? l.rp.slice(0, 253) : '',
    fails: num(l.fails, 0, 1000, 0),
    until: num(l.until, 0, Number.MAX_SAFE_INTEGER, 0),
  };
}

export const isOn = () => !!read();

function write(l: Lock) {
  try {
    localStorage.setItem(KEY, JSON.stringify(l));
  } catch {}
}
export const update = (p: Partial<Lock>) => {
  const l = read();
  if (l) write({ ...l, ...p });
};
export function turnOff() {
  try {
    localStorage.removeItem(KEY);
  } catch {}
}

// ---------- the passcode

export const validPasscode = (p: string) => /^\d{4,8}$/.test(p);

export async function hashPasscode(passcode: string, salt: Uint8Array, iter = ITERATIONS): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(passcode), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: iter }, key, 256);
  return b64u(bits);
}

export async function turnOn(passcode: string, { away = 0, bio = '' }: { away?: number; bio?: string } = {}) {
  if (!validPasscode(passcode)) throw new Error('The passcode needs 4 to 8 digits.');
  const salt = random(16);
  const hash = await hashPasscode(passcode, salt);
  write({ salt: b64u(salt), hash, iter: ITERATIONS, digits: passcode.length, away: AWAY.includes(away) ? away : 0, bio, rp: bio ? location.hostname : '', fails: 0, until: 0 });
}

// How long to wait after this many wrong passcodes in a row: none for the first 4, 30 seconds
// after the 5th, then twice as long after each one more (an hour at most).
export const waitFor = (fails: number) => (fails < FREE_TRIES ? 0 : Math.min(FIRST_WAIT * 2 ** (fails - FREE_TRIES), MAX_WAIT));

// Milliseconds before the passcode can be tried again (0: now).
export function waitLeft(now = Date.now()): number {
  const l = read();
  if (!l || !l.until) return 0;
  // A clock turned back doesn't make the wait longer than it was.
  return Math.max(0, Math.min(l.until - now, waitFor(l.fails)));
}

// Checks a passcode, counting wrong ones. 'wait': too many wrong ones, try again later.
export async function check(passcode: string): Promise<'ok' | 'wrong' | 'wait'> {
  const l = read();
  if (!l) return 'ok';
  if (waitLeft()) return 'wait';
  const same = validPasscode(passcode) && equal(await hashPasscode(passcode, fromB64u(l.salt), l.iter), l.hash);
  if (same) {
    update({ fails: 0, until: 0 });
    return 'ok';
  }
  const fails = (read()?.fails ?? l.fails) + 1;
  const wait = waitFor(fails);
  update({ fails, until: wait ? Date.now() + wait : 0 });
  return 'wrong';
}

function equal(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// Whether being away from `hiddenAt` until `now` asks for the lock again.
export const awayTooLong = (hiddenAt: number, now: number, away: number) => now - hiddenAt >= away * 60_000;

// ---------- Face ID / Touch ID (a passkey on this device that only unlocks it)

// Works in browsers on this kind of device; not in the iPhone app (capacitor://localhost).
export async function bioAvailable(): Promise<boolean> {
  try {
    if (!globalThis.isSecureContext || typeof PublicKeyCredential === 'undefined' || !navigator.credentials) return false;
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

// The credential still works here (it's tied to the site it was made on).
export const bioUsable = (l: Lock | null) => !!l?.bio && l.rp === location.hostname;

// Makes the credential. Returns its id, or '' if it wasn't made (cancelled, or not possible).
export async function bioEnroll(): Promise<string> {
  try {
    const cred = (await navigator.credentials.create({
      publicKey: {
        challenge: random(32),
        rp: { name: 'Arise', id: location.hostname },
        user: { id: random(16), name: 'Arise app lock', displayName: 'Arise app lock' },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
        attestation: 'none',
        timeout: 60_000,
      },
    })) as PublicKeyCredential | null;
    return cred ? b64u(cred.rawId) : '';
  } catch {
    return '';
  }
}

// Asks for Face ID / Touch ID (or the device's own unlock). True only when the device says the
// person was verified, for this credential and this request.
export async function bioVerify(id: string): Promise<boolean> {
  try {
    const challenge = random(32);
    const cred = (await navigator.credentials.get({
      publicKey: { challenge, rpId: location.hostname, allowCredentials: [{ type: 'public-key', id: fromB64u(id) }], userVerification: 'required', timeout: 60_000 },
    })) as PublicKeyCredential | null;
    if (!cred || b64u(cred.rawId) !== id) return false;
    const r = cred.response as AuthenticatorAssertionResponse;
    const client = JSON.parse(new TextDecoder().decode(r.clientDataJSON));
    if (client.type !== 'webauthn.get' || client.challenge !== b64u(challenge)) return false;
    const flags = new Uint8Array(r.authenticatorData)[32];
    return (flags & 0x05) === 0x05; // the person was there, and verified
  } catch {
    return false;
  }
}

// What the device's own unlock is called, for buttons.
export function bioName(ua = navigator.userAgent): string {
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'Face ID or Touch ID';
  if (/Macintosh/.test(ua)) return 'Touch ID';
  if (/Windows/.test(ua)) return 'Windows Hello';
  if (/Android/.test(ua)) return 'fingerprint or face';
  return "this device's unlock";
}
