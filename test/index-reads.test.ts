import { readFileSync } from 'node:fs'
import { BlobFile } from 'generic-filehandle2'
import type { GenericFilehandle } from 'generic-filehandle2'
import type { SharedReadCache } from '@gmod/shared-read-cache'
import { expect, test } from 'vitest'
import { FigWig, FigWigError } from '../src/index.js'
import type { FigWigOptions } from '../src/index.js'
import { parseFixed, parseTables } from '../src/format/header.js'
import { parseRawIndex } from '../src/format/group.js'
import type { RawIndex } from '../src/format/group.js'
import type { MetadataState } from '../src/format/header.js'
import { expectedValues, fixturePath } from './conformance/oracle.js'

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
  '%s coalesces group metadata probes and caches discoveries independently',
  async (name) => {
    const { bytes, state } = fixture(name),
      { reader, reads } = capturedReader(bytes),
      separate = capturedReader(bytes, { maxCoalescedBytes: 1 })
    try {
      await reader.getHeader()
      await separate.reader.getHeader()
      reads.length = 0
      separate.reads.length = 0
      reader.resetDiagnostics()
      const tracks = state.members
          .slice(0, 3)
          .map((members) => members[0].name),
        levels = await reader.getZoomLevels({ tracks })
      expect(levels.length).toBeGreaterThan(0)
      for (const level of levels) expect(level.groups).toEqual([0, 1, 2])
      expect(await separate.reader.getZoomLevels({ tracks })).toEqual(levels)
      expect(reads.length).toBeLessThan(separate.reads.length)
      expect(
        reads.every(
          (read) =>
            read.position >= state.directory[0] &&
            read.position + read.bytes.length <= state.directory[3],
        ),
      ).toBe(true)
      expect(reader.getDiagnostics()).toMatchObject({
        readRequests: reads.length,
        indexBytes: reads.reduce((total, read) => total + read.bytes.length, 0),
        dataBytes: 0,
      })
      const coldReads = reads.length
      await reader.getZoomLevels({ tracks: [...tracks].reverse() })
      expect(reads).toHaveLength(coldReads)
    } finally {
      await Promise.all([reader.close(), separate.reader.close()])
    }
  },
)

test.each([
  [{}, 660],
  [{ maxCoalescedBytes: 400 }, 400],
  [{ maxReadBytes: 373 }, 373],
  [{ maxCoalescedBytes: 1 }, 20],
] as const)(
  'group-index reads honor %j without changing zoom discovery',
  async (options, maximum) => {
    const { bytes, fixed } = fixture('blocks')
    // The three group records total 660 bytes. Discovery fetches their headers;
    // individual probes may exceed a one-byte coalescing target, while bounded
    // coalesced responses must still respect maxReadBytes.
    expect(fixed.nGroups).toBe(3)
    const { reader, reads } = capturedReader(bytes, options)
    try {
      await reader.getHeader()
      reads.length = 0
      const levels = await reader.getZoomLevels()
      for (const level of levels) expect(level.groups).toEqual([0, 1, 2])
      expect(reads.length).toBeGreaterThan(0)
      expect(reads.every((read) => read.bytes.length <= maximum)).toBe(true)
      const coldReads = reads.length
      expect(await reader.getZoomLevels()).toEqual(levels)
      expect(reads).toHaveLength(coldReads)
    } finally {
      await reader.close()
    }
  },
)

test.each(['blocks', 'zlib'])(
  '%s cached raw indexes own their tile arrays after coalesced reads',
  async (name) => {
    const { bytes, fixed, state } = fixture(name),
      view = new DataView(bytes.buffer),
      weights = state.directory.slice(0, 3).map((start, id) => {
        const n = view.getUint32(start, true),
          size =
            fixed.flags & 1
              ? 8 + n * 40
              : 16 + n * 32 + view.getUint32(start + 12 + n * 32, true)
        return parseRawIndex(
          bytes.subarray(start, start + size),
          id,
          state,
          1024 ** 2,
        ).byteLength
      }),
      budget = Math.max(...weights),
      { reader, reads } = capturedReader(bytes, {
        indexCacheBytes: budget,
        summaryCacheBytes: 0,
      })
    try {
      await reader.getHeader()
      reads.length = 0
      const load = Reflect.get(reader, 'group') as (
        id: number,
        state: MetadataState,
      ) => Promise<RawIndex>
      await Promise.all([0, 1, 2].map((id) => load.call(reader, id, state)))
      expect(
        reads.some(
          (read) =>
            read.position <= state.directory[0] &&
            read.position + read.bytes.length > state.directory[1],
        ),
      ).toBe(true)
      expect(reader.getDiagnostics().cacheBytes).toBeLessThanOrEqual(budget)
      // Check the retained allocation itself, not only the reported cache weight.
      // Raw indexes need no compressed response bytes after parsing.
      const cache = Reflect.get(reader, 'groups') as SharedReadCache<
          number,
          RawIndex
        >,
        retained = await cache.getIfCached(2)
      expect(retained).toBeDefined()
      expect(retained!.tiles.buffer.byteLength).toBe(retained!.tiles.byteLength)
      expect(retained).not.toHaveProperty('summaries')
      const tiles = [...retained!.tiles],
        chunks = retained!.chunks.map((chunk) => ({ ...chunk })),
        coldReads = reads.length
      for (const read of reads) {
        expect(retained!.tiles.buffer).not.toBe(read.bytes.buffer)
        read.bytes.fill(0)
      }
      expect(await load.call(reader, 2, state)).toBe(retained)
      expect([...retained!.tiles]).toEqual(tiles)
      expect(retained!.chunks).toEqual(chunks)
      expect(reads).toHaveLength(coldReads)
      const track = state.members[2][0].name,
        chromosome = name === 'blocks' ? 'chrA' : 'chr1',
        dataset = name === 'blocks' ? 'blocks' : 'toy',
        result = await reader.getValues(chromosome, 0, 20, { tracks: [track] })
      expect([...result.tracks[0].values]).toEqual([
        ...expectedValues(dataset, chromosome, track, 0, 20),
      ])
      expect(
        reads.slice(coldReads).every((read) => read.position < fixed.chroms),
      ).toBe(true)
      reader.clearCache()
      expect(reader.getDiagnostics().cacheBytes).toBe(0)
    } finally {
      await reader.close()
    }
  },
)

test.each(['zlib', 'tracks_zlib'])(
  '%s validates every requested raw-index CRC after coalesced reads',
  async (name) => {
    const { bytes, state } = fixture(name)
    bytes[state.directory[1] + 4] ^= 1
    const { reader, reads } = capturedReader(bytes)
    try {
      await reader.getHeader()
      reads.length = 0
      const tracks = state.members.slice(0, 2).map((members) => members[0].name)
      await expect(reader.getValues('chr1', 0, 64, { tracks })).rejects.toThrow(
        FigWigError,
      )
      const afterFailure = reads.length
      await reader.getValues('chr1', 0, 64, { tracks: tracks.slice(0, 1) })
      expect(
        reads
          .slice(afterFailure)
          .every((read) => read.position < state.fixed.chroms),
      ).toBe(true)
      // The corrupt group's failure is retryable, rather than a cached rejection.
      const beforeRetry = reads.length
      await expect(
        reader.getValues('chr1', 0, 64, { tracks: tracks.slice(1) }),
      ).rejects.toThrow(/CRC-32 mismatch/)
      expect(reads.length).toBeGreaterThan(beforeRetry)
      expect(
        reads
          .slice(beforeRetry)
          .some((read) => read.position >= state.directory[1]),
      ).toBe(true)
    } finally {
      await reader.close()
    }
  },
)
