import { describe, expect, it } from 'vitest'
import {
  decodeBlock,
  decodeChunk,
  validateKind,
} from '../src/decoding/chunk.js'

function bytes(length: number): { bytes: Uint8Array; view: DataView } {
  const result = new Uint8Array(Math.ceil(length / 8) * 8)
  return { bytes: result, view: new DataView(result.buffer) }
}

describe('numeric payload decoding', () => {
  const types: [
    number,
    number,
    number,
    (view: DataView, at: number, value: number) => void,
  ][] = [
    [0, 1, 255, (view, at, value) => view.setUint8(at, value)],
    [1, 2, 65_535, (view, at, value) => view.setUint16(at, value, true)],
    [2, 4, 4_294_967_295, (view, at, value) => view.setUint32(at, value, true)],
    [3, 1, -128, (view, at, value) => view.setInt8(at, value)],
    [4, 2, -32_768, (view, at, value) => view.setInt16(at, value, true)],
    [5, 4, -2_147_483_648, (view, at, value) => view.setInt32(at, value, true)],
    [6, 4, 1.25, (view, at, value) => view.setFloat32(at, value, true)],
    [
      8,
      8,
      1.0000000000000002,
      (view, at, value) => view.setFloat64(at, value, true),
    ],
  ]

  for (const [code, width, value, write] of types) {
    it(`decodes element code ${code} exactly in dense tiles and blocks`, () => {
      const dense = bytes(2 * 16 * width)
      write(dense.view, 0, value)
      write(dense.view, 16 * width, value)
      const decoded = decodeChunk(dense.bytes, 1 | (code << 3), 2, 16)
      expect(decoded.tracks).toHaveLength(2)
      expect(decoded.tracks[0]!.values[0]).toBe(value)
      expect(decoded.tracks[1]!.values[0]).toBe(value)
      expect(decoded.tracks[0]!.offsets).toBeUndefined()
      expect(decoded.byteLength).toBe(2 * 16 * 8)

      const block = bytes(8 + width)
      block.view.setUint32(0, 0xffff_ffff, true)
      write(block.view, 8, value)
      const blockResult = decodeBlock(
        block.bytes,
        1 | (code << 3),
        1,
        0xffff_ffff,
        0xffff_ffff,
      )
      expect([...blockResult.tracks[0]!.offsets!]).toEqual([0xffff_ffff])
      expect(blockResult.tracks[0]!.values[0]).toBe(value)
    })
  }

  it('decodes sparse implicit-one offsets spanning three varint bytes', () => {
    const payload = bytes(20)
    payload.view.setUint32(0, 3, true)
    payload.view.setUint32(4, 6, true)
    payload.view.setUint32(8, 0, true)
    payload.bytes.set([0, 0xff, 0x7f, 0x80, 0x80, 0x01], 12)
    const decoded = decodeChunk(payload.bytes, 2 | (7 << 3), 2, 65_536)
    expect([...decoded.tracks[0]!.offsets!]).toEqual([0, 16_383, 32_767])
    expect([...decoded.tracks[0]!.values]).toEqual([1, 1, 1])
    expect(decoded.tracks[1]!.values).toHaveLength(0)
    expect(decoded.byteLength).toBe(36)
  })

  it('keeps runs sparse and preserves zero changes and NaNs', () => {
    const payload = bytes(12 + 4 * 4)
    payload.view.setUint32(0, 4, true)
    payload.view.setUint32(4, 4, true)
    payload.bytes.set([0, 4, 4, 4], 8)
    for (const [index, value] of [3, NaN, 0, 2.5].entries())
      payload.view.setFloat32(12 + index * 4, value, true)
    const decoded = decodeChunk(payload.bytes, 4 | (6 << 3), 1, 16)
    expect(decoded.tracks[0]!.runs).toBe(true)
    expect([...decoded.tracks[0]!.offsets!]).toEqual([0, 4, 8, 12])
    expect([...decoded.tracks[0]!.values]).toEqual([3, NaN, 0, 2.5])
  })

  it('uses unaligned float64 reads in sparse payloads', () => {
    const payload = bytes(20)
    payload.view.setUint32(0, 1, true)
    payload.view.setUint32(4, 1, true)
    payload.bytes[8] = 3
    payload.view.setFloat64(12, Math.PI, true)
    const decoded = decodeChunk(payload.bytes, 2 | (8 << 3), 1, 16)
    expect([...decoded.tracks[0]!.offsets!]).toEqual([3])
    expect(decoded.tracks[0]!.values[0]).toBe(Math.PI)
  })

  it('decodes matrix entries with absent and empty present tracks', () => {
    const payload = bytes(40)
    payload.view.setUint32(0, 3, true)
    payload.view.setUint32(4, 0, true)
    payload.view.setUint32(8, 2, true)
    payload.view.setUint32(12, 3, true)
    for (const [index, pointer] of [0, 2, 2, 3].entries())
      payload.view.setUint32(16 + index * 4, pointer, true)
    for (const [index, offset] of [3, 9, 15].entries())
      payload.view.setUint16(32 + index * 2, offset, true)
    const decoded = decodeChunk(payload.bytes, 3 | (7 << 3), 5, 16)
    expect([...decoded.tracks[0]!.offsets!]).toEqual([3, 9])
    expect([...decoded.tracks[0]!.values]).toEqual([1, 1])
    expect(decoded.tracks[1]!.values).toHaveLength(0)
    expect(decoded.tracks[2]!.values).toHaveLength(0)
    expect([...decoded.tracks[3]!.offsets!]).toEqual([15])
    expect(decoded.tracks[4]!.values).toHaveLength(0)
    expect(decoded.byteLength).toBe(36)
  })

  it('accepts blocks with implicit-one values', () => {
    const payload = bytes(8)
    payload.view.setUint32(0, 10, true)
    payload.view.setUint32(4, 300, true)
    const decoded = decodeBlock(payload.bytes, 1 | (7 << 3), 2, 10, 300)
    expect([...decoded.tracks[0]!.values]).toEqual([1, 1])
  })

  it('supports input Uint8Array views with unaligned byte offsets', () => {
    const backing = new Uint8Array(17)
    const payload = backing.subarray(1)
    payload[0] = 7
    expect(decodeChunk(payload, 1, 1, 16).tracks[0]!.values[0]).toBe(7)
  })
})

describe('corrupt payloads', () => {
  it.each([0, 5, 6, 7, 255, 1 | (9 << 3), -1, 256, 1.5])(
    'rejects kind byte %s',
    (kind) => {
      expect(() => validateKind(kind)).toThrow(/Corrupt Figwig/)
    },
  )

  it('validates stored bits and implicit-one restrictions', () => {
    expect(validateKind(129, false, 1)).toEqual({
      kind: 1,
      code: 0,
      width: 1,
      stored: true,
    })
    expect(() => validateKind(129, false, 0)).toThrow(/stored bit/)
    expect(() => validateKind(129, true)).toThrow(/stored bit/)
    expect(() => validateKind(2, true)).toThrow(/block/)
    expect(() => validateKind(1 | (7 << 3))).toThrow(/implicit-one/)
    expect(() => validateKind(4 | (7 << 3))).toThrow(/implicit-one/)
  })

  it('rejects impossible dimensions and short payloads', () => {
    expect(() => decodeChunk(new Uint8Array(16), 1, 0, 16)).toThrow(
      /track count/,
    )
    expect(() => decodeChunk(new Uint8Array(16), 1, 1, 17)).toThrow(/tile size/)
    expect(() => decodeChunk(new Uint8Array(16), 1, 2 ** 29, 16)).toThrow(
      /track count/,
    )
    expect(() => decodeChunk(new Uint8Array(1), 1, 1, 16)).toThrow(
      /multiple of 8/,
    )
    expect(() => decodeChunk(new Uint8Array(8), 1, 1, 16)).toThrow(/truncated/)
    expect(() => decodeChunk(new Uint8Array(8), 3, 2, 16)).not.toThrow()
  })

  it('rejects infinite values but preserves NaNs', () => {
    const payload = bytes(16 * 4)
    payload.view.setFloat32(0, NaN, true)
    expect(
      decodeChunk(payload.bytes, 1 | (6 << 3), 1, 16).tracks[0]!.values[0],
    ).toBeNaN()
    payload.view.setFloat32(0, Infinity, true)
    expect(() => decodeChunk(payload.bytes, 1 | (6 << 3), 1, 16)).toThrow(
      /infinite/,
    )
  })

  it('limits decoded allocations independently of payload bytes', () => {
    // A 16-byte uint8 payload expands to a 128-byte numeric buffer.
    expect(() => decodeChunk(new Uint8Array(16), 1, 1, 16, 127)).toThrow(
      /maxDecodedBytes/,
    )
    expect(() => decodeChunk(new Uint8Array(16), 1, 1, 16, 128)).not.toThrow()
    const sparse = bytes(16)
    sparse.view.setUint32(0, 1, true)
    sparse.view.setUint32(4, 1, true)
    expect(() => decodeChunk(sparse.bytes, 57 + 1, 1, 16, 11)).toThrow(
      /maxDecodedBytes/,
    )
    expect(() => decodeBlock(new Uint8Array(8), 57, 1, 0, 0, 11)).toThrow(
      /maxDecodedBytes/,
    )
  })

  it.each([
    { name: 'matrix', kind: 3, length: 8 },
    { name: 'sparse', kind: 2 | (7 << 3), length: 24 },
  ])(
    'bounds per-track allocation for empty $name chunks',
    ({ kind, length }) => {
      const payload = new Uint8Array(length)
      // Numeric storage is empty, but five track descriptors/views still need
      // a meaningful allocation budget. Sparse chunks also have lengths workspace.
      expect(() => decodeChunk(payload, kind, 5, 16, 512)).toThrow(
        /maxDecodedBytes/,
      )
      const decoded = decodeChunk(payload, kind, 5, 16, 640)
      expect(decoded.tracks).toHaveLength(5)
      expect(decoded.byteLength).toBe(0)
      expect(decoded.tracks.every((track) => track.values.length === 0)).toBe(
        true,
      )
    },
  )

  it('bounds track-order descriptor allocation for tiny blocks', () => {
    const payload = new Uint8Array(8)
    expect(() => decodeBlock(payload, 57, 1, 0, 0, 127)).toThrow(
      /maxDecodedBytes/,
    )
    const decoded = decodeBlock(payload, 57, 1, 0, 0, 128)
    expect([...decoded.tracks[0].values]).toEqual([1])
    expect(decoded.byteLength).toBe(12)
  })

  it('rejects duplicate sparse offsets and unterminated varints', () => {
    const payload = bytes(16)
    payload.view.setUint32(0, 2, true)
    payload.view.setUint32(4, 2, true)
    payload.bytes.set([3, 0], 8)
    expect(() => decodeChunk(payload.bytes, 2 | (7 << 3), 1, 16)).toThrow(
      /strictly ascend/,
    )
    payload.view.setUint32(0, 1, true)
    payload.view.setUint32(4, 1, true)
    payload.bytes[8] = 128
    expect(() => decodeChunk(payload.bytes, 2 | (7 << 3), 1, 16)).toThrow(
      /varint/,
    )
    payload.view.setUint32(4, 3, true)
    payload.bytes.set([128, 128, 128], 8)
    expect(() => decodeChunk(payload.bytes, 2 | (7 << 3), 1, 16)).toThrow(
      /three bytes/,
    )
  })

  it('rejects incorrect sparse counts and offsets outside the tile', () => {
    const payload = bytes(16)
    payload.view.setUint32(0, 1, true)
    payload.view.setUint32(4, 1, true)
    payload.bytes[8] = 16
    expect(() => decodeChunk(payload.bytes, 2 | (7 << 3), 1, 16)).toThrow(
      /out of bounds/,
    )
    payload.view.setUint32(0, 100_000_000, true)
    expect(() => decodeChunk(payload.bytes, 2 | (7 << 3), 1, 16)).toThrow(
      /too many/,
    )
    payload.view.setUint32(0, 2, true)
    expect(() => decodeChunk(payload.bytes, 2 | (7 << 3), 1, 16)).toThrow(
      /byte lengths/,
    )
    payload.view.setUint32(0, 1, true)
    payload.view.setUint32(4, 2, true)
    payload.bytes.set([128, 0], 8)
    expect(() => decodeChunk(payload.bytes, 2 | (7 << 3), 1, 16)).not.toThrow()
  })

  it('rejects invalid matrix slots, pointers, and offsets', () => {
    const payload = bytes(24)
    payload.view.setUint32(0, 1, true)
    payload.view.setUint32(4, 1, true)
    payload.view.setUint32(8, 0, true)
    payload.view.setUint32(12, 1, true)
    payload.view.setUint16(16, 3, true)
    expect(() => decodeChunk(payload.bytes, 3 | (7 << 3), 1, 16)).toThrow(
      /slots/,
    )
    payload.view.setUint32(4, 0, true)
    payload.view.setUint32(8, 1, true)
    expect(() => decodeChunk(payload.bytes, 3 | (7 << 3), 1, 16)).toThrow(
      /first pointer/,
    )
    payload.view.setUint32(8, 0, true)
    payload.view.setUint16(16, 16, true)
    expect(() => decodeChunk(payload.bytes, 3 | (7 << 3), 1, 16)).toThrow(
      /offsets/,
    )
    payload.view.setUint32(0, 2, true)
    expect(() => decodeChunk(payload.bytes, 3 | (7 << 3), 1, 16)).toThrow(
      /too many present/,
    )
  })

  it('rejects block counts, duplicate positions, and mismatched endpoints', () => {
    const payload = bytes(8)
    expect(() => decodeBlock(payload.bytes, 57, 0, 0, 0)).toThrow(/entry count/)
    expect(() => decodeBlock(payload.bytes, 57, 65_537, 0, 0)).toThrow(
      /entry count/,
    )
    expect(() => decodeBlock(payload.bytes, 57, 2, 0, 0)).toThrow(
      /strictly ascend/,
    )
    payload.view.setUint32(4, 1, true)
    expect(() => decodeBlock(payload.bytes, 57, 2, 0, 2)).toThrow(
      /index record/,
    )
  })
})
