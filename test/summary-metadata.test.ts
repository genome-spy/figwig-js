import { readFileSync } from 'node:fs'
import { BlobFile } from 'generic-filehandle2'
import type { GenericFilehandle } from 'generic-filehandle2'
import { expect, test } from 'vitest'
import { FigWig } from '../src/index.js'
import type { FigWigOptions } from '../src/index.js'
import { decodeNumber, fixturePath, oracle } from './conformance/oracle.js'

function capturedReader(
  name: string,
  options: Omit<FigWigOptions, 'filehandle' | 'url'> = {},
) {
  const bytes = new Uint8Array(readFileSync(fixturePath(name))),
    underlying = new BlobFile(new Blob([bytes])),
    reads: { position: number; bytes: Uint8Array }[] = []
  const filehandle: GenericFilehandle = {
    read: async (length, position, options) => {
      const data = await underlying.read(length, position, options)
      reads.push({ position, bytes: data })
      return data
    },
    stat: underlying.stat.bind(underlying),
    close: underlying.close.bind(underlying),
    readFile: async () => {
      throw new Error('Whole-file reads are not expected')
    },
  }
  return { reader: new FigWig({ filehandle, ...options }), reads }
}

test.each(['zlib', 'tracks_zlib'])(
  '%s reuses summary metadata and decoded levels without retaining raw indexes',
  async (name) => {
    const file = oracle.files[name],
      track = file.metadata.tracks.find((track) => track.name === 'wide')!,
      group = track.group,
      slot = file.metadata.tracks
        .filter((item) => item.group === group)
        .findIndex((item) => item.name === track.name),
      expected = file.groups[group],
      budget = 64 * 1024,
      { reader, reads } = capturedReader(name, {
        indexCacheBytes: 0,
        chunkCacheBytes: 0,
        summaryCacheBytes: budget,
      })
    try {
      const summary = await reader.getSummary(group),
        zoom = await reader.getSummary(group, 1)
      expect([...summary.bins]).toEqual(expected.summary!.ids)
      expect([...summary.sums]).toEqual(
        expected.summary!.sums.flat().map(decodeNumber),
      )
      expect([...zoom.sums]).toEqual(
        expected.zooms[0].sums.flat().map(decodeNumber),
      )
      expect(reader.getDiagnostics().cacheBytes).toBeGreaterThan(0)
      expect(reader.getDiagnostics().cacheBytes).toBeLessThanOrEqual(budget)

      // Only the raw-index cache is disabled. Queries for other groups must not
      // discard the separate summary metadata or decoded summary results.
      await reader.getValues('chr1', 0, 128, { tracks: ['ones', 'random'] })
      reads.length = 0
      reader.resetDiagnostics()
      expect(await reader.getZoomLevels({ tracks: [track.name] })).toEqual(
        expected.zooms.map((zoom, index) => ({
          level: index + 1,
          factor: zoom.factor,
          binSize: file.tile * zoom.factor,
          groups: [group],
        })),
      )
      const regions = [
          { chromosome: 'chr1', start: 0, end: 128 },
          { chromosome: 'chr1', start: 128, end: 256 },
        ],
        bins = await reader.getBinsMulti(regions, {
          tracks: [track.name],
          binSize: file.tile,
          aggregation: 'sum',
          missing: 'zero',
          requireSummaries: true,
        })
      for (const result of bins) {
        expect(result.source).toBe('summary')
        expect([...result.tracks[0].values]).toEqual(
          [...result.starts].map((start) => {
            const row = expected.summary!.ids.indexOf(start / file.tile)
            return row < 0 ? 0 : decodeNumber(expected.summary!.sums[row][slot])
          }),
        )
      }
      const coarse = await reader.getBins('chr1', 0, 256, {
        tracks: [track.name],
        binSize: 256,
        aggregation: 'sum',
        missing: 'zero',
        requireSummaries: true,
      })
      expect(coarse.source).toBe('summary')
      expect([...coarse.tracks[0].values]).toEqual([
        decodeNumber(expected.zooms[0].sums[0][slot]),
      ])
      expect(reads).toHaveLength(0)
      expect(reader.getDiagnostics()).toMatchObject({
        readRequests: 0,
        indexBytes: 0,
        dataBytes: 0,
        chunksFetched: 0,
      })
    } finally {
      await reader.close()
    }
  },
)

test.each(['zlib', 'tracks_zlib'])(
  '%s accounts for compact metadata and decoded summaries in the same budget',
  async (name) => {
    const track = oracle.files[name].metadata.tracks[0],
      group = track.group,
      { reader: roomy } = capturedReader(name, {
        indexCacheBytes: 0,
        chunkCacheBytes: 0,
        summaryCacheBytes: 64 * 1024,
      })
    let combined: number
    try {
      await roomy.getZoomLevels({ tracks: [track.name] })
      const catalogBytes = roomy.getDiagnostics().cacheBytes,
        summary = await roomy.getSummary(group)
      combined = roomy.getDiagnostics().cacheBytes
      expect(catalogBytes).toBeGreaterThan(0)
      expect(combined).toBe(
        catalogBytes + summary.bins.byteLength + summary.sums.byteLength + 128,
      )
    } finally {
      await roomy.close()
    }
    const budget = combined! - 1,
      { reader } = capturedReader(name, {
        indexCacheBytes: 0,
        chunkCacheBytes: 0,
        summaryCacheBytes: budget,
      })
    try {
      for (let repeat = 0; repeat < 2; repeat++) {
        await reader.getZoomLevels({ tracks: [track.name] })
        await reader.getSummary(group)
        expect(reader.getDiagnostics().cacheBytes).toBeGreaterThan(0)
        expect(reader.getDiagnostics().cacheBytes).toBeLessThanOrEqual(budget)
      }
      reader.clearCache()
      expect(reader.getDiagnostics().cacheBytes).toBe(0)
    } finally {
      await reader.close()
    }
    expect(reader.getDiagnostics().cacheBytes).toBe(0)
  },
)

test.each(['zlib', 'tracks_zlib'])(
  '%s copies cached summary metadata and clears it with decoded summaries',
  async (name) => {
    const track = oracle.files[name].metadata.tracks[0],
      { reader, reads } = capturedReader(name, {
        indexCacheBytes: 0,
        chunkCacheBytes: 0,
      })
    try {
      const levels = await reader.getZoomLevels({ tracks: [track.name] }),
        summary = await reader.getSummary(track.group),
        expected = [...summary.sums]
      // A filehandle may recycle its response buffers. Cached descriptors and
      // decoded summaries must not depend on those mutable response bytes.
      for (const read of reads) read.bytes.fill(0)
      reads.length = 0
      expect(await reader.getZoomLevels({ tracks: [track.name] })).toEqual(
        levels,
      )
      expect([...(await reader.getSummary(track.group)).sums]).toEqual(expected)
      expect(reads).toHaveLength(0)

      reader.clearCache()
      expect(reader.getDiagnostics().cacheBytes).toBe(0)
      expect(await reader.getZoomLevels({ tracks: [track.name] })).toEqual(
        levels,
      )
      expect(reads.length).toBeGreaterThan(0)
      await reader.close()
      expect(reader.getDiagnostics().cacheBytes).toBe(0)
      expect([...summary.sums]).toEqual(expected)
    } finally {
      await reader.close()
    }
  },
)

test.each([
  ['zlib', 0],
  ['zlib', 1],
  ['tracks_zlib', 0],
  ['tracks_zlib', 1],
] as const)(
  '%s retains no summary metadata or decoded arrays with a %i-byte budget',
  async (name, budget) => {
    const track = oracle.files[name].metadata.tracks[0],
      { reader, reads } = capturedReader(name, {
        indexCacheBytes: 0,
        chunkCacheBytes: 0,
        summaryCacheBytes: budget,
      })
    try {
      for (let repeat = 0; repeat < 2; repeat++) {
        reads.length = 0
        await reader.getZoomLevels({ tracks: [track.name] })
        await reader.getSummary(track.group)
        expect(reads.length).toBeGreaterThan(0)
        expect(reader.getDiagnostics().cacheBytes).toBe(0)
      }
    } finally {
      await reader.close()
    }
  },
)
