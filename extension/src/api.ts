// The browser's extension API: `browser` in Firefox, `chrome` in Chrome, Edge, Brave and Arc.
// Both return promises in Manifest V3. Only the parts the extension uses are typed here.

export interface Tab {
  id?: number;
  windowId: number;
  url?: string;
  title?: string;
  active: boolean;
  incognito: boolean;
  audible?: boolean;
}
export interface Win {
  id?: number;
  focused: boolean;
  incognito: boolean;
  type?: string;
  tabs?: Tab[];
}
export interface Sender {
  id?: string;
  url?: string;
  origin?: string;
  tab?: Tab;
}
interface Area {
  get(keys: string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}
interface Evt<F> {
  addListener(f: F): void;
}

export interface Api {
  runtime: {
    id: string;
    getURL(path: string): string;
    getManifest(): { version: string };
    sendMessage(msg: unknown): Promise<unknown>;
    onMessage: Evt<(msg: unknown, sender: Sender, respond: (r: unknown) => void) => boolean | void>;
    onInstalled: Evt<(d: { reason: string }) => void>;
    onStartup: Evt<() => void>;
  };
  storage: { local: Area; session: Area };
  history: {
    search(q: { text: string; startTime?: number; endTime?: number; maxResults?: number }): Promise<{ url?: string; title?: string }[]>;
    getVisits(d: { url: string }): Promise<{ visitTime?: number; transition?: string; isLocal?: boolean }[]>;
    onVisited: Evt<(item: { url?: string }) => void>;
  };
  tabs: {
    query(q: { url?: string[]; active?: boolean; lastFocusedWindow?: boolean }): Promise<Tab[]>;
    sendMessage(tabId: number, msg: unknown): Promise<unknown>;
    create(p: { url: string }): Promise<Tab>;
    onActivated: Evt<(info: { tabId: number; windowId: number }) => void>;
    onUpdated: Evt<(tabId: number, change: { url?: string; status?: string; audible?: boolean }, tab: Tab) => void>;
  };
  windows: {
    WINDOW_ID_NONE: number;
    getLastFocused(q?: { populate?: boolean }): Promise<Win>;
    getAll(q?: { windowTypes?: string[] }): Promise<Win[]>;
    create(p: { url: string; type?: string; width?: number; height?: number; focused?: boolean }): Promise<Win>;
    update(id: number, p: { focused?: boolean }): Promise<Win>;
    onFocusChanged: Evt<(windowId: number) => void>;
    onRemoved: Evt<(windowId: number) => void>;
  };
  idle: {
    queryState(seconds: number): Promise<'active' | 'idle' | 'locked'>;
    setDetectionInterval(seconds: number): void;
    onStateChanged: Evt<(state: 'active' | 'idle' | 'locked') => void>;
  };
  alarms: {
    create(name: string, p: { periodInMinutes: number; delayInMinutes?: number }): Promise<void> | void;
    get(name: string): Promise<unknown>;
    onAlarm: Evt<(a: { name: string }) => void>;
  };
  action: {
    setBadgeText(p: { text: string }): Promise<void>;
    setBadgeBackgroundColor(p: { color: string }): Promise<void>;
  };
}

// (Checked for `runtime`: on a page, an element with id="browser" would be window.browser too.)
const g = globalThis as unknown as { browser?: Api; chrome?: Api };
export const api: Api = (g.browser?.runtime ? g.browser : g.chrome)!;

// Arise's own addresses, set when the extension is built (scripts/build-extension.mjs).
declare const __EXT_ARISE__: string[];
export const ARISE: string[] = __EXT_ARISE__;
