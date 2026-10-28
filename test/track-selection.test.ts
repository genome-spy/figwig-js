import { readFileSync } from 'node:fs'
import { BlobFile } from 'generic-filehandle2'
import { expect, test } from 'vitest'
import { FigWig } from '../src/index.js'
import { parseFixed } from '../src/format/header.js'
import { crc32 } from '../src/utils/binary.js'
import { expectedValues, fixturePath } from './conformance/oracle.js'

function interleavedTracks() {
  const bytes = new Uint8Array(readFileSync(fixturePath('zlib')))
  const fixed = parseFixed(bytes)
  const metadata = JSON.parse(
    new TextDecoder().decode(
      bytes.subarray(fixed.metadata, fixed.metadata + fixed.metadataLength),
    ),
  ) as { tracks: { name: string; group: number }[] }
  // Move second members of three groups to the end without changing their
  // relative order within the group or the group's encoded payload slots.
  const postponed = new Set(['random2', 'runs2', 'signal'])
  const order = metadata.tracks.map((track, index) => ({ track, index }))
  order.sort(
    (a, b) =>
      Number(postponed.has(a.track.name)) - Number(postponed.has(b.track.name)),
  )
  metadata.tracks = order.map(({ track }) => track)
  const text = new TextEncoder().encode(JSON.stringify(metadata))
  if (text.length > fixed.metadataLength)
    throw new Error('Reordered metadata must fit the original table')
  bytes.fill(32, fixed.metadata, fixed.metadata + fixed.metadataLength)
  bytes.set(text, fixed.metadata)
  const statistics = bytes.slice(
    fixed.tracks,
    fixed.tracks + 32 * fixed.nTracks,
  )
  order.forEach(({ index }, destination) => {
    bytes.set(
      statistics.subarray(index * 32, (index + 1) * 32),
      fixed.tracks + destination * 32,
    )
  })
  const view = new DataView(bytes.buffer)
  view.setUint32(
    28,
    crc32(bytes.subarray(fixed.chroms, fixed.index + 8 * fixed.nGroups)),
    true,
  )
  view.setUint32(104, 0, true)
  view.setUint32(104, crc32(bytes.subarray(0, 128)), true)
  return bytes
}

test('mixed reordered selections retain group slots when metadata members are nonadjacent', async () => {
  const reader = new FigWig({
    filehandle: new BlobFile(new Blob([interleavedTracks()])),
  })
  try {
    const header = await reader.getHeader()
    const index = (name: string) =>
      header.tracks.find((track) => track.name === name)!.index
    expect(index('random2') - index('random')).toBeGreaterThan(1)
    const names = ['signal', 'random2', 'wide', 'random', 'runs2', 'runs']
    const regions = [
      { chromosome: 'chr1', start: 0, end: 160 },
      { chromosome: 'chr2', start: 10, end: 80 },
    ]
    const results = await reader.getValuesMulti(regions, {
      tracks: [
        index('signal'),
        'random2',
        'wide',
        index('random'),
        'runs2',
        'runs',
      ],
    })
    for (const result of results) {
      expect(result.tracks.map(({ track }) => track.name)).toEqual(names)
      for (const { track, values } of result.tracks) {
        expect([...values]).toEqual([
          ...expectedValues(
            'toy',
            result.chromosome,
            track.name,
            result.start,
            result.end,
          ),
        ])
      }
    }
  } finally {
    await reader.close()
  }
})

test('summary bins use the same group slots for interleaved and original metadata', async () => {
  const original = new FigWig({
    filehandle: new BlobFile(new Blob([readFileSync(fixturePath('zlib'))])),
  })
  const interleaved = new FigWig({
    filehandle: new BlobFile(new Blob([interleavedTracks()])),
  })
  try {
    const options = {
      tracks: ['signal', 'random2', 'wide', 'random', 'runs2', 'runs'],
      binSize: 64,
      aggregation: 'sum' as const,
      missing: 'zero' as const,
      useSummaries: true,
    }
    const expected = await original.getBins('chr1', 0, 256, options)
    const actual = await interleaved.getBins('chr1', 0, 256, options)
    expect(expected.source).toBe('summary')
    expect(actual.source).toBe('summary')
    expect(actual.starts).toEqual(expected.starts)
    expect(actual.ends).toEqual(expected.ends)
    expect(actual.tracks.map(({ track }) => track.name)).toEqual(options.tracks)
    expect(actual.tracks.map(({ values }) => [...values])).toEqual(
      expected.tracks.map(({ values }) => [...values]),
    )
  } finally {
    await Promise.all([original.close(), interleaved.close()])
  }
})
