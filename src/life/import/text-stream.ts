// Readers for text that arrives a piece at a time: lines, CSV rows and XML tags. Each takes
// pieces with push() and gives back what's complete; end() gives the rest.

// ---------- lines

export class Lines {
  private rest = '';
  push(s: string): string[] {
    let text = this.rest + s;
    // A piece can end between \r and \n: keep the \r for the next one.
    let tail = '';
    if (text.endsWith('\r')) {
      text = text.slice(0, -1);
      tail = '\r';
    }
    const lines = text.split(/\r\n|\n|\r/);
    this.rest = (lines.pop() ?? '') + tail;
    return lines;
  }
  end(): string[] {
    const r = this.rest.replace(/\r$/, '');
    this.rest = '';
    return r ? [r] : [];
  }
}

// ---------- CSV (RFC 4180: quotes, quoted commas and line breaks, "" for a quote)

export class CsvRows {
  private row: string[] = [];
  private field = '';
  private quoted = false; // inside quotes
  private afterQuote = false; // just read a closing quote (or the first of "")
  private cr = false; // just ended a row with \r
  constructor(private delimiter = ',') {}

  push(s: string): string[][] {
    const out: string[][] = [];
    const d = this.delimiter;
    let field = this.field;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (this.cr) {
        this.cr = false;
        if (ch === '\n') continue;
      }
      if (this.quoted) {
        if (ch === '"') {
          this.quoted = false;
          this.afterQuote = true;
        } else {
          // Read up to the next quote in one go.
          const j = s.indexOf('"', i);
          const end = j < 0 ? s.length : j;
          field += s.slice(i, end);
          i = end - 1;
        }
        continue;
      }
      if (ch === '"') {
        if (this.afterQuote) field += '"'; // "" inside quotes
        this.quoted = true;
        this.afterQuote = false;
        continue;
      }
      this.afterQuote = false;
      if (ch === d) {
        this.row.push(field);
        field = '';
      } else if (ch === '\n' || ch === '\r') {
        this.row.push(field);
        field = '';
        out.push(this.row);
        this.row = [];
        if (ch === '\r') this.cr = true;
      } else {
        // Read up to the next special character in one go.
        let j = i + 1;
        while (j < s.length) {
          const c = s[j];
          if (c === d || c === '\n' || c === '\r' || c === '"') break;
          j++;
        }
        field += s.slice(i, j);
        i = j - 1;
      }
    }
    this.field = field;
    return out;
  }

  end(): string[][] {
    if (!this.row.length && !this.field) return [];
    this.row.push(this.field);
    const r = this.row;
    this.row = [];
    this.field = '';
    return [r];
  }
}

// The delimiter of a CSV from its first lines: the one of , ; tab | that splits them into the
// same number of columns (more than one) most often.
export function sniffDelimiter(head: string): string {
  const lines = head.split(/\r\n|\n|\r/).filter((l) => l.trim()).slice(0, 20);
  let best = ',';
  let bestScore = 0;
  for (const d of [',', ';', '\t', '|']) {
    const counts = lines.map((l) => {
      const p = new CsvRows(d);
      const rows = [...p.push(l), ...p.end()];
      return rows[0]?.length ?? 0;
    });
    const freq = new Map<number, number>();
    for (const c of counts) if (c > 1) freq.set(c, (freq.get(c) ?? 0) + 1);
    let score = 0;
    for (const [cols, f] of freq) score = Math.max(score, f * 100 + cols);
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

// ---------- XML tags

// One tag. `attrs` is the raw text after the name; read values with attr().
export interface Tag {
  name: string;
  attrs: string;
  close: boolean; // </Workout>
  self: boolean; // <Record … />
}

// A tiny scanner for big, simple XML (the Apple Health export): it finds tags and skips text,
// comments, the DOCTYPE and processing instructions. No DOM, so a 1 GB file is fine.
export class XmlTags {
  private rest = '';
  private inComment = false;
  // Only tags with these names are given back (all of them when empty), which saves work on
  // the millions of tags nobody needs.
  constructor(private names: Set<string> = new Set()) {}

  push(chunk: string): Tag[] {
    const s = this.rest ? this.rest + chunk : chunk;
    const out: Tag[] = [];
    let i = 0;
    const n = s.length;
    while (i < n) {
      if (this.inComment) {
        const e = s.indexOf('-->', i);
        if (e < 0) {
          i = Math.max(i, n - 2);
          break;
        }
        this.inComment = false;
        i = e + 3;
        continue;
      }
      const lt = s.indexOf('<', i);
      if (lt < 0) {
        i = n;
        break;
      }
      if (s.startsWith('<!--', lt)) {
        this.inComment = true;
        i = lt + 4;
        continue;
      }
      if (lt + 4 > n) {
        i = lt;
        break;
      }
      // Find the end of the tag, stepping over quoted values (which may hold a ">").
      let p = lt + 1;
      let gt = -1;
      while (p < n) {
        const c = s.charCodeAt(p);
        if (c === 62) {
          gt = p;
          break;
        }
        if (c === 34 || c === 39) {
          const q = s.indexOf(c === 34 ? '"' : "'", p + 1);
          if (q < 0) break;
          p = q + 1;
          continue;
        }
        p++;
      }
      if (gt < 0) {
        i = lt;
        break;
      }
      i = gt + 1;
      const first = s.charCodeAt(lt + 1);
      if (first === 33 || first === 63) continue; // <!DOCTYPE …>, <!ELEMENT …>, <?xml …?>
      const close = first === 47;
      const nameStart = close ? lt + 2 : lt + 1;
      let nameEnd = nameStart;
      while (nameEnd < gt) {
        const c = s.charCodeAt(nameEnd);
        if (c === 32 || c === 9 || c === 10 || c === 13 || c === 47 || c === 62) break;
        nameEnd++;
      }
      const name = s.slice(nameStart, nameEnd);
      if (this.names.size && !this.names.has(name)) continue;
      const self = s.charCodeAt(gt - 1) === 47;
      out.push({ name, attrs: close ? '' : s.slice(nameEnd, self ? gt - 1 : gt), close, self });
    }
    this.rest = i < n ? s.slice(i) : '';
    if (this.rest.length > 1 << 20) this.rest = ''; // not XML after all: don't keep it all
    return out;
  }
}

const ATTR_RE = new Map<string, RegExp>();
const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

// The value of one attribute (the first, if a broken export repeats it), entities decoded.
export function attr(attrs: string, name: string): string | undefined {
  let re = ATTR_RE.get(name);
  if (!re) {
    re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`);
    ATTR_RE.set(name, re);
  }
  const m = attrs.match(re);
  if (!m) return undefined;
  const v = m[1] ?? m[2] ?? '';
  return v.includes('&') ? v.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (all, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : all;
    }
    return ENTITIES[e] ?? all;
  }) : v;
}
