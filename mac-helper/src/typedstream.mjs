// The text of a message from Messages' attributedBody column. On recent macOS the plain `text`
// column is often empty and the words only live there, as an NSAttributedString saved in Apple's
// old "typedstream" format. Its string sits right after the NSString class name:
//   ... "NSString" 0x01 0x94 0x84 0x01 '+' <length> <UTF-8 bytes> ...
// where <length> is one byte below 0x80, or 0x81 and 2 bytes, or 0x82 and 4 bytes (little-endian,
// like the format's own header, 0x81 0xe8 0x03 = 1000).

const NSSTRING = Array.from('NSString', (c) => c.charCodeAt(0));
const START = [0x84, 0x01, 0x2b]; // a new object of one value, a C string ('+')

function find(buf, needle, from = 0, to = buf.length) {
  const end = Math.min(to, buf.length) - needle.length;
  outer: for (let i = Math.max(0, from); i <= end; i++) {
    for (let k = 0; k < needle.length; k++) if (buf[i + k] !== needle[k]) continue outer;
    return i;
  }
  return -1;
}

/** @param {Uint8Array | null | undefined} input */
export function attributedText(input) {
  if (!input || !input.length) return '';
  const buf = input instanceof Uint8Array ? input : new Uint8Array(input);
  const cls = find(buf, NSSTRING);
  if (cls < 0) return '';
  let at = find(buf, START, cls + NSSTRING.length, cls + NSSTRING.length + 16);
  if (at < 0) return '';
  at += START.length;
  let n = buf[at];
  if (n === undefined) return '';
  if (n === 0x81) {
    if (at + 3 > buf.length) return '';
    n = buf[at + 1] | (buf[at + 2] << 8);
    at += 3;
  } else if (n === 0x82) {
    if (at + 5 > buf.length) return '';
    n = (buf[at + 1] | (buf[at + 2] << 8) | (buf[at + 3] << 16)) + buf[at + 4] * 2 ** 24;
    at += 5;
  } else if (n < 0x80) {
    at += 1;
  } else {
    return '';
  }
  const text = new TextDecoder().decode(buf.subarray(at, Math.min(buf.length, at + n)));
  // U+FFFC marks where an attachment (a photo, a sticker) sat in the message.
  return text.replace(/￼/g, '').trim();
}
