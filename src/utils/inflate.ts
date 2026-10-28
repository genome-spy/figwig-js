import { Inflate } from 'pako-esm2'
import { check, FigWigError } from './binary.js'

/** A single RFC1950 stream: bounded output, Adler32, and no trailing bytes. */
export function inflateZlib(
  bytes: Uint8Array,
  expected: number,
  limit: number,
): Uint8Array {
  check(
    Number.isSafeInteger(expected) && expected >= 0 && expected <= limit,
    'inflated allocation exceeds maxInflatedBytes',
  )
  check(bytes.length >= 6, 'truncated zlib stream')
  const cmf = bytes[0],
    flg = bytes[1]
  check(
    (cmf & 15) === 8 &&
      cmf >>> 4 <= 7 &&
      ((cmf << 8) + flg) % 31 === 0 &&
      !(flg & 32),
    'invalid or dictionary-dependent zlib header',
  )
  const out = new Uint8Array(expected)
  const inflater = new Inflate({
    raw: true,
    chunkSize: Math.min(65536, expected + 1),
    windowBits: (cmf >>> 4) + 8,
  })
  let count = 0,
    a = 1,
    b = 0
  inflater.onData = (data) => {
    const part = data as Uint8Array
    check(
      count + part.length <= expected,
      'zlib stream expands beyond its declared size',
    )
    out.set(part, count)
    count += part.length
    for (let at = 0; at < part.length; at += 5552) {
      const end = Math.min(part.length, at + 5552)
      let j = at
      // Eight byte updates combined algebraically, without signed bitwise
      // arithmetic. The unchanged 5552-byte window keeps both sums exact.
      for (; j + 8 <= end; j += 8) {
        const x0 = part[j],
          x1 = part[j + 1],
          x2 = part[j + 2],
          x3 = part[j + 3],
          x4 = part[j + 4],
          x5 = part[j + 5],
          x6 = part[j + 6],
          x7 = part[j + 7]
        b +=
          8 * a +
          8 * x0 +
          7 * x1 +
          6 * x2 +
          5 * x3 +
          4 * x4 +
          3 * x5 +
          2 * x6 +
          x7
        a += x0 + x1 + x2 + x3 + x4 + x5 + x6 + x7
      }
      for (; j < end; j++) {
        a += part[j]
        b += a
      }
      a %= 65521
      b %= 65521
    }
  }
  try {
    // The finish flag can accept incomplete DEFLATE in this Pako fork. Let a
    // real end marker finish the stream, then require ended below.
    inflater.push(bytes.subarray(2, -4), false)
  } catch (e) {
    if (e instanceof FigWigError) throw e
    throw new FigWigError('corrupt DEFLATE payload', { cause: e })
  }
  // Raw mode lets us check that one DEFLATE stream consumed the entire payload.
  check(
    inflater.err === 0 &&
      inflater.ended &&
      count === expected &&
      inflater.strm?.next_in === bytes.length - 6,
    'corrupt, truncated, trailing, or wrong-sized zlib stream',
  )
  const checksum = new DataView(
    bytes.buffer,
    bytes.byteOffset + bytes.length - 4,
    4,
  ).getUint32(0)
  check(((b << 16) | a) >>> 0 === checksum, 'zlib Adler-32 mismatch')
  return out
}
