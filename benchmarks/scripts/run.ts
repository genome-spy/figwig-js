import { readdir, readFile, mkdir, writeFile, stat } from 'node:fs/promises'
import { resolve, basename } from 'node:path'
import { cpus, platform, arch, totalmem } from 'node:os'
import { performance } from 'node:perf_hooks'
import { RemoteFile } from 'generic-filehandle2'
import { FigWig } from '../../src/index.js'
import { startRangeServer } from '../server/range-server.js'

const scenarios = {
  local: { latencyMs: 0, bandwidthBitsPerSecond: 0 },
  fast: { latencyMs: 20, bandwidthBitsPerSecond: 100_000_000 },
  typical: { latencyMs: 80, bandwidthBitsPerSecond: 50_000_000 },
  high: { latencyMs: 150, bandwidthBitsPerSecond: 10_000_000 },
}

type Scenario = keyof typeof scenarios
type Reader = InstanceType<typeof FigWig>
interface Parameters {
  upstream_commit?: string
  profile?: string
  tracks: number
  chromosomes: Record<string, number>
  tile: number
  group: number
  order: string
}
interface TraceStep { name: string; milliseconds: number; diagnostics: ReturnType<Reader['getDiagnostics']> }
interface Pattern { name: string; run: (reader: Reader) => Promise<unknown> }
interface Sample {
  file: string
  scenario: Scenario
  pattern: string
  cache: 'cold' | 'warm'
  repetition: number
  milliseconds: number
  initializationMs: number
  requests: number
  transferredBytes: number
  indexBytes: number
  dataBytes: number
  chunksFetched: number
  chunksDecompressed: number
  indexLoadMs: number
  decompressionMs: number
  decodingMs: number
  chunkCacheHits: number
  chunkCacheMisses: number
  cacheBytes: number
  steps?: TraceStep[]
}

function argumentsOf(argv: string[]) {
  const args = { directory: 'benchmarks/fixtures', scenarios: 'all', repetitions: 3, patterns: 'all', match: '', coalesceGap: 4096, maxConcurrentRequests: 6, maxCoalescedBytes: 4 * 1024 ** 2, chunkCacheBytes: 64 * 1024 ** 2, indexCacheBytes: 32 * 1024 ** 2, output: 'benchmarks/measurements/latest.json', files: [] as string[] }
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index]
    if (!key.startsWith('--')) { args.files.push(key); continue }
    const value = argv[++index]
    if (value === undefined) throw new Error(`Missing value for ${key}`)
    if (key === '--directory') args.directory = value
    else if (key === '--scenarios') args.scenarios = value
    else if (key === '--repetitions') args.repetitions = Number(value)
    else if (key === '--patterns') args.patterns = value
    else if (key === '--match') args.match = value
    else if (key === '--coalesce-gap') args.coalesceGap = Number(value)
    else if (key === '--max-concurrent') args.maxConcurrentRequests = Number(value)
    else if (key === '--max-coalesced-mib') args.maxCoalescedBytes = Number(value) * 1024 ** 2
    else if (key === '--chunk-cache-mib') args.chunkCacheBytes = Number(value) * 1024 ** 2
    else if (key === '--index-cache-mib') args.indexCacheBytes = Number(value) * 1024 ** 2
    else if (key === '--output') args.output = value
    else throw new Error(`Unknown option ${key}`)
  }
  if (!Number.isInteger(args.repetitions) || args.repetitions < 1) throw new Error('Repetitions must be a positive integer')
  return args
}

async function traceSteps(reader: Reader, operations: { name: string; run: () => Promise<unknown> }[]): Promise<TraceStep[]> {
  const trace: TraceStep[] = []
  for (const operation of operations) {
    const before = reader.getDiagnostics(), start = performance.now()
    await operation.run()
    const after = reader.getDiagnostics()
    const diagnostics = Object.fromEntries(Object.entries(after).map(([key, value]) => [key, key === 'cacheBytes' ? value : value - before[key as keyof typeof before]])) as ReturnType<Reader['getDiagnostics']>
    trace.push({ name: operation.name, milliseconds: performance.now() - start, diagnostics })
  }
  return trace
}

function patterns(parameters: Parameters): Pattern[] {
  const { chromosomes, tracks: count, tile, group } = parameters
  const chrom = Object.keys(chromosomes)[0]
  const length = chromosomes[chrom]
  const all = Array.from({ length: Math.min(count, 24) }, (_, index) => index)
  const subset = all.slice(0, 6)
  const small = Math.min(length, 10_000)
  const medium = Math.min(length, 100_000)
  const start = Math.min(Math.floor(length / 3), Math.max(0, length - medium))
  const same = Array.from({ length: Math.min(count, group, 4) }, (_, index) => index)
  const cross = Array.from({ length: Math.min(4, Math.ceil(count / group)) }, (_, index) => Math.min(index * group, count - 1))
  const binsize = tile * 16
  const coarseEnd = Math.max(Math.min(length, binsize), Math.floor(Math.min(length, 10_000_000) / binsize) * binsize)
  const regions = [
    { chromosome: chrom, start: 0, end: small },
    { chromosome: chrom, start, end: Math.min(length, start + small) },
    ...Object.entries(chromosomes).slice(1).map(([name, size]) => ({ chromosome: name, start: 0, end: Math.min(size, small) })),
    { chromosome: chrom, start: Math.max(0, length - small), end: length },
  ]
  return [
    { name: 'A-single-track-10kb', run: fw => fw.getValues(chrom, start, Math.min(length, start + small), { tracks: [0] }) },
    { name: 'A-all-tracks-10kb', run: fw => fw.getValues(chrom, start, Math.min(length, start + small), { tracks: all }) },
    { name: 'B-single-track-100kb', run: fw => fw.getValues(chrom, start, start + medium, { tracks: [0] }) },
    { name: 'B-all-tracks-100kb', run: fw => fw.getValues(chrom, start, start + medium, { tracks: all }) },
    { name: 'C-same-group', run: fw => fw.getValues(chrom, start, start + medium, { tracks: same }) },
    { name: 'C-different-groups', run: fw => fw.getValues(chrom, start, start + medium, { tracks: cross }) },
    { name: 'D-coarse-large-region', run: fw => fw.getBins(chrom, 0, coarseEnd, { tracks: subset, binSize: binsize, aggregation: 'sum', missing: 'zero', useSummaries: true }) },
    { name: 'E-panning', run: fw => traceSteps(fw, Array.from({ length: 6 }, (_, index) => ({
      name: `pan-${index}`,
      run: () => {
        const left = Math.min(start + index * 20_000, length - medium)
        return fw.getValues(chrom, left, left + medium, { tracks: subset })
      },
    }))) },
    { name: 'F-zooming', run: fw => traceSteps(fw, [
      { name: 'full-resolution', run: () => fw.getValues(chrom, 0, small, { tracks: subset }) },
      { name: 'first-tile-summary', run: () => fw.getBins(chrom, 0, coarseEnd, { tracks: subset, binSize: tile, aggregation: 'sum', missing: 'zero', useSummaries: true }) },
      { name: 'first-coarse-zoom', run: () => fw.getBins(chrom, 0, coarseEnd, { tracks: subset, binSize: binsize, aggregation: 'sum', missing: 'zero', useSummaries: true }) },
      { name: 'repeated-tile-summary', run: () => fw.getBins(chrom, 0, coarseEnd, { tracks: subset, binSize: tile, aggregation: 'sum', missing: 'zero', useSummaries: true }) },
    ]) },
    { name: 'G-track-selection', run: fw => traceSteps(fw, [all, subset, all.slice(6, 12).length ? all.slice(6, 12) : subset, all].map((selected, index) => ({
      name: `selection-${index}-${selected.length}-tracks`,
      run: () => fw.getValues(chrom, start, start + medium, { tracks: selected }),
    }))) },
    { name: 'I-all-file-tracks-10kb', run: fw => fw.getValues(chrom, start, Math.min(length, start + small), { tracks: Array.from({ length: count }, (_, index) => index) }) },
    { name: 'I-scattered-file-tracks-10kb', run: fw => fw.getValues(chrom, start, Math.min(length, start + small), { tracks: [...new Set([0, Math.floor(count / 3), Math.floor(2 * count / 3), count - 1])] }) },
    { name: 'H-batch', run: fw => fw.getValuesMulti(regions, { tracks: subset }) },
    { name: 'H-sequential', run: async fw => {
      for (const region of regions) await fw.getValues(region.chromosome, region.start, region.end, { tracks: subset })
    } },
  ]
}

function quantile(values: number[], fraction: number) {
  const sorted = [...values].sort((a, b) => a - b)
  const position = (sorted.length - 1) * fraction
  const lower = Math.floor(position)
  return sorted[lower] + (sorted[Math.ceil(position)] - sorted[lower]) * (position - lower)
}

async function main() {
  const args = argumentsOf(process.argv.slice(2))
  const directory = resolve(args.directory)
  const names = args.files.length ? args.files.map(file => basename(file)) : (await readdir(directory)).filter(file => file.endsWith('.fw') && file.includes(args.match)).sort()
  if (!names.length) throw new Error('No benchmark files: run npm run benchmark:generate first')
  const selectedScenarios = args.scenarios === 'all' ? Object.keys(scenarios) as Scenario[] : args.scenarios.split(',') as Scenario[]
  for (const scenario of selectedScenarios) if (!(scenario in scenarios)) throw new Error(`Unknown scenario ${scenario}`)
  const samples: Sample[] = []
  const datasets: Record<string, Parameters & { bytes: number }> = {}
  const requestedPatterns = args.patterns.split(',')
  for (const file of names) {
    const parameters = JSON.parse(await readFile(resolve(directory, file.replace(/\.fw$/, '.json')), 'utf8')) as Parameters
    datasets[file] = { ...parameters, bytes: (await stat(resolve(directory, file))).size }
    for (const scenario of selectedScenarios) {
      const server = await startRangeServer({ root: directory, ...scenarios[scenario], seed: 1701, maxConcurrent: 8 })
      try {
        for (const pattern of patterns(parameters)) {
          if (args.patterns !== 'all' && !requestedPatterns.some(requested => pattern.name === requested || pattern.name.startsWith(requested + '-'))) continue
          // Untimed JIT/decompressor warm-up uses a separate reader, preserving
          // genuinely cold parsed/index/chunk caches for every measured sample.
          const warmup = new FigWig({ filehandle: new RemoteFile(`${server.url}/${file}`), coalesceGap: args.coalesceGap, maxConcurrentRequests: args.maxConcurrentRequests, maxCoalescedBytes: args.maxCoalescedBytes, chunkCacheBytes: args.chunkCacheBytes, indexCacheBytes: args.indexCacheBytes })
          await warmup.getHeader()
          await pattern.run(warmup)
          await warmup.close()
          for (let repetition = 0; repetition < args.repetitions; repetition++) {
            const reader = new FigWig({ filehandle: new RemoteFile(`${server.url}/${file}`), coalesceGap: args.coalesceGap, maxConcurrentRequests: args.maxConcurrentRequests, maxCoalescedBytes: args.maxCoalescedBytes, chunkCacheBytes: args.chunkCacheBytes, indexCacheBytes: args.indexCacheBytes })
            const initialized = performance.now()
            await reader.getHeader()
            const initializationMs = performance.now() - initialized
            for (const cache of ['cold', 'warm'] as const) {
              // A completed reader request can finish before the HTTP server's
              // final asynchronous file close, so let its active count settle.
              while (server.metrics.active) await new Promise(resolveDelay => setTimeout(resolveDelay, 1))
              server.resetMetrics()
              reader.resetDiagnostics()
              const before = performance.now()
              const patternResult = await pattern.run(reader)
              const milliseconds = performance.now() - before
              while (server.metrics.active) await new Promise(resolveDelay => setTimeout(resolveDelay, 1))
              const diagnostics = reader.getDiagnostics()
              samples.push({ file, scenario, pattern: pattern.name, cache, repetition, milliseconds, initializationMs, requests: server.metrics.requests, transferredBytes: server.metrics.bodyBytes, ...diagnostics, ...(Array.isArray(patternResult) && patternResult[0]?.diagnostics ? { steps: patternResult as TraceStep[] } : {}) })
            }
            await reader.close()
          }
          const cold = samples.filter(sample => sample.file === file && sample.scenario === scenario && sample.pattern === pattern.name && sample.cache === 'cold')
          console.log(`${file} ${scenario} ${pattern.name}: cold median ${quantile(cold.map(sample => sample.milliseconds), .5).toFixed(2)}ms, ${quantile(cold.map(sample => sample.transferredBytes), .5)} bytes`)
        }
      } finally { await server.close() }
    }
  }
  const environment = { date: new Date().toISOString(), node: process.version, platform: platform(), architecture: arch(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryBytes: totalmem() }
  const output = resolve(args.output)
  await mkdir(resolve(output, '..'), { recursive: true })
  await writeFile(output, JSON.stringify({ environment, scenarios, args, datasets, samples }, null, 2) + '\n')
  const grouped = new Map<string, Sample[]>()
  for (const sample of samples) {
    const key = `${sample.file}|${sample.scenario}|${sample.pattern}|${sample.cache}`
    grouped.set(key, [...(grouped.get(key) ?? []), sample])
  }
  const lines = ['# Measured benchmark results', '', `Generated: ${environment.date}. Node ${environment.node}; ${environment.cpu}; ${environment.platform}/${environment.architecture}; ${environment.logicalCpus} logical CPUs.`, '', 'These timings exclude header/metadata initialization (recorded separately in JSON). Each pattern has one untimed JIT warm-up on a separate reader; every cold sample creates a fresh reader, and its paired warm sample reuses it. Network simulation uses one shared bandwidth reservation timeline across responses, with 16 KiB body chunks. No external network is used.', '', '| File | Network | Pattern | Cache | n | Median ms | p95 ms | Requests | Body bytes | Index bytes | Data bytes | Chunks inflated | Cache bytes |', '|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|']
  for (const group of grouped.values()) {
    const first = group[0]
    const median = (key: keyof Sample) => quantile(group.map(sample => Number(sample[key])), .5)
    lines.push(`| ${first.file} | ${first.scenario} | ${first.pattern} | ${first.cache} | ${group.length} | ${median('milliseconds').toFixed(2)} | ${quantile(group.map(sample => sample.milliseconds), .95).toFixed(2)} | ${median('requests')} | ${median('transferredBytes')} | ${median('indexBytes')} | ${median('dataBytes')} | ${median('chunksDecompressed')} | ${median('cacheBytes')} |`)
  }
  lines.push('', 'Full samples include initialization, index loading, decompression, decoding time, chunk fetches, and cache hit/miss counts in the adjacent JSON file. Small repetition counts support exploratory comparisons; p95 is interpolated and is not a stable tail-latency estimate.', '')
  await writeFile(output.replace(/\.json$/, '.md'), lines.join('\n'))
  console.log(`Saved ${samples.length} samples to ${output}`)
}

await main()
