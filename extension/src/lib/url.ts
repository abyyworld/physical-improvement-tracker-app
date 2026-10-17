// What of an address is kept: the site and the page, never the query string (it often holds
// tokens, emails and tracking ids) or the part after #. Searches keep their search words only
// (search.ts).

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
  let url = `${u.protocol}//${host}${u.port ? `:${u.port}` : ''}${u.pathname}`;
  if (url.length > MAX_URL) url = url.slice(0, MAX_URL);
  return { url, host, site: siteOf(host) };
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
