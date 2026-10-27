import { describe, expect, it } from 'vitest'
import { constants, deflateRawSync, deflateSync, gzipSync } from 'node:zlib'
import { inflateZlib } from '../src/utils/inflate.js'
import { crc, crc32, FigWigError } from '../src/utils/binary.js'

const text = new TextEncoder().encode(
  'Figwig v1 zlib payload: genomic signals, zeros, and NaNs.\n'.repeat(300),
)

function concatenate(...parts: Uint8Array[]) {
  const bytes = new Uint8Array(
    parts.reduce((size, part) => size + part.length, 0),
  )
  let offset = 0
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.length
  }
  return bytes
}

describe('strict RFC1950 decompression', () => {
  it.each([0, 1, 6, 9] as const)(
    'reads zlib streams written by Node zlib at level %s',
    (level) => {
      const compressed = deflateSync(text, { level })
      expect(inflateZlib(compressed, text.length, text.length)).toEqual(text)
    },
  )

  it.each([
    constants.Z_DEFAULT_STRATEGY,
    constants.Z_FIXED,
    constants.Z_HUFFMAN_ONLY,
    constants.Z_RLE,
  ])('supports DEFLATE strategy %s', (strategy) => {
    expect(
      inflateZlib(deflateSync(text, { strategy }), text.length, text.length),
    ).toEqual(text)
  })

  it('accepts an empty stream and checks its Adler32', () => {
    const compressed = deflateSync(new Uint8Array())
    expect(inflateZlib(compressed, 0, 0)).toEqual(new Uint8Array())
    compressed[compressed.length - 1] ^= 1
    expect(() => inflateZlib(compressed, 0, 0)).toThrow(/Adler-32/)
  })

  it('handles chunk boundaries and Adler reduction boundaries in a larger stream', () => {
    const data = Uint8Array.from(
      { length: 2 * 1024 * 1024 + 5553 },
      (_, i) => (i * 37 + Math.floor(i / 5552)) & 255,
    )
    expect(inflateZlib(deflateSync(data), data.length, data.length)).toEqual(
      data,
    )
  })

  it('reads a zlib stream from an unaligned input view', () => {
    const compressed = deflateSync(text)
    const container = new Uint8Array(compressed.length + 3)
    container.set(compressed, 3)
    expect(
      inflateZlib(container.subarray(3), text.length, text.length),
    ).toEqual(text)
  })

  it('rejects header checksums, unsupported methods, windows, and preset dictionaries', () => {
    const compressed = Uint8Array.from(deflateSync(text))
    compressed[1] ^= 1
    expect(() => inflateZlib(compressed, text.length, text.length)).toThrow(
      /zlib header/,
    )
    expect(() =>
      inflateZlib(new Uint8Array([0x79, 0x18, 0, 0, 0, 1]), 0, 0),
    ).toThrow(/zlib header/)
    expect(() =>
      inflateZlib(new Uint8Array([0x88, 0x1c, 0, 0, 0, 1]), 0, 0),
    ).toThrow(/zlib header/)
    const dictionary = new TextEncoder().encode('genomic signals')
    const withDictionary = deflateSync(text, { dictionary })
    expect(() => inflateZlib(withDictionary, text.length, text.length)).toThrow(
      /dictionary-dependent/,
    )
  })

  it('rejects raw DEFLATE and gzip wrappers', () => {
    expect(() =>
      inflateZlib(deflateRawSync(text), text.length, text.length),
    ).toThrow(/zlib/)
    expect(() => inflateZlib(gzipSync(text), text.length, text.length)).toThrow(
      /zlib/,
    )
  })

  it('validates Adler32 independently of successful DEFLATE decoding', () => {
    const compressed = Uint8Array.from(deflateSync(text))
    compressed[compressed.length - 1] ^= 1
    expect(() => inflateZlib(compressed, text.length, text.length)).toThrow(
      /Adler-32 mismatch/,
    )
  })

  it('rejects trailing bytes, concatenated streams, and bytes inserted before Adler32', () => {
    const compressed = deflateSync(text)
    const trailing = concatenate(compressed, new Uint8Array([0]))
    const concatenated = concatenate(compressed, deflateSync(new Uint8Array()))
    const beforeChecksum = concatenate(
      compressed.subarray(0, -4),
      new Uint8Array([0]),
      compressed.subarray(-4),
    )
    for (const bytes of [trailing, concatenated, beforeChecksum]) {
      expect(() => inflateZlib(bytes, text.length, text.length)).toThrow(
        /trailing/,
      )
    }
  })

  it('rejects every truncation of a zlib stream', () => {
    const data = new TextEncoder().encode('abc123abc123abc123')
    const compressed = deflateSync(data)
    for (let length = 0; length < compressed.length; length++) {
      expect(() =>
        inflateZlib(compressed.subarray(0, length), data.length, data.length),
      ).toThrow(FigWigError)
    }
  })

  it('rejects corrupt DEFLATE bytes', () => {
    const compressed = Uint8Array.from(deflateSync(text))
    // BTYPE=3 is a reserved DEFLATE block type regardless of the payload.
    compressed[2] = (compressed[2] & ~6) | 6
    expect(() => inflateZlib(compressed, text.length, text.length)).toThrow(
      /corrupt/,
    )
  })

  it('requires the exact declared output size', () => {
    const compressed = deflateSync(text)
    expect(() => inflateZlib(compressed, text.length - 1, text.length)).toThrow(
      /declared size/,
    )
    expect(() =>
      inflateZlib(compressed, text.length + 1, text.length + 1),
    ).toThrow(/wrong-sized/)
    expect(() => inflateZlib(compressed, 0, 0)).toThrow(/declared size/)
  })

  it('checks the allocation budget before decompression', () => {
    const compressed = deflateSync(text)
    for (const expected of [
      -1,
      1.5,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
      text.length,
    ]) {
      expect(() => inflateZlib(compressed, expected, text.length - 1)).toThrow(
        /maxInflatedBytes/,
      )
    }
  })

  it('stops a highly compressible expansion when its claimed size is too small', () => {
    const compressed = deflateSync(new Uint8Array(4 * 1024 * 1024))
    expect(compressed.length).toBeLessThan(5000)
    expect(() => inflateZlib(compressed, 1024, 1024)).toThrow(/declared size/)
  })
})

describe('Figwig CRC-32', () => {
  it('matches the standard reflected CRC32 check vector', () => {
    const bytes = new TextEncoder().encode('123456789')
    expect(crc32(bytes)).toBe(0xcbf43926)
    expect(crc32(new Uint8Array())).toBe(0)
    expect(() => crc(bytes, 0xcbf43926, 'index')).not.toThrow()
    expect(() => crc(bytes, 0xcbf43927, 'index')).toThrow(
      /index CRC-32 mismatch/,
    )
  })
})
