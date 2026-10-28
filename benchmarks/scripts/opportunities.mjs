/** Compare production or temporary prototypes against a pinned reader baseline. */
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir, cpus } from 'node:os'
import { dirname, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import process from 'node:process'
import { execFileSync } from 'node:child_process'
import { build } from 'esbuild'
import { chromium } from '@playwright/test'
import { startRangeServer } from '../server/range-server.ts'

const root = resolve(import.meta.dirname, '../..')
const baselineRevision =
  process.env.FIGWIG_BENCH_BASELINE ??
  'eaf75569b5bfcc0a6673e3af211042c5ac9f071f'
const production = process.argv[5] === 'production'
const browserCacheDisabled = process.argv[6] === 'cache-disabled'
const repetitions = Number(process.argv[2] ?? 7)
if (!Number.isInteger(repetitions) || repetitions < 3)
  throw new Error('Provide at least three repetitions')
const output = resolve(
  root,
  process.argv[4] ?? 'benchmarks/measurements/opportunities.json',
)
const scratch = await mkdtemp(resolve(tmpdir(), 'figwig-opportunities-'))

function replace(source, before, after) {
  if (!source.includes(before))
    throw new Error(`Prototype source drift: ${before}`)
  return source.replace(before, after)
}

function prototype(source, name, path) {
  if (name === 'crc' && path.endsWith('/binary.ts')) {
    const start = source.indexOf('export function crc32(')
    const end = source.indexOf('\nexport function crc(', start)
    if (start < 0 || end < 0) throw new Error('CRC prototype source drift')
    return (
      source.slice(0, start) +
      `
const slices = [crcTable]
for (let k = 1; k < 8; k++)
  slices.push(Uint32Array.from(slices[k - 1], c => (c >>> 8) ^ crcTable[c & 255]))
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff, i = 0
  for (; i + 8 <= bytes.length; i += 8) {
    c ^= bytes[i] | bytes[i + 1] << 8 | bytes[i + 2] << 16 | bytes[i + 3] << 24
    c = slices[7][c & 255] ^ slices[6][c >>> 8 & 255] ^
      slices[5][c >>> 16 & 255] ^ slices[4][c >>> 24] ^
      slices[3][bytes[i + 4]] ^ slices[2][bytes[i + 5]] ^
      slices[1][bytes[i + 6]] ^ slices[0][bytes[i + 7]]
  }
  for (; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 255] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
` +
      source.slice(end)
    )
  }
  if (!path.endsWith('/figwig.ts')) return source
  if (name === 'dense-bins') {
    return replace(
      source,
      `      for (let position = first; position < last; position++)
        add(track.values[position - base], position, position + 1)`,
      `      let position = first, bin = Math.floor((first - start) / binSize)
      while (position < last) {
        const stop = Math.min(last, start + (bin + 1) * binSize)
        for (; position < stop; position++) {
          const value = track.values[position - base]
          if (Number.isNaN(value)) {
            if (missing === 'propagate') out[bin] = NaN
            else if (nanCounts) nanCounts[bin]++
          } else if (value !== 0) out[bin] += value
        }
        bin++
      }`,
    )
  }
  if (name === 'name-map') {
    source = replace(
      source,
      '  private closePromise?: Promise<void>',
      '  private closePromise?: Promise<void>\n  private trackNames?: Map<string, Track>',
    )
    source = replace(
      source,
      'header.tracks.find((t) => t.name === id)',
      '(this.trackNames ??= new Map(header.tracks.map(t => [t.name, t]))).get(id)',
    )
    return replace(
      source,
      '      this.metadata.clear()',
      '      this.metadata.clear()\n      this.trackNames = undefined',
    )
  }
  if (name === 'coalesce-indexes') {
    source = replace(
      source,
      '  private readonly reads: ChunkReads',
      '  private readonly reads: ChunkReads\n  private readonly indexReads: ChunkReads',
    )
    source = replace(
      source,
      '    this.reads = new ChunkReads(',
      `    this.indexReads = new ChunkReads(
      (offset, size, signal) => this.read(offset, size, 'indexBytes', signal),
      this.options.coalesceGap,
      Math.min(this.options.maxCoalescedBytes, this.options.maxReadBytes),
    )
    this.reads = new ChunkReads(`,
    )
    return replace(
      source,
      "const bytes = await this.read(start, end - start, 'indexBytes', shared)",
      // Give each cached group its own backing buffer: retaining one small
      // group must not pin the entire coalesced response outside its budget.
      'const bytes = Uint8Array.from(await this.indexReads.get({ offset: start, size: end - start } as ChunkRef, shared))',
    )
  }
  return source
}

// This function is embedded into each portable bundle and runs unchanged in
// Node and Chromium. Comparisons and warm-up happen outside timed samples.
async function benchmarkCase(apis, urls, name, count) {
  function equal(actual, expected) {
    if (typeof actual === 'number') {
      if (actual !== expected) throw new Error('CRC mismatch')
      return
    }
    if (actual.tracks.length !== expected.tracks.length)
      throw new Error('Track count mismatch')
    for (let i = 0; i < actual.tracks.length; i++) {
      const a = actual.tracks[i],
        b = expected.tracks[i]
      if (a.track.name !== b.track.name || a.values.length !== b.values.length)
        throw new Error('Track identity or output length mismatch')
      for (let j = 0; j < a.values.length; j++)
        if (!Object.is(a.values[j], b.values[j]))
          throw new Error(`Value mismatch: ${i}:${j}`)
    }
  }
  const contexts = []
  const queries =
    name === 'crc-1MiB'
      ? 8
      : name.startsWith('named')
        ? 20
        : name.includes('warm-bins')
          ? 3
          : 1
  for (const [variant, api] of Object.entries(apis)) {
    const data = new Uint8Array(1024 ** 2)
    for (let i = 0; i < data.length; i++) data[i] = (i * 31 + (i >>> 8)) & 255
    let reader, run
    if (name === 'crc-1MiB') run = () => api.crc32(data)
    else {
      const url = name.startsWith('named600')
        ? urls.toy
        : name.startsWith('named')
          ? urls.collection
          : name.startsWith('manygroup')
            ? urls.many
            : name.startsWith('track')
              ? urls.track
              : name.startsWith('sparse')
                ? urls.collection
                : name.startsWith('toy')
                  ? urls.toy
                  : name.startsWith('mixed')
                    ? urls.mixed
                    : urls.dense
      reader = new api.FigWig({ url })
      const header = await reader.getHeader()
      const names = name.startsWith('named4')
        ? [0, 31, 63, 95].map((i) => header.tracks[i].name)
        : header.tracks.slice(-600).map((t) => t.name)
      if (name.startsWith('named'))
        run = () =>
          name.startsWith('named600')
            ? reader.getValues('chr1', 0, 64, { tracks: names })
            : reader.getValues('chr1', 1000000, 1010000, { tracks: names })
      else if (name === 'manygroup-cold-values')
        run = () => reader.getValues('chr1', 166666, 176666)
      else if (name === 'track-cold-values')
        run = () => reader.getValues('chrA', 0, 200000)
      else if (name === 'toy-cold-values')
        run = () =>
          reader.getValues('chr1', 0, 300, {
            tracks: ['wide', 'signal', 'ones'],
          })
      else if (name.endsWith('cold-values'))
        run = () => reader.getValues('chr1', 1000000, 1200000)
      else
        run = () =>
          reader.getBins('chr1', 1000000, 1200000, {
            binSize: name.startsWith('mixed') ? 997 : 1000,
            aggregation: 'mean',
            missing: 'omit',
          })
    }
    let expected
    for (let i = 0; i < 3; i++) expected = await run()
    contexts.push({ variant, reader, run, expected })
  }
  const reference = contexts[0].expected
  for (const context of contexts) equal(context.expected, reference)
  const samples = []
  try {
    for (let rep = 0; rep < count; rep++) {
      for (let j = 0; j < contexts.length; j++) {
        const context = contexts[(j + rep) % contexts.length]
        context.reader?.resetDiagnostics()
        let result
        const start = globalThis.performance.now()
        for (let i = 0; i < queries; i++) {
          if (name.includes('cold')) context.reader.clearCache()
          result = await context.run()
        }
        const ms = (globalThis.performance.now() - start) / queries
        equal(result, reference)
        const diagnostics = context.reader?.getDiagnostics()
        samples.push({
          variant: context.variant,
          repetition: rep,
          ms,
          queries,
          diagnostics,
        })
      }
    }
  } finally {
    await Promise.all(contexts.map((c) => c.reader?.close()))
  }
  return { name, samples }
}

const variants = production
  ? ['baseline', 'production']
  : ['baseline', 'crc', 'dense-bins', 'name-map', 'coalesce-indexes']
const bundles = {}
const sizes = {}
const apis = {}
for (const name of variants) {
  const result = await build({
    absWorkingDir: root,
    stdin: {
      contents: `export { FigWig } from './src/index.ts'; export { crc32 } from './src/utils/binary.ts'; export const benchmarkCase = ${benchmarkCase.toString()};`,
      resolveDir: root,
      loader: 'js',
    },
    bundle: true,
    platform: 'browser',
    target: 'es2022',
    format: 'esm',
    write: false,
    plugins: [
      {
        name: 'experimental-prototype',
        setup(builder) {
          builder.onLoad({ filter: /\/src\/.*\.ts$/ }, async (args) => ({
            contents: prototype(
              name === 'production'
                ? await readFile(args.path, 'utf8')
                : execFileSync(
                    'git',
                    [
                      'show',
                      `${baselineRevision}:${relative(root, args.path)}`,
                    ],
                    { cwd: root, encoding: 'utf8' },
                  ),
              name,
              args.path,
            ),
            loader: 'ts',
          }))
        },
      },
    ],
  })
  bundles[`/${name}.mjs`] = result.outputFiles[0].text
  sizes[name] = result.outputFiles[0].contents.length
  const path = resolve(scratch, `${name}.mjs`)
  await writeFile(path, bundles[`/${name}.mjs`])
  apis[name] = await import(pathToFileURL(path).href)
}

const local = await startRangeServer({ root })
const typical = await startRangeServer({
  root,
  latencyMs: 80,
  bandwidthBitsPerSecond: 50e6,
})
const app = createServer((request, response) => {
  response.setHeader('Content-Type', 'text/javascript')
  response.end(bundles[request.url] ?? '')
})
await new Promise((resolveListen) => app.listen(0, '127.0.0.1', resolveListen))
const address = app.address()
const appUrl = `http://127.0.0.1:${address.port}`
const urls = {
  dense: `${local.url}/benchmarks/fixtures/dense-n8-tile4096-g4-positions-l6-s1701.fw`,
  mixed: `${local.url}/benchmarks/fixtures/mixed-n24-tile4096-g4-positions-l6-s1701.fw`,
  toy: `${local.url}/test/fixtures/zlib.fw`,
  collection: `${local.url}/benchmarks/fixtures/collection-n96-tile4096-g8-positions-l6-s1701.fw`,
  many: `${typical.url}/benchmarks/fixtures/sparse-n24-tile4096-g1-positions-l6-s1701.fw`,
  track: `${local.url}/test/fixtures/blocks.fw`,
}
const cases = [
  ['crc-1MiB', 'crc'],
  ['dense-cold-values', 'crc'],
  ...(production
    ? [
        ['mixed-cold-values', 'production'],
        ['sparse-cold-values', 'production'],
        ['track-cold-values', 'production'],
        ['toy-cold-values', 'production'],
      ]
    : []),
  ['dense-warm-bins', 'dense-bins'],
  ['mixed-warm-bins', 'dense-bins'],
  ['named600-warm-values', 'name-map'],
  ['named96-warm-values', 'name-map'],
  ['named4-warm-values', 'name-map'],
  ['manygroup-cold-values', 'coalesce-indexes'],
]
  .map(([name, candidate]) => [name, production ? 'production' : candidate])
  .filter(
    ([name]) =>
      !process.argv[3] ||
      process.argv[3].split(',').some((prefix) => name.startsWith(prefix)),
  )
if (!cases.length) throw new Error('No matching benchmark cases')
const measurements = []
let browser
try {
  for (const [name, candidate] of cases) {
    const result = await benchmarkCase(
      { baseline: apis.baseline, [candidate]: apis[candidate] },
      urls,
      name,
      repetitions,
    )
    measurements.push({ engine: 'node', ...result })
    process.stdout.write(`Node: ${name}\n`)
  }
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  await page.goto(appUrl)
  if (browserCacheDisabled) {
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Network.enable')
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
  }
  for (const [name, candidate] of cases) {
    const result = await page.evaluate(
      async ({ appUrl, urls, name, candidate, repetitions }) => {
        const baseline = await import(`${appUrl}/baseline.mjs`)
        const variant = await import(`${appUrl}/${candidate}.mjs`)
        return baseline.benchmarkCase(
          { baseline, [candidate]: variant },
          urls,
          name,
          repetitions,
        )
      },
      { appUrl, urls, name, candidate, repetitions },
    )
    measurements.push({ engine: 'chromium', ...result })
    process.stdout.write(`Chromium: ${name}\n`)
  }
  const report = {
    date: '2026-10-28',
    node: process.version,
    chromium: browser.version(),
    platform: `${process.platform}/${process.arch}`,
    cpu: cpus()[0].model,
    source: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim(),
    baselineRevision,
    mode: production ? 'production' : 'prototype',
    browserCacheDisabled,
    productionDiff: production
      ? execFileSync('git', ['diff', baselineRevision, '--', 'src'], {
          cwd: root,
          encoding: 'utf8',
        })
      : undefined,
    repetitions,
    bundleBytes: sizes,
    method:
      'Experimental source transforms; alternating variant order; three warm-ups; exact Object.is comparisons outside timing. Cold queries clear parsed caches and exclude header initialization. Local HTTP has no added delay. Many-group HTTP uses 80 ms per response and shared 50 Mbit/s. Warm cases retain decoded caches.',
    measurements,
  }
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, JSON.stringify(report, null, 2) + '\n')
  for (const row of measurements) {
    const byVariant = new Map()
    for (const sample of row.samples) {
      const values = byVariant.get(sample.variant) ?? []
      values.push(sample.ms)
      byVariant.set(sample.variant, values)
    }
    const medians = Object.fromEntries(
      [...byVariant].map(([name, values]) => [
        name,
        values.sort((a, b) => a - b)[Math.floor(values.length / 2)],
      ]),
    )
    process.stdout.write(
      JSON.stringify({ engine: row.engine, name: row.name, medians }) + '\n',
    )
  }
} finally {
  await browser?.close()
  await Promise.all([
    local.close(),
    typical.close(),
    new Promise((resolveClose, reject) =>
      app.close((error) => (error ? reject(error) : resolveClose())),
    ),
  ])
  await rm(scratch, { recursive: true, force: true })
}
