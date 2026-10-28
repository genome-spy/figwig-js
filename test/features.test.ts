import { readFileSync } from 'node:fs'
import { BlobFile, LocalFile } from 'generic-filehandle2'
import { expect, test, vi } from 'vitest'
import { FigWig, type FeatureOptions } from '../src/index.js'
import { parseFixed, parseTables } from '../src/format/header.js'
import { parseGroup } from '../src/format/group.js'
import { fixturePath } from './conformance/oracle.js'

const open = (maxOutputBytes?: number) =>
  new FigWig({
    filehandle: new LocalFile(fixturePath('zlib')),
    maxOutputBytes,
  })

test.each([
  { aggregation: 'sum', missing: 'propagate', expected: NaN },
  { aggregation: 'sum', missing: 'omit', expected: 0 },
  { aggregation: 'sum', missing: 'zero', expected: 0 },
  { aggregation: 'mean', missing: 'propagate', expected: NaN },
  { aggregation: 'mean', missing: 'omit', expected: NaN },
  { aggregation: 'mean', missing: 'zero', expected: 0 },
] as const)(
  'one-base features honor $aggregation/$missing before zero filtering',
  async ({ aggregation, missing, expected }) => {
    const reader = open()
    const region = { chromosome: 'chr1', start: 7, end: 8 }
    const options = { tracks: ['signal'], aggregation, missing }
    try {
      const bins = await reader.getBins('chr1', 7, 8, {
        ...options,
        binSize: 1,
      })
      const features = await reader.getFeatures('chr1', 7, 8, options)
      const [batch] = await reader.getFeaturesMulti([region], options)
      const partial = await reader.getFeatures('chr1', 7, 8, {
        ...options,
        basesPerSpan: 2,
      })
      expect(bins.tracks[0].values[0]).toBe(expected)
      expect(features[0].score).toBe(expected)
      expect(batch).toEqual(features)
      expect(partial).toEqual(features)
      const filtered = await reader.getFeatures('chr1', 7, 8, {
        ...options,
        includeZeros: false,
      })
      expect(filtered).toEqual(Number.isNaN(expected) ? features : [])
    } finally {
      await reader.close()
    }
  },
)

test('one-base features keep the native raw-output budget', async () => {
  const reader = open(1)
  try {
    const features = await reader.getFeatures('chr1', 0, 1, {
      tracks: ['ones'],
      missing: 'zero',
    })
    expect(features.map(({ score }) => score)).toEqual([1])
    await expect(
      reader.getBins('chr1', 0, 1, { tracks: ['ones'], binSize: 1 }),
    ).rejects.toThrow(/maxOutputBytes/)
  } finally {
    await reader.close()
  }
})

test('default one-base features preserve raw precision and negative zero', async () => {
  const bytes = new Uint8Array(readFileSync(fixturePath('stored')))
  const fixed = parseFixed(bytes)
  const state = parseTables(
    fixed,
    bytes.subarray(fixed.chroms, fixed.index + 8 * fixed.nGroups),
  )
  const group = state.header.tracks.find(
    (track) => track.name === 'wide',
  )!.group
  const ref = parseGroup(
    bytes.subarray(state.directory[group], state.directory[group + 1]),
    group,
    state,
    128 * 1024 ** 2,
  ).chunks[0]
  const view = new DataView(bytes.buffer, ref.offset, ref.size)
  const valuesAt =
    Math.ceil((12 + view.getUint32(4, true) + view.getUint32(8, true)) / 4) * 4
  // The codec0 sparse float64 chunk stores wide:10 and wide:11 first.
  // Preserve its large integer and replace the second value with negative zero.
  view.setFloat64(valuesAt + 8, -0, true)
  const reader = new FigWig({
    filehandle: new BlobFile(new Blob([bytes])),
    verify: false,
  })
  try {
    const features = await reader.getFeatures('chr1', 10, 12, {
      tracks: ['wide'],
    })
    expect(features.map(({ score }) => score)).toEqual([2 ** 24 + 1, -0])
    expect(
      (await reader.getFeatures('chr1', 7, 8, { tracks: ['signal'] }))[0].score,
    ).toBeNaN()
  } finally {
    await reader.close()
  }
})

test.each(['aggregation', 'missing'] as const)(
  'invalid %s is rejected at every feature resolution before I/O',
  async (field) => {
    const reader = open()
    const read = vi.spyOn(reader.filehandle, 'read')
    try {
      for (const invalid of ['invalid', null]) {
        for (const basesPerSpan of [1, 2]) {
          const options = {
            tracks: ['signal'],
            basesPerSpan,
            [field]: invalid,
          } as unknown as FeatureOptions
          await expect(
            reader.getFeatures('chr1', 7, 8, options),
          ).rejects.toThrow(RangeError)
        }
      }
      expect(read).not.toHaveBeenCalled()
    } finally {
      await reader.close()
    }
  },
)
