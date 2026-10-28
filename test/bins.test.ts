import { readFileSync } from 'node:fs'
import { BlobFile, LocalFile } from 'generic-filehandle2'
import { describe, expect, it } from 'vitest'
import { FigWig } from '../src/index.js'
import type { BinsResult, MissingPolicy } from '../src/index.js'
import type { DecodedTrack } from '../src/decoding/chunk.js'
import { crc32 } from '../src/utils/binary.js'
import { parseFixed, parseTables } from '../src/format/header.js'
import type { MetadataState } from '../src/format/header.js'
import { parseGroup } from '../src/format/group.js'
import type { ChunkRef, GroupIndex } from '../src/format/group.js'
import { expectedValues, fixturePath } from './conformance/oracle.js'

describe('required summaries', () => {
  it('enables stored summaries without raw chunks, including a partial chromosome bin', async () => {
    const reader = new FigWig({
      filehandle: new LocalFile(fixturePath('zlib')),
    })
    const result = await reader.getBins('chr1', 0, 300, {
      tracks: ['wide'],
      binSize: 256,
      aggregation: 'mean',
      missing: 'zero',
      useSummaries: false,
      requireSummaries: true,
    })
    expect(result.source).toBe('summary')
    expect([...result.ends]).toEqual([256, 300])
    expect([...result.tracks[0].values]).toEqual([
      Math.fround(2 ** 24 + 1.5) / 256,
      0,
    ])
    expect(reader.getDiagnostics()).toMatchObject({
      dataBytes: 0,
      chunksFetched: 0,
    })
  })

  it('rejects an unsupported region before any raw reads in the whole batch', async () => {
    const reader = new FigWig({
      filehandle: new LocalFile(fixturePath('zlib')),
    })
    await expect(
      reader.getBinsMulti(
        [
          { chromosome: 'chr1', start: 0, end: 64 },
          { chromosome: 'chr2', start: 1, end: 65 },
        ],
        {
          tracks: ['wide'],
          binSize: 64,
          missing: 'zero',
          requireSummaries: true,
        },
      ),
    ).rejects.toThrow(/Required summaries.*chr2:1-65/)
    expect(reader.getDiagnostics()).toMatchObject({
      dataBytes: 0,
      chunksFetched: 0,
    })
  })

  it.each(['omit', 'propagate'] as const)(
    'rejects the incompatible %s missing policy',
    async (missing) => {
      const reader = new FigWig({
        filehandle: new LocalFile(fixturePath('zlib')),
      })
      await expect(
        reader.getBins('chr1', 0, 64, {
          binSize: 64,
          missing,
          requireSummaries: true,
        }),
      ).rejects.toThrow("Required summaries need missing: 'zero'")
      expect(reader.getDiagnostics()).toMatchObject({
        dataBytes: 0,
        chunksFetched: 0,
      })
    },
  )

  it('rejects unavailable summaries without falling back on tracks that contain data', async () => {
    const bytes = new Uint8Array(readFileSync(fixturePath('stored')))
    const fixed = parseFixed(bytes),
      state = parseTables(
        fixed,
        bytes.subarray(fixed.chroms, fixed.index + 8 * fixed.nGroups),
      ),
      groupId = fixed.nGroups - 1,
      group = parseGroup(
        bytes.subarray(state.directory[groupId]),
        groupId,
        state,
        128 * 1024 ** 2,
      ),
      summaryBytes = group.summaries[0].bytes.length,
      withoutSummary = bytes.slice(0, bytes.length - summaryBytes),
      view = new DataView(withoutSummary.buffer)
    // The last group has no zooms: replace its final summary by a valid absent record.
    expect(group.summaries).toHaveLength(1)
    withoutSummary.fill(
      0,
      withoutSummary.length - 12 - (fixed.optional & 1 ? 4 : 0),
    )
    view.setBigUint64(88, BigInt(withoutSummary.length), true)
    view.setUint32(104, 0, true)
    view.setUint32(104, crc32(withoutSummary.subarray(0, 128)), true)
    const reader = new FigWig({
      filehandle: new BlobFile(new Blob([withoutSummary])),
    })
    await expect(
      reader.getBins('chr1', 0, 64, {
        tracks: ['ones', state.members[groupId][0].name],
        binSize: 64,
        missing: 'zero',
        requireSummaries: true,
      }),
    ).rejects.toThrow(/Required summaries are unavailable/)
    expect(reader.getDiagnostics()).toMatchObject({
      dataBytes: 0,
      chunksFetched: 0,
    })
  })

  it('requires summaries consistently for binned and single-base feature queries', async () => {
    const reader = new FigWig({
      filehandle: new LocalFile(fixturePath('zlib')),
    })
    const result = await reader.getFeatures('chr1', 0, 64, {
      tracks: ['wide'],
      basesPerSpan: 64,
      missing: 'zero',
      requireSummaries: true,
    })
    expect(result).toHaveLength(1)
    expect(result[0].score).toBe(Math.fround(2 ** 24 + 1.5) / 64)
    await expect(
      reader.getFeaturesMulti([{ chromosome: 'chr1', start: 0, end: 1 }], {
        tracks: ['wide'],
        missing: 'zero',
        requireSummaries: true,
      }),
    ).rejects.toThrow(/Required summaries.*tile-aligned/)
    expect(reader.getDiagnostics()).toMatchObject({
      dataBytes: 0,
      chunksFetched: 0,
    })
  })
})

describe('direct binned aggregation', () => {
  it('uses summaries only at supported resolution and keeps exact missing gaps as NaNs', async () => {
    const reader = new FigWig({
      filehandle: new LocalFile(fixturePath('nan_positions')),
    })
    try {
      const summary = await reader.getBins('missing', 0, 128, {
        binSize: 64,
        missing: 'zero',
        requireSummaries: true,
      })
      expect(summary.source).toBe('summary')
      expect(summary.tracks.every((t) => t.values.every((v) => v === 0))).toBe(
        true,
      )
      expect(reader.getDiagnostics()).toMatchObject({
        dataBytes: 0,
        chunksFetched: 0,
      })
      reader.resetDiagnostics()
      await expect(
        reader.getBins('missing', 0, 128, {
          binSize: 32,
          missing: 'zero',
          requireSummaries: true,
        }),
      ).rejects.toThrow(/Required summaries/)
      expect(reader.getDiagnostics().dataBytes).toBe(0)
      const exact = await reader.getBins('missing', 0, 128, {
        binSize: 32,
        missing: 'omit',
        useSummaries: true,
      })
      expect(exact.source).toBe('values')
      expect(exact.tracks.every((t) => t.values.every(Number.isNaN))).toBe(true)
      expect(reader.getDiagnostics()).toMatchObject({
        chunksFetched: 2,
        chunksDecompressed: 1,
      })
    } finally {
      await reader.close()
    }
  })

  it('inflates identical missing tiles once per query without retaining a new cache', async () => {
    const reader = new FigWig({
      filehandle: new LocalFile(fixturePath('nan_positions')),
      chunkCacheBytes: 0,
    })
    try {
      for (let repeat = 0; repeat < 2; repeat++) {
        reader.resetDiagnostics()
        const result = await reader.getBins('missing', 3, 125, {
          binSize: 17,
          missing: 'omit',
        })
        expect(
          result.tracks.every((track) => track.values.every(Number.isNaN)),
        ).toBe(true)
        expect(reader.getDiagnostics()).toMatchObject({
          chunksFetched: 2,
          chunksDecompressed: 1,
          chunkCacheHits: 0,
        })
      }
    } finally {
      await reader.close()
    }
  })

  it.each([true, false])(
    'does not reuse a modified stream with verify=%s',
    async (verify) => {
      const bytes = new Uint8Array(readFileSync(fixturePath('nan_positions')))
      const fixed = parseFixed(bytes),
        state = parseTables(
          fixed,
          bytes.subarray(fixed.chroms, fixed.index + 8 * fixed.nGroups),
        )
      const index = parseGroup(
        bytes.subarray(state.directory[0], state.directory[1]),
        0,
        state,
        128 * 1024 ** 2,
      )
      const ref = index.chunks[1]
      expect(ref.kind).toBe(1 | (6 << 3))
      bytes[ref.offset + ref.size - 1] ^= 1
      const reader = new FigWig({
        filehandle: new BlobFile(new Blob([bytes])),
        verify,
      })
      try {
        await expect(
          reader.getBins('missing', 0, 128, { binSize: 17, missing: 'omit' }),
        ).rejects.toThrow(verify ? /chunk CRC/ : /Adler-32/)
      } finally {
        await reader.close()
      }
    },
  )

  it.each(['crc', 'raw', 'kind'] as const)(
    "checks each missing tile's %s metadata before reuse",
    async (field) => {
      const reader = new FigWig({
        filehandle: new LocalFile(fixturePath('nan_positions')),
      })
      try {
        const state = await (
          Reflect.get(reader, 'state') as () => Promise<MetadataState>
        ).call(reader)
        const index = await (
          Reflect.get(reader, 'group') as (
            id: number,
            state: MetadataState,
          ) => Promise<GroupIndex>
        ).call(reader, 0, state)
        if (field === 'kind') index.chunks[1].kind = 1 | (8 << 3)
        else index.chunks[1][field] += field === 'raw' ? 8 : 1
        await expect(
          reader.getBins('missing', 0, 128, { binSize: 17, missing: 'omit' }),
        ).rejects.toThrow(
          field === 'crc'
            ? /chunk CRC/
            : field === 'raw'
              ? /wrong-sized/
              : /truncated/,
        )
      } finally {
        await reader.close()
      }
    },
  )

  it('owns reused bytes and rechecks the destination group shape and dtype', async () => {
    const reader = new FigWig({
      filehandle: new LocalFile(fixturePath('nan_positions')),
      chunkCacheBytes: 0,
    })
    try {
      const state = await (
        Reflect.get(reader, 'state') as () => Promise<MetadataState>
      ).call(reader)
      const index = await (
        Reflect.get(reader, 'group') as (
          id: number,
          state: MetadataState,
        ) => Promise<GroupIndex>
      ).call(reader, 0, state)
      const reuse: { last?: { bytes: Uint8Array } } = {}
      const chunk = Reflect.get(reader, 'chunk') as (
        ref: ChunkRef,
        state: MetadataState,
        reuse: unknown,
      ) => Promise<{ tracks: DecodedTrack[] }>
      await chunk.call(reader, index.chunks[0], state, reuse)
      expect(reuse.last!.bytes.buffer.byteLength).toBe(
        reuse.last!.bytes.byteLength,
      )
      state.members[0] = state.members[0].slice(0, 3)
      expect(
        (await chunk.call(reader, index.chunks[1], state, reuse)).tracks,
      ).toHaveLength(3)
      state.members[0] = state.members[0].map((track) => ({
        ...track,
        dtype: 'uint32',
      }))
      await expect(
        chunk.call(reader, index.chunks[0], state, reuse),
      ).rejects.toThrow(/declared uint32/)
    } finally {
      await reader.close()
    }
  })

  it.each(['nan_positions', 'nan_tracks'])(
    'preserves missing gaps and observed zeros in %s',
    async (file) => {
      const reader = new FigWig({
        filehandle: new LocalFile(fixturePath(file)),
      })
      const regions = [
        { chromosome: 'missing', start: 3, end: 125 },
        { chromosome: 'mixed', start: 5, end: 64 },
        { chromosome: 'unwritten', start: 1, end: 63 },
      ]
      try {
        for (const missing of ['propagate', 'omit', 'zero'] as const)
          for (const aggregation of ['sum', 'mean'] as const) {
            const results = await reader.getBinsMulti(regions, {
              binSize: 23,
              aggregation,
              missing,
            })
            for (const result of results)
              for (const { track, values } of result.tracks)
                for (let bin = 0; bin < values.length; bin++) {
                  const source = expectedValues(
                    'nan',
                    result.chromosome,
                    track.name,
                    result.starts[bin],
                    result.ends[bin],
                  )
                  let sum = 0,
                    count = 0,
                    nan = false
                  for (const value of source) {
                    if (Number.isNaN(value)) {
                      nan = true
                      if (missing === 'zero') count++
                    } else {
                      sum += value
                      count++
                    }
                  }
                  const expected =
                    nan && missing === 'propagate'
                      ? NaN
                      : aggregation === 'sum'
                        ? sum
                        : count
                          ? sum / count
                          : NaN
                  expect(Object.is(values[bin], expected)).toBe(true)
                }
          }
        const raw = await reader.getValues('missing', 1, 127)
        expect(
          raw.tracks.every(
            (t) =>
              t.values instanceof Float32Array && t.values.every(Number.isNaN),
          ),
        ).toBe(true)
        raw.tracks[0].values.fill(3)
        const repeated = await reader.getValues('missing', 1, 127)
        expect(repeated.tracks.every((t) => t.values.every(Number.isNaN))).toBe(
          true,
        )
      } finally {
        await reader.close()
      }
    },
  )

  it('retains a fully missing dense tile under a small decoded-cache budget', async () => {
    const reader = new FigWig({
      filehandle: new LocalFile(fixturePath('nan_positions')),
      chunkCacheBytes: 1024,
    })
    try {
      const first = await reader.getBins('missing', 0, 64, {
        binSize: 7,
        missing: 'omit',
      })
      expect(reader.getDiagnostics().chunksDecompressed).toBe(1)
      reader.resetDiagnostics()
      const repeated = await reader.getBins('missing', 0, 64, {
        binSize: 7,
        missing: 'omit',
      })
      expect(repeated).toEqual(first)
      expect(reader.getDiagnostics()).toMatchObject({
        chunksDecompressed: 0,
        dataBytes: 0,
        chunkCacheHits: 1,
      })
    } finally {
      await reader.close()
    }
  })

  it('preserves binary64 addition order and NaN counts across dense and sparse chunks', async () => {
    const reader = new FigWig({
      filehandle: new LocalFile(fixturePath('zlib')),
    })
    try {
      const track = (await reader.getTracks()).find((t) => t.name === 'wide')!,
        aggregate = Reflect.get(reader, 'aggregate') as (
          track: DecodedTrack,
          base: number,
          result: BinsResult,
          outputIndex: number,
          tileSize: number,
          missing: MissingPolicy,
          nanCounts?: Uint32Array,
        ) => void
      const patterns = [
        [2 ** 54, 1, -(2 ** 54), -1, Number.MIN_VALUE, -0, NaN, 0.25, -0.25],
        [NaN],
        [0, -0],
        [Number.MAX_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE],
        [...Array<number>(70).fill(0), 1, NaN, -1],
      ]
      for (const pattern of patterns) {
        const values = Float64Array.from(
          { length: 128 },
          (_, i) => pattern[i % pattern.length],
        )
        for (const missing of ['propagate', 'omit', 'zero'] as const) {
          for (const binSize of [1, 7, 33, 128]) {
            for (const order of [
              [0, 64],
              [64, 0],
            ]) {
              for (const sparse of [false, true]) {
                const start = 5,
                  end = 123,
                  n = Math.ceil((end - start) / binSize),
                  expected = new Float64Array(n),
                  expectedNaNs = new Uint32Array(n),
                  nanCounts =
                    missing === 'omit' ? new Uint32Array(n) : undefined,
                  result: BinsResult = {
                    chromosome: 'chr1',
                    start,
                    end,
                    binSize,
                    source: 'values',
                    starts: Uint32Array.from(
                      { length: n },
                      (_, i) => start + i * binSize,
                    ),
                    ends: Uint32Array.from({ length: n }, (_, i) =>
                      Math.min(end, start + (i + 1) * binSize),
                    ),
                    tracks: [{ track, values: new Float64Array(n) }],
                  }
                for (const base of order) {
                  // Scalar oracle follows visitation order, including cancellation
                  // that would change if a chunk's sum were computed separately.
                  for (
                    let p = Math.max(start, base);
                    p < Math.min(end, base + 64);
                    p++
                  ) {
                    const bin = Math.floor((p - start) / binSize),
                      value = values[p]
                    if (Number.isNaN(value)) {
                      if (missing === 'propagate') expected[bin] = NaN
                      else if (missing === 'omit') expectedNaNs[bin]++
                    } else if (value !== 0) expected[bin] += value
                  }
                  const chunkValues = values.subarray(base, base + 64),
                    offsets = Uint32Array.from(
                      Array.from({ length: 64 }, (_, i) => i).filter(
                        (i) => chunkValues[i] !== 0,
                      ),
                    ),
                    decoded = sparse
                      ? {
                          offsets,
                          values: Float64Array.from(
                            offsets,
                            (i) => chunkValues[i],
                          ),
                        }
                      : { values: chunkValues }
                  aggregate.call(
                    reader,
                    decoded,
                    base,
                    result,
                    0,
                    64,
                    missing,
                    nanCounts,
                  )
                }
                for (let b = 0; b < n; b++)
                  expect(
                    Object.is(result.tracks[0].values[b], expected[b]),
                  ).toBe(true)
                if (nanCounts) expect(nanCounts).toEqual(expectedNaNs)
              }
            }
          }
        }
      }
    } finally {
      await reader.close()
    }
  })

  it('reads a 200kb sparse region into bins under a 100-byte output budget', async () => {
    const reader = new FigWig({
      filehandle: new LocalFile(fixturePath('blocks')),
      maxOutputBytes: 100,
    })
    const options = {
      tracks: ['u', 'ones'],
      binSize: 100_000,
      aggregation: 'mean' as const,
      missing: 'omit' as const,
    }
    const result = await reader.getBins('chrA', 0, 200_000, options)
    expect(result.source).toBe('values')
    expect([...result.starts]).toEqual([0, 100_000])
    expect([...result.ends]).toEqual([100_000, 200_000])
    expect([...result.tracks[0].values]).toEqual([9 / 99_999, 0])
    expect([...result.tracks[1].values]).toEqual([
      33_334 / 100_000,
      33_333 / 100_000,
    ])
    // The equivalent dense output needs 1.6MB and must remain rejected.
    await expect(reader.getValues('chrA', 0, 200_000, options)).rejects.toThrow(
      /maxOutputBytes/,
    )
  })

  it('counts bin output and NaN-denominator workspace before allocation', async () => {
    const reader = new FigWig({
      filehandle: new LocalFile(fixturePath('blocks')),
      maxOutputBytes: 39,
    })
    await expect(
      reader.getBins('chrA', 0, 200_000, {
        tracks: ['u'],
        binSize: 100_000,
        missing: 'omit',
      }),
    ).rejects.toThrow(/maxOutputBytes/)
    const zero = await reader.getBins('chrA', 0, 200_000, {
      tracks: ['u'],
      binSize: 100_000,
      missing: 'zero',
    })
    expect([...zero.tracks[0].values]).toEqual([9 / 100_000, 0])
  })

  it('counts NaN runs by covered bases across partial bins and tile boundaries', async () => {
    const bytes = new Uint8Array(readFileSync(fixturePath('stored')))
    const fixed = parseFixed(bytes),
      state = parseTables(
        fixed,
        bytes.subarray(fixed.chroms, fixed.index + 8 * fixed.nGroups),
      )
    const index = parseGroup(
      bytes.subarray(state.directory[2], state.directory[3]),
      2,
      state,
      128 * 1024 ** 2,
    )
    const ref = index.chunks.find((chunk) => chunk.tile === 0)!
    expect(ref.kind).toBe(4 | (6 << 3))
    const payload = new DataView(bytes.buffer, ref.offset, ref.size)
    const valuesAt =
      Math.ceil(
        (12 + payload.getUint32(4, true) + payload.getUint32(8, true)) / 4,
      ) * 4
    // The first track's first run covers chr1:20-64. Replace its 2.5 by NaN;
    // codec0 optional CRC verification is disabled for this deliberate mutation.
    expect(payload.getFloat32(valuesAt, true)).toBe(2.5)
    payload.setFloat32(valuesAt, NaN, true)
    const reader = new FigWig({
      filehandle: new BlobFile(new Blob([bytes])),
      verify: false,
    })
    for (const missing of ['propagate', 'omit', 'zero'] as const) {
      const result = await reader.getBins('chr1', 10, 65, {
        tracks: ['runs'],
        binSize: 20,
        aggregation: 'mean',
        missing,
      })
      const expected =
        missing === 'propagate'
          ? [NaN, NaN, NaN]
          : missing === 'omit'
            ? [0, NaN, 2.5]
            : [0, 0, 2.5 / 15]
      expect([...result.tracks[0].values]).toEqual(expected)
    }
  })

  it.each(['zlib', 'stored', 'tracks_zlib', 'tracks'])(
    'shares the batch plan for %s across reordered overlapping regions',
    async (name) => {
      const reader = new FigWig({
        filehandle: new LocalFile(fixturePath(name)),
      })
      const regions = [
        { chromosome: 'chr2', start: 3, end: 100 },
        { chromosome: 'chr1', start: 59, end: 148 },
        { chromosome: 'chr1', start: 65, end: 130 },
        { chromosome: 'chr3', start: 64, end: 64 },
      ]
      const tracks = ['runs2', 'signal', 'ones', 'random', 'wide', 'site300']
      for (const missing of ['propagate', 'omit', 'zero'] as const) {
        const result = await reader.getBinsMulti(regions, {
          tracks,
          binSize: 23,
          aggregation: 'mean',
          missing,
        })
        expect(result.map((r) => r.chromosome)).toEqual(
          regions.map((r) => r.chromosome),
        )
        for (let r = 0; r < regions.length; r++) {
          expect(result[r].tracks.map((t) => t.track.name)).toEqual(tracks)
          for (const track of result[r].tracks) {
            for (let bin = 0; bin < result[r].starts.length; bin++) {
              const source = expectedValues(
                'toy',
                regions[r].chromosome,
                track.track.name,
                result[r].starts[bin],
                result[r].ends[bin],
              )
              let sum = 0,
                count = 0,
                nan = false
              for (const value of source) {
                if (Number.isNaN(value)) {
                  nan = true
                  if (missing === 'zero') count++
                } else {
                  sum += value
                  count++
                }
              }
              const expected =
                (nan && missing === 'propagate') || !count ? NaN : sum / count
              expect(track.values[bin]).toBe(expected)
            }
          }
        }
      }
    },
  )

  it('bounds the decode window while preserving identical bin results and raw values', async () => {
    const filehandle = new LocalFile(fixturePath('zlib'))
    // The small cap forces several decode windows in the same batched plan.
    const reader = new FigWig({
      filehandle,
      maxInflatedBytes: 3000,
      chunkCacheBytes: 0,
    })
    const options = {
      tracks: ['random', 'random2', 'wide', 'signal', 'ones'],
      binSize: 17,
      missing: 'zero' as const,
    }
    const first = await reader.getBins('chr1', 0, 300, options)
    const repeated = await reader.getBins('chr1', 0, 300, options)
    expect(repeated).toEqual(first)
    const raw = await reader.getValues('chr1', 0, 300, options)
    for (const track of raw.tracks)
      expect([...track.values]).toEqual([
        ...expectedValues('toy', 'chr1', track.track.name, 0, 300),
      ])
  })
})

it('preserves a literal initial U+FEFF in a chromosome name', async () => {
  const bytes = new Uint8Array(readFileSync(fixturePath('zlib')))
  const view = new DataView(bytes.buffer)
  const chroms = Number(view.getBigUint64(32, true))
  const index = Number(view.getBigUint64(48, true))
  // Both chr1 and U+FEFF + a take exactly four UTF8 bytes.
  expect(view.getUint16(chroms, true)).toBe(4)
  bytes.set(new TextEncoder().encode('\ufeffa'), chroms + 2)
  view.setUint32(
    28,
    crc32(bytes.subarray(chroms, index + 8 * view.getUint32(24, true))),
    true,
  )
  view.setUint32(104, 0, true)
  view.setUint32(104, crc32(bytes.subarray(0, 128)), true)
  const reader = new FigWig({ filehandle: new BlobFile(new Blob([bytes])) })
  expect((await reader.getHeader()).chromosomes[0].name).toBe('\ufeffa')
  expect([
    ...(await reader.getValues('\ufeffa', 0, 10, { tracks: ['ones'] }))
      .tracks[0].values,
  ]).toEqual([...expectedValues('toy', 'chr1', 'ones', 0, 10)])
  await expect(reader.getValues('a', 0, 1)).rejects.toThrow(
    /Unknown chromosome/,
  )
})
