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
export function zipBlob(files: Record<string, string | Uint8Array>, opts: { store?: boolean } = {}): Blob {
  const data: Record<string, [Uint8Array, { level: 0 | 6 }]> = {};
  for (const [name, v] of Object.entries(files)) data[name] = [typeof v === 'string' ? strToU8(v) : v, { level: opts.store ? 0 : 6 }];
  return new Blob([new Uint8Array(zipSync(data))]);
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
