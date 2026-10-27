import { Inflate } from 'pako/lib/inflate.js'
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
      for (let j = at; j < end; j++) {
        a += part[j]
        b += a
      }
      a %= 65521
      b %= 65521
    }
  }
  try {
    inflater.push(bytes.subarray(2, -4), true)
  } catch (e) {
    if (e instanceof FigWigError) throw e
    throw new FigWigError('corrupt DEFLATE payload', { cause: e })
  }
  // Pako's raw inflater exposes the zlib stream state. Raw mode prevents its
  // wrapper from automatically accepting concatenated zlib streams.
  const state = inflater as unknown as {
    ended: boolean
    strm: { next_in: number }
  }
  check(
    !inflater.err &&
      state.ended &&
      count === expected &&
      state.strm.next_in === bytes.length - 6,
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
