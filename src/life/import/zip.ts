// Reads a zip straight from the file, a slice at a time: the list of what's in it from its
// central directory at the end, then only the entries that are needed, unpacked as they're read.
// Nothing ever holds the whole file, so a 1 GB Apple Health export is fine on a phone.

import { Inflate } from 'fflate';

export interface ZipEntry {
  name: string;
  method: number; // 0 stored, 8 deflate
  flags: number;
  packed: number; // compressed size
  size: number; // unpacked size
  offset: number; // where its local header starts
}

export class ZipError extends Error {
  constructor(public code: 'method' | 'broken') {
    super(code === 'method' ? 'This zip is packed in a way Arise can’t open.' : 'This zip looks broken.');
  }
}

const CHUNK = 1 << 20;
const PACKED_CHUNK = 256 << 10; // packed bytes read from the file at a time…
// …and handed to the unpacker at a time. What one push unpacks comes out as one piece, and
// deflate can unpack to about 1,032 times its size: this keeps a piece under about 17 MB, even
// for a zip made to blow up.
const INFLATE_STEP = 16 << 10;
// A central directory bigger than this, or with more entries, isn't a real export (a Takeout
// with hundreds of thousands of files has well under it): it's broken, or made to use up memory.
const MAX_DIRECTORY = 128 << 20;
const MAX_ENTRIES = 1_000_000;

async function bytes(blob: Blob, start: number, end: number): Promise<Uint8Array> {
  return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u64 = (b: Uint8Array, o: number) => u32(b, o) + u32(b, o + 4) * 2 ** 32;

// Starts like a zip ("PK\3\4", or "PK\5\6" for an empty one).
export async function isZip(blob: Blob): Promise<boolean> {
  if (blob.size < 22) return false;
  const b = await bytes(blob, 0, 4);
  return b[0] === 0x50 && b[1] === 0x4b && ((b[2] === 3 && b[3] === 4) || (b[2] === 5 && b[3] === 6));
}

// What's in the zip, from its central directory.
export async function listZip(blob: Blob): Promise<ZipEntry[]> {
  const tailLen = Math.min(blob.size, 22 + 0xffff);
  const tail = await bytes(blob, blob.size - tailLen, blob.size);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 5 && tail[i + 3] === 6) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('broken');
  let count = u16(tail, eocd + 10);
  let cdSize = u32(tail, eocd + 12);
  let cdOffset = u32(tail, eocd + 16);
  // ZIP64: the real numbers are in a record the locator just before points to.
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const loc = eocd - 20;
    if (loc >= 0 && u32(tail, loc) === 0x07064b50) {
      const at = u64(tail, loc + 8);
      const z = await bytes(blob, at, at + 56);
      if (u32(z, 0) === 0x06064b50) {
        count = u64(z, 32);
        cdSize = u64(z, 40);
        cdOffset = u64(z, 48);
      }
    }
  }
  if (cdSize > MAX_DIRECTORY || cdOffset + cdSize > blob.size) throw new ZipError('broken');
  const cd = await bytes(blob, cdOffset, cdOffset + cdSize);
  const names = new TextDecoder('utf-8');
  const out: ZipEntry[] = [];
  let p = 0;
  for (let n = 0; n < count && p + 46 <= cd.length; n++) {
    if (u32(cd, p) !== 0x02014b50) break;
    const flags = u16(cd, p + 8);
    const method = u16(cd, p + 10);
    let packed = u32(cd, p + 20);
    let size = u32(cd, p + 24);
    const nameLen = u16(cd, p + 28);
    const extraLen = u16(cd, p + 30);
    const commentLen = u16(cd, p + 32);
    let offset = u32(cd, p + 42);
    const name = names.decode(cd.subarray(p + 46, p + 46 + nameLen));
    // ZIP64 extra field: the 8-byte sizes and offset, for the ones that didn't fit.
    let e = p + 46 + nameLen;
    const extraEnd = e + extraLen;
    while (e + 4 <= extraEnd) {
      const id = u16(cd, e);
      const len = u16(cd, e + 2);
      if (id === 1) {
        let q = e + 4;
        if (size === 0xffffffff) (size = u64(cd, q)), (q += 8);
        if (packed === 0xffffffff) (packed = u64(cd, q)), (q += 8);
        if (offset === 0xffffffff) offset = u64(cd, q);
      }
      e += 4 + len;
    }
    if (!name.endsWith('/')) {
      if (out.length >= MAX_ENTRIES) throw new ZipError('broken');
      out.push({ name, method, flags, packed, size, offset });
    }
    p = extraEnd + commentLen;
  }
  return out;
}

// Where an entry's packed data starts (after its local header).
async function dataStart(blob: Blob, entry: ZipEntry): Promise<number> {
  const h = await bytes(blob, entry.offset, entry.offset + 30);
  if (u32(h, 0) !== 0x04034b50) throw new ZipError('broken');
  return entry.offset + 30 + u16(h, 26) + u16(h, 28);
}

// The unpacked bytes of one entry, a piece at a time. `onRead` hears how many packed bytes were
// read, for progress. Stops early (without reading the rest) when the caller stops asking.
export async function* entryBytes(blob: Blob, entry: ZipEntry, onRead?: (n: number) => void, limit = Infinity): AsyncGenerator<Uint8Array> {
  if (entry.flags & 1) throw new ZipError('method'); // encrypted
  if (entry.method !== 0 && entry.method !== 8) throw new ZipError('method');
  const start = await dataStart(blob, entry);
  const end = start + entry.packed;
  if (end > blob.size) throw new ZipError('broken');
  // Only the start wanted: small reads, so looking at thousands of entries stays quick.
  const step = limit < Infinity ? 16 << 10 : 0;
  if (entry.method === 0) {
    for (let at = start; at < end && at - start < limit; at += step || CHUNK) {
      const b = await bytes(blob, at, Math.min(end, at + (step || CHUNK)));
      onRead?.(b.length);
      yield b;
    }
    return;
  }
  const ready: Uint8Array[] = [];
  const inflate = new Inflate((chunk) => {
    if (chunk.length) ready.push(chunk);
  });
  let out = 0;
  for (let at = start; at < end; at += step || PACKED_CHUNK) {
    const stop = Math.min(end, at + (step || PACKED_CHUNK));
    const b = await bytes(blob, at, stop);
    onRead?.(b.length);
    for (let i = 0; i < b.length; i += INFLATE_STEP) {
      try {
        inflate.push(b.subarray(i, i + INFLATE_STEP), stop >= end && i + INFLATE_STEP >= b.length);
      } catch {
        throw new ZipError('broken');
      }
      while (ready.length) {
        const c = ready.shift()!;
        out += c.length;
        // More than the zip says the entry holds: broken, or made to blow up. Stop here.
        if (out > entry.size) throw new ZipError('broken');
        yield c;
      }
      if (out >= limit) return;
    }
  }
}

// The first `n` unpacked bytes of an entry (to see what it is).
export async function entryHead(blob: Blob, entry: ZipEntry, n = 8192): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let got = 0;
  for await (const c of entryBytes(blob, entry, undefined, n)) {
    parts.push(c);
    got += c.length;
    if (got >= n) break;
  }
  const out = new Uint8Array(Math.min(got, n));
  let p = 0;
  for (const c of parts) {
    const take = Math.min(c.length, out.length - p);
    out.set(c.subarray(0, take), p);
    p += take;
    if (p >= out.length) break;
  }
  return out;
}
