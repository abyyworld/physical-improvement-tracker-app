// Requests to the services people link. In a browser they go through fetch, which only works
// with services that allow it (Google and Microsoft do). In the iPhone app they go through
// Capacitor's own HTTP (the CapacitorHttp plugin that comes with @capacitor/core), which isn't
// held back by the browser's cross-site rules, so Steam and PlayStation work there too.
//
// Nothing goes through Arise's servers: each request goes straight from this device to the service.

export interface Req {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  noRedirect?: boolean; // answer with the redirect itself instead of following it
}

export interface Res {
  status: number;
  data: unknown; // parsed JSON when it is JSON, otherwise the text
  headers: Record<string, string>; // names in lower case
}

// What went wrong, in a form the sync can act on. `message` is written for the Player.
export type Trouble =
  | 'auth' // signed out, revoked, or the key is wrong: they need to connect again
  | 'tap' // the sign-in ran out and needs a tap (Google and Microsoft on the web)
  | 'rate' // too many requests: try again after `retryAfter`
  | 'gone' // a sync cursor ran out: start that part again
  | 'net' // offline, or the service is down for a moment: try again later
  | 'private' // the account doesn't share this (a private Steam profile)
  | 'other';

export class ConnectError extends Error {
  constructor(
    readonly kind: Trouble,
    message: string,
    readonly retryAfter = 0, // ms
    readonly status = 0,
  ) {
    super(message);
  }
}

interface Cap {
  isNativePlatform?: () => boolean;
  PluginHeaders?: { name: string }[];
  nativePromise: (plugin: string, method: string, options?: object) => Promise<Record<string, unknown>>;
}
const cap = () => (globalThis as { Capacitor?: Cap }).Capacitor;
export const isNative = () => !!cap()?.isNativePlatform?.();
// The iPhone app's own HTTP. It's part of Capacitor itself, so no new plugin (and no new
// Arise.ipa) is needed for it.
export const nativeHttp = () => isNative() && !!cap()?.PluginHeaders?.some((h) => h.name === 'CapacitorHttp');

const TIMEOUT = 30_000;

const parse = (data: unknown, type: string): unknown => {
  if (typeof data !== 'string') return data;
  if (/json/i.test(type) || /^\s*[{[]/.test(data)) {
    try {
      return JSON.parse(data);
    } catch {}
  }
  return data;
};

const lower = (h: Record<string, unknown> | undefined) => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h || {})) out[k.toLowerCase()] = String(v);
  return out;
};

export async function request(r: Req): Promise<Res> {
  if (nativeHttp()) {
    let out: Record<string, unknown>;
    try {
      out = await cap()!.nativePromise('CapacitorHttp', 'request', {
        url: r.url,
        method: r.method || 'GET',
        headers: r.headers || {},
        ...(r.body !== undefined ? { data: r.body } : {}),
        disableRedirects: !!r.noRedirect,
        responseType: 'text',
        connectTimeout: TIMEOUT,
        readTimeout: TIMEOUT,
      });
    } catch {
      throw new ConnectError('net', "Couldn't reach it. Arise will try again later.");
    }
    const headers = lower(out.headers as Record<string, unknown>);
    return { status: Number(out.status) || 0, headers, data: parse(out.data, headers['content-type'] || '') };
  }
  let res: Response;
  try {
    res = await fetch(r.url, {
      method: r.method || 'GET',
      headers: r.headers,
      body: r.body,
      redirect: r.noRedirect ? 'manual' : 'follow',
      credentials: 'omit',
      cache: 'no-store',
      signal: typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(TIMEOUT) : undefined,
    });
  } catch {
    throw new ConnectError('net', "Couldn't reach it. Arise will try again later.");
  }
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
  const text = await res.text().catch(() => '');
  return { status: res.status, headers, data: parse(text, headers['content-type'] || '') };
}

// How long a service asked to wait (Retry-After: seconds, or a date), in ms.
export function retryAfter(res: Res, fallback = 15 * 60_000): number {
  const v = res.headers['retry-after'];
  if (!v) return fallback;
  if (/^\d+$/.test(v.trim())) return Math.min(Number(v) * 1000, 24 * 3600_000);
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, Math.min(at - Date.now(), 24 * 3600_000)) : fallback;
}

// A form body (application/x-www-form-urlencoded).
export const form = (o: Record<string, string>) => new URLSearchParams(o).toString();

export const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const text = (v: unknown, max = 500) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max) : '');
