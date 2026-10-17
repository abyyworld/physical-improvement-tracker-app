// Reads the objects of a big JSON array a piece of text at a time, so a file of hundreds of
// megabytes never has to be in memory at once. It finds the objects of the top-level array
// ([{…}, {…}]) and of the arrays under the given top-level keys ({"semanticSegments": [{…}]}),
// and parses each one on its own. An object that is broken is skipped, not the whole file.

export interface JsonItem {
  key: string | null; // the top-level key of its array; null for a top-level array
  value: unknown;
}

const QUOTE = 34;
const BACKSLASH = 92;
const OPEN_OBJ = 123;
const CLOSE_OBJ = 125;
const OPEN_ARR = 91;
const CLOSE_ARR = 93;

export class JsonItems {
  private depth = 0;
  private inStr = false;
  private esc = false;
  private rootArray: boolean | null = null; // what the top level is, once seen
  private key = ''; // the last string closed at depth 1 (a top-level key)
  private keyParts: string[] | null = null; // that string while it's being read
  private arrayKey: string | null = null; // the key of the array being read, at depth 2
  private wanted: Set<string>;
  private itemDepth = 0; // depth of the object being collected, 0 when none
  private parts: string[] = []; // its text so far, from earlier pieces
  broken = 0; // objects that couldn't be read

  constructor(keys: string[] = []) {
    this.wanted = new Set(keys);
  }

  push(s: string): JsonItem[] {
    const out: JsonItem[] = [];
    let start = this.itemDepth ? 0 : -1; // where the object being collected starts in s
    let keyStart = this.keyParts ? 0 : -1;
    const n = s.length;
    for (let i = 0; i < n; i++) {
      if (this.inStr) {
        // Jump to the next quote or backslash.
        if (this.esc) {
          this.esc = false;
          continue;
        }
        let j = i;
        for (; j < n; j++) {
          const c = s.charCodeAt(j);
          if (c === QUOTE || c === BACKSLASH) break;
        }
        if (j >= n) {
          i = n;
          break;
        }
        i = j;
        if (s.charCodeAt(i) === BACKSLASH) {
          this.esc = true;
          continue;
        }
        this.inStr = false;
        if (keyStart >= 0) {
          this.key = (this.keyParts ? this.keyParts.join('') : '') + s.slice(keyStart, i);
          this.keyParts = null;
          keyStart = -1;
        }
        continue;
      }
      const c = s.charCodeAt(i);
      if (c === QUOTE) {
        this.inStr = true;
        if (this.depth === 1 && this.rootArray === false) {
          keyStart = i + 1;
          this.keyParts = [];
        }
      } else if (c === OPEN_OBJ || c === OPEN_ARR) {
        if (this.depth === 0) this.rootArray = c === OPEN_ARR;
        this.depth++;
        if (!this.itemDepth) {
          if (this.depth === 2 && this.rootArray === false && c === OPEN_ARR) {
            this.arrayKey = this.wanted.has(this.key) ? this.key : null;
          } else if (c === OPEN_OBJ && ((this.depth === 2 && this.rootArray) || (this.depth === 3 && this.arrayKey !== null))) {
            this.itemDepth = this.depth;
            start = i;
          }
        }
      } else if (c === CLOSE_OBJ || c === CLOSE_ARR) {
        if (this.itemDepth && this.depth === this.itemDepth && c === CLOSE_OBJ) {
          const text = this.parts.length ? this.parts.join('') + s.slice(start, i + 1) : s.slice(start, i + 1);
          this.parts = [];
          this.itemDepth = 0;
          start = -1;
          try {
            out.push({ key: this.rootArray ? null : this.arrayKey, value: JSON.parse(text) });
          } catch {
            this.broken++;
          }
        }
        if (this.depth === 2 && c === CLOSE_ARR) this.arrayKey = null;
        if (this.depth > 0) this.depth--;
      }
    }
    if (this.itemDepth && start >= 0) this.parts.push(s.slice(start));
    if (this.keyParts && keyStart >= 0) this.keyParts.push(s.slice(keyStart));
    return out;
  }

  // Whether the text so far was JSON at all (an object or an array at the top).
  get started(): boolean {
    return this.rootArray !== null;
  }
}
