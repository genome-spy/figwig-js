import { test, expect } from '@playwright/test'
import { build } from 'esbuild'
import { createServer, type Server } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { builtinModules } from 'node:module'
import { startRangeServer } from '../../benchmarks/server/range-server.js'
import type {} from './entry.js'

interface OracleTrack {
  positions: number[]
  values: (number | string)[]
}
interface Oracle {
  datasets: Record<
    string,
    { chromosomes: Record<string, { tracks: Record<string, OracleTrack> }> }
  >
  files: Record<string, { size: number }>
}

const root = resolve(import.meta.dirname, '../..')
let rangeServer: Awaited<ReturnType<typeof startRangeServer>>
let appServer: Server
let appUrl: string
let oracle: Oracle

function expectedValues(track: string, start: number, end: number) {
  const sparse = oracle.datasets.toy.chromosomes.chr1.tracks[track]
  const values = new Array<number>(end - start).fill(0)
  for (let i = 0; i < sparse.positions.length; i++) {
    const position = sparse.positions[i]
    if (position >= start && position < end) {
      const value = sparse.values[i]
      values[position - start] =
        value === 'NaN' ? NaN : value === '-0' ? -0 : Number(value)
    }
  }
  return values
}

test.beforeAll(async ({ browser }) => {
  console.info(`Browser verification: Chromium ${browser.version()}`)
  oracle = JSON.parse(
    await readFile(resolve(root, 'test/fixtures/expected.json'), 'utf8'),
  ) as Oracle
  const bundle = await build({
    absWorkingDir: root,
    entryPoints: ['test/browser/entry.ts'],
    bundle: true,
    platform: 'browser',
    target: 'es2022',
    format: 'esm',
    write: false,
    metafile: true,
  })
  // A browser-targeted build must succeed without aliases or Node polyfills.
  const builtins = new Set(
    builtinModules.map((name) => name.replace(/^node:/, '')),
  )
  for (const input of Object.values(bundle.metafile.inputs)) {
    for (const imported of input.imports) {
      expect(
        imported.path.startsWith('node:') || builtins.has(imported.path),
      ).toBe(false)
    }
  }
  expect(
    Object.keys(bundle.metafile.inputs).some((path) =>
      /generic-filehandle2\/.*localFile/.test(path),
    ),
  ).toBe(false)
  // The shared ESM entry also exports compression. It must be tree-shaken out.
  expect(
    Object.values(bundle.metafile.outputs).some((output) =>
      Object.entries(output.inputs).some(
        ([path, input]) =>
          /pako-esm2\/esm\/(?:zlib\/)?deflate\.js$/.test(path) &&
          input.bytesInOutput > 0,
      ),
    ),
  ).toBe(false)
  const javascript = bundle.outputFiles[0].text
  appServer = createServer((request, response) => {
    if (request.url === '/bundle.js') {
      response
        .writeHead(200, { 'Content-Type': 'text/javascript' })
        .end(javascript)
    } else {
      response
        .writeHead(200, { 'Content-Type': 'text/html' })
        .end(
          '<!doctype html><title>Figwig browser tests</title><script type="module" src="/bundle.js"></script>',
        )
    }
  })
  await new Promise<void>((resolveListen) =>
    appServer.listen(0, '127.0.0.1', resolveListen),
  )
  const address = appServer.address()
  if (!address || typeof address === 'string')
    throw new Error('Failed to start browser application server')
  appUrl = `http://127.0.0.1:${address.port}`
  // A distinct origin also tests CORS response headers. Latency makes actual
  // cancellation observable without relying on a race against local disk I/O.
  rangeServer = await startRangeServer({
    root: resolve(root, 'test/fixtures'),
    latencyMs: 30,
  })
})

test.afterAll(async () => {
  await rangeServer?.close()
  if (appServer)
    await new Promise<void>((resolveClose, reject) => {
      appServer.close((error) => (error ? reject(error) : resolveClose()))
      appServer.closeAllConnections()
    })
})

test.beforeEach(async ({ page }) => {
  await page.goto(appUrl)
  await page.waitForFunction(() => typeof window.FigWig === 'function')
})

test('reads metadata, selected native dtypes, and overlapping regions through real HTTP ranges', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const result = await page.evaluate(async (url) => {
    const reader = new window.FigWig({
      filehandle: new window.RemoteFile(`${url}/zlib.fw`),
      coalesceGap: 0,
    })
    window.figwigReader = reader
    const header = await reader.getHeader()
    const selected = await reader.selectTracks({ assay: 'ATAC' })
    const values = await reader.getValues('chr1', 50, 150, {
      tracks: ['wide', 'signal', 'ones'],
    })
    return {
      version: header.version,
      order: header.order,
      genome: header.genome,
      chromosomes: header.chromosomes.map((chromosome) => ({
        name: chromosome.name,
        length: chromosome.length,
      })),
      selected: selected.map((track) => track.name),
      tracks: values.tracks.map(({ track, values: trackValues }) => ({
        name: track.name,
        dtype: trackValues.constructor.name,
        values: Array.from(trackValues),
      })),
    }
  }, rangeServer.url)
  expect(result.version).toBe(1)
  expect(result.order).toBe('positions')
  expect(result.genome).toBe('toy')
  expect(result.selected).toEqual(['signal'])
  expect(result.chromosomes).toContainEqual({ name: 'chr1', length: 300 })
  expect(result.tracks.map((track) => track.name)).toEqual([
    'wide',
    'signal',
    'ones',
  ])
  expect(result.tracks.map((track) => track.dtype)).toEqual([
    'Float64Array',
    'Float32Array',
    'Uint8Array',
  ])
  for (const track of result.tracks)
    expect(track.values).toEqual(expectedValues(track.name, 50, 150))

  const beforeOverlap = rangeServer.metrics.requests
  const overlap = await page.evaluate(async () => {
    const values = await window.figwigReader!.getValues('chr1', 60, 140, {
      tracks: ['signal', 'wide'],
    })
    return values.tracks.map(({ track, values: trackValues }) => ({
      name: track.name,
      values: Array.from(trackValues),
    }))
  })
  for (const track of overlap)
    expect(track.values).toEqual(expectedValues(track.name, 60, 140))
  expect(rangeServer.metrics.requests).toBe(beforeOverlap)
  const metrics = rangeServer.metrics
  expect(metrics.ranges.length).toBeGreaterThan(0)
  expect(
    metrics.ranges.every(
      (range) => range.range?.startsWith('bytes=') && range.status === 206,
    ),
  ).toBe(true)
  expect(metrics.bodyBytes).toBeLessThan(oracle.files.zlib.size)
  expect(errors).toEqual([])
})

test('reads compressed track-order blocks and a browser Blob against the independent oracle', async ({
  page,
}) => {
  const result = await page.evaluate(async (url) => {
    const remote = new window.FigWig({
      filehandle: new window.RemoteFile(`${url}/tracks_zlib.fw`),
    })
    const tracks = ['u32', 'wide', 'signal']
    const remoteValues = await remote.getValues('chr1', 0, 100, { tracks })
    const blob = await (await fetch(`${url}/zlib.fw`)).blob()
    const local = new window.FigWig({ filehandle: new window.BlobFile(blob) })
    const blobValues = await local.getValues('chr1', 0, 100, { tracks })
    return [remoteValues, blobValues].map((values) =>
      values.tracks.map(({ track, values: trackValues }) => ({
        name: track.name,
        values: Array.from(trackValues),
      })),
    )
  }, rangeServer.url)
  for (const source of result)
    for (const track of source) {
      expect(track.values).toEqual(expectedValues(track.name, 0, 100))
    }
})

test('keeps missing gaps distinct from zeros and caches compact NaN tiles', async ({
  page,
}) => {
  const results = await page.evaluate(async (url) => {
    const results = []
    for (const file of ['nan_positions', 'nan_tracks']) {
      const reader = new window.FigWig({
        url: `${url}/${file}.fw`,
        chunkCacheBytes: 1024,
      })
      try {
        await reader.getBins('missing', 0, 64, { binSize: 7, missing: 'omit' })
        reader.resetDiagnostics()
        await reader.getBins('missing', 0, 64, { binSize: 7, missing: 'omit' })
        const repeated = reader.getDiagnostics()
        const policies = []
        for (const missing of ['propagate', 'omit', 'zero'] as const) {
          const gaps = await reader.getBins('missing', 3, 125, {
            binSize: 23,
            missing,
          })
          const mixed = await reader.getBins('mixed', 0, 64, {
            binSize: 64,
            missing,
          })
          const zeros = await reader.getBins('unwritten', 0, 64, {
            binSize: 64,
            missing,
          })
          policies.push({
            missing,
            gaps: gaps.tracks.map((t) => Array.from(t.values)),
            mixed: mixed.tracks.map((t) => t.values[0]),
            zeros: zeros.tracks.map((t) => t.values[0]),
          })
        }
        const raw = await reader.getValues('missing', 3, 125)
        results.push({
          file,
          repeated,
          policies,
          rawMissing: raw.tracks.every(
            (t) =>
              t.values instanceof Float32Array && t.values.every(Number.isNaN),
          ),
        })
      } finally {
        await reader.close()
      }
    }
    return results
  }, rangeServer.url)
  for (const result of results) {
    expect(result.rawMissing).toBe(true)
    if (result.file === 'nan_positions')
      expect(result.repeated).toMatchObject({
        dataBytes: 0,
        chunksDecompressed: 0,
        chunkCacheHits: 1,
      })
    for (const row of result.policies) {
      expect(row.zeros).toEqual([0, 0, 0, 0])
      expect(
        row.gaps.every((values) =>
          values.every((v) =>
            row.missing === 'zero' ? v === 0 : Number.isNaN(v),
          ),
        ),
      ).toBe(true)
      expect(row.mixed).toEqual(
        row.missing === 'propagate'
          ? [NaN, NaN, NaN, NaN]
          : row.missing === 'omit'
            ? [0, 2.5, NaN, NaN]
            : [0, 2.5 / 64, 0, 0],
      )
    }
  }
})

test('reuses only verified missing streams within each browser query and keeps summaries separate', async ({
  page,
}) => {
  const result = await page.evaluate(async (url) => {
    const reader = new window.FigWig({
      url: `${url}/nan_positions.fw`,
      chunkCacheBytes: 0,
    })
    try {
      const summary = await reader.getBins('missing', 0, 128, {
        binSize: 64,
        missing: 'zero',
        requireSummaries: true,
      })
      const summaryMetrics = reader.getDiagnostics()
      const exact = []
      for (let i = 0; i < 2; i++) {
        reader.resetDiagnostics()
        const bins = await reader.getBins('missing', 3, 125, {
          binSize: 17,
          missing: 'omit',
        })
        exact.push({
          source: bins.source,
          allMissing: bins.tracks.every((t) => t.values.every(Number.isNaN)),
          metrics: reader.getDiagnostics(),
        })
      }
      return {
        summarySource: summary.source,
        summaryZero: summary.tracks.every((t) =>
          t.values.every((v) => v === 0),
        ),
        summaryMetrics,
        exact,
      }
    } finally {
      await reader.close()
    }
  }, rangeServer.url)
  expect(result.summarySource).toBe('summary')
  expect(result.summaryZero).toBe(true)
  expect(result.summaryMetrics).toMatchObject({
    dataBytes: 0,
    chunksFetched: 0,
  })
  for (const row of result.exact) {
    expect(row.source).toBe('values')
    expect(row.allMissing).toBe(true)
    expect(row.metrics).toMatchObject({
      chunksFetched: 2,
      chunksDecompressed: 1,
      chunkCacheHits: 0,
    })
  }
})

test('requires stored summaries over HTTP without falling back to raw chunks', async ({
  page,
}) => {
  const result = await page.evaluate(async (url) => {
    const reader = new window.FigWig({
      filehandle: new window.RemoteFile(`${url}/zlib.fw`),
    })
    try {
      const bins = await reader.getBins('chr1', 0, 300, {
        tracks: ['wide'],
        binSize: 256,
        missing: 'zero',
        useSummaries: false,
        requireSummaries: true,
      })
      const batchError = await reader
        .getBinsMulti(
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
        )
        .then(
          () => 'resolved',
          (error: Error) => `${error.name}: ${error.message}`,
        )
      return {
        source: bins.source,
        ends: Array.from(bins.ends),
        values: Array.from(bins.tracks[0].values),
        batchError,
        diagnostics: reader.getDiagnostics(),
      }
    } finally {
      await reader.close()
    }
  }, rangeServer.url)
  expect(result.source).toBe('summary')
  expect(result.ends).toEqual([256, 300])
  expect(result.values).toEqual([Math.fround(2 ** 24 + 1.5) / 256, 0])
  expect(result.batchError).toMatch(
    /^RangeError: Required summaries.*chr2:1-65/,
  )
  expect(result.diagnostics).toMatchObject({ dataBytes: 0, chunksFetched: 0 })
})

test('cancels before and during reads while preserving another concurrent query', async ({
  page,
}) => {
  const result = await page.evaluate(async (url) => {
    const reader = new window.FigWig({
      filehandle: new window.RemoteFile(`${url}/zlib.fw`),
    })
    const alreadyAborted = new AbortController()
    alreadyAborted.abort()
    const preAbort = await reader
      .getValues('chr1', 0, 100, {
        tracks: ['runs'],
        signal: alreadyAborted.signal,
      })
      .then(
        () => 'resolved',
        (error: Error) => error.name,
      )
    await reader.getHeader()
    const controller = new AbortController()
    const first = reader
      .getValues('chr1', 0, 100, {
        tracks: ['runs'],
        signal: controller.signal,
      })
      .then(
        () => 'resolved',
        (error: Error) => error.name,
      )
    const second = reader.getValues('chr1', 0, 100, { tracks: ['runs'] })
    setTimeout(() => controller.abort(), 10)
    const [aborted, surviving] = await Promise.all([first, second])
    return { preAbort, aborted, values: Array.from(surviving.tracks[0].values) }
  }, rangeServer.url)
  expect(result.preAbort).toBe('AbortError')
  expect(result.aborted).toBe('AbortError')
  expect(result.values).toEqual(expectedValues('runs', 0, 100))
})

test('closing a reader cancels pending browser reads and prevents late cache refills', async ({
  page,
}) => {
  const result = await page.evaluate(async (url) => {
    const blob = await (await fetch(`${url}/zlib.fw`)).blob()
    const underlying = new window.BlobFile(blob)
    let reads = 0,
      closes = 0,
      blockNext = false
    let enter!: () => void, release!: () => void, complete!: () => void
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const completed = new Promise<void>((resolve) => {
      complete = resolve
    })
    const reader = new window.FigWig({
      filehandle: {
        read: async (...args: Parameters<typeof underlying.read>) => {
          reads++
          const held = blockNext
          if (held) {
            blockNext = false
            enter()
            // Deliberately ignore cancellation to simulate a late filehandle.
            await blocked
          }
          try {
            return await underlying.read(...args)
          } finally {
            if (held) complete()
          }
        },
        stat: underlying.stat.bind(underlying),
        readFile: underlying.readFile.bind(underlying),
        close: async () => {
          closes++
          await underlying.close()
        },
      },
    })
    await reader.getHeader()
    blockNext = true
    const pending = reader
      .getValues('chr1', 0, 100, { tracks: ['signal'] })
      .then(
        () => 'resolved',
        (error: Error) => error.name,
      )
    await entered
    const readsAtClose = reads
    await Promise.all([reader.close(), reader.close()])
    // This timeout only bounds a failure: cancellation must settle while the
    // underlying read is still blocked, not after it eventually returns.
    const outcome = await new Promise<string>((resolve) => {
      const timeout = setTimeout(() => resolve('pending'), 5000)
      void pending.then((value) => {
        clearTimeout(timeout)
        resolve(value)
      })
    })
    const cacheAtClose = reader.getDiagnostics().cacheBytes
    release()
    await completed
    // Let all late read/cache promise continuations finish before inspection.
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    const afterClose = await reader.getHeader().then(
      () => 'resolved',
      (error: Error) => error.name,
    )
    await reader.close()
    return {
      outcome,
      afterClose,
      readsAtClose,
      readsAfterLateCompletion: reads,
      cacheAtClose,
      cacheAfterLateCompletion: reader.getDiagnostics().cacheBytes,
      closes,
    }
  }, rangeServer.url)
  expect(result.outcome).toBe('AbortError')
  expect(result.afterClose).toBe('AbortError')
  expect(result.readsAfterLateCompletion).toBe(result.readsAtClose)
  expect(result.cacheAtClose).toBe(0)
  expect(result.cacheAfterLateCompletion).toBe(0)
  expect(result.closes).toBe(1)
})

test('coalesces group metadata probes in both storage orders', async ({
  page,
}) => {
  const results = await page.evaluate(async (url) => {
    const results = []
    for (const file of ['zlib', 'tracks_zlib']) {
      const reader = new window.FigWig({ url: `${url}/${file}.fw` }),
        separate = new window.FigWig({
          url: `${url}/${file}.fw`,
          maxCoalescedBytes: 1,
        })
      try {
        const header = await reader.getHeader()
        await separate.getHeader()
        const tracks = [
          ...new Map(
            header.tracks.map((track) => [track.group, track.name]),
          ).values(),
        ].slice(0, 3)
        reader.resetDiagnostics()
        separate.resetDiagnostics()
        const levels = await reader.getZoomLevels({ tracks })
        const first = reader.getDiagnostics()
        const individual = await separate.getZoomLevels({ tracks })
        const repeated = await reader.getZoomLevels({
          tracks: [...tracks].reverse(),
        })
        results.push({
          levels,
          individual,
          separate: separate.getDiagnostics(),
          repeated,
          first,
          after: reader.getDiagnostics(),
        })
      } finally {
        await Promise.all([reader.close(), separate.close()])
      }
    }
    return results
  }, rangeServer.url)
  for (const result of results) {
    expect(result.first.readRequests).toBeGreaterThan(0)
    expect(result.first.readRequests).toBeLessThan(result.separate.readRequests)
    expect(result.first.dataBytes).toBe(0)
    expect(result.individual).toEqual(result.levels)
    expect(result.repeated).toEqual(result.levels)
    expect(result.after.readRequests).toBe(result.first.readRequests)
    expect(result.after.indexBytes).toBe(result.first.indexBytes)
    expect(result.levels.length).toBeGreaterThan(0)
    for (const level of result.levels) expect(level.groups).toEqual([0, 1, 2])
  }
})

test('warm summaries need no HTTP reads when raw-index retention is disabled', async ({
  page,
}) => {
  const results = await page.evaluate(async (url) => {
    const results = []
    for (const file of ['zlib', 'tracks_zlib']) {
      const reader = new window.FigWig({
        url: `${url}/${file}.fw`,
        indexCacheBytes: 0,
        chunkCacheBytes: 0,
        coalesceGap: 0,
      })
      try {
        const header = await reader.getHeader(),
          track = header.tracks.find((track) => track.name === 'wide')!
        await reader.getSummary(track.group)
        await reader.getSummary(track.group, 1)
        const levels = await reader.getZoomLevels({ tracks: [track.name] }),
          regions = [
            { chromosome: 'chr1', start: 0, end: 128 },
            { chromosome: 'chr1', start: 128, end: 256 },
          ],
          options = {
            tracks: [track.name],
            binSize: header.tileSize,
            aggregation: 'sum' as const,
            missing: 'zero' as const,
            requireSummaries: true,
          }
        const first = await reader.getBinsMulti(regions, options)
        reader.resetDiagnostics()
        const repeated = await reader.getBinsMulti(regions, options),
          coarse = await reader.getBins('chr1', 0, 256, {
            ...options,
            binSize: 256,
          }),
          repeatedLevels = await reader.getZoomLevels({ tracks: [track.name] })
        results.push({
          first,
          repeated,
          coarseSource: coarse.source,
          levels,
          repeatedLevels,
          diagnostics: reader.getDiagnostics(),
        })
      } finally {
        await reader.close()
      }
    }
    return results
  }, rangeServer.url)
  for (const result of results) {
    expect(result.repeated).toEqual(result.first)
    expect(result.repeated.every((batch) => batch.source === 'summary')).toBe(
      true,
    )
    expect(result.coarseSource).toBe('summary')
    expect(result.repeatedLevels).toEqual(result.levels)
    expect(result.diagnostics).toMatchObject({
      readRequests: 0,
      indexBytes: 0,
      dataBytes: 0,
      chunksFetched: 0,
    })
    expect(result.diagnostics.cacheBytes).toBeGreaterThan(0)
  }
})
