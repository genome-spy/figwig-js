/** Sampling CPU profiles for the pinned baseline and current reader. */
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { cpus } from 'node:os'
import { basename, dirname, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { SourceMap } from 'node:module'
import { Session } from 'node:inspector'
import { execFileSync } from 'node:child_process'
import process from 'node:process'
import { build } from 'esbuild'
import { chromium } from '@playwright/test'
import { startRangeServer } from '../server/range-server.ts'

const root = resolve(import.meta.dirname, '../..'),
  baseline =
    process.env.FIGWIG_PROFILE_BASELINE ??
    'eaf75569b5bfcc0a6673e3af211042c5ac9f071f',
  durationMs = Number(process.argv[2] ?? 2000),
  output = resolve(
    root,
    process.env.FIGWIG_PROFILE_OUTPUT ?? 'benchmarks/results/profiles',
  ),
  summaryPath = resolve(
    root,
    process.env.FIGWIG_PROFILE_SUMMARY ??
      'benchmarks/measurements/profiles-cpu.json',
  )
if (!Number.isFinite(durationMs) || durationMs < 500)
  throw new Error('Profile for at least 500 ms')
await mkdir(output, { recursive: true })
const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
}).trim()
const runtimeDiff = execFileSync('git', ['diff', '--', 'src'], {
  cwd: root,
  encoding: 'utf8',
})

async function createWorkload(FigWig, name, url) {
  const reader = new FigWig({ url }),
    header = await reader.getHeader()
  const tracks =
    name === 'named600'
      ? header.tracks.slice(-600).map((t) => t.name)
      : undefined
  const context = { reader, last: undefined, run: undefined }
  context.run = async () => {
    if (name.endsWith('cold')) reader.clearCache()
    context.last = name.startsWith('gap-bins')
      ? await reader.getBins('chr10', 10000000, 12000000, {
          binSize: 2000,
          missing: 'omit',
        })
      : name === 'named600'
        ? await reader.getValues('chr1', 0, 64, { tracks })
        : name === 'dense-bins' || name === 'mixed-bins'
          ? await reader.getBins('chr1', 1000000, 1200000, {
              binSize: name === 'mixed-bins' ? 997 : 1000,
              aggregation: 'mean',
              missing: 'omit',
            })
          : name === 'track-cold'
            ? await reader.getValues('chrA', 0, 200000)
            : name.startsWith('manygroup')
              ? await reader.getValues('chr1', 166666, 176666)
              : await reader.getValues('chr1', 1000000, 1200000)
  }
  if (!name.startsWith('manygroup'))
    for (let i = 0; i < 3; i++) await context.run()
  reader.resetDiagnostics()
  return context
}

async function runWorkload(context, durationMs, once) {
  const start = globalThis.performance.now()
  let queries = 0
  do {
    await context.run()
    queries++
  } while (!once && globalThis.performance.now() - start < durationMs)
  return {
    queries,
    wallMs: globalThis.performance.now() - start,
    diagnostics: context.reader.getDiagnostics(),
  }
}

function compareResults(actual, expected) {
  if (actual.tracks.length !== expected.tracks.length)
    throw new Error('Track count mismatch')
  for (let i = 0; i < actual.tracks.length; i++) {
    const a = actual.tracks[i],
      b = expected.tracks[i]
    if (a.track.name !== b.track.name || a.values.length !== b.values.length)
      throw new Error('Track identity/length mismatch')
    for (let j = 0; j < a.values.length; j++)
      if (!Object.is(a.values[j], b.values[j]))
        throw new Error(`Value mismatch ${i}:${j}`)
  }
}

const assets = {},
  apis = {},
  maps = {}
for (const variant of ['baseline', 'current']) {
  const result = await build({
    absWorkingDir: root,
    stdin: {
      contents: `export { FigWig } from './src/index.ts'; export const createWorkload = ${createWorkload.toString()}; export const runWorkload = ${runWorkload.toString()}; export const compareResults = ${compareResults.toString()};`,
      sourcefile: 'profile-workload.js',
      resolveDir: root,
      loader: 'js',
    },
    outfile: resolve(output, `${variant}.mjs`),
    bundle: true,
    platform: 'browser',
    target: 'es2022',
    format: 'esm',
    sourcemap: 'linked',
    write: false,
    plugins: [
      {
        name: 'reader-source',
        setup(builder) {
          builder.onLoad({ filter: /\/src\/.*\.ts$/ }, async (args) => ({
            contents:
              variant === 'current'
                ? await readFile(args.path, 'utf8')
                : execFileSync(
                    'git',
                    ['show', `${baseline}:${relative(root, args.path)}`],
                    { cwd: root, encoding: 'utf8' },
                  ),
            loader: 'ts',
          }))
        },
      },
    ],
  })
  for (const file of result.outputFiles) {
    await writeFile(file.path, file.contents)
    assets[`/${relative(output, file.path)}`] = file.text
    if (file.path.endsWith('.map'))
      maps[variant] = new SourceMap(JSON.parse(file.text))
  }
  apis[variant] = await import(
    pathToFileURL(resolve(output, `${variant}.mjs`)).href
  )
}

function mappedFrame(frame, variant) {
  const mapped = frame.url?.endsWith(`/${variant}.mjs`)
    ? maps[variant].findEntry(frame.lineNumber, frame.columnNumber)
    : {}
  return {
    name: frame.functionName || '(anonymous)',
    file: mapped.originalSource
      ? relative(root, resolve(output, mapped.originalSource))
      : frame.url,
    line:
      mapped.originalLine === undefined
        ? frame.lineNumber + 1
        : mapped.originalLine + 1,
  }
}

function summarize(profile, variant) {
  const nodes = new Map(profile.nodes.map((n) => [n.id, n])),
    parents = new Map(),
    self = new Map(),
    inclusive = new Map()
  for (const node of profile.nodes)
    for (const child of node.children ?? []) parents.set(child, node.id)
  let totalUs = 0,
    idleUs = 0,
    gcUs = 0,
    activeSamples = 0
  for (let i = 0; i < profile.samples.length; i++) {
    const id = profile.samples[i],
      weight = profile.timeDeltas[i],
      frame = nodes.get(id).callFrame
    totalUs += weight
    if (frame.functionName === '(idle)') idleUs += weight
    else activeSamples++
    if (frame.functionName === '(garbage collector)') gcUs += weight
    const leaf = mappedFrame(frame, variant),
      key = JSON.stringify(leaf)
    self.set(key, (self.get(key) ?? 0) + weight)
    const seen = new Set()
    for (
      let current = id;
      current !== undefined;
      current = parents.get(current)
    ) {
      const location = mappedFrame(nodes.get(current).callFrame, variant),
        label = JSON.stringify(location)
      if (!seen.has(label))
        inclusive.set(label, (inclusive.get(label) ?? 0) + weight)
      seen.add(label)
    }
  }
  const activeUs = totalUs - idleUs
  const rows = (table) =>
    [...table]
      .map(([key, timeUs]) => ({
        ...JSON.parse(key),
        ms: timeUs / 1000,
        percentTotal: (100 * timeUs) / totalUs,
        percentActive:
          JSON.parse(key).name === '(idle)' ? null : (100 * timeUs) / activeUs,
      }))
      .sort((a, b) => b.ms - a.ms)
  return {
    samples: profile.samples.length,
    activeSamples,
    sampledMs: totalUs / 1000,
    idlePercent: (100 * idleUs) / totalUs,
    gcPercentActive: (100 * gcUs) / activeUs,
    self: rows(self).slice(0, 30),
    inclusive: rows(inclusive)
      .filter(
        (r) =>
          r.file.includes('/src/') ||
          r.file.startsWith('src/') ||
          r.file.includes('node_modules'),
      )
      .slice(0, 30),
  }
}

const local = await startRangeServer({ root }),
  typical = await startRangeServer({
    root,
    latencyMs: 80,
    bandwidthBitsPerSecond: 50e6,
  })
const gapFile = process.env.FIGWIG_GAP_FILE
const gapServer = gapFile
  ? await startRangeServer({ root: dirname(resolve(gapFile)) })
  : undefined
const app = createServer((request, response) => {
  if (request.url === '/') {
    response.setHeader('Content-Type', 'text/html')
    response.end('<!doctype html><title>Figwig profiles</title>')
  } else {
    response.setHeader(
      'Content-Type',
      request.url.endsWith('.map') ? 'application/json' : 'text/javascript',
    )
    response.end(assets[request.url] ?? '')
  }
})
await new Promise((done) => app.listen(0, '127.0.0.1', done))
const appUrl = `http://127.0.0.1:${app.address().port}`
const cases = [
  ...(gapServer
    ? [
        ['gap-bins', `${gapServer.url}/${basename(gapFile)}`],
        ['gap-bins-cold', `${gapServer.url}/${basename(gapFile)}`],
      ]
    : []),
  ['named600', `${local.url}/test/fixtures/zlib.fw`],
  [
    'dense-bins',
    `${local.url}/benchmarks/fixtures/dense-n8-tile4096-g4-positions-l6-s1701.fw`,
  ],
  [
    'mixed-bins',
    `${local.url}/benchmarks/fixtures/mixed-n24-tile4096-g4-positions-l6-s1701.fw`,
  ],
  [
    'dense-cold',
    `${local.url}/benchmarks/fixtures/dense-n8-tile4096-g4-positions-l6-s1701.fw`,
  ],
  [
    'sparse-cold',
    `${local.url}/benchmarks/fixtures/collection-n96-tile4096-g8-positions-l6-s1701.fw`,
  ],
  ['track-cold', `${local.url}/test/fixtures/blocks.fw`],
  [
    'manygroup-cold',
    `${typical.url}/benchmarks/fixtures/sparse-n24-tile4096-g1-positions-l6-s1701.fw`,
  ],
].filter(
  ([name]) =>
    !process.env.FIGWIG_PROFILE_CASES ||
    process.env.FIGWIG_PROFILE_CASES.split(',').some((prefix) =>
      name.startsWith(prefix),
    ),
)
const session = new Session()
session.connect()
const post = (method, params = {}) =>
  new Promise((done, reject) =>
    session.post(method, params, (error, result) =>
      error ? reject(error) : done(result),
    ),
  )
const summaries = []
let browser
try {
  await post('Profiler.enable')
  await post('Profiler.setSamplingInterval', { interval: 1000 })
  for (const [name, url] of cases) {
    let reference
    for (const variant of ['baseline', 'current']) {
      const context = await apis[variant].createWorkload(
        apis[variant].FigWig,
        name,
        url,
      )
      await post('HeapProfiler.collectGarbage')
      await post('Profiler.start')
      const stats = await apis[variant].runWorkload(
        context,
        durationMs,
        name.startsWith('manygroup'),
      )
      const { profile } = await post('Profiler.stop')
      if (reference) compareResults(context.last, reference)
      else reference = context.last
      const filename = `node-${name}-${variant}.cpuprofile`
      await writeFile(resolve(output, filename), JSON.stringify(profile))
      summaries.push({
        engine: 'node',
        name,
        variant,
        profile: filename,
        ...stats,
        ...summarize(profile, variant),
      })
      await context.reader.close()
      process.stdout.write(`Node profile: ${name} ${variant}\n`)
    }
  }
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage(),
    cdp = await page.context().newCDPSession(page)
  await page.goto(appUrl)
  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.setSamplingInterval', { interval: 1000 })
  await cdp.send('Network.enable')
  let network = new Map(),
    recording = false
  cdp.on('Network.requestWillBeSent', (event) => {
    if (recording)
      network.set(event.requestId, {
        url: event.request.url,
        method: event.request.method,
        range: event.request.headers.Range ?? event.request.headers.range,
        start: event.timestamp,
        initiator: event.initiator.type,
      })
  })
  cdp.on('Network.responseReceived', (event) => {
    const row = network.get(event.requestId)
    if (row)
      Object.assign(row, {
        status: event.response.status,
        timing: event.response.timing,
        fromDiskCache: event.response.fromDiskCache,
      })
  })
  cdp.on('Network.loadingFinished', (event) => {
    const row = network.get(event.requestId)
    if (row)
      Object.assign(row, {
        end: event.timestamp,
        encodedDataLength: event.encodedDataLength,
      })
  })
  const browserCases = cases.flatMap(([name, url]) =>
    name.startsWith('manygroup')
      ? [
          [name, url, false],
          [name, url, true],
        ]
      : [[name, url, false]],
  )
  for (const [name, url, cacheDisabled] of browserCases) {
    await page.evaluate(() => {
      globalThis.profileReference = undefined
    })
    for (const variant of ['baseline', 'current']) {
      await cdp.send('Network.setCacheDisabled', { cacheDisabled })
      await page.evaluate(
        async ({ appUrl, name, url, variant }) => {
          globalThis.profileApi = await import(`${appUrl}/${variant}.mjs`)
          globalThis.profileContext =
            await globalThis.profileApi.createWorkload(
              globalThis.profileApi.FigWig,
              name,
              url,
            )
        },
        { appUrl, name, url, variant },
      )
      await cdp.send('HeapProfiler.collectGarbage')
      network = new Map()
      recording = true
      await cdp.send('Profiler.start')
      const stats = await page.evaluate(
        async ({ durationMs, once }) =>
          globalThis.profileApi.runWorkload(
            globalThis.profileContext,
            durationMs,
            once,
          ),
        { durationMs, once: name.startsWith('manygroup') },
      )
      const { profile } = await cdp.send('Profiler.stop')
      recording = false
      await page.evaluate(async () => {
        if (globalThis.profileReference)
          globalThis.profileApi.compareResults(
            globalThis.profileContext.last,
            globalThis.profileReference,
          )
        else globalThis.profileReference = globalThis.profileContext.last
        await globalThis.profileContext.reader.close()
      })
      const filename = `chromium-${name}-${variant}${cacheDisabled ? '-cache-disabled' : ''}.cpuprofile`
      await writeFile(resolve(output, filename), JSON.stringify(profile))
      await writeFile(
        resolve(output, filename.replace('.cpuprofile', '-network.json')),
        JSON.stringify([...network.values()], null, 2),
      )
      summaries.push({
        engine: 'chromium',
        name,
        variant,
        cacheDisabled,
        profile: filename,
        networkRequests: network.size,
        ...stats,
        ...summarize(profile, variant),
      })
      process.stdout.write(
        `Chromium profile: ${name} ${variant} cache-disabled=${cacheDisabled}\n`,
      )
    }
  }
  const report = {
    date: '2026-10-28',
    revision,
    baseline,
    runtimeDiff,
    node: process.version,
    chromium: browser.version(),
    cpu: cpus()[0].model,
    durationMs,
    samplingIntervalUs: 1000,
    rawDirectory: relative(root, output),
    method:
      'V8 sampling CPU profiles. Three warm-ups outside capture except many-group HTTP (metadata only). CPU phases run at least durationMs; many-group phases run one cold query. Source-mapped self and inclusive times weighted by timeDeltas. Node includes localhost-server CPU; Chromium is renderer-main-thread only. Output equality checked outside capture. Profiled times are not uninstrumented benchmark results.',
    summaries,
  }
  await writeFile(summaryPath, JSON.stringify(report, null, 2) + '\n')
} finally {
  session.disconnect()
  await browser?.close()
  await Promise.all([
    local.close(),
    typical.close(),
    gapServer?.close(),
    new Promise((done, reject) =>
      app.close((error) => (error ? reject(error) : done())),
    ),
  ])
}
