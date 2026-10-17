// A pretend internet for the linked accounts' tests (src/connect): each route answers a request
// whose address matches, like the real service would. The same routes answer the web app's fetch
// and the iPhone app's own HTTP (a simulated Capacitor with the CapacitorHttp plugin).

import { vi } from 'vitest';

export interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  noRedirect: boolean;
}

export interface Answer {
  status?: number;
  body?: unknown; // an object is sent as JSON
  headers?: Record<string, string>;
}

type Route = [RegExp, (c: Call) => Answer | Promise<Answer>];

export function fakeNet() {
  const routes: Route[] = [];
  const calls: Call[] = [];
  const net = {
    calls,
    // Later routes win, so a test can override one for a moment.
    on(re: RegExp, answer: Answer | ((c: Call) => Answer | Promise<Answer>)) {
      routes.unshift([re, typeof answer === 'function' ? answer : () => answer]);
      return net;
    },
    async answer(c: Call): Promise<{ status: number; text: string; headers: Record<string, string> }> {
      calls.push(c);
      const r = routes.find(([re]) => re.test(c.url));
      if (!r) {
        console.error(`No route for ${c.method} ${c.url}`);
        throw new Error(`No route for ${c.method} ${c.url}`);
      }
      const a = await r[1](c);
      const json = a.body !== undefined && typeof a.body !== 'string';
      return {
        status: a.status ?? 200,
        text: a.body === undefined ? '' : json ? JSON.stringify(a.body) : String(a.body),
        headers: { ...(json ? { 'content-type': 'application/json; charset=UTF-8' } : {}), ...(a.headers || {}) },
      };
    },
    urls: () => calls.map((c) => c.url),
  };
  return net;
}

export type Net = ReturnType<typeof fakeNet>;

// The web app: fetch.
export function useWeb(net: Net) {
  delete (globalThis as { Capacitor?: unknown }).Capacitor;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers as Record<string, string>) || {})) headers[k] = v;
    const a = await net.answer({ url, method: init.method || 'GET', headers, body: String(init.body ?? ''), noRedirect: init.redirect === 'manual' });
    // A redirect that isn't followed reads as an opaque answer in a browser.
    const status = a.status >= 300 && a.status < 400 ? 200 : a.status;
    return new Response(a.text || null, { status, headers: a.headers });
  });
}

// The iPhone app: Capacitor's own HTTP, which can stop at a redirect and read where it goes.
export function useNative(net: Net, plugins = ['CapacitorHttp']) {
  vi.stubGlobal('fetch', async () => {
    throw new Error('The iPhone app should use its own HTTP');
  });
  (globalThis as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => true,
    PluginHeaders: plugins.map((name) => ({ name })),
    nativePromise: async (plugin: string, method: string, o: Record<string, unknown>) => {
      if (plugin !== 'CapacitorHttp' || method !== 'request') throw new Error(`${plugin}.${method} isn't simulated`);
      const a = await net.answer({ url: String(o.url), method: String(o.method || 'GET'), headers: (o.headers as Record<string, string>) || {}, body: String(o.data ?? ''), noRedirect: o.disableRedirects === true });
      const isJson = /json/.test(a.headers['content-type'] || '');
      return { status: a.status, headers: a.headers, data: isJson ? JSON.parse(a.text) : a.text, url: o.url };
    },
  };
}

export function offline() {
  delete (globalThis as { Capacitor?: unknown }).Capacitor;
  vi.stubGlobal('fetch', async () => {
    throw new TypeError('Failed to fetch');
  });
}
