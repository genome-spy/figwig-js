import { test, expect } from '@playwright/test'
import { build } from 'esbuild'
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { startRangeServer } from '../../benchmarks/server/range-server.js'
import type {} from './entry.js'

interface Query {
  name: string
  chromosome: string
  start: number
  end: number
  binSize: number
  tracks: number[]
  expected: Record<string, number[]>
}
interface Level {
  group: number
  level: number
  source_offset: number
  source_bytes: number
  window_bins: number
}
interface Manifest {
  queries: Query[]
  files: Record<string, { levels: Level[] }>
}
const root = resolve(import.meta.dirname, '../..')
let ranges: Awaited<ReturnType<typeof startRangeServer>>
let app: Server
let appUrl: string
let manifest: Manifest

test.beforeAll(async () => {
  manifest = JSON.parse(
    await readFile(
      resolve(root, 'test/fixtures/summary-expected.json'),
      'utf8',
    ),
  ) as Manifest
  const bundle = await build({
    absWorkingDir: root,
    entryPoints: ['test/browser/entry.ts'],
    bundle: true,
    platform: 'browser',
    target: 'es2022',
    format: 'esm',
    write: false,
  })
  app = createServer((request, response) => {
    if (request.url === '/bundle.js')
      response
        .writeHead(200, { 'Content-Type': 'text/javascript' })
        .end(bundle.outputFiles[0].text)
    else
      response
        .writeHead(200, { 'Content-Type': 'text/html' })
        .end(
          '<!doctype html><title>Summary restart browser tests</title><script type="module" src="/bundle.js"></script>',
        )
  })
  await new Promise<void>((done) => app.listen(0, '127.0.0.1', done))
  const address = app.address()
  if (!address || typeof address === 'string')
    throw new Error('Cannot start summary browser application')
  appUrl = `http://127.0.0.1:${address.port}`
  ranges = await startRangeServer({
    root: resolve(root, 'test/fixtures'),
    latencyMs: 10,
    bandwidthBitsPerSecond: 50_000_000,
    maxConcurrent: 6,
  })
  // Real cross-origin CORS filtering, rather than a mock filehandle size.
  ranges.server.on(
    'request',
    (_request: IncomingMessage, response: ServerResponse) =>
      response.removeHeader('Access-Control-Expose-Headers'),
  )
})

test.afterAll(async () => {
  await ranges?.close()
  if (app)
    await new Promise<void>((done, reject) => {
      app.close((error) => (error ? reject(error) : done()))
      app.closeAllConnections()
    })
})

test.beforeEach(async ({ page }) => {
  await page.goto(appUrl)
  await page.waitForFunction(() => typeof window.FigWig === 'function')
})

for (const order of ['positions', 'tracks']) {
  test(`${order}: regional summaries use real bounded ranges at 50 Mbps / 10 ms`, async ({
    page,
  }) => {
    const name = `summary_${order}`
    const first = manifest.queries.find((query) => query.name === 'base')!
    const cold = await page.evaluate(
      async ({ url, name, query }) => {
        const reader = new window.FigWig({ url: `${url}/${name}.fw` })
        window.figwigReader = reader
        await reader.getHeader()
        const size = (await reader.filehandle.stat()).size
        const before = reader.getDiagnostics()
        const result = await reader.getBins(
          query.chromosome,
          query.start,
          query.end,
          {
            tracks: query.tracks,
            binSize: query.binSize,
            aggregation: 'sum',
            missing: 'zero',
            requireSummaries: true,
          },
        )
        return {
          size,
          before,
          after: reader.getDiagnostics(),
          source: result.source,
          values: Object.fromEntries(
            result.tracks.map(({ track, values }) => [
              track.name,
              Array.from(values),
            ]),
          ),
        }
      },
      { url: ranges.url, name, query: first },
    )
    expect(cold.size).toBe(0)
    expect(cold.source).toBe('summary')
    expect(cold.values).toEqual(first.expected)
    expect(cold.after.summaryIndexBytes).toBeGreaterThan(0)
    expect(cold.after.summaryInflatedBytes).toBeLessThan(64 * 1024)
    const coldRanges = ranges.metrics.ranges.filter(
      (range) => range.path === `/${name}.fw`,
    )
    expect(coldRanges.every((range) => range.status === 206)).toBe(true)
    expect(coldRanges.every((range) => range.range?.startsWith('bytes='))).toBe(
      true,
    )
    for (const level of manifest.files[name].levels.filter(
      (level) => level.level === 0 && level.window_bins > 0,
    ))
      expect(
        coldRanges.some(
          (range) =>
            range.start <= level.source_offset &&
            range.end + 1 >= level.source_offset + level.source_bytes,
        ),
      ).toBe(false)

    const same = manifest.queries.find(
      (query) => query.name === 'same-window-pan',
    )!
    const repeat = await page.evaluate(async (query) => {
      const reader = window.figwigReader!
      const before = reader.getDiagnostics()
      const result = await reader.getBins(
        query.chromosome,
        query.start,
        query.end,
        {
          tracks: query.tracks,
          binSize: query.binSize,
          aggregation: 'sum',
          missing: 'zero',
          requireSummaries: true,
        },
      )
      return {
        requests: reader.getDiagnostics().readRequests - before.readRequests,
        values: Object.fromEntries(
          result.tracks.map(({ track, values }) => [
            track.name,
            Array.from(values),
          ]),
        ),
      }
    }, same)
    expect(repeat.values).toEqual(same.expected)
    expect(repeat.requests).toBe(0)

    for (const query of manifest.queries.filter(
      (query) => !['base', 'same-window-pan'].includes(query.name),
    )) {
      const result = await page.evaluate(async (query) => {
        const reader = window.figwigReader!
        const before = reader.getDiagnostics()
        const result = await reader.getBins(
          query.chromosome,
          query.start,
          query.end,
          {
            tracks: query.tracks,
            binSize: query.binSize,
            aggregation: 'sum',
            missing: 'zero',
            requireSummaries: true,
          },
        )
        const after = reader.getDiagnostics()
        return {
          source: result.source,
          payloadBytes: after.summaryBytes - before.summaryBytes,
          requests: after.readRequests - before.readRequests,
          values: Object.fromEntries(
            result.tracks.map(({ track, values }) => [
              track.name,
              Array.from(values),
            ]),
          ),
        }
      }, query)
      expect(result.source, query.name).toBe('summary')
      expect(result.values, query.name).toEqual(query.expected)
      if (query.name === 'empty-window') expect(result.payloadBytes).toBe(0)
      if (query.name === 'overview')
        expect(result.requests).toBeLessThanOrEqual(
          order === 'positions' ? 2 : 2 * query.tracks.length,
        )
    }

    const comparison = await page.evaluate(
      async ({ url, name, query }) => {
        const legacy = new window.FigWig({ url: `${url}/${name}_legacy.fw` })
        try {
          const options = {
            tracks: query.tracks,
            binSize: query.binSize,
            aggregation: 'sum' as const,
            missing: 'zero' as const,
            requireSummaries: true,
          }
          const indexed = await window.figwigReader!.getBins(
            query.chromosome,
            query.start,
            query.end,
            options,
          )
          const ordinary = await legacy.getBins(
            query.chromosome,
            query.start,
            query.end,
            options,
          )
          const raw = await window.figwigReader!.getValues('chrA', 0, 40, {
            tracks: [0, 1, 7],
          })
          const rawLegacy = await legacy.getValues('chrA', 0, 40, {
            tracks: [0, 1, 7],
          })
          return {
            indexed: indexed.tracks.map((track) => Array.from(track.values)),
            legacy: ordinary.tracks.map((track) => Array.from(track.values)),
            raw: raw.tracks.map((track) => Array.from(track.values)),
            rawLegacy: rawLegacy.tracks.map((track) =>
              Array.from(track.values),
            ),
          }
        } finally {
          await legacy.close()
          await window.figwigReader!.close()
        }
      },
      { url: ranges.url, name, query: first },
    )
    expect(comparison.indexed).toEqual(comparison.legacy)
    expect(comparison.raw).toEqual(comparison.rawLegacy)
  })

  test(`${order}: one aborted summary waiter preserves a shared browser fill`, async ({
    page,
  }) => {
    const query = manifest.queries.find((query) => query.name === 'base')!
    const result = await page.evaluate(
      async ({ url, order, query }) => {
        const reader = new window.FigWig({
          url: `${url}/summary_${order}.fw`,
        })
        try {
          await reader.getHeader()
          const controller = new AbortController()
          const options = {
            tracks: query.tracks,
            binSize: query.binSize,
            aggregation: 'sum' as const,
            missing: 'zero' as const,
            requireSummaries: true,
          }
          const aborted = reader
            .getBins(query.chromosome, query.start, query.end, {
              ...options,
              signal: controller.signal,
            })
            .then(
              () => 'unexpected success',
              (error: Error) => error.name,
            )
          const survivor = reader.getBins(
            query.chromosome,
            query.start,
            query.end,
            options,
          )
          setTimeout(() => controller.abort(), 2)
          const result = await survivor
          return {
            aborted: await aborted,
            source: result.source,
            values: Object.fromEntries(
              result.tracks.map(({ track, values }) => [
                track.name,
                Array.from(values),
              ]),
            ),
          }
        } finally {
          await reader.close()
        }
      },
      { url: ranges.url, order, query },
    )
    expect(result.aborted).toBe('AbortError')
    expect(result.source).toBe('summary')
    expect(result.values).toEqual(query.expected)
  })
}
