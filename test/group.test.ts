import { readFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { expect, test } from 'vitest'
import { decodeBlock } from '../src/decoding/chunk.js'
import { parseGroup } from '../src/format/group.js'
import { parseFixed, parseTables } from '../src/format/header.js'
import { crc32 } from '../src/utils/binary.js'
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
