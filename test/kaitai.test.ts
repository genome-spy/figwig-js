import { readFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { describe, expect, test } from 'vitest'
import { parse, ParseStream } from '../src/kaitai/parse.js'
import { parseFixed, parseTables } from '../src/format/header.js'
import { parseSummary } from '../src/format/group.js'
import { decodeBlock, decodeChunk } from '../src/decoding/chunk.js'

function uint64(value: bigint) {
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setBigUint64(0, value, true)
  return bytes
}

function chromosome(name: Uint8Array) {
  const bytes = new Uint8Array(2 + name.length + 8)
  const view = new DataView(bytes.buffer)
  view.setUint16(0, name.length, true)
  bytes.set(name, 2)
  view.setBigUint64(2 + name.length, 100n, true)
  return bytes
}

describe('Kaitai integration boundaries', () => {
  test('generated uint64 readers preserve the largest safe integer', () => {
    const result = parse<{ offsets: number[] }>(
      'Directory',
      new ParseStream(uint64(BigInt(Number.MAX_SAFE_INTEGER))),
      1,
    )
    expect(result.offsets).toEqual([Number.MAX_SAFE_INTEGER])
  })

  test.each([2n ** 53n, 2n ** 53n + 1n, 2n ** 64n - 1n])(
    'generated uint64 readers reject %s before lossy number conversion',
    (value) => {
      const stream = new ParseStream(uint64(value))
      expect(() => parse('Directory', stream, 1)).toThrow(/MAX_SAFE_INTEGER/)
      expect(stream.pos).toBe(0)
    },
  )

  test('generated readers respect a fetched subarray rather than its backing buffer', () => {
    const backing = new Uint8Array(32).fill(0xff)
    new DataView(backing.buffer).setUint32(7, 0x12345678, true)
    const stream = new ParseStream(backing.subarray(7, 11))
    expect(parse<{ values: number[] }>('U32Array', stream, 1).values).toEqual([
      0x12345678,
    ])
    expect(stream.size).toBe(4)
    expect(stream.pos).toBe(4)
    expect(() => parse('U32Array', stream, 1)).toThrow(/truncated/)
    expect(() => stream.seek(5)).toThrow(/truncated/)
  })

  test('generated chromosome strings preserve a literal leading UTF-8 BOM', () => {
    const name = '\uFEFFchr1'
    const parsed = parse<{ name: string; length: number }>(
      'Chrom',
      new ParseStream(chromosome(new TextEncoder().encode(name))),
    )
    expect(parsed.name).toBe(name)
    expect(parsed.length).toBe(100)
  })

  test('generated chromosome strings reject malformed UTF-8', () => {
    expect(() =>
      parse('Chrom', new ParseStream(chromosome(Uint8Array.of(0xc3, 0x28)))),
    ).toThrow(TypeError)
  })

  test('generated varints accept three bytes and bound unterminated values at three', () => {
    type Varint = { groups: { hasNext: boolean }[]; value: number }
    const valid = new ParseStream(Uint8Array.of(0x80, 0x80, 0x01, 0x5a))
    const parsed = parse<Varint>('Varint', valid)
    expect(parsed.value).toBe(16384)
    expect(parsed.groups).toHaveLength(3)
    expect(valid.pos).toBe(3)
    expect(valid.readU1()).toBe(0x5a)

    const unterminated = new ParseStream(
      Uint8Array.of(0x80, 0x80, 0x80, 0x80, 0),
    )
    const bounded = parse<Varint>('Varint', unterminated)
    expect(bounded.groups).toHaveLength(3)
    expect(bounded.groups[2].hasNext).toBe(true)
    expect(unterminated.pos).toBe(3)
    // The chunk adapter rejects this continuation flag; the generated layer
    // must stop before constructing an unbounded chain of varint objects.
  })

  test('summary limits include temporary generated arrays as well as inflated bytes', () => {
    const file = new Uint8Array(
      readFileSync(new URL('./fixtures/zlib.fw', import.meta.url)),
    )
    const fixed = parseFixed(file)
    const state = parseTables(
      fixed,
      file.subarray(fixed.chroms, fixed.index + 8 * fixed.nGroups),
    )
    const tracks = state.members[0].length
    const raw = new Uint8Array(4 + 4 * tracks)
    const ref = {
      factor: 1,
      n: 1,
      bytes: new Uint8Array(deflateSync(raw)),
      binCount: state.nTiles,
    }
    const stagingBudget = 24 + 24 * tracks
    expect(raw.length).toBeLessThan(stagingBudget - 1)
    expect(() => parseSummary(ref, 0, state, stagingBudget - 1)).toThrow(
      /parsed summary allocation/,
    )
    const parsed = parseSummary(ref, 0, state, stagingBudget)
    expect(parsed.bins).toEqual(Uint32Array.of(0))
    expect(parsed.sums).toEqual(new Float32Array(tracks))
  })

  test('dense values preserve ordering, NaN, and negative zero across generated windows', () => {
    const expected = Float64Array.from({ length: 8192 }, (_, i) => i + 0.5)
    expected[4095] = -0
    expected[4096] = NaN
    expected[4097] = -123.5
    const payload = new Uint8Array(expected.length * 8)
    const view = new DataView(payload.buffer)
    expected.forEach((value, i) => view.setFloat64(i * 8, value, true))

    const decoded = decodeChunk(payload, 1 | (8 << 3), 1, 8192)
    expect(decoded.tracks[0].values).toEqual(expected)
    expect(Object.is(decoded.tracks[0].values[4095], -0)).toBe(true)
    expect(decoded.byteLength).toBe(expected.byteLength)
  })

  test.each([
    [4095, Infinity],
    [4096, -Infinity],
  ])('rejects infinity at dense window boundary %i', (index, value) => {
    const payload = new Uint8Array(8192 * 8)
    new DataView(payload.buffer).setFloat64(index * 8, value, true)
    expect(() => decodeChunk(payload, 1 | (8 << 3), 1, 8192)).toThrow(
      /infinite numeric value/,
    )
  })

  test('track-order positions and values stay aligned across generated windows', () => {
    const n = 4101
    const positions = Uint32Array.from({ length: n }, (_, i) => 1000 + 3 * i)
    const values = Float64Array.from({ length: n }, (_, i) => i / 2)
    values[4095] = -0
    values[4096] = NaN
    values[4097] = -456.25
    const valuesAt = Math.ceil((n * 4) / 8) * 8
    const payload = new Uint8Array(valuesAt + n * 8)
    const view = new DataView(payload.buffer)
    positions.forEach((position, i) => view.setUint32(i * 4, position, true))
    values.forEach((value, i) => view.setFloat64(valuesAt + i * 8, value, true))

    const decoded = decodeBlock(
      payload,
      1 | (8 << 3),
      n,
      positions[0],
      positions[n - 1],
    )
    expect(decoded.tracks[0].offsets).toEqual(positions)
    expect(decoded.tracks[0].values).toEqual(values)
    expect(Object.is(decoded.tracks[0].values[4095], -0)).toBe(true)
    expect(decoded.byteLength).toBe(n * 12)
  })

  test('matrix uint16 offsets preserve the final partial generated window', () => {
    const n = 4097
    const valuesAt = Math.ceil((16 + 2 * n) / 4) * 4
    const payload = new Uint8Array(Math.ceil((valuesAt + n * 8) / 8) * 8)
    const view = new DataView(payload.buffer)
    view.setUint32(0, 1, true) // One present track, slot 0; initial pointer is 0.
    view.setUint32(12, n, true)
    const offsets = Uint32Array.from({ length: n }, (_, i) => i)
    const values = Float64Array.from({ length: n }, (_, i) => i + 0.25)
    offsets.forEach((offset, i) => view.setUint16(16 + i * 2, offset, true))
    values.forEach((value, i) => view.setFloat64(valuesAt + i * 8, value, true))

    const decoded = decodeChunk(payload, 3 | (8 << 3), 1, 8192)
    expect(decoded.tracks[0].offsets).toEqual(offsets)
    expect(decoded.tracks[0].values).toEqual(values)
    expect(decoded.byteLength).toBe(n * 12)
  })

  test('empty sparse data still bounds its many-track lengths workspace', () => {
    const tracks = 4097
    const payload = new Uint8Array(Math.ceil((4 + 4 * tracks) / 8) * 8)
    expect(() => decodeChunk(payload, 2 | (7 << 3), tracks, 16, 16)).toThrow(
      /decoded allocation exceeds maxDecodedBytes/,
    )
  })

  test('empty matrix data still bounds its large slots and pointers workspace', () => {
    const tracks = 4097
    const payload = new Uint8Array(8 + 8 * tracks)
    const view = new DataView(payload.buffer)
    view.setUint32(0, tracks, true)
    for (let i = 0; i < tracks; i++) view.setUint32(4 + i * 4, i, true)
    expect(() => decodeChunk(payload, 3 | (7 << 3), tracks, 16, 16)).toThrow(
      /decoded allocation exceeds maxDecodedBytes/,
    )
  })
})
