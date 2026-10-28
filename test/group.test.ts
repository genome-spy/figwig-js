import { readFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { expect, test } from 'vitest'
import { decodeBlock } from '../src/decoding/chunk.js'
import { parseGroup, parseSummary } from '../src/format/group.js'
import { parseFixed, parseTables } from '../src/format/header.js'
import { crc32, FigWigError } from '../src/utils/binary.js'
import { inflateZlib } from '../src/utils/inflate.js'

function fixtureState(name: string) {
  const bytes = new Uint8Array(
    readFileSync(new URL(`./fixtures/${name}.fw`, import.meta.url)),
  )
  const fixed = parseFixed(bytes)
  return parseTables(
    fixed,
    bytes.subarray(fixed.chroms, fixed.index + fixed.nGroups * 8),
  )
}

test('track blocks accept zlib expansion beyond the position-order size bound', () => {
  const state = fixtureState('blocks'),
    n = 65536,
    raw = Buffer.alloc(12 * n)
  for (let i = 0; i < n; i++) {
    raw.writeUInt32LE(i, i * 4)
    raw.writeDoubleLE(2, 4 * n + i * 8)
  }
  // Both pinned Python readers accept this encoding; v1 gives track blocks
  // a raw-size bound, but no position-order compressed-size bound.
  const compressed = deflateSync(raw, { level: 0, memLevel: 1 })
  expect(compressed.length).toBeGreaterThan(12 * n + 128)
  state.fixed = {
    ...state.fixed,
    chroms: 128 + compressed.length,
    optional: 0,
  }
  // One block record, followed by an absent base summary.
  const index = Buffer.alloc(60)
  index.writeUInt32LE(1)
  index.writeUInt32LE(n - 1, 16)
  index.writeUInt32LE(n, 20)
  index.writeBigUInt64LE(128n, 24)
  index.writeUInt32LE(compressed.length, 32)
  index.writeUInt32LE(raw.length, 36)
  index.writeUInt32LE(65, 40) // kind 1, float64
  index.writeUInt32LE(crc32(compressed), 44)
  const checksum = () => index.writeUInt32LE(crc32(index.subarray(8, 48)), 4)
  checksum()
  const group = parseGroup(index, 0, state, 128 * 1024 ** 2),
    ref = group.chunks[0],
    decoded = decodeBlock(
      inflateZlib(compressed, ref.raw, 128 * 1024 ** 2),
      ref.kind,
      ref.n!,
      ref.first!,
      ref.last!,
    )
  expect(decoded.tracks[0].values.length).toBe(n)
  expect(decoded.tracks[0].values.every((v) => v === 2)).toBe(true)
  expect(decoded.tracks[0].offsets!.every((v, i) => v === i)).toBe(true)

  // Relaxing compressed size must retain data-region and raw-size checks.
  index.writeUInt32LE(compressed.length + 1, 32)
  checksum()
  expect(() => parseGroup(index, 0, state, 128 * 1024 ** 2)).toThrow(
    /outside data region/,
  )
  index.writeUInt32LE(compressed.length, 32)
  index.writeUInt32LE(12 * n + 72, 36)
  checksum()
  expect(() => parseGroup(index, 0, state, 128 * 1024 ** 2)).toThrow(
    /invalid chunk raw size/,
  )
})

test('position-order chunks retain their compressed-size bound', () => {
  const state = fixtureState('zlib'),
    tracks = state.members[0].length,
    rawSize = 8 * tracks * state.fixed.tile,
    size = rawSize + 16 * tracks + 129,
    live = Buffer.alloc(17)
  live[4] = 65 // dense float64, tile 0
  live.writeUInt32LE(size, 5)
  live.writeUInt32LE(rawSize, 9)
  const compressed = deflateSync(live),
    index = Buffer.alloc(64 + compressed.length)
  index.writeUInt32LE(1)
  index.writeBigUInt64LE(128n, 24)
  index.writeBigUInt64LE(BigInt(size), 32)
  index.writeUInt32LE(1, 40)
  index.writeUInt32LE(compressed.length, 44)
  index.set(compressed, 48)
  index.writeUInt32LE(crc32(index.subarray(8, 48 + compressed.length)), 4)
  expect(() => parseGroup(index, 0, state, 128 * 1024 ** 2)).toThrow(
    /invalid chunk raw size/,
  )
})

function emptyGroupIndex(
  order: 'positions' | 'tracks',
  summary: Uint8Array,
  zoom?: Uint8Array,
) {
  const empty = deflateSync(new Uint8Array()),
    prefix = Buffer.alloc(order === 'tracks' ? 8 : 16 + empty.length)
  if (order === 'positions') {
    prefix.writeUInt32LE(empty.length, 12)
    prefix.set(empty, 16)
    prefix.writeUInt32LE(crc32(prefix.subarray(8)), 4)
  }
  const summaryHeader = Buffer.alloc(12),
    zoomHeader = Buffer.alloc(zoom === undefined ? 4 : 20)
  summaryHeader.writeUInt32LE(summary.length, 4)
  summaryHeader.writeUInt32LE(crc32(summary), 8)
  if (zoom !== undefined) {
    zoomHeader.writeUInt32LE(1)
    zoomHeader.writeUInt32LE(4, 4)
    zoomHeader.writeUInt32LE(zoom.length, 12)
    zoomHeader.writeUInt32LE(crc32(zoom), 16)
  }
  return Buffer.concat([
    prefix,
    summaryHeader,
    summary,
    zoomHeader,
    zoom ?? new Uint8Array(),
  ])
}

test.each(['zlib', 'tracks_zlib'])(
  '%s rejects a listed zoom without a zlib stream',
  (name) => {
    const state = fixtureState(name),
      bytes = emptyGroupIndex(
        state.header.order,
        deflateSync(new Uint8Array()),
        new Uint8Array(),
      )
    expect(() => parseGroup(bytes, 0, state, 1024)).toThrow(FigWigError)
    expect(() => parseGroup(bytes, 0, state, 1024)).toThrow(/empty zoom stream/)
  },
)

test.each(['zlib', 'tracks_zlib'])(
  '%s distinguishes an absent base summary from compressed empty summaries and zooms',
  (name) => {
    const state = fixtureState(name),
      empty = deflateSync(new Uint8Array()),
      absent = parseGroup(
        emptyGroupIndex(state.header.order, new Uint8Array()),
        0,
        state,
        1024,
      ),
      available = parseGroup(
        emptyGroupIndex(state.header.order, empty, empty),
        0,
        state,
        1024,
      )
    expect(parseSummary(absent.summaries[0], 0, state, 1024)).toMatchObject({
      available: false,
      bins: new Uint32Array(),
      sums: new Float32Array(),
    })
    for (const [level, sums] of [
      new Float32Array(),
      new Float64Array(),
    ].entries())
      expect(
        parseSummary(available.summaries[level], 0, state, 1024),
      ).toMatchObject({ available: true, bins: new Uint32Array(), sums })
  },
)

test.each(['zlib', 'tracks_zlib'])(
  '%s validates zlib integrity even for a zoom with zero bins',
  (name) => {
    const state = fixtureState(name),
      empty = deflateSync(new Uint8Array()),
      corrupt = Buffer.from(empty)
    corrupt[corrupt.length - 1] ^= 1
    const group = parseGroup(
      emptyGroupIndex(state.header.order, empty, corrupt),
      0,
      state,
      1024,
    )
    expect(() => parseSummary(group.summaries[1], 0, state, 1024)).toThrow(
      /Adler-32 mismatch/,
    )
  },
)
