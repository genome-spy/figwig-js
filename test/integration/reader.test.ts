import { resolve } from 'node:path'
import { BlobFile, LocalFile, RemoteFile } from 'generic-filehandle2'
import { readFile } from 'node:fs/promises'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { FigWig } from '../../src/index.js'
import { startRangeServer } from '../../benchmarks/server/range-server.js'

const root = resolve(import.meta.dirname, '../fixtures')
let server: Awaited<ReturnType<typeof startRangeServer>>
beforeAll(async () => {
  server = await startRangeServer({
    root,
    latencyMs: 5,
    bandwidthBitsPerSecond: 50_000_000,
  })
})
afterAll(async () => {
  await server?.close()
})
async function settled() {
  while (server.metrics.active)
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1))
}

test.each(['zlib', 'tracks_zlib', 'appended', 'blocks'])(
  'RemoteFile ranges match LocalFile and BlobFile for %s',
  async (name) => {
    await settled()
    server.resetMetrics()
    const file = `${name}.fw`,
      bytes = await readFile(resolve(root, file)),
      tracks = name === 'blocks' ? ['u', 'ones'] : ['wide', 'signal', 'ones']
    const chromosome = name === 'blocks' ? 'chrA' : 'chr1',
      regions = [
        { chromosome, start: 0, end: 100 },
        { chromosome, start: 60, end: 150 },
        { chromosome, start: 20, end: 20 },
      ]
    const remote = new FigWig({
      filehandle: new RemoteFile(`${server.url}/${file}`),
      maxConcurrentRequests: 2,
    })
    const local = new FigWig({ filehandle: new LocalFile(resolve(root, file)) })
    const blob = new FigWig({ filehandle: new BlobFile(new Blob([bytes])) })
    const result = await remote.getValuesMulti(regions, { tracks })
    expect(result).toEqual(await local.getValuesMulti(regions, { tracks }))
    expect(result).toEqual(await blob.getValuesMulti(regions, { tracks }))
    await settled()
    expect(
      server.metrics.ranges.every(
        (r) => r.range?.startsWith('bytes=') && r.status === 206,
      ),
    ).toBe(true)
    expect(server.metrics.peakConcurrent).toBeLessThanOrEqual(2)
    if (name !== 'blocks')
      expect(server.metrics.bodyBytes).toBeLessThan(bytes.length)
    const requests = server.metrics.requests
    expect(
      await remote.getValuesMulti([...regions].reverse(), {
        tracks: [...tracks].reverse(),
      }),
    ).toEqual(
      await local.getValuesMulti([...regions].reverse(), {
        tracks: [...tracks].reverse(),
      }),
    )
    await settled()
    expect(server.metrics.requests).toBe(requests)
    await Promise.all([remote.close(), local.close(), blob.close()])
  },
)

test('overlapping concurrent queries share indexes and chunks even when a waiter aborts', async () => {
  await settled()
  server.resetMetrics()
  const remote = new FigWig({
    filehandle: new RemoteFile(`${server.url}/zlib.fw`),
  })
  const local = new FigWig({
    filehandle: new LocalFile(resolve(root, 'zlib.fw')),
  })
  await remote.getHeader()
  const controller = new AbortController()
  const aborted = remote.getValues('chr1', 0, 100, {
    tracks: ['signal'],
    signal: controller.signal,
  })
  const rejection = expect(aborted).rejects.toHaveProperty('name', 'AbortError')
  const surviving = remote.getValues('chr1', 0, 100, { tracks: ['signal'] })
  setTimeout(() => controller.abort(), 2)
  await rejection
  expect(await surviving).toEqual(
    await local.getValues('chr1', 0, 100, { tracks: ['signal'] }),
  )
  const diagnostics = remote.getDiagnostics()
  expect(diagnostics.chunksFetched).toBe(2)
  await settled()
  expect(server.metrics.cancelled).toBe(0)
  await Promise.all([remote.close(), local.close()])
})

test('batch deduplication fetches each chunk once and coalescing is configurable', async () => {
  await settled()
  server.resetMetrics()
  const regions = [
    { chromosome: 'chr1', start: 0, end: 100 },
    { chromosome: 'chr1', start: 0, end: 100 },
    { chromosome: 'chr1', start: 60, end: 150 },
  ]
  const coalesced = new FigWig({
    filehandle: new RemoteFile(`${server.url}/zlib.fw`),
    coalesceGap: 100_000,
  })
  const separate = new FigWig({
    filehandle: new RemoteFile(`${server.url}/zlib.fw`),
    coalesceGap: 0,
  })
  const a = await coalesced.getValuesMulti(regions, {
    tracks: ['signal', 'u32', 'wide'],
  })
  const b = await separate.getValuesMulti(regions, {
    tracks: ['signal', 'u32', 'wide'],
  })
  expect(a).toEqual(b)
  expect(coalesced.getDiagnostics().chunksFetched).toBe(
    separate.getDiagnostics().chunksFetched,
  )
  expect(coalesced.getDiagnostics().readRequests).toBeLessThanOrEqual(
    separate.getDiagnostics().readRequests,
  )
  const hits = coalesced.getDiagnostics().chunkCacheHits
  await coalesced.getValuesMulti(regions, { tracks: ['signal'] })
  expect(coalesced.getDiagnostics().chunkCacheHits).toBeGreaterThan(hits)
  await Promise.all([coalesced.close(), separate.close()])
})

test.each(['zlib', 'tracks_zlib'])(
  '%s coalesces HTTP index ranges without transferring extra bytes',
  async (name) => {
    const coalesced = new FigWig({ url: `${server.url}/${name}.fw` }),
      separate = new FigWig({
        url: `${server.url}/${name}.fw`,
        maxCoalescedBytes: 1,
      })
    try {
      const header = await coalesced.getHeader()
      await separate.getHeader()
      const tracks = [
        ...new Map(
          header.tracks.map((track) => [track.group, track.name]),
        ).values(),
      ].slice(0, 3)
      await settled()
      server.resetMetrics()
      coalesced.resetDiagnostics()
      const together = await coalesced.getZoomLevels({ tracks })
      await settled()
      const togetherMetrics = server.metrics
      expect(togetherMetrics.requests).toBe(1)
      expect(coalesced.getDiagnostics()).toMatchObject({
        readRequests: 1,
        dataBytes: 0,
      })
      server.resetMetrics()
      separate.resetDiagnostics()
      expect(await separate.getZoomLevels({ tracks })).toEqual(together)
      await settled()
      expect(server.metrics.requests).toBe(3)
      expect(server.metrics.bodyBytes).toBe(togetherMetrics.bodyBytes)
      expect(separate.getDiagnostics().indexBytes).toBe(
        coalesced.getDiagnostics().indexBytes,
      )
    } finally {
      await Promise.all([coalesced.close(), separate.close()])
    }
  },
)
