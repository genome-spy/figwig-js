import { readFileSync } from 'node:fs'
import { BlobFile, LocalFile } from 'generic-filehandle2'
import { describe, expect, it } from 'vitest'
import { FigWig } from '../src/index.js'
import { crc32 } from '../src/utils/binary.js'
import { parseFixed, parseTables } from '../src/format/header.js'
import { parseGroup } from '../src/format/group.js'
import { expectedValues, fixturePath } from './conformance/oracle.js'

describe('direct binned aggregation', () => {
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
