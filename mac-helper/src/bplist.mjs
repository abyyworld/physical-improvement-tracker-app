// Reads Apple's binary property lists ("bplist00"), which is how macOS keeps each notification's
// title, subtitle and body. Small and strict: anything out of bounds throws, nothing is executed.
//
// Values come back as plain JavaScript: null, booleans, numbers (bigint past 2^53), strings,
// Uint8Array for data, Date for dates, arrays, plain objects for dictionaries, and { UID: n } for
// the references keyed archives use.

const MAX_DEPTH = 64;

export class PlistError extends Error {}

/** @param {Uint8Array} input */
export function parseBplist(input) {
  const buf = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (buf.length < 40 || String.fromCharCode(...buf.subarray(0, 6)) !== 'bplist') throw new PlistError('Not a binary plist');
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const t = buf.length - 32;
  const offsetSize = buf[t + 6];
  const refSize = buf[t + 7];
  const count = num(view, t + 8, 8);
  const top = num(view, t + 16, 8);
  const tableAt = num(view, t + 24, 8);
  if (![1, 2, 4, 8].includes(offsetSize) || ![1, 2, 4, 8].includes(refSize)) throw new PlistError('Bad trailer');
  if (count < 1 || top >= count || tableAt + count * offsetSize > t) throw new PlistError('Bad offset table');

  const offsetOf = (i) => {
    if (i >= count) throw new PlistError('Bad object reference');
    const o = num(view, tableAt + i * offsetSize, offsetSize);
    if (o < 8 || o >= tableAt) throw new PlistError('Bad object offset');
    return o;
  };
  const inside = (at, n) => {
    if (at < 0 || n < 0 || at + n > tableAt) throw new PlistError('Object runs past the end');
  };

  const read = (i, depth, path) => {
    if (depth > MAX_DEPTH || path.includes(i)) throw new PlistError('Too deep or circular');
    const at = offsetOf(i);
    const marker = buf[at];
    const type = marker >> 4;
    const info = marker & 0x0f;
    // Length of a container or string: in the marker, or an int object right after it.
    const length = () => {
      if (info !== 0x0f) return { n: info, start: at + 1 };
      const m = buf[at + 1];
      if (m >> 4 !== 0x1) throw new PlistError('Bad length');
      const size = 1 << (m & 0x0f);
      inside(at + 2, size);
      return { n: num(view, at + 2, size), start: at + 2 + size };
    };
    switch (type) {
      case 0x0:
        if (marker === 0x00) return null;
        if (marker === 0x08) return false;
        if (marker === 0x09) return true;
        throw new PlistError('Unknown simple value');
      case 0x1: {
        const size = 1 << info;
        inside(at + 1, size);
        if (size === 8) {
          const v = view.getBigInt64(at + 1);
          return v >= Number.MIN_SAFE_INTEGER && v <= Number.MAX_SAFE_INTEGER ? Number(v) : v;
        }
        if (size === 16) {
          // 128-bit ints only hold unsigned 64-bit values in practice: the low half.
          const v = view.getBigUint64(at + 9);
          return v <= Number.MAX_SAFE_INTEGER ? Number(v) : v;
        }
        return num(view, at + 1, size);
      }
      case 0x2: {
        const size = 1 << info;
        inside(at + 1, size);
        if (size === 4) return view.getFloat32(at + 1);
        if (size === 8) return view.getFloat64(at + 1);
        throw new PlistError('Bad real');
      }
      case 0x3:
        if (marker !== 0x33) throw new PlistError('Bad date');
        inside(at + 1, 8);
        return new Date((view.getFloat64(at + 1) + 978307200) * 1000);
      case 0x4: {
        const { n, start } = length();
        inside(start, n);
        return buf.slice(start, start + n);
      }
      case 0x5: {
        const { n, start } = length();
        inside(start, n);
        let s = '';
        for (let k = 0; k < n; k++) s += String.fromCharCode(buf[start + k]);
        return s;
      }
      case 0x6: {
        const { n, start } = length();
        inside(start, n * 2);
        let s = '';
        for (let k = 0; k < n; k++) s += String.fromCharCode(view.getUint16(start + k * 2));
        return s;
      }
      case 0x7: {
        const { n, start } = length();
        inside(start, n);
        return new TextDecoder().decode(buf.subarray(start, start + n));
      }
      case 0x8: {
        inside(at + 1, info + 1);
        return { UID: num(view, at + 1, info + 1) };
      }
      case 0xa:
      case 0xb:
      case 0xc: {
        const { n, start } = length();
        inside(start, n * refSize);
        const out = [];
        for (let k = 0; k < n; k++) out.push(read(num(view, start + k * refSize, refSize), depth + 1, [...path, i]));
        return out;
      }
      case 0xd: {
        const { n, start } = length();
        inside(start, n * refSize * 2);
        const out = Object.create(null);
        for (let k = 0; k < n; k++) {
          const key = read(num(view, start + k * refSize, refSize), depth + 1, [...path, i]);
          if (typeof key !== 'string') throw new PlistError('Dictionary key is not a string');
          out[key] = read(num(view, start + (n + k) * refSize, refSize), depth + 1, [...path, i]);
        }
        return out;
      }
      default:
        throw new PlistError('Unknown object type');
    }
  };
  return read(top, 0, []);
}

// An unsigned big-endian number of 1, 2, 4 or 8 bytes. Offsets past 2^53 can't be real.
function num(view, at, size) {
  if (at < 0 || at + size > view.byteLength) throw new PlistError('Number runs past the end');
  if (size === 1) return view.getUint8(at);
  if (size === 2) return view.getUint16(at);
  if (size === 4) return view.getUint32(at);
  if (size === 8) {
    const v = view.getBigUint64(at);
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new PlistError('Number too big');
    return Number(v);
  }
  // 3-byte UIDs and the like.
  let v = 0;
  for (let k = 0; k < size; k++) v = v * 256 + view.getUint8(at + k);
  return v;
}
