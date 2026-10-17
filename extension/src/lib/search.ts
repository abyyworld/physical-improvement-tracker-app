// Searches, read from the address of a search page: the words and where they were searched. The
// address kept for it has the search words only, never the rest of the query string (tracking
// ids, the map's position, the page of results…).

import { parse } from './url';

export interface Search {
  engine: string; // a short id, e.g. 'google', 'youtube'
  name: string; // what a person reads, e.g. 'Google', 'YouTube'
  query: string;
  url: string; // the search page with the search words only
}

interface Rule {
  engine: string;
  name: string;
  host: RegExp;
  path: RegExp;
  params?: string[]; // the search words are in one of these
  hash?: boolean; // …or after the #, like google.com/#q=…
  segment?: number; // …or in this part of the path (its index in path.exec's groups)
  canon?: (u: URL, q: string) => string;
}

// Country sites: google.com, google.de, google.co.uk, google.com.au…
const TLD = String.raw`(?:com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})`;
const GOOGLE = new RegExp(`^(?:www\\.)?google\\.${TLD}$`);
const enc = encodeURIComponent;
const byParam = (param: string) => (u: URL, q: string) => `${u.protocol}//${u.host}${u.pathname}?${param}=${enc(q)}`;
const at = (path: string, param: string) => (u: URL, q: string) => `${u.protocol}//${u.host}${path}?${param}=${enc(q)}`;

// In order: the first rule that fits the address wins (maps before the plain search engines).
const RULES: Rule[] = [
  // Maps first: they share google.com and bing.com.
  { engine: 'google-maps', name: 'Google Maps', host: GOOGLE, path: /^\/maps\/search\/([^/]+)/, segment: 1, canon: (u, q) => `${u.protocol}//${u.host}/maps/search/${enc(q)}` },
  { engine: 'google-maps', name: 'Google Maps', host: new RegExp(`^maps\\.google\\.${TLD}$`), path: /^\/maps\/search\/([^/]+)/, segment: 1, canon: (u, q) => `${u.protocol}//${u.host}/maps/search/${enc(q)}` },
  { engine: 'google-maps', name: 'Google Maps', host: GOOGLE, path: /^\/maps(\/|$)/, params: ['q', 'query'], canon: at('/maps', 'q') },
  { engine: 'google-maps', name: 'Google Maps', host: new RegExp(`^maps\\.google\\.${TLD}$`), path: /^\/(maps\/?)?$/, params: ['q', 'query'], canon: at('/maps', 'q') },
  { engine: 'apple-maps', name: 'Apple Maps', host: /^maps\.apple\.com$/, path: /^\/(search\/?)?$/, params: ['q', 'query'], canon: at('/', 'q') },
  { engine: 'bing-maps', name: 'Bing Maps', host: /^(www\.)?bing\.com$/, path: /^\/maps\/?$/, params: ['q', 'where1'], canon: at('/maps', 'q') },
  { engine: 'osm', name: 'OpenStreetMap', host: /^(www\.)?openstreetmap\.org$/, path: /^\/search\/?$/, params: ['query'], canon: at('/search', 'query') },

  { engine: 'google', name: 'Google', host: GOOGLE, path: /^\/search\/?$/, params: ['q', 'as_q'], hash: true, canon: at('/search', 'q') },
  { engine: 'google', name: 'Google', host: GOOGLE, path: /^\/(webhp)?$/, params: ['q'], hash: true, canon: at('/search', 'q') },
  { engine: 'google', name: 'Google', host: new RegExp(`^(images|news|scholar)\\.google\\.${TLD}$`), path: /^\/(search|scholar|images)?\/?$/, params: ['q'], canon: byParam('q') },
  { engine: 'bing', name: 'Bing', host: /^(www\.|cn\.)?bing\.com$/, path: /^\/((images|videos|news|shop)\/)?search\/?$/, params: ['q'], canon: byParam('q') },
  { engine: 'duckduckgo', name: 'DuckDuckGo', host: /^(html\.|lite\.|start\.)?duckduckgo\.com$/, path: /^\/((html|lite)\/?)?$/, params: ['q'], canon: (_u, q) => `https://duckduckgo.com/?q=${enc(q)}` },
  { engine: 'youtube', name: 'YouTube', host: /^(www\.|m\.)?youtube\.com$/, path: /^\/results\/?$/, params: ['search_query', 'q'], canon: (_u, q) => `https://www.youtube.com/results?search_query=${enc(q)}` },
  { engine: 'youtube-music', name: 'YouTube Music', host: /^music\.youtube\.com$/, path: /^\/search\/?$/, params: ['q'], canon: byParam('q') },
  { engine: 'amazon', name: 'Amazon', host: new RegExp(`^(www\\.|smile\\.)?amazon\\.${TLD}$`), path: /^\/s(\/|$)/, params: ['k', 'field-keywords'], canon: at('/s', 'k') },
  { engine: 'reddit', name: 'Reddit', host: /^(www\.|old\.|new\.|np\.|sh\.)?reddit\.com$/, path: /^(\/r\/[\w-]+)?\/search\/?$/, params: ['q'], canon: (u, q) => `https://www.reddit.com${u.pathname.replace(/\/$/, '')}?q=${enc(q)}` },
  // Wikipedia in every language, and its mobile site. Special:Search has a name in each language
  // (Spezial:Suche…), so any /w/ or /wiki/ page with ?search= counts.
  { engine: 'wikipedia', name: 'Wikipedia', host: /^([a-z-]+\.)?(m\.)?wikipedia\.org$/, path: /^\/(w\/index\.php|wiki\/[^/]+)$/, params: ['search'], canon: at('/w/index.php', 'search') },
  { engine: 'wikipedia', name: 'Wikipedia', host: /^([a-z-]+\.)?(m\.)?wikipedia\.org$/, path: /^\/wiki\/Special:Search\/(.+)$/, segment: 1, canon: (u, q) => `${u.protocol}//${u.host}/w/index.php?search=${enc(q)}` },
  { engine: 'chatgpt', name: 'ChatGPT', host: /^(chatgpt\.com|chat\.openai\.com)$/, path: /^\/?$/, params: ['q', 'prompt'], canon: at('/', 'q') },
  { engine: 'perplexity', name: 'Perplexity', host: /^(www\.)?perplexity\.ai$/, path: /^\/((search)(\/new)?\/?)?$/, params: ['q'], canon: at('/search', 'q') },

  // Other search boxes people use a lot.
  { engine: 'ecosia', name: 'Ecosia', host: /^(www\.)?ecosia\.org$/, path: /^\/(search|images|videos|news)\/?$/, params: ['q'], canon: byParam('q') },
  { engine: 'brave', name: 'Brave Search', host: /^search\.brave\.com$/, path: /^\/(search|images|videos|news)\/?$/, params: ['q'], canon: byParam('q') },
  { engine: 'yahoo', name: 'Yahoo', host: new RegExp(`^([a-z]{2}\\.)?search\\.yahoo\\.(com|co\\.jp)$`), path: /^\/search/, params: ['p', 'q'], canon: at('/search', 'p') },
  { engine: 'kagi', name: 'Kagi', host: /^kagi\.com$/, path: /^\/search\/?$/, params: ['q'], canon: byParam('q') },
  { engine: 'startpage', name: 'Startpage', host: /^(www\.)?startpage\.com$/, path: /^\/(do|sp)\/search\/?$/, params: ['query', 'q'], canon: at('/do/search', 'query') },
  { engine: 'yandex', name: 'Yandex', host: /^(www\.)?(yandex|ya)\.(ru|com|com\.tr|kz|by)$/, path: /^\/search\/?$/, params: ['text'], canon: byParam('text') },
  { engine: 'baidu', name: 'Baidu', host: /^(www\.)?baidu\.com$/, path: /^\/s\/?$/, params: ['wd', 'word'], canon: byParam('wd') },
  { engine: 'x', name: 'X', host: /^(www\.|mobile\.)?(x|twitter)\.com$/, path: /^\/search\/?$/, params: ['q'], canon: (_u, q) => `https://x.com/search?q=${enc(q)}` },
  { engine: 'tiktok', name: 'TikTok', host: /^(www\.)?tiktok\.com$/, path: /^\/search(\/\w+)?\/?$/, params: ['q'], canon: at('/search', 'q') },
  { engine: 'pinterest', name: 'Pinterest', host: new RegExp(`^([a-z]{2}\\.|www\\.)?pinterest\\.${TLD}$`), path: /^\/search\/\w+\/?$/, params: ['q'], canon: byParam('q') },
  { engine: 'github', name: 'GitHub', host: /^github\.com$/, path: /^\/search\/?$/, params: ['q'], canon: byParam('q') },
  { engine: 'stackoverflow', name: 'Stack Overflow', host: /^stackoverflow\.com$/, path: /^\/search\/?$/, params: ['q'], canon: byParam('q') },
  { engine: 'ebay', name: 'eBay', host: new RegExp(`^(www\\.)?ebay\\.${TLD}$`), path: /^\/sch\//, params: ['_nkw'], canon: at('/sch/i.html', '_nkw') },
  { engine: 'etsy', name: 'Etsy', host: /^(www\.)?etsy\.com$/, path: /^\/([a-z]{2}(-[a-z]{2})?\/)?search\/?$/, params: ['q'], canon: at('/search', 'q') },
  { engine: 'spotify', name: 'Spotify', host: /^open\.spotify\.com$/, path: /^\/search\/([^/]+)/, segment: 1, canon: (_u, q) => `https://open.spotify.com/search/${enc(q)}` },
  { engine: 'netflix', name: 'Netflix', host: /^(www\.)?netflix\.com$/, path: /^\/search\/?$/, params: ['q'], canon: at('/search', 'q') },
  { engine: 'linkedin', name: 'LinkedIn', host: /^(www\.)?linkedin\.com$/, path: /^\/search\/results\//, params: ['keywords'], canon: at('/search/results/all/', 'keywords') },
];

const MAX_QUERY = 300;

export function tidy(q: string): string {
  return q.replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY).trim();
}

function decode(part: string): string {
  try {
    return decodeURIComponent(part.replace(/\+/g, ' '));
  } catch {
    return part;
  }
}

export function findSearch(raw: string): Search | null {
  const u = parse(raw);
  if (!u) return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  for (const r of RULES) {
    if (!r.host.test(host)) continue;
    const m = r.path.exec(u.pathname);
    if (!m) continue;
    let q = '';
    if (r.segment) q = decode(m[r.segment] || '');
    if (!q && r.params) {
      const hash = r.hash ? new URLSearchParams(u.hash.replace(/^#/, '')) : null;
      for (const p of r.params) q ||= u.searchParams.get(p) || hash?.get(p) || '';
    }
    q = tidy(q);
    if (!q) continue;
    return { engine: r.engine, name: r.name, query: q, url: (r.canon || byParam(r.params?.[0] || 'q'))(u, q) };
  }
  return null;
}
