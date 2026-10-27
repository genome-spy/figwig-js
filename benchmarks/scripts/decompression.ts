/**
 * Optional research benchmark against pinned external GMOD WASM bundles.
 * These experimental adapters are deliberately absent from the runtime package:
 * the upstream APIs do not expose the consumed-input count Figwig requires.
 */
import { execFileSync } from 'node:child_process'
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { cpus, platform, arch } from 'node:os'
import { basename, dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'
import { build } from 'esbuild'
import { parseFixed, parseTables } from '../../src/format/header.js'
import { parseGroup } from '../../src/format/group.js'
import { crc32 } from '../../src/utils/binary.js'
import { inflateZlib } from '../../src/utils/inflate.js'

const BBI_COMMIT = 'a7eefcc0c9830f5dbbd8bded268a8dacdfaf96f5'
const BGZF_COMMIT = '02a8f4619316f189d8bb571da54af6214e9d8a26'
const MAX = 256 * 1024 ** 2
const args = process.argv.slice(2)
function argument(name: string, fallback: string): string {
  const index = args.indexOf(name)
  return index < 0 ? fallback : args[index + 1]
}

interface Payload {
  bytes: Uint8Array
  expected: number
  label: string
  raw: Uint8Array
  bgzf?: Uint8Array
}
interface BbiWasm {
  inflateRawBatch(
    data: Uint8Array,
    offsets: Uint32Array,
    sizes: Uint32Array,
    maximum: number,
  ): Promise<{ data: Uint8Array; offsets: number[] }>
}
interface BgzfWasm {
  decompressAll(data: Uint8Array): Promise<Uint8Array>
}

function readExact(fd: number, at: number, size: number): Uint8Array {
  if (size > MAX) throw new Error(`Benchmark read exceeds ${MAX} bytes`)
  const bytes = new Uint8Array(size)
  if (readSync(fd, bytes, 0, size, at) !== size)
    throw new Error('Truncated benchmark fixture')
  return bytes
}
function same(a: Uint8Array, b: Uint8Array): void {
  if (a.length !== b.length || !Buffer.from(a).equals(b))
    throw new Error('WASM output differs from verified Pako output')
}

/** RFC1950 header, output length and Adler32 only. Does NOT check consumed input. */
function checkEnvelope(
  bytes: Uint8Array,
  output: Uint8Array,
  expected: number,
): void {
  const cmf = bytes[0],
    flg = bytes[1]
  if (
    bytes.length < 6 ||
    (cmf & 15) !== 8 ||
    cmf >>> 4 > 7 ||
    ((cmf << 8) + flg) % 31 ||
    flg & 32
  )
    throw new Error('Invalid zlib header')
  if (output.length !== expected) throw new Error('Incorrect inflated size')
  let a = 1,
    b = 0
  for (let at = 0; at < output.length; at += 5552) {
    const end = Math.min(output.length, at + 5552)
    for (let i = at; i < end; i++) {
      a += output[i]
      b += a
    }
    a %= 65521
    b %= 65521
  }
  const stored = new DataView(
    bytes.buffer,
    bytes.byteOffset + bytes.length - 4,
    4,
  ).getUint32(0)
  if (((b << 16) | a) >>> 0 !== stored) throw new Error('Adler32 mismatch')
}

/** Reuse the exact raw DEFLATE bytes inside a synthetic, valid BGZF envelope. */
function rewrap(payload: Payload): Uint8Array | undefined {
  const size = payload.bytes.length - 6 + 26
  if (payload.expected > 65_536 || size > 65_536) return undefined
  const result = new Uint8Array(size)
  result.set([31, 139, 8, 4, 0, 0, 0, 0, 0, 255, 6, 0, 66, 67, 2, 0])
  const view = new DataView(result.buffer)
  view.setUint16(16, size - 1, true)
  result.set(payload.bytes.subarray(2, -4), 18)
  view.setUint32(size - 8, crc32(payload.raw), true)
  view.setUint32(size - 4, payload.expected, true)
  return result
}

function sample<T>(values: T[], maximum: number): T[] {
  if (values.length <= maximum) return values
  return Array.from(
    { length: maximum },
    (_, i) => values[Math.floor((i * (values.length - 1)) / (maximum - 1))],
  )
}

function collect(path: string, maximum: number): Payload[] {
  const fd = openSync(path, 'r')
  try {
    const f = parseFixed(readExact(fd, 0, 128))
    if (f.codec !== 1) return []
    const state = parseTables(
      f,
      readExact(fd, f.chroms, f.index + f.nGroups * 8 - f.chroms),
    )
    const candidates: {
      offset: number
      size: number
      raw: number
      group: number
    }[] = []
    for (let group = 0; group < f.nGroups; group++) {
      const at = state.directory[group],
        end = state.directory[group + 1] ?? f.length
      const index = parseGroup(readExact(fd, at, end - at), group, state, MAX)
      for (const chunk of index.chunks)
        if (!(chunk.kind & 128)) candidates.push({ ...chunk, group })
    }
    return sample(candidates, maximum).map((ref, i) => {
      const bytes = readExact(fd, ref.offset, ref.size)
      const raw = inflateZlib(bytes, ref.raw, MAX)
      const payload: Payload = {
        bytes,
        expected: ref.raw,
        raw,
        label: `${basename(path)}:${ref.group}:${i}`,
      }
      payload.bgzf = rewrap(payload)
      return payload
    })
  } finally {
    closeSync(fd)
  }
}

function pack(payloads: Payload[], bgzf = false) {
  const inputs = payloads.map((p) => (bgzf ? p.bgzf! : p.bytes))
  const offsets = new Uint32Array(inputs.length),
    sizes = new Uint32Array(inputs.length)
  let size = 0
  for (let i = 0; i < inputs.length; i++) {
    offsets[i] = size
    sizes[i] = inputs[i].length
    size += inputs[i].length
  }
  const bytes = new Uint8Array(size)
  for (let i = 0; i < inputs.length; i++) bytes.set(inputs[i], offsets[i])
  return {
    bytes,
    offsets,
    sizes,
    maximum: Math.max(...payloads.map((p) => p.expected)),
    payloads,
  }
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[
    Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))
  ]
}

async function main() {
  const bbiRoot = resolve(argument('--bbi-checkout', '/tmp/figwig-bbi-js'))
  const bgzfRoot = resolve(
    argument('--bgzf-checkout', '/tmp/figwig-bgzf-filehandle'),
  )
  for (const [directory, commit] of [
    [bbiRoot, BBI_COMMIT],
    [bgzfRoot, BGZF_COMMIT],
  ]) {
    const actual = execFileSync('git', ['-C', directory, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim()
    if (actual !== commit)
      throw new Error(
        `Expected upstream commit ${commit}; found ${actual} at ${directory}`,
      )
  }
  const bbiPath = resolve(bbiRoot, 'src/wasm/inflate-wasm-inlined.js')
  const bgzfPath = resolve(bgzfRoot, 'src/wasm/bgzf-wasm-inlined.js')
  mkdirSync('benchmarks/results', { recursive: true })
  const pakoBundle = await build({
    entryPoints: ['src/utils/inflate.ts'],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    minify: true,
    write: false,
  })
  const pakoPath = resolve('benchmarks/results/pako-strict.mjs')
  writeFileSync(pakoPath, pakoBundle.outputFiles[0].contents)
  const bbi: BbiWasm = (await import(pathToFileURL(bbiPath).href)) as BbiWasm
  const bgzf: BgzfWasm = (await import(
    pathToFileURL(bgzfPath).href
  )) as BgzfWasm
  const repetitions = Number(argument('--repetitions', '7'))
  const cases: { name: string; payloads: Payload[] }[] = []
  for (const [name, paths] of [
    ['official-position', ['test/fixtures/zlib.fw']],
    [
      'official-track',
      ['test/fixtures/tracks_zlib.fw', 'test/fixtures/blocks.fw'],
    ],
    [
      'sparse24',
      ['benchmarks/fixtures/sparse-n24-tile4096-g4-positions-l6-s1701.fw'],
    ],
    [
      'dense8',
      ['benchmarks/fixtures/dense-n8-tile4096-g4-positions-l6-s1701.fw'],
    ],
    [
      'mixed24',
      ['benchmarks/fixtures/mixed-n24-tile4096-g4-positions-l6-s1701.fw'],
    ],
  ] as const) {
    const payloads = paths.flatMap((path) => collect(path, 128))
    for (const eligible of [true, false]) {
      const selected = payloads.filter((p) => Boolean(p.bgzf) === eligible)
      if (selected.length)
        cases.push({
          name: `${name}/${eligible ? 'BGZF-eligible' : 'over-BGZF-limit'}`,
          payloads: selected,
        })
    }
  }
  const first = cases
    .flatMap((c) => c.payloads)
    .find((p) => p.expected > 32_000 && p.bgzf)!
  const moduleSizes = [bbiPath, bgzfPath, pakoPath].map((path) => {
    const code = readFileSync(path)
    const base64 = code
      .toString()
      .match(/data:application\/wasm;base64,([A-Za-z0-9+/=]+)/)?.[1]
    return {
      name: basename(path),
      javascriptBytes: code.length,
      gzipBytes: gzipSync(code).length,
      wasmBytes: base64 ? Buffer.from(base64, 'base64').length : null,
    }
  })
  const cold = []
  for (const [name, path, payload] of [
    ['bbi', bbiPath, first.bytes],
    ['bgzf', bgzfPath, first.bgzf!],
    ['pako', pakoPath, first.bytes],
  ] as const) {
    const timings = []
    for (let i = 0; i < repetitions; i++) {
      const code = `const start=performance.now();const m=await import(process.argv[1]);const loaded=performance.now();const bytes=Uint8Array.from(Buffer.from(process.argv[2],'base64'));if(process.argv[3]==='bbi')await m.inflateRawBatch(bytes,Uint32Array.of(0),Uint32Array.of(bytes.length),${first.expected});else if(process.argv[3]==='pako')m.inflateZlib(bytes,${first.expected},${MAX});else await m.decompressAll(bytes);process.stdout.write(JSON.stringify({importMs:loaded-start,firstCallMs:performance.now()-loaded,totalMs:performance.now()-start}));`
      timings.push(
        JSON.parse(
          execFileSync(
            process.execPath,
            [
              '--input-type=module',
              '-e',
              code,
              pathToFileURL(path).href,
              Buffer.from(payload).toString('base64'),
              name,
            ],
            { encoding: 'utf8' },
          ),
        ) as { importMs: number; firstCallMs: number; totalMs: number },
      )
    }
    cold.push({
      name,
      medianImportMs: percentile(
        timings.map((t) => t.importMs),
        0.5,
      ),
      medianFirstCallMs: percentile(
        timings.map((t) => t.firstCallMs),
        0.5,
      ),
      medianTotalMs: percentile(
        timings.map((t) => t.totalMs),
        0.5,
      ),
      p95TotalMs: percentile(
        timings.map((t) => t.totalMs),
        0.95,
      ),
      samples: timings,
    })
  }
  const results = []
  for (const entry of cases) {
    const totalRaw = entry.payloads.reduce((sum, p) => sum + p.expected, 0)
    const passes = Math.min(
      1024,
      Math.max(1, Math.ceil((8 * 1024 ** 2) / totalRaw)),
    )
    const singles = entry.payloads.map((p) => ({ payload: p, pack: pack([p]) }))
    const batches: ReturnType<typeof pack>[] = []
    for (let i = 0; i < entry.payloads.length; i += 32)
      batches.push(pack(entry.payloads.slice(i, i + 32)))
    const variants: {
      name: string
      run: () => Promise<void>
      times: number[]
    }[] = [
      {
        name: 'Pako strict',
        times: [],
        run: async () => {
          for (const p of entry.payloads) inflateZlib(p.bytes, p.expected, MAX)
        },
      },
      {
        name: 'BBI raw single',
        times: [],
        run: async () => {
          for (const { pack: p } of singles)
            await bbi.inflateRawBatch(p.bytes, p.offsets, p.sizes, p.maximum)
        },
      },
      {
        name: 'BBI header+Adler single',
        times: [],
        run: async () => {
          for (const { payload, pack: p } of singles) {
            const result = await bbi.inflateRawBatch(
              p.bytes,
              p.offsets,
              p.sizes,
              p.maximum,
            )
            checkEnvelope(payload.bytes, result.data, payload.expected)
          }
        },
      },
      {
        name: 'BBI header+Adler batch32',
        times: [],
        run: async () => {
          for (const p of batches) {
            const result = await bbi.inflateRawBatch(
              p.bytes,
              p.offsets,
              p.sizes,
              p.maximum,
            )
            for (let i = 0; i < p.payloads.length; i++)
              checkEnvelope(
                p.payloads[i].bytes,
                result.data.subarray(result.offsets[i], result.offsets[i + 1]),
                p.payloads[i].expected,
              )
          }
        },
      },
    ]
    if (entry.payloads[0].bgzf)
      variants.push(
        {
          name: 'BGZF rewrap raw single',
          times: [],
          run: async () => {
            for (const p of entry.payloads) await bgzf.decompressAll(p.bgzf!)
          },
        },
        {
          name: 'BGZF rewrap header+Adler single',
          times: [],
          run: async () => {
            for (const p of entry.payloads)
              checkEnvelope(
                p.bytes,
                await bgzf.decompressAll(p.bgzf!),
                p.expected,
              )
          },
        },
      )
    // Verify all outputs outside the timer, then warm every path twice.
    for (const { payload, pack: p } of singles) {
      same(
        (await bbi.inflateRawBatch(p.bytes, p.offsets, p.sizes, p.maximum))
          .data,
        payload.raw,
      )
      if (payload.bgzf)
        same(await bgzf.decompressAll(payload.bgzf), payload.raw)
    }
    for (const variant of variants) {
      await variant.run()
      await variant.run()
    }
    for (let repeat = 0; repeat < repetitions; repeat++) {
      for (let i = 0; i < variants.length; i++) {
        const variant = variants[(i + repeat) % variants.length]
        const start = performance.now()
        for (let pass = 0; pass < passes; pass++) await variant.run()
        variant.times.push(performance.now() - start)
      }
    }
    for (const variant of variants) {
      const medianMs = percentile(variant.times, 0.5),
        p95Ms = percentile(variant.times, 0.95)
      const row = {
        dataset: entry.name,
        variant: variant.name,
        chunks: entry.payloads.length,
        compressedBytes: entry.payloads.reduce(
          (sum, p) => sum + p.bytes.length,
          0,
        ),
        rawBytes: totalRaw,
        passes,
        medianMs,
        p95Ms,
        mibPerSecond: (totalRaw * passes) / 1024 ** 2 / (medianMs / 1000),
        samples: variant.times,
      }
      results.push(row)
      console.log(
        `${row.dataset} | ${row.variant}: median ${medianMs.toFixed(3)} ms, p95 ${p95Ms.toFixed(3)} ms, ${row.mibPerSecond.toFixed(1)} MiB/s`,
      )
    }
  }
  // Explicit semantic probes: a length+Adler wrapper still cannot reject data
  // between the end of raw DEFLATE and the Adler32 without consumed-input info.
  const probe = cases[0].payloads[0]
  const checksum = probe.bytes.slice()
  checksum[checksum.length - 1] ^= 1
  const header = probe.bytes.slice()
  header[0] = 0
  const trailing = Uint8Array.from([
    ...probe.bytes.subarray(0, -4),
    123,
    ...probe.bytes.subarray(-4),
  ])
  const concatenated = Uint8Array.from([...probe.bytes, ...probe.bytes])
  const probes = []
  for (const [name, bytes, expected] of [
    ['valid', probe.bytes, probe.expected],
    ['bad header', header, probe.expected],
    ['bad Adler32', checksum, probe.expected],
    ['trailing DEFLATE byte', trailing, probe.expected],
    ['concatenated streams', concatenated, probe.expected],
    ['declared output too small', probe.bytes, probe.expected - 1],
  ] as const) {
    const statuses: Record<string, string> = {}
    for (const mode of ['Pako strict', 'BBI raw', 'BBI header+Adler']) {
      try {
        if (mode === 'Pako strict') inflateZlib(bytes, expected, MAX)
        else {
          const result = await bbi.inflateRawBatch(
            bytes,
            Uint32Array.of(0),
            Uint32Array.of(bytes.length),
            expected,
          )
          if (mode === 'BBI header+Adler')
            checkEnvelope(bytes, result.data, expected)
        }
        statuses[mode] = 'accepted'
      } catch {
        statuses[mode] = 'rejected'
      }
    }
    probes.push({ name, ...statuses })
  }
  let bgzfZlib = 'accepted'
  try {
    await bgzf.decompressAll(probe.bytes)
  } catch {
    bgzfZlib = 'rejected'
  }
  const report = {
    environment: {
      node: process.version,
      platform: `${platform()} ${arch()}`,
      cpu: cpus()[0]?.model,
      date: new Date().toISOString(),
      repetitions,
    },
    upstream: { bbi: BBI_COMMIT, bgzf: BGZF_COMMIT },
    moduleSizes,
    cold,
    results,
    probes,
    bgzfOrdinaryZlib: bgzfZlib,
    files: [
      'test/fixtures/zlib.fw',
      'test/fixtures/tracks_zlib.fw',
      'test/fixtures/blocks.fw',
      'benchmarks/fixtures/sparse-n24-tile4096-g4-positions-l6-s1701.fw',
      'benchmarks/fixtures/dense-n8-tile4096-g4-positions-l6-s1701.fw',
      'benchmarks/fixtures/mixed-n24-tile4096-g4-positions-l6-s1701.fw',
    ].map((path) => ({ path, size: statSync(path).size })),
  }
  mkdirSync('benchmarks/results', { recursive: true })
  const output = argument(
    '--output',
    'benchmarks/measurements/decompression.json',
  )
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
  console.log(`Saved ${output}`)
}

await main()
