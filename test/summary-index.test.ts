import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { constants, deflateRawSync } from 'node:zlib'
import { BlobFile, LocalFile } from 'generic-filehandle2'
import { expect, test } from 'vitest'
import { FigWig } from '../src/index.js'
import { parseFixed, parseTables } from '../src/format/header.js'
import { crc32 } from '../src/utils/binary.js'
import { inflateRestart } from '../src/utils/inflate.js'
import { decodeNumber } from './conformance/oracle.js'
import type { OracleNumber } from './conformance/oracle.js'

interface Query {
  name: string
  chromosome: string
  start: number
  end: number
  binSize: number
  tracks: number[]
  expected: Record<string, OracleNumber[]>
}
interface Level {
  group: number
  level: number
  source_offset: number
  source_bytes: number
  source_rows: number
  window_bins: number
  index_offset: number
}
const manifest = JSON.parse(
  readFileSync(
    new URL('./fixtures/summary-expected.json', import.meta.url),
    'utf8',
  ),
) as {
  queries: Query[]
  files: Record<string, { sha256: string; levels: Level[] }>
}
const path = (name: string) =>
  new URL(`./fixtures/${name}.fw`, import.meta.url).pathname
const query = () => manifest.queries.find((q) => q.name === 'base')!
const options = (q: Query) => ({
  tracks: q.tracks,
  binSize: q.binSize,
  aggregation: 'sum' as const,
  missing: 'zero' as const,
  requireSummaries: true,
})
const bins = (reader: FigWig, q = query()) =>
  reader.getBins(q.chromosome, q.start, q.end, options(q))

class CapturedFile extends BlobFile {
  reads: { offset: number; size: number; bytes: Uint8Array }[] = []
  override async read(...args: Parameters<BlobFile['read']>) {
    const data = await super.read(...args)
    this.reads.push({ offset: args[1] ?? 0, size: args[0], bytes: data })
    return data
  }
}
function captured(name = 'summary_positions', settings = {}) {
  const bytes = new Uint8Array(readFileSync(path(name))),
    filehandle = new CapturedFile(new Blob([bytes])),
    reader = new FigWig({ filehandle, coalesceGap: 0, ...settings })
  return { bytes, filehandle, reader }
}
function layout(bytes: Uint8Array, name = 'summary_positions') {
  const fixed = parseFixed(bytes),
    state = parseTables(
      fixed,
      bytes.subarray(fixed.chroms, fixed.index + 8 * fixed.nGroups),
    ),
    locator = state.header.metadata['org.figwig.summary-restarts'] as {
      offset: number
    },
    view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    directory = Number(view.getBigUint64(locator.offset + 16, true)),
    catalog = Number(view.getBigUint64(directory, true)),
    ref = manifest.files[name].levels.find(
      (l) => l.group === 0 && l.level === 0,
    )!,
    window = Math.floor(query().start / fixed.tile / ref.window_bins),
    page = ref.index_offset + Math.floor(window / 102) * 4096,
    descriptor = page + 16 + (window % 102) * 40,
    idOffset = ref.source_offset + view.getUint32(descriptor + 8, true),
    idSize = view.getUint32(descriptor + 12, true)
  return {
    fixed,
    state,
    root: locator.offset,
    directory,
    catalog,
    ref,
    window,
    page,
    descriptor,
    idOffset,
    idSize,
    view,
  }
}
function updateCrc(
  bytes: Uint8Array,
  offset: number,
  size: number,
  field: number,
) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  view.setUint32(offset + field, 0, true)
  view.setUint32(
    offset + field,
    crc32(bytes.subarray(offset, offset + size)),
    true,
  )
}

test.each(Object.keys(manifest.files))(
  '%s matches its independent source hash',
  (name) => {
    expect(
      createHash('sha256')
        .update(readFileSync(path(name)))
        .digest('hex'),
    ).toBe(manifest.files[name].sha256)
  },
)
test.each(['positions', 'tracks'])(
  '%s indexed queries preserve independent v1 sums at every level',
  async (order) => {
    const reader = new FigWig({
        filehandle: new LocalFile(path(`summary_${order}`)),
      }),
      legacy = new FigWig({
        filehandle: new LocalFile(path(`summary_${order}_legacy`)),
      })
    try {
      for (const q of manifest.queries) {
        const result = await bins(reader, q)
        expect(result.source).toBe('summary')
        for (const item of result.tracks)
          expect([...item.values], q.name).toEqual(
            q.expected[item.track.name].map(decodeNumber),
          )
        expect(result).toEqual(await bins(legacy, q))
      }
      const header = await reader.getHeader()
      for (let group = 0; group < header.groupCount; group++)
        for (let level = 0; level < 4; level++) {
          const actual = await reader.getSummary(group, level),
            expected = await legacy.getSummary(group, level)
          expect(actual.bins).toEqual(expected.bins)
          expect(actual.sums).toEqual(expected.sums)
        }
    } finally {
      await reader.close()
      await legacy.close()
    }
  },
)
test.each(['positions', 'tracks'])(
  '%s regional reads avoid whole levels and preserve private cache ownership',
  async (order) => {
    const name = `summary_${order}`,
      { reader, filehandle, bytes } = captured(name)
    try {
      await reader.getHeader()
      filehandle.reads.length = 0
      reader.resetDiagnostics()
      const result = await bins(reader),
        expected = [...result.tracks[0].values],
        metrics = reader.getDiagnostics()
      expect(metrics.summaryInflatedBytes).toBeGreaterThan(0)
      const fullRaw = manifest.files[name].levels
        .filter((l) => l.level === 0)
        .reduce(
          (n, l) =>
            n +
            l.source_rows *
              (4 + 4 * (order === 'positions' && l.group === 0 ? 8 : 1)),
          0,
        )
      expect(metrics.summaryInflatedBytes).toBeLessThan(fullRaw / 4)
      for (const level of manifest.files[name].levels.filter(
        (l) => l.level === 0 && l.window_bins,
      ))
        expect(
          filehandle.reads.some(
            (r) =>
              r.offset <= level.source_offset &&
              r.offset + r.size >= level.source_offset + level.source_bytes,
          ),
        ).toBe(false)
      expect(filehandle.reads.reduce((n, r) => n + r.size, 0)).toBeLessThan(
        bytes.length / 3,
      )
      for (const read of filehandle.reads) read.bytes.fill(0)
      filehandle.reads.length = 0
      result.tracks[0].values.fill(999)
      expect([...(await bins(reader)).tracks[0].values]).toEqual(expected)
      expect(filehandle.reads).toHaveLength(0)
      reader.clearCache()
      expect(reader.getDiagnostics().cacheBytes).toBe(0)
    } finally {
      await reader.close()
    }
  },
)
test.each([0, 1])(
  'a %i-byte summary budget retains no oversized restart entries',
  async (summaryCacheBytes) => {
    const { reader, filehandle } = captured('summary_positions', {
      summaryCacheBytes,
    })
    try {
      await bins(reader)
      const first = filehandle.reads.length
      await bins(reader)
      expect(filehandle.reads.length).toBeGreaterThan(first)
      expect(reader.getDiagnostics().cacheBytes).toBe(0)
    } finally {
      await reader.close()
    }
  },
)
test('restart directory allocations fail before reading an oversized descriptor page', async () => {
  const { reader, filehandle, bytes } = captured('summary_positions', {
      maxInflatedBytes: 4000,
    }),
    { page } = layout(bytes)
  try {
    await expect(bins(reader)).rejects.toThrow(/maxInflatedBytes/)
    expect(filehandle.reads.some((r) => r.offset === page)).toBe(false)
  } finally {
    await reader.close()
  }
})

test.each(['root', 'locator', 'catalog', 'page', 'fragment'] as const)(
  'mandatory %s CRC checks survive verify:false and do not affect raw/whole-level paths',
  async (section) => {
    const bytes = new Uint8Array(readFileSync(path('summary_positions'))),
      l = layout(bytes),
      at = {
        root: l.root + 40,
        locator: l.directory + 28,
        catalog: l.catalog + 16,
        page: l.page + 20,
        fragment: l.idOffset + 1,
      }[section]
    bytes[at] ^= 1
    const reader = new FigWig({
      filehandle: new BlobFile(new Blob([bytes])),
      verify: false,
    })
    try {
      await expect(bins(reader)).rejects.toThrow(/CRC-32/)
      if (section !== 'fragment')
        await expect(reader.getSummary(0)).resolves.toHaveProperty(
          'available',
          true,
        )
      await expect(
        reader.getValues('chrA', 0, 16, { tracks: [0] }),
      ).resolves.toHaveProperty('tracks')
    } finally {
      await reader.close()
    }
  },
)
test.each(['window count', 'fragment extent', 'empty descriptor'] as const)(
  'rejects a CRC-correct malformed %s before a payload read',
  async (kind) => {
    const bytes = new Uint8Array(readFileSync(path('summary_positions'))),
      l = layout(bytes)
    if (kind === 'window count')
      l.view.setUint32(l.descriptor, l.ref.window_bins + 1, true)
    else if (kind === 'fragment extent')
      l.view.setUint32(l.descriptor + 8, l.ref.source_bytes, true)
    else {
      l.view.setUint32(l.descriptor, 0, true)
      l.view.setUint32(l.descriptor + 4, 0, true)
    }
    updateCrc(bytes, l.page, 16 + l.view.getUint32(l.page + 8, true) * 40, 12)
    const handle = new CapturedFile(new Blob([bytes])),
      reader = new FigWig({ filehandle: handle, coalesceGap: 0 })
    try {
      await expect(bins(reader)).rejects.toThrow(/summary restart/)
      expect(
        handle.reads.some(
          (r) => r.offset === l.idOffset && r.size === l.idSize,
        ),
      ).toBe(false)
    } finally {
      await reader.close()
    }
  },
)
test("a CRC-correct page cannot alias another window's sum fragment", async () => {
  const bytes = new Uint8Array(readFileSync(path('summary_positions'))),
    l = layout(bytes)
  expect(l.view.getUint32(l.descriptor, true)).toBe(
    l.view.getUint32(l.descriptor + 40, true),
  )
  bytes.copyWithin(l.descriptor + 24, l.descriptor + 64, l.descriptor + 80)
  updateCrc(bytes, l.page, 16 + l.view.getUint32(l.page + 8, true) * 40, 12)
  const reader = new FigWig({ filehandle: new BlobFile(new Blob([bytes])) })
  try {
    await expect(bins(reader)).rejects.toThrow(/overlap|order/)
    await expect(reader.getSummary(0)).resolves.toHaveProperty(
      'available',
      true,
    )
  } finally {
    await reader.close()
  }
})
test('a failed group stops this query from scheduling later groups and windows', async () => {
  const bytes = new Uint8Array(readFileSync(path('summary_tracks'))),
    l = layout(bytes, 'summary_tracks')
  bytes[l.page + 20] ^= 1
  let started = 0
  class DelayedFile extends BlobFile {
    override async read(...args: Parameters<BlobFile['read']>) {
      started++
      await new Promise((resolve) => setTimeout(resolve, 4))
      return super.read(...args)
    }
  }
  const reader = new FigWig({
      filehandle: new DelayedFile(new Blob([bytes])),
      coalesceGap: 0,
    }),
    q = query()
  try {
    await expect(
      reader.getBins(q.chromosome, q.start, q.end, {
        ...options(q),
        tracks: [0, 1, 2, 3, 4, 5, 6],
      }),
    ).rejects.toThrow(/CRC-32/)
    const atRejection = started
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(started).toBe(atRejection)
  } finally {
    await reader.close()
  }
})
test.each(['positions', 'tracks'])(
  '%s overview reuses the extension catalog instead of rediscovering headers',
  async (order) => {
    const { reader, filehandle } = captured(`summary_${order}`),
      q = query(),
      overview = manifest.queries.find((q) => q.name === 'overview')!
    try {
      await bins(reader)
      filehandle.reads.length = 0
      await bins(reader, overview)
      expect(filehandle.reads.length).toBeLessThanOrEqual(
        order === 'positions' ? 1 : q.tracks.length,
      )
      // Its complete level is also available through the unchanged public API.
      filehandle.reads.length = 0
      const group = 0,
        level = 3
      await reader.getSummary(group, level)
      expect(filehandle.reads).toHaveLength(0)
    } finally {
      await reader.close()
    }
  },
)
test('a changed header makes a valid old root stale and safely uses legacy summaries', async () => {
  const bytes = new Uint8Array(readFileSync(path('summary_positions'))),
    l = layout(bytes)
  l.view.setUint32(100, l.fixed.optional | 4, true)
  updateCrc(bytes, 0, 128, 104)
  const reader = new FigWig({ filehandle: new BlobFile(new Blob([bytes])) })
  try {
    expect([...(await bins(reader)).tracks[0].values]).toEqual(
      query().expected.signal0.map(decodeNumber),
    )
    expect(reader.getDiagnostics().summaryInflatedBytes).toBeGreaterThan(65536)
  } finally {
    await reader.close()
  }
})
test('an unused legacy stream corruption is deferred until its bytes are requested', async () => {
  const bytes = new Uint8Array(readFileSync(path('summary_positions'))),
    l = layout(bytes)
  bytes[l.ref.source_offset + l.ref.source_bytes - 1] ^= 1
  const reader = new FigWig({ filehandle: new BlobFile(new Blob([bytes])) })
  try {
    expect((await bins(reader)).source).toBe('summary')
    await expect(reader.getSummary(0)).rejects.toThrow(/CRC-32/)
  } finally {
    await reader.close()
  }
})
test('unknown optional bit 1 without the namespaced locator retains normal v1 fallback', async () => {
  const bytes = new Uint8Array(
      readFileSync(new URL('./fixtures/zlib.fw', import.meta.url)),
    ),
    view = new DataView(bytes.buffer)
  view.setUint32(100, view.getUint32(100, true) | 2, true)
  updateCrc(bytes, 0, 128, 104)
  const reader = new FigWig({ filehandle: new BlobFile(new Blob([bytes])) })
  try {
    await expect(
      reader.getBins('chr1', 0, 64, {
        binSize: 64,
        missing: 'zero',
        requireSummaries: true,
      }),
    ).resolves.toHaveProperty('source', 'summary')
  } finally {
    await reader.close()
  }
})
test.each([1, 9])(
  'unsupported locator version %i uses whole v1 summaries',
  async (version) => {
    const bytes = new Uint8Array(readFileSync(path('summary_positions'))),
      l = layout(bytes),
      text = new TextDecoder().decode(
        bytes.subarray(
          l.fixed.metadata,
          l.fixed.metadata + l.fixed.metadataLength,
        ),
      ),
      changed = text.replace(
        /("org.figwig.summary-restarts"\s*:\s*\{\s*"version"\s*:\s*)2/,
        `$1${version}`,
      ),
      encoded = new TextEncoder().encode(changed)
    expect(changed).not.toBe(text)
    expect(encoded.length).toBe(l.fixed.metadataLength)
    bytes.set(encoded, l.fixed.metadata)
    l.view.setUint32(
      28,
      crc32(
        bytes.subarray(l.fixed.chroms, l.fixed.index + 8 * l.fixed.nGroups),
      ),
      true,
    )
    updateCrc(bytes, 0, 128, 104)
    const reader = new FigWig({ filehandle: new BlobFile(new Blob([bytes])) })
    try {
      expect((await bins(reader)).source).toBe('summary')
      expect(reader.getDiagnostics().summaryInflatedBytes).toBeGreaterThan(
        65536,
      )
      expect(reader.getDiagnostics().summaryIndexBytes).toBe(0)
      for (const q of manifest.queries) {
        const result = await bins(reader, q)
        for (const item of result.tracks)
          expect([...item.values]).toEqual(
            q.expected[item.track.name].map(decodeNumber),
          )
      }
    } finally {
      await reader.close()
    }
  },
)
test('a locator and root with mismatched versions reject as malformed', async () => {
  const bytes = new Uint8Array(readFileSync(path('summary_positions'))),
    l = layout(bytes)
  l.view.setUint16(l.root + 8, 9, true)
  updateCrc(bytes, l.root, 256, 12)
  const reader = new FigWig({ filehandle: new BlobFile(new Blob([bytes])) })
  try {
    await expect(bins(reader)).rejects.toThrow(
      /unsupported summary restart root/,
    )
  } finally {
    await reader.close()
  }
})
test('unsafe uint64 restart pointers reject without rounding or unsafe reads', async () => {
  const bytes = new Uint8Array(readFileSync(path('summary_positions'))),
    l = layout(bytes)
  l.view.setBigUint64(l.root + 16, 2n ** 53n + 1n, true)
  updateCrc(bytes, l.root, 256, 12)
  const reader = new FigWig({ filehandle: new BlobFile(new Blob([bytes])) })
  try {
    await expect(bins(reader)).rejects.toThrow(/MAX_SAFE_INTEGER/)
  } finally {
    await reader.close()
  }
})
test('available empty summary streams still require their whole-stream CRC', async () => {
  const bytes = new Uint8Array(readFileSync(path('summary_positions'))),
    ref = manifest.files.summary_positions.levels.find(
      (l) => l.group === 1 && l.level === 0,
    )!
  expect(ref.source_rows).toBe(0)
  bytes[ref.source_offset + ref.source_bytes - 1] ^= 1
  const reader = new FigWig({ filehandle: new BlobFile(new Blob([bytes])) }),
    q = manifest.queries.find((q) => q.name === 'empty-summary')!
  try {
    await expect(bins(reader, q)).rejects.toThrow(/CRC-32/)
  } finally {
    await reader.close()
  }
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
test.each(['abort', 'close'])(
  '%s cancels an in-flight restart fill and clears failed cache ownership',
  async (action) => {
    const bytes = new Uint8Array(readFileSync(path('summary_positions'))),
      { idOffset, idSize } = layout(bytes),
      entered = deferred(),
      release = deferred(),
      controller = new AbortController()
    let requestSignal: AbortSignal | undefined
    class GatedFile extends BlobFile {
      override async read(...args: Parameters<BlobFile['read']>) {
        if (args[1] === idOffset && args[0] === idSize) {
          requestSignal = args[2]?.signal
          entered.resolve()
          await new Promise<void>((resolve, reject) => {
            const aborted = () => reject(requestSignal!.reason)
            if (requestSignal?.aborted) return aborted()
            requestSignal?.addEventListener('abort', aborted, { once: true })
            void release.promise.then(() => {
              requestSignal?.removeEventListener('abort', aborted)
              resolve()
            })
          })
        }
        return super.read(...args)
      }
    }
    const reader = new FigWig({
        filehandle: new GatedFile(new Blob([bytes])),
        coalesceGap: 0,
      }),
      q = query(),
      pending = reader.getBins(q.chromosome, q.start, q.end, {
        ...options(q),
        signal: controller.signal,
      }),
      rejected = expect(pending).rejects.toHaveProperty('name', 'AbortError')
    try {
      await entered.promise
      if (action === 'abort') controller.abort()
      else await reader.close()
      await rejected
      expect(requestSignal?.aborted).toBe(true)
      release.resolve()
      if (action === 'abort')
        expect((await bins(reader)).source).toBe('summary')
      else expect(reader.getDiagnostics().cacheBytes).toBe(0)
    } finally {
      release.resolve()
      await reader.close()
    }
  },
)

test('raw restart inflation requires complete, bounded, dictionary-free DEFLATE', () => {
  const expected = Uint8Array.from({ length: 2048 }, (_, i) => i % 251),
    compressed = deflateRawSync(expected, {
      finishFlush: constants.Z_FULL_FLUSH,
    })
  expect(inflateRestart(compressed, expected.length, expected.length)).toEqual(
    expected,
  )
  expect(() => inflateRestart(compressed, expected.length, 1024)).toThrow(
    /maxInflatedBytes/,
  )
  expect(() => inflateRestart(compressed, expected.length - 1, 4096)).toThrow(
    /beyond/,
  )
  expect(() => inflateRestart(compressed, expected.length + 1, 4096)).toThrow(
    /wrong-sized/,
  )
  expect(() =>
    inflateRestart(compressed.subarray(0, -1), expected.length, 4096),
  ).toThrow(/marker/)
  const dictionary = Buffer.alloc(32768, 97),
    dependent = deflateRawSync(Buffer.alloc(2048, 97), {
      dictionary,
      finishFlush: constants.Z_FULL_FLUSH,
    })
  expect(() => inflateRestart(dependent, 2048, 4096)).toThrow(/restart/)
})
