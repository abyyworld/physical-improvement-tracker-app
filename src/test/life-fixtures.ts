// Helpers for the importer tests: text in pieces of any size, events collected from a parser,
// and zips made on the fly.

import { zipSync, strToU8 } from 'fflate';
import type { LifeEvent } from '../life/types';
import type { TextInput } from '../life/import/types';

// The text in pieces of `size` characters (so every boundary gets tested), or of varying sizes.
export async function* pieces(text: string, size: number | 'random' = 'random'): AsyncGenerator<string> {
  let seed = 7;
  const next = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return 1 + (seed % 97);
  };
  for (let i = 0; i < text.length; ) {
    const n = size === 'random' ? next() : size;
    yield text.slice(i, i + n);
    i += n;
  }
}

export const input = (name: string, text: string, size: number | 'random' = 'random'): TextInput => ({ name, text: pieces(text, size) });

// Every batch a parser gives, and all its events.
export async function run(gen: AsyncGenerator<LifeEvent[]>): Promise<{ batches: LifeEvent[][]; events: LifeEvent[] }> {
  const batches: LifeEvent[][] = [];
  for await (const b of gen) batches.push(b);
  return { batches, events: batches.flat() };
}

export const titles = (events: LifeEvent[]) => events.map((e) => e.title);

// A zip of these files. `store` keeps them unpacked (method 0).
export function zipBytes(files: Record<string, string | Uint8Array>, opts: { store?: boolean } = {}): Uint8Array<ArrayBuffer> {
  const data: Record<string, [Uint8Array, { level: 0 | 6 }]> = {};
  for (const [name, v] of Object.entries(files)) data[name] = [typeof v === 'string' ? strToU8(v) : v, { level: opts.store ? 0 : 6 }];
  return new Uint8Array(zipSync(data));
}

export const zipBlob = (files: Record<string, string | Uint8Array>, opts: { store?: boolean } = {}): Blob => new Blob([zipBytes(files, opts)]);

// The same zip, with its central directory saying something else about one entry: a packed
// size that cuts its data short (a damaged download), or an unpacked size that's a lie.
export function patchZip(zip: Uint8Array, name: string, change: { packed?: number; size?: number }): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(zip);
  const v = new DataView(out.buffer);
  for (let p = 0; p + 46 <= out.length; p++) {
    if (v.getUint32(p, true) !== 0x02014b50) continue;
    const len = v.getUint16(p + 28, true);
    if (new TextDecoder().decode(out.subarray(p + 46, p + 46 + len)) !== name) continue;
    if (change.packed !== undefined) v.setUint32(p + 20, change.packed, true);
    if (change.size !== undefined) v.setUint32(p + 24, change.size, true);
    return out;
  }
  throw new Error(`${name} is not in the zip`);
}

export const fileOf = (parts: BlobPart[], name: string) => new File(parts, name);

// Every event has the shape the life log expects.
export function wellFormed(e: LifeEvent): boolean {
  return (
    typeof e.id === 'string' &&
    e.id.startsWith(`${e.source}:`) &&
    Number.isFinite(e.at) &&
    (e.end === undefined || (Number.isFinite(e.end) && e.end >= e.at)) &&
    typeof e.title === 'string' &&
    e.title.length > 0 &&
    e.title.length <= 320 &&
    [1, 2, 3].includes(e.tier) &&
    (e.value === undefined || Number.isFinite(e.value))
  );
}
