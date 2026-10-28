import { readFileSync } from 'node:fs'
import { BlobFile } from 'generic-filehandle2'
import type { GenericFilehandle } from 'generic-filehandle2'
import type { SharedReadCache } from '@gmod/shared-read-cache'
import { expect, test } from 'vitest'
import { FigWig, FigWigError } from '../src/index.js'
import type { FigWigOptions } from '../src/index.js'
import { parseFixed, parseTables } from '../src/format/header.js'
import { parseGroup } from '../src/format/group.js'
import type { GroupIndex } from '../src/format/group.js'
import { decodeNumber, fixturePath, oracle } from './conformance/oracle.js'

function fixture(name: string) {
  const bytes = new Uint8Array(readFileSync(fixturePath(name))),
    fixed = parseFixed(bytes),
    state = parseTables(
      fixed,
      bytes.subarray(fixed.chroms, fixed.index + 8 * fixed.nGroups),
    )
  return { bytes, fixed, state }
}

function capturedReader(
  bytes: Uint8Array<ArrayBuffer>,
  options: Omit<FigWigOptions, 'filehandle' | 'url'> = {},
) {
  const underlying = new BlobFile(new Blob([bytes])),
    reads: { position: number; bytes: Uint8Array }[] = []
  const filehandle: GenericFilehandle = {
    read: async (length, position, options) => {
      const data = await underlying.read(length, position, options)
      reads.push({ position, bytes: data })
      return data
    },
    stat: underlying.stat.bind(underlying),
    close: underlying.close.bind(underlying),
    readFile: underlying.readFile.bind(underlying),
  }
  return { reader: new FigWig({ filehandle, ...options }), reads }
}

test.each(['zlib', 'tracks_zlib'])(
  '%s coalesces adjacent group indexes and caches them independently',
  async (name) => {
    const { bytes, state } = fixture(name),
      { reader, reads } = capturedReader(bytes)
    try {
      await reader.getHeader()
      reads.length = 0
      reader.resetDiagnostics()
      const tracks = state.members
          .slice(0, 3)
          .map((members) => members[0].name),
        levels = await reader.getZoomLevels({ tracks })
      expect(levels.length).toBeGreaterThan(0)
      for (const level of levels) expect(level.groups).toEqual([0, 1, 2])
      expect(reads).toHaveLength(1)
      expect(reads[0].position).toBe(state.directory[0])
      expect(reads[0].bytes.length).toBe(
        state.directory[3] - state.directory[0],
      )
      expect(reader.getDiagnostics()).toMatchObject({
        readRequests: 1,
        dataBytes: 0,
      })
      await reader.getZoomLevels({ tracks: [...tracks].reverse() })
      expect(reads).toHaveLength(1)
    } finally {
      await reader.close()
    }
  },
)

test.each([
  [{}, 1, 660],
  [{ maxCoalescedBytes: 400 }, 2, 400],
  [{ maxReadBytes: 373 }, 3, 373],
  [{ maxCoalescedBytes: 1 }, 3, 286],
] as const)(
  'group-index reads honor %j without changing zoom discovery',
  async (options, count, maximum) => {
    const { bytes, fixed } = fixture('blocks')
    // This fixture has 373 metadata bytes and index records of 286, 135, 239
    // bytes. The read limit must split a response even when the coalescing target
    // is larger; a single record may exceed a smaller coalescing target.
    expect(fixed.nGroups).toBe(3)
    const { reader, reads } = capturedReader(bytes, options)
    try {
      await reader.getHeader()
      reads.length = 0
      const levels = await reader.getZoomLevels()
      for (const level of levels) expect(level.groups).toEqual([0, 1, 2])
      expect(reads).toHaveLength(count)
      expect(reads.every((read) => read.bytes.length <= maximum)).toBe(true)
    } finally {
      await reader.close()
    }
  },
)

test('one cached group cannot retain or alias the entire coalesced index response', async () => {
  const { bytes, fixed, state } = fixture('blocks'),
    weights = state.directory.map(
      (start, id) =>
        parseGroup(
          bytes.subarray(start, state.directory[id + 1] ?? fixed.length),
          id,
          state,
          1024 ** 2,
        ).byteLength,
    ),
    budget = Math.max(...weights),
    { reader, reads } = capturedReader(bytes, { indexCacheBytes: budget })
  try {
    await reader.getHeader()
    reads.length = 0
    await reader.getZoomLevels()
    expect(reads).toHaveLength(1)
    expect(reader.getDiagnostics().cacheBytes).toBeLessThanOrEqual(budget)
    // Public summaries expose decoded arrays, so inspect the retained compressed
    // buffer here to verify the memory invariant, not only reported cache weight.
    const cache = Reflect.get(reader, 'groups') as SharedReadCache<
        number,
        GroupIndex
      >,
      retained = await cache.getIfCached(2)
    expect(retained).toBeDefined()
    expect(retained!.summaries[0].bytes.buffer.byteLength).toBe(
      fixed.length - state.directory[2],
    )
    expect(retained!.summaries[0].bytes.buffer).not.toBe(reads[0].bytes.buffer)
    reads[0].bytes.fill(0)
    const summary = await reader.getSummary(2),
      expected = oracle.files.blocks.groups[2].summary!
    expect([...summary.bins]).toEqual(expected.ids)
    expect([...summary.sums]).toEqual(expected.sums.flat().map(decodeNumber))
    expect(reads).toHaveLength(1)
    reader.clearCache()
    expect(reader.getDiagnostics().cacheBytes).toBe(0)
  } finally {
    await reader.close()
  }
})

test.each(['zlib', 'tracks_zlib'])(
  '%s validates every group CRC after a coalesced read',
  async (name) => {
    const { bytes, state } = fixture(name)
    bytes[state.directory[1] + 4] ^= 1
    const { reader, reads } = capturedReader(bytes)
    try {
      await reader.getHeader()
      reads.length = 0
      const tracks = state.members.slice(0, 2).map((members) => members[0].name)
      await expect(reader.getZoomLevels({ tracks })).rejects.toThrow(
        FigWigError,
      )
      expect(reads).toHaveLength(1)
      expect(
        (await reader.getZoomLevels({ tracks: tracks.slice(0, 1) })).length,
      ).toBeGreaterThan(0)
      expect(reads).toHaveLength(1)
      // The corrupt group's failure is retryable, rather than a cached rejection.
      await expect(
        reader.getZoomLevels({ tracks: tracks.slice(1) }),
      ).rejects.toThrow(/CRC-32 mismatch/)
      expect(reads).toHaveLength(2)
    } finally {
      await reader.close()
    }
  },
)
