import { readFileSync } from 'node:fs'
import { BlobFile } from 'generic-filehandle2'
import type { GenericFilehandle } from 'generic-filehandle2'
import { describe, expect, test } from 'vitest'
import { FigWig } from '../src/index.js'
import { crc32 } from '../src/utils/binary.js'
import { parseFixed, parseTables } from '../src/format/header.js'
import { parseGroup } from '../src/format/group.js'

const fixture = () =>
  new Uint8Array(readFileSync(new URL('./fixtures/zlib.fw', import.meta.url)))
const storedFixture = () =>
  new Uint8Array(readFileSync(new URL('./fixtures/stored.fw', import.meta.url)))
const view = (data: Uint8Array) =>
  new DataView(data.buffer, data.byteOffset, data.byteLength)
function patchHeader(data: Uint8Array) {
  const v = view(data)
  v.setUint32(104, 0, true)
  v.setUint32(104, crc32(data.subarray(0, 128)), true)
  return data
}
function patchTables(data: Uint8Array) {
  const v = view(data),
    start = Number(v.getBigUint64(32, true)),
    end = Number(v.getBigUint64(48, true)) + v.getUint32(24, true) * 8
  v.setUint32(28, crc32(data.subarray(start, end)), true)
  return patchHeader(data)
}
function handle(data: Uint8Array) {
  return new BlobFile(new Blob([data as Uint8Array<ArrayBuffer>]))
}
function reader(data: Uint8Array = fixture(), options = {}) {
  return new FigWig({ filehandle: handle(data), ...options })
}
function firstGroup(data: Uint8Array) {
  const v = view(data)
  return Number(v.getBigUint64(Number(v.getBigUint64(48, true)), true))
}
function patchGroup(data: Uint8Array, at = firstGroup(data)) {
  const v = view(data),
    count = v.getUint32(at, true),
    liveAt = at + 8 + count * 32,
    end = liveAt + 8 + v.getUint32(liveAt + 4, true)
  v.setUint32(at + 4, crc32(data.subarray(at + 8, end)), true)
  return data
}
function rewriteMetadata(
  change: (metadata: Record<string, unknown>) => void,
  data = fixture(),
) {
  const f = parseFixed(data),
    bytes = data.subarray(f.metadata, f.metadata + f.metadataLength)
  const object = JSON.parse(new TextDecoder().decode(bytes)) as Record<
    string,
    unknown
  >
  change(object)
  const text = new TextEncoder().encode(JSON.stringify(object))
  if (text.length > bytes.length) throw new Error('Mutation must fit metadata')
  bytes.fill(32)
  bytes.set(text)
  return patchTables(data)
}
function state(data: Uint8Array) {
  const f = parseFixed(data)
  return parseTables(f, data.subarray(f.chroms, f.index + 8 * f.nGroups))
}

describe('malformed files fail before unsafe reads or allocations', () => {
  test('bad magic and uncorrected header CRC', async () => {
    const badMagic = fixture()
    badMagic[0] = 0
    await expect(reader(badMagic).getHeader()).rejects.toThrow(/magic/)
    const badCrc = fixture()
    badCrc[20] ^= 1
    await expect(reader(badCrc).getHeader()).rejects.toThrow(/header CRC/)
  })
  test('pooled Buffer headers use their own offsets and never mutate the input', async () => {
    const data = fixture(),
      pooled = Buffer.alloc(data.length + 37, 0xa5)
    pooled.set(data, 37)
    const fixed = parseFixed(pooled.subarray(37))
    expect(fixed.tile).toBe(64)
    expect(new Uint8Array(pooled.subarray(37))).toEqual(data)
    const fw = new FigWig({
      filehandle: {
        read: async (length: number, position: number) =>
          pooled.subarray(position + 37, position + 37 + length),
        stat: async () => ({ size: data.length }),
        close: async () => {},
        readFile: async () => data,
      } as unknown as GenericFilehandle,
    })
    expect(
      (await fw.getValues('chr1', 7, 8, { tracks: ['signal'] })).tracks[0]
        .values[0],
    ).toBeNaN()
    expect(new Uint8Array(pooled.subarray(37))).toEqual(data)
  })
  test.each([
    [4, 2, 'version'],
    [6, 2, 'flags'],
    [8, 31, 'tile'],
    [12, 2, 'codec'],
    [96, 1, 'required'],
  ] as const)('unsupported header field at %i', async (at, value, message) => {
    const data = fixture(),
      v = view(data)
    if (at === 4 || at === 6 || at === 12) v.setUint16(at, value, true)
    else v.setUint32(at, value, true)
    await expect(reader(patchHeader(data)).getHeader()).rejects.toThrow(
      new RegExp(message),
    )
  })
  test('unknown optional features are ignored', async () => {
    const data = fixture()
    view(data).setUint32(100, 0x80000001, true)
    const result = await reader(patchHeader(data)).getValues('chr1', 0, 10, {
      tracks: ['ones'],
    })
    expect(result.tracks[0].values.length).toBe(10)
  })
  test('uint64 offsets beyond safe integers are rejected without rounding', async () => {
    const data = fixture()
    view(data).setBigUint64(32, 2n ** 53n + 1n, true)
    await expect(reader(patchHeader(data)).getHeader()).rejects.toThrow(
      /MAX_SAFE_INTEGER/,
    )
  })
  test('short headers, physical truncation, out-of-order offsets, and absurd counts', async () => {
    await expect(reader(fixture().slice(0, 100)).getHeader()).rejects.toThrow(
      /truncated/,
    )
    await expect(reader(fixture().slice(0, -1)).getHeader()).rejects.toThrow(
      /physical/,
    )
    const badOffset = fixture()
    view(badOffset).setBigUint64(32, 64n, true)
    await expect(reader(patchHeader(badOffset)).getHeader()).rejects.toThrow(
      /offsets/,
    )
    const counts = fixture()
    view(counts).setUint32(20, 0xffffffff, true)
    await expect(reader(patchHeader(counts)).getHeader()).rejects.toThrow(
      /statistics/,
    )
  })
  test('corrupt metadata is checked before use', async () => {
    const data = fixture(),
      f = parseFixed(data)
    data[f.metadata] ^= 1
    await expect(reader(data).getHeader()).rejects.toThrow(/tables CRC/)
    await expect(reader(patchTables(data)).getHeader()).rejects.toThrow(/JSON/)
  })
  test.each([
    'attributes',
    'tracks',
    'dtype',
    'group',
    'name',
    'duplicate',
  ] as const)('invalid metadata %s', async (field) => {
    const data = rewriteMetadata((metadata) => {
      const tracks = metadata.tracks as Record<string, unknown>[]
      if (field === 'attributes') metadata.attributes = null
      else if (field === 'tracks') metadata.tracks = []
      else if (field === 'dtype') tracks[0].dtype = 'bad'
      else if (field === 'group') tracks[0].group = -1
      else if (field === 'name') tracks[0].name = ''
      else tracks[0].name = tracks[1].name
    })
    await expect(reader(data).getHeader()).rejects.toThrow(/metadata|track/)
  })
  test.each([
    ['wide', 'float32'],
    ['wide', 'int32'],
    ['u32', 'int32'],
    ['neg16', 'uint8'],
  ])('rejects %s values that cannot fit declared %s', async (name, dtype) => {
    const data = rewriteMetadata((metadata) => {
      const tracks = metadata.tracks as Record<string, unknown>[]
      tracks.find((track) => track.name === name)!.dtype = dtype
    })
    // Bins must reject incompatible values before any output conversion;
    // disabling optional CRC verification must not disable numeric validation.
    await expect(
      reader(data, { verify: false }).getBins('chr1', 0, 64, {
        tracks: [name],
        binSize: 64,
      }),
    ).rejects.toThrow(`cannot be represented in declared ${dtype} dtype`)
  })
  test.each([
    { track: 'runs', value: NaN, dtype: 'float32', error: undefined },
    {
      track: 'runs',
      value: NaN,
      dtype: 'int32',
      error: /cannot be represented/,
    },
    {
      track: 'runs',
      value: Infinity,
      dtype: 'float32',
      error: /infinite numeric value/,
    },
    {
      track: 'runs',
      value: -Infinity,
      dtype: 'float32',
      error: /infinite numeric value/,
    },
    { track: 'wide', value: NaN, dtype: 'float64', error: undefined },
    {
      track: 'wide',
      value: Infinity,
      dtype: 'float64',
      error: /infinite numeric value/,
    },
    {
      track: 'wide',
      value: -Infinity,
      dtype: 'float64',
      error: /infinite numeric value/,
    },
  ])(
    'validates $value in $track declared $dtype',
    async ({ track, value, dtype, error }) => {
      const data = rewriteMetadata((metadata) => {
        const tracks = metadata.tracks as Record<string, unknown>[]
        tracks.find((t) => t.name === track)!.dtype = dtype
      }, storedFixture())
      const s = state(data),
        groupId = s.header.tracks.find((t) => t.name === track)!.group,
        members = s.members[groupId],
        group = parseGroup(
          data.subarray(s.directory[groupId], s.directory[groupId + 1]),
          groupId,
          s,
          128 * 1024 ** 2,
        ),
        ref = group.chunks.find((chunk) => chunk.tile === 0)!,
        payload = new DataView(data.buffer, ref.offset, ref.size)
      expect(members[0].name).toBe(track)
      const offsetsEnd =
          4 +
          4 * members.length +
          members.reduce(
            (n, _, i) => n + payload.getUint32(4 + i * 4, true),
            0,
          ),
        valuesAt = Math.ceil(offsetsEnd / 4) * 4
      // Each target is its group's first track; change one value without altering
      // the valid sparse/run layout. Optional payload CRC checking is disabled.
      if (track === 'runs') payload.setFloat32(valuesAt, value, true)
      else payload.setFloat64(valuesAt, value, true)
      const result = reader(data, { verify: false }).getBins(
        'chr1',
        track === 'runs' ? 20 : 10,
        track === 'runs' ? 21 : 11,
        {
          tracks: [track],
          binSize: 1,
          missing: 'omit',
        },
      )
      if (error) await expect(result).rejects.toThrow(error)
      else expect((await result).tracks[0].values[0]).toBeNaN()
    },
  )
  test('unsafe group offsets and invalid chromosome lengths', async () => {
    const data = fixture(),
      f = parseFixed(data)
    view(data).setBigUint64(f.index, 2n ** 60n, true)
    await expect(reader(patchTables(data)).getHeader()).rejects.toThrow(
      /MAX_SAFE_INTEGER/,
    )
    const badChrom = fixture(),
      ff = parseFixed(badChrom),
      v = view(badChrom)
    v.setBigUint64(ff.chroms + 2 + v.getUint16(ff.chroms, true), 0n, true)
    await expect(reader(patchTables(badChrom)).getHeader()).rejects.toThrow(
      /chromosome/,
    )
  })
  test('corrupt group CRC, truncated records, and bad run offsets', async () => {
    const data = fixture(),
      at = firstGroup(data)
    data[at + 8] ^= 1
    await expect(
      reader(data).getValues('chr1', 0, 10, { tracks: [0] }),
    ).rejects.toThrow()
    const badCount = fixture()
    view(badCount).setUint32(firstGroup(badCount), 0xffffffff, true)
    await expect(
      reader(badCount).getValues('chr1', 0, 10, { tracks: [0] }),
    ).rejects.toThrow(/truncated|invalid|record bounds/)
    const badRun = fixture()
    view(badRun).setBigUint64(firstGroup(badRun) + 8 + 16, 1n, true)
    await expect(
      reader(patchGroup(badRun)).getValues('chr1', 0, 10, { tracks: [0] }),
    ).rejects.toThrow(/run/)
  })
  test('overlapping run ranges and incorrect run byte totals', async () => {
    const data = fixture(),
      at = firstGroup(data),
      v = view(data),
      n = v.getUint32(at, true)
    expect(n).toBeGreaterThan(1)
    v.setBigUint64(at + 8 + 32, v.getBigUint64(at + 8, true), true)
    await expect(
      reader(patchGroup(data)).getValues('chr1', 0, 10, { tracks: [0] }),
    ).rejects.toThrow(/overlap|bounds/)
    const totals = fixture(),
      a = firstGroup(totals),
      vv = view(totals)
    vv.setBigUint64(a + 8 + 24, vv.getBigUint64(a + 8 + 24, true) + 1n, true)
    await expect(
      reader(patchGroup(totals)).getValues('chr1', 0, 10, { tracks: [0] }),
    ).rejects.toThrow(/add up/)
  })
  test('summary and zoom streams check their independent CRCs', async () => {
    for (const zoom of [false, true]) {
      const data = fixture(),
        at = firstGroup(data),
        v = view(data),
        n = v.getUint32(at, true)
      const liveAt = at + 8 + n * 32,
        summaryAt = liveAt + 8 + v.getUint32(liveAt + 4, true)
      const stream = zoom
        ? summaryAt + 12 + v.getUint32(summaryAt + 4, true) + 4 + 16
        : summaryAt + 12
      data[stream] ^= 1
      await expect(reader(data).getSummary(0, zoom ? 1 : 0)).rejects.toThrow(
        /CRC/,
      )
    }
  })
  test('stored chunks always check CRC in codec1; optional CRC also checks codec0', async () => {
    for (const [data, verify] of [
      [fixture(), false],
      [storedFixture(), true],
    ] as const) {
      const s = state(data),
        group = parseGroup(
          data.subarray(s.directory[0], s.directory[1]),
          0,
          s,
          128 * 1024 ** 2,
        )
      const ref = group.chunks.find((r) => s.fixed.codec === 0 || r.kind & 128)!
      expect(ref).toBeDefined()
      data[ref.offset] ^= 1
      const chromosome = s.header.chromosomes.find(
        (c) =>
          ref.tile! >= c.tileOffset && ref.tile! < c.tileOffset + c.tileCount,
      )!
      const start = (ref.tile! - chromosome.tileOffset) * s.fixed.tile
      await expect(
        reader(data, { verify }).getValues(
          chromosome.name,
          start,
          Math.min(chromosome.length, start + s.fixed.tile),
          { tracks: [0] },
        ),
      ).rejects.toThrow(/chunk CRC/)
    }
  })
  test('corrupt compressed chunk is rejected even when optional CRC verification is disabled', async () => {
    const data = fixture(),
      s = state(data)
    const group = s.directory.findIndex((offset, id) =>
      parseGroup(
        data.subarray(offset, s.directory[id + 1] ?? s.fixed.length),
        id,
        s,
        128 * 1024 ** 2,
      ).chunks.some((r) => !(r.kind & 128)),
    )
    const g = parseGroup(
      data.subarray(
        s.directory[group],
        s.directory[group + 1] ?? s.fixed.length,
      ),
      group,
      s,
      128 * 1024 ** 2,
    )
    const ref = g.chunks.find((r) => !(r.kind & 128))!
    data[ref.offset + ref.size - 1] ^= 1
    await expect(
      reader(data, { verify: false }).getValues('chr1', 0, 300, {
        tracks: [s.members[group][0].name],
      }),
    ).rejects.toThrow(/Adler|zlib/)
  })
})

describe('query validation, bounded caches, and cancellation', () => {
  test('invalid identifiers and coordinates reject; empty queries allocate no values', async () => {
    const fw = reader()
    for (const tracks of [['absent'], [-1], [1.5], [0, 0]])
      await expect(fw.getValues('chr1', 0, 1, { tracks })).rejects.toThrow(
        /track/i,
      )
    await expect(fw.getValues('absent', 0, 1)).rejects.toThrow(/chromosome/)
    for (const [start, end] of [
      [-1, 2],
      [3, 2],
      [0, 301],
      [0.1, 2],
      [NaN, 1],
      [0, Infinity],
    ])
      await expect(fw.getValues('chr1', start, end)).rejects.toThrow(/interval/)
    expect(
      (await fw.getValues('chr1', 300, 300, { tracks: ['wide'] })).tracks[0]
        .values.length,
    ).toBe(0)
    expect((await fw.getValues('chr1', 0, 300, { tracks: [] })).tracks).toEqual(
      [],
    )
    expect(await fw.getValuesMulti([])).toEqual([])
  })
  test('allocation and feature-object limits reject accidental large queries', async () => {
    await expect(
      reader(fixture(), { maxOutputBytes: 3 }).getValues('chr1', 0, 10, {
        tracks: ['wide'],
      }),
    ).rejects.toThrow(/maxOutputBytes/)
    await expect(
      reader(fixture(), { maxFeatures: 2 }).getFeatures('chr1', 0, 10, {
        tracks: ['wide'],
      }),
    ).rejects.toThrow(/maxFeatures/)
    await expect(
      reader(fixture(), { maxInflatedBytes: 1 }).getValues('chr1', 0, 10, {
        tracks: [0],
      }),
    ).rejects.toThrow(/maxInflatedBytes/)
    for (const options of [
      { maxOutputBytes: -1 },
      { maxConcurrentRequests: 0 },
      { chunkCacheBytes: Infinity },
    ])
      expect(() => reader(fixture(), options)).toThrow(/Invalid/)
  })
  test('bin options and absent zoom levels reject clearly', async () => {
    const fw = reader()
    await expect(fw.getBins('chr1', 0, 10, { binSize: 0 })).rejects.toThrow(
      /binSize/,
    )
    await expect(fw.getSummary(-1)).rejects.toThrow(/group/)
    await expect(fw.getSummary(0, 13)).rejects.toThrow(/unavailable/)
  })
  test('zero cache budgets retain no parsed group or chunk data', async () => {
    const fw = reader(fixture(), {
      indexCacheBytes: 0,
      chunkCacheBytes: 0,
      summaryCacheBytes: 0,
    })
    await fw.getValues('chr1', 0, 10, { tracks: ['signal'] })
    await fw.getSummary(0)
    expect(fw.getDiagnostics().cacheBytes).toBe(0)
    fw.clearCache()
    expect(fw.getDiagnostics().cacheBytes).toBe(0)
  })
  test('failed reads are not cached forever', async () => {
    const underlying = handle(fixture())
    let fail = true
    const fw = new FigWig({
      filehandle: {
        read: async (...args) => {
          if (fail) {
            fail = false
            throw new Error('transient failure')
          }
          return underlying.read(...args)
        },
        stat: () => underlying.stat(),
        close: () => underlying.close(),
        readFile: underlying.readFile.bind(underlying),
      } as GenericFilehandle,
    })
    await expect(fw.getHeader()).rejects.toThrow(/transient/)
    expect((await fw.getHeader()).version).toBe(1)
  })
  test('abort before reading performs no I/O; one aborted waiter does not cancel another', async () => {
    const underlying = handle(fixture())
    let reads = 0,
      cancelled = 0
    const delayed = {
      read: async (
        length: number,
        position: number,
        options?: { signal?: AbortSignal },
      ) => {
        reads++
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            clearTimeout(timer)
            cancelled++
            reject(options!.signal!.reason)
          }
          const timer = setTimeout(() => {
            options?.signal?.removeEventListener('abort', abort)
            resolve()
          }, 10)
          options?.signal?.addEventListener('abort', abort, { once: true })
        })
        return underlying.read(length, position, options)
      },
      stat: () => underlying.stat(),
      close: () => underlying.close(),
      readFile: underlying.readFile.bind(underlying),
    } as GenericFilehandle
    const fw = new FigWig({ filehandle: delayed }),
      pre = AbortSignal.abort()
    await expect(fw.getHeader({ signal: pre })).rejects.toHaveProperty(
      'name',
      'AbortError',
    )
    expect(reads).toBe(0)
    const first = new AbortController(),
      second = new AbortController()
    const p1 = fw.getValues('chr1', 0, 100, {
      tracks: ['signal'],
      signal: first.signal,
    })
    const rejection = expect(p1).rejects.toHaveProperty('name', 'AbortError')
    const p2 = fw.getValues('chr1', 0, 100, {
      tracks: ['signal'],
      signal: second.signal,
    })
    first.abort()
    await rejection
    expect((await p2).tracks[0].values.length).toBe(100)
    expect(cancelled).toBe(0)
    fw.clearCache()
    const all = new AbortController(),
      p3 = fw.getValues('chr1', 0, 100, {
        tracks: ['signal'],
        signal: all.signal,
      })
    const rejected = expect(p3).rejects.toHaveProperty('name', 'AbortError')
    setTimeout(() => all.abort(), 2)
    await rejected
    await new Promise((resolve) => setTimeout(resolve, 15))
    expect(cancelled).toBeGreaterThan(0)
    expect(
      (await fw.getValues('chr1', 0, 100, { tracks: ['signal'] })).tracks[0]
        .values.length,
    ).toBe(100)
  })
})
