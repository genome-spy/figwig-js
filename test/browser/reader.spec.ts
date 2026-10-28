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
