/** Summarize Chrome's incremental CPU profile and Figwig range requests. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, dirname } from 'node:path'
import { URL } from 'node:url'
import process from 'node:process'

const bytes = await readFile(process.argv[2]),
  trace = JSON.parse(bytes),
  nodes = new Map(),
  samples = [],
  self = new Map(),
  inclusive = new Map()
if (trace.traceEvents.filter((event) => event.name === 'Profile').length !== 1)
  throw new Error('This analyzer requires one V8 CPU profile')
for (const event of trace.traceEvents) {
  if (event.name !== 'ProfileChunk') continue
  const data = event.args.data,
    profile = data.cpuProfile ?? {}
  for (const node of profile.nodes ?? [])
    nodes.set(node.id, { ...nodes.get(node.id), ...node })
  if ((profile.samples?.length ?? 0) !== (data.timeDeltas?.length ?? 0))
    throw new Error('CPU sample/timeDelta length mismatch')
  for (let i = 0; i < (profile.samples?.length ?? 0); i++)
    samples.push([profile.samples[i], data.timeDeltas[i]])
}
const keyOf = (node) =>
  JSON.stringify({
    name: node.callFrame.functionName || '(anonymous)',
    file: node.callFrame.url
      ? basename(new URL(node.callFrame.url).pathname)
      : '',
    line:
      node.callFrame.lineNumber === undefined
        ? 0
        : node.callFrame.lineNumber + 1,
  })
for (const [id, weight] of samples) {
  const node = nodes.get(id),
    key = keyOf(node)
  self.set(key, (self.get(key) ?? 0) + weight)
  const seen = new Set()
  for (let current = node; current; current = nodes.get(current.parent)) {
    const key = keyOf(current)
    if (!seen.has(key)) inclusive.set(key, (inclusive.get(key) ?? 0) + weight)
    seen.add(key)
  }
}
const totalUs = samples.reduce((sum, [, weight]) => sum + weight, 0),
  idleUs = [...self]
    .filter(([key]) => JSON.parse(key).name === '(idle)')
    .reduce((sum, [, weight]) => sum + weight, 0)
const rows = (map) =>
  [...map]
    .map(([key, weight]) => ({
      ...JSON.parse(key),
      ms: weight / 1000,
      percentActive:
        JSON.parse(key).name === '(idle)'
          ? null
          : (weight / (totalUs - idleUs)) * 100,
    }))
    .sort((a, b) => b.ms - a.ms)
const requests = new Map(
  trace.traceEvents
    .filter((e) => e.name === 'ResourceSendRequest')
    .map((e) => [e.args.data.requestId, e.args.data]),
)
const ranges = trace.traceEvents
  .filter(
    (e) =>
      e.name === 'ResourceReceiveResponse' &&
      requests.get(e.args.data.requestId)?.url &&
      new URL(requests.get(e.args.data.requestId).url).pathname.endsWith('.fw'),
  )
  .map((event) => {
    const data = event.args.data,
      headers = Object.fromEntries(
        data.headers.map(({ name, value }) => [name.toLowerCase(), value]),
      )
    return {
      status: data.statusCode,
      range: headers['content-range'],
      bytes: Number(headers['content-length']),
      sendDelayMs: data.timing?.sendStart,
    }
  })
const report = {
  source: 'User-provided Chrome navigation trace',
  sha256: createHash('sha256').update(bytes).digest('hex'),
  startTime: trace.metadata.startTime,
  sampledMs: totalUs / 1000,
  idleMs: idleUs / 1000,
  method:
    'Incremental ProfileChunk nodes and timeDeltas; inclusive includes callees and must not be summed across nested rows. Active excludes (idle). Script paths reduced to basenames; raw trace is not copied.',
  self: rows(self).slice(0, 40),
  inclusive: rows(inclusive).slice(0, 40),
  focused: [
    'aggregate',
    'add',
    'inflateZlib',
    'inflater.onData',
    'decodeChunk',
    'readValues',
    'summaryBins',
    'getSummary',
    'parseSummary',
    'getZoomLevels',
  ].map((name) => ({
    name,
    selfMs: rows(self)
      .filter((row) => row.name === name)
      .reduce((sum, row) => sum + row.ms, 0),
    inclusiveMs: rows(inclusive)
      .filter((row) => row.name === name)
      .reduce((sum, row) => sum + row.ms, 0),
  })),
  figwigRangeRequests: ranges.length,
  figwigBytes: ranges.reduce((sum, r) => sum + r.bytes, 0),
  ranges,
}
const output = process.argv[3] ?? 'benchmarks/results/navigation-trace.json'
await mkdir(dirname(output), { recursive: true })
await writeFile(output, JSON.stringify(report, null, 2) + '\n')
process.stdout.write(
  JSON.stringify(
    {
      sampledMs: report.sampledMs,
      idleMs: report.idleMs,
      self: report.self.slice(0, 10),
      figwigRangeRequests: report.figwigRangeRequests,
      figwigBytes: report.figwigBytes,
    },
    null,
    2,
  ) + '\n',
)
