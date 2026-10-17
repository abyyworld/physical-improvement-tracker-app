// What of an address is kept: the site and the page, never the query string (it often holds
// tokens, emails and tracking ids) or the part after #. Searches keep their search words only
// (search.ts). Parts of the page's path that work like a key are left out too (`cleanPath`).

export interface Clean {
  url: string; // scheme, host and path only
  host: string; // as it is, e.g. www.youtube.com
  site: string; // the host without www. or m., e.g. youtube.com
}

const MAX_URL = 512;

export function siteOf(host: string): string {
  return host.replace(/^(www\d?|m|mobile)\./, '');
}

export function parse(raw: string): URL | null {
  if (typeof raw !== 'string' || raw.length > 8192) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u : null;
  } catch {
    return null;
  }
}

export function cleanUrl(raw: string): Clean | null {
  const u = parse(raw);
  if (!u || !u.hostname) return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  let url = `${u.protocol}//${host}${u.port ? `:${u.port}` : ''}${cleanPath(host, u.pathname)}`;
  if (url.length > MAX_URL) url = url.slice(0, MAX_URL);
  return { url, host, site: siteOf(host) };
}

// ---------- parts of a path that work like a key

// What's put in place of a part that's left out.
export const HIDDEN = '…';

// Sites whose addresses are keys themselves (a file shared by link, an invite to a chat or a
// call): only this many parts of the path are kept.
const KEY_SITES: [string, number][] = [
  ['docs.google.com', 1], ['drive.google.com', 1], ['meet.google.com', 0], ['goo.gl', 0], ['forms.gle', 0],
  ['dropbox.com', 1], ['1drv.ms', 0], ['onedrive.live.com', 0], ['wetransfer.com', 1], ['we.tl', 0],
  ['discord.gg', 0], ['chat.whatsapp.com', 0], ['zoom.us', 1],
];
// Google Maps: its paths hold places, addresses and where the map was. Only the kind of page is kept.
const MAPS = /^(?:www\.|maps\.)?google\.(?:com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})$/;
const MAPS_PAGES = new Set(['place', 'dir', 'search']);
// After a part with one of these words, the rest of the path is a code more often than not
// (a password reset, a sign-in or confirm link, an invite, an unsubscribe link).
const KEY_WORDS = new Set([
  'reset', 'password', 'passwords', 'verify', 'verification', 'confirm', 'confirmation', 'magic', 'token', 'invite',
  'invitation', 'unsubscribe', 'activate', 'activation', 'oauth', 'oauth2', 'authorize', 'login', 'signin', 'sso', 'joinchat',
]);
const KEY_PARTS = ['password', 'unsubscribe', 'oauth', 'authorize'];

const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

// Whether one part of a path looks like a code, an id that opens something, or an email address.
// Words, dates, page names and short ids don't: long runs that mix letters and digits do.
export function looksSecret(part: string): boolean {
  const s = decode(part);
  if (/[^@\s/]@[^@\s/]+\.[a-z]{2,}/i.test(s)) return true; // an email address
  if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(s)) return true; // a UUID
  for (const run of s.split(/[^A-Za-z0-9]+/)) {
    const digits = run.replace(/\D/g, '').length;
    if ((run.length >= 16 && digits >= 1) || (run.length >= 12 && digits >= 3)) return true;
  }
  // A code with - or _ in it: long, with capitals, small letters and digits.
  return s.length >= 20 && /^[\w-]+$/.test(s) && /\d/.test(s) && /[a-z]/.test(s) && /[A-Z]/.test(s);
}

const hasKeyWord = (part: string) => {
  const s = decode(part).toLowerCase();
  return s.split(/[^a-z0-9]+/).some((w) => KEY_WORDS.has(w)) || KEY_PARTS.some((w) => s.includes(w));
};

// The path, with the parts that work like a key replaced by HIDDEN.
export function cleanPath(host: string, pathname: string): string {
  let parts = pathname.split('/').slice(1); // '/a/b/' → ['a', 'b', '']
  const keySite = KEY_SITES.find(([s]) => host === s || host.endsWith(`.${s}`));
  if (keySite && parts.slice(keySite[1]).some(Boolean)) parts = [...parts.slice(0, keySite[1]), HIDDEN];
  if (MAPS.test(host) && (host.startsWith('maps.') || parts[0] === 'maps')) parts = ['maps', ...(MAPS_PAGES.has(parts[1]) ? [parts[1]] : [])];
  const out: string[] = [];
  for (const [i, part] of parts.entries()) {
    out.push(part !== HIDDEN && looksSecret(part) ? HIDDEN : part);
    if (hasKeyWord(part) && parts.slice(i + 1).some(Boolean)) {
      out.push(HIDDEN);
      break;
    }
  }
  // Several parts left out in a row show as one.
  return `/${out.filter((p, i) => !(p === HIDDEN && out[i - 1] === HIDDEN)).join('/')}`;
}

// Pages that are nobody's life: this computer itself and addresses without a name.
export function isLocal(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || /^[\d.]+$/.test(host) || host.startsWith('[');
}

// Whether an address is one of Arise's own: the same scheme and host as one of `prefixes`, the
// same port (any port when the prefix gives none, for a development server on localhost) and a
// path under its path.
export function matchesPrefix(raw: string, prefixes: readonly string[]): boolean {
  const u = parse(raw);
  if (!u) return false;
  return prefixes.some((p) => {
    const q = parse(p);
    return !!q && q.protocol === u.protocol && q.hostname === u.hostname && (!q.port || q.port === u.port) && u.pathname.startsWith(q.pathname);
  });
}
