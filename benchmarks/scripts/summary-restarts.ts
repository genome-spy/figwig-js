/** Paired real-HTTP benchmark for the optional summary index; no mock I/O. */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { cpus, platform, arch } from 'node:os'
import { execFileSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { FigWig } from '../../src/index.js'
import type { BinsResult, Diagnostics } from '../../src/index.js'
import { startRangeServer } from '../server/range-server.js'

interface Input {
  file: string
  order: string
  summaryIndex: boolean
  fileBytes: number
  sha256: string
  signalSha256: string
  chromosomes: Record<string, number>
  tracks: number
  tile: number
  generationSeconds: number
  processPeakRssBytes: number
}
interface Manifest {
  files: Record<string, Input>
}
interface Sample {
  file: string
  order: string
  summaryIndex: boolean
  selection: string
  step: string
  repetition: number
  milliseconds: number
  requests: number
  transferredBytes: number
  diagnostics: Diagnostics
  observedRssBytes: number
  observedHeapBytes: number
  observedArrayBufferBytes: number
  resultSha256?: string
  ranges: Awaited<ReturnType<typeof startRangeServer>>['metrics']['ranges']
}

const args = {
  directory: 'benchmarks/fixtures/summary-restarts',
  output: 'benchmarks/results/summary-restarts.json',
  repetitions: 5,
}
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]
  const value = process.argv[i + 1]
  if (value === undefined) throw new Error(`Missing value for ${key}`)
  if (key === '--directory') args.directory = value
  else if (key === '--output') args.output = value
  else if (key === '--repetitions') args.repetitions = Number(value)
  else throw new Error(`Unknown option ${key}`)
}
if (!Number.isInteger(args.repetitions) || args.repetitions < 1)
  throw new Error('Repetitions must be a positive integer')

const directory = resolve(args.directory)
const repository = resolve(import.meta.dirname, '../..')
const readerFiles = new Map<string, Uint8Array>()
const readerSource = revision()
const output = resolve(args.output)
const sourceDirectory = `${output.replace(/\.json$/, '')}-reader-source`
for (const [name, bytes] of readerFiles) {
  const filename = resolve(sourceDirectory, name)
  await mkdir(resolve(filename, '..'), { recursive: true })
  await writeFile(filename, bytes)
}
await writeFile(
  resolve(sourceDirectory, 'provenance.json'),
  JSON.stringify(readerSource, null, 2) + '\n',
)
const manifest = JSON.parse(
  await readFile(resolve(directory, 'manifest.json'), 'utf8'),
) as Manifest
for (const input of Object.values(manifest.files)) {
  const bytes = await readFile(resolve(directory, input.file))
  if (createHash('sha256').update(bytes).digest('hex') !== input.sha256)
    throw new Error(`Input hash mismatch: ${input.file}`)
}
const server = await startRangeServer({
  root: directory,
  latencyMs: 10,
  bandwidthBitsPerSecond: 50_000_000,
  maxConcurrent: 6,
})
const samples: Sample[] = []
const correctness = new Map<string, string>()

async function settled() {
  while (server.metrics.active) await new Promise((done) => setTimeout(done, 1))
}
function difference(after: Diagnostics, before: Diagnostics): Diagnostics {
  return Object.fromEntries(
    Object.entries(after).map(([key, value]) => [
      key,
      key === 'cacheBytes' ? value : value - before[key as keyof Diagnostics],
    ]),
  ) as unknown as Diagnostics
}
function hashResult(result: BinsResult) {
  const hash = createHash('sha256')
  for (const values of [
    result.starts,
    result.ends,
    ...result.tracks.map((track) => track.values),
  ])
    hash.update(
      new Uint8Array(values.buffer, values.byteOffset, values.byteLength),
    )
  return hash.digest('hex')
}
function revision() {
  const sourceSha256: Record<string, string> = {}
  const visit = (directory: string) => {
    for (const file of readdirSync(directory, { withFileTypes: true })) {
      const filename = resolve(directory, file.name)
      if (file.isDirectory()) visit(filename)
      else if (file.name.endsWith('.ts')) {
        const bytes = readFileSync(filename)
        const name = relative(repository, filename)
        readerFiles.set(name, bytes)
        sourceSha256[name] = createHash('sha256').update(bytes).digest('hex')
      }
    }
  }
  visit(resolve(repository, 'src'))
  return {
    baseRevision: execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      cwd: repository,
    }).trim(),
    trackedPatchSha256: createHash('sha256')
      .update(
        execFileSync('git', ['diff', '--binary', 'HEAD', '--', 'src'], {
          cwd: repository,
        }),
      )
      .digest('hex'),
    sourceSha256,
  }
}
function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2
}

try {
  // Warm code on a separate reader; every recorded repetition starts empty.
  const warmInput = manifest.files.positions_restarts
  const warm = new FigWig({
    url: `${server.url}/${warmInput.file}`,
  })
  await warm.getBins('chr1', 4096 * warmInput.tile, 4160 * warmInput.tile, {
    tracks: [0],
    binSize: warmInput.tile,
    aggregation: 'sum',
    missing: 'zero',
    requireSummaries: true,
  })
  await warm.close()
  await settled()

  for (let repetition = 0; repetition < args.repetitions; repetition++) {
    // Alternate flag order so a variant does not always get the earlier slot.
    const modes =
      repetition % 2 ? ['restarts', 'legacy'] : ['legacy', 'restarts']
    for (const order of ['positions', 'tracks'])
      for (const mode of modes)
        for (const selection of ['one', 'all']) {
          const input = manifest.files[`${order}_${mode}`]
          const reader = new FigWig({ url: `${server.url}/${input.file}` })
          const tracks =
            selection === 'one'
              ? [0]
              : Array.from({ length: input.tracks }, (_, index) => index)
          const operations = [
            { name: 'initialization' },
            { name: 'cold', first: 4096, bins: 64, factor: 1 },
            { name: 'repeat', first: 4096, bins: 64, factor: 1 },
            { name: 'same-window-pan', first: 4112, bins: 64, factor: 1 },
            { name: 'next-window-pan', first: 6144, bins: 64, factor: 1 },
            { name: 'zoom', first: 4096, bins: 64, factor: 4 },
            { name: 'empty', first: 8192, bins: 64, factor: 1 },
            { name: 'overview', first: 0, factor: 1024 },
          ]
          try {
            for (const operation of operations) {
              await settled()
              const beforeServer = server.metrics
              const before = reader.getDiagnostics()
              const started = performance.now()
              let result: BinsResult | undefined
              if (operation.name === 'initialization') await reader.getHeader()
              else {
                const first = operation.first! * input.tile
                result = await reader.getBins(
                  'chr1',
                  first,
                  operation.bins === undefined
                    ? input.chromosomes.chr1
                    : first + operation.bins * operation.factor! * input.tile,
                  {
                    tracks,
                    binSize: operation.factor! * input.tile,
                    aggregation: 'sum',
                    missing: 'zero',
                    requireSummaries: true,
                  },
                )
                if (result.source !== 'summary')
                  throw new Error('Benchmark unexpectedly used raw signal')
              }
              const milliseconds = performance.now() - started
              const diagnostics = difference(reader.getDiagnostics(), before)
              const memory = process.memoryUsage()
              await settled()
              const afterServer = server.metrics
              const resultSha256 = result ? hashResult(result) : undefined
              if (resultSha256) {
                const key = `${order}:${selection}:${operation.name}:${repetition}`
                const expected = correctness.get(key)
                if (expected && resultSha256 !== expected)
                  throw new Error(`Paired result mismatch: ${key}`)
                correctness.set(key, resultSha256)
              }
              samples.push({
                file: input.file,
                order,
                summaryIndex: input.summaryIndex,
                selection,
                step: operation.name,
                repetition,
                milliseconds,
                requests: afterServer.requests - beforeServer.requests,
                transferredBytes:
                  afterServer.bodyBytes - beforeServer.bodyBytes,
                diagnostics,
                observedRssBytes: memory.rss,
                observedHeapBytes: memory.heapUsed,
                observedArrayBufferBytes: memory.arrayBuffers,
                resultSha256,
                ranges: afterServer.ranges.slice(beforeServer.ranges.length),
              })
            }
          } finally {
            await reader.close()
          }
        }
  }
  const groups = new Map<string, Sample[]>()
  for (const sample of samples) {
    const key = `${sample.order}/${sample.selection}/${sample.step}/${sample.summaryIndex ? 'restarts' : 'legacy'}`
    const group = groups.get(key) ?? []
    group.push(sample)
    groups.set(key, group)
  }
  const summary = [...groups].map(([key, group]) => ({
    key,
    millisecondsMedian: median(group.map((row) => row.milliseconds)),
    transferredBytesMedian: median(group.map((row) => row.transferredBytes)),
    requestsMedian: median(group.map((row) => row.requests)),
    summaryInflatedBytesMedian: median(
      group.map((row) => row.diagnostics.summaryInflatedBytes),
    ),
    cacheBytesMedian: median(group.map((row) => row.diagnostics.cacheBytes)),
  }))
  await mkdir(resolve(output, '..'), { recursive: true })
  await writeFile(
    output,
    JSON.stringify(
      {
        network: {
          bandwidthBitsPerSecond: 50_000_000,
          responseLatencyMs: 10,
          maxConcurrent: 6,
          bodyChunkBytes: 16 * 1024,
          model: 'One shared bandwidth timeline; 10 ms pre-response RTT model',
        },
        environment: {
          node: process.version,
          platform: platform(),
          arch: arch(),
          cpu: cpus()[0]?.model,
          reader: readerSource,
        },
        benchmarkSha256: createHash('sha256')
          .update(readFileSync(import.meta.filename))
          .digest('hex'),
        readerSourceDirectory: relative(repository, sourceDirectory),
        inputs: manifest,
        repetitions: args.repetitions,
        limitations: [
          'Node HTTP/Pako benchmark; browser execution is verified separately by Chromium e2e tests.',
          'Initialization is recorded separately. OS caches and HTTP connections may be warm.',
          'RSS/heap/array buffers are observations after each operation, not per-operation peak memory.',
          'Writer RSS is a separate fresh-process high-water mark including input arrays, imports and warmup.',
          'No TCP loss, connection setup, HTTP/2 scheduling or proxy-cache model.',
        ],
        summary,
        samples,
      },
      null,
      2,
    ) + '\n',
  )
  console.log(
    JSON.stringify(
      {
        output,
        samples: samples.length,
        cold: summary.filter((row) => row.key.includes('/cold/')),
      },
      null,
      2,
    ),
  )
} finally {
  await server.close()
}
