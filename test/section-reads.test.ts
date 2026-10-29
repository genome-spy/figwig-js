import { readFileSync } from 'node:fs'
import { setImmediate } from 'node:timers/promises'
import { BlobFile } from 'generic-filehandle2'
import type { GenericFilehandle } from 'generic-filehandle2'
import { expect, test } from 'vitest'
import { FigWig, FigWigError } from '../src/index.js'
import type { FigWigOptions } from '../src/index.js'
import { parseFixed, parseTables } from '../src/format/header.js'
import { crc32 } from '../src/utils/binary.js'
import {
  decodeNumber,
  expectedValues,
  fixturePath,
  oracle,
} from './conformance/oracle.js'

interface Range {
  start: number
  end: number
}
interface SummarySection extends Range {
  header: number
  count: number
  checksum: number
  factor: number
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function gate(target: Range) {
  return {
    target,
    entered: deferred(),
    release: deferred(),
    finished: deferred(),
    signal: undefined as AbortSignal | undefined,
  }
}

function fixture(name: string) {
  const bytes = new Uint8Array(readFileSync(fixturePath(name))),
    fixed = parseFixed(bytes),
    state = parseTables(
      fixed,
      bytes.subarray(fixed.chroms, fixed.index + 8 * fixed.nGroups),
    ),
    group = 0,
    start = state.directory[group],
    end = state.directory[group + 1] ?? fixed.length,
    view = new DataView(bytes.buffer),
    count = view.getUint32(start, true),
    liveHeader = start + 8 + count * 32,
    raw: Range =
      fixed.flags & 1
        ? { start: start + 8, end: start + 8 + count * 40 }
        : {
            start: liveHeader + 8,
            end: liveHeader + 8 + view.getUint32(liveHeader + 4, true),
          }
  let cursor = raw.end
  const summary = (factor: number): SummarySection => {
    const header = cursor,
      count = view.getUint32(header, true),
      length = view.getUint32(header + 4, true),
      checksum = header + 8
    cursor += 12 + length
    return { header, count, checksum, factor, start: header + 12, end: cursor }
  }
  const base = summary(1),
    zoomCount = cursor,
    levels: SummarySection[] = [base]
  if (fixed.optional & 1) {
    const count = view.getUint32(cursor, true)
    cursor += 4
    for (let level = 0; level < count; level++) {
      const factor = view.getUint32(cursor, true)
      cursor += 4
      levels.push(summary(factor))
    }
  }
  expect(cursor).toBe(end)
  return {
    bytes,
    fixed,
    state,
    group,
    start,
    end,
    raw,
    liveHeader,
    zoomCount,
    levels,
  }
}

function capturedReader(
  bytes: Uint8Array<ArrayBuffer>,
  options: Omit<FigWigOptions, 'filehandle' | 'url'> = {},
) {
  const underlying = new BlobFile(new Blob([bytes])),
    reads: Range[] = [],
    invalidReads: Range[] = [],
    control = { pause: undefined as ReturnType<typeof gate> | undefined }
  const filehandle: GenericFilehandle = {
    read: async (length, position = 0, options) => {
      const range = { start: position, end: position + length }
      if (
        !Number.isSafeInteger(position) ||
        !Number.isSafeInteger(length) ||
        position < 0 ||
        length < 0 ||
        range.end > bytes.length
      ) {
        invalidReads.push(range)
        throw new Error('Unsafe filehandle read')
      }
      options?.signal?.throwIfAborted()
      reads.push(range)
      const pause = control.pause
      if (pause && intersects(range, pause.target)) {
        control.pause = undefined
        pause.signal = options?.signal
        pause.entered.resolve()
        // Deliberately ignore cancellation while paused: the reader must reject
        // promptly and prevent cache fills even with an uncooperative handle.
        await pause.release.promise
      }
      try {
        return bytes.slice(range.start, range.end)
      } finally {
        if (pause && intersects(range, pause.target)) pause.finished.resolve()
      }
    },
    stat: underlying.stat.bind(underlying),
    close: underlying.close.bind(underlying),
    readFile: async () => {
      throw new Error('Whole-file reads are not expected')
    },
  }
  return {
    reader: new FigWig({ filehandle, coalesceGap: 0, ...options }),
    reads,
    invalidReads,
    control,
  }
}

function intersects(a: Range, b: Range) {
  return a.start < b.end && b.start < a.end
}

function covered(reads: Range[], target: Range) {
  let right = target.start,
    total = 0
  for (const read of [...reads].sort((a, b) => a.start - b.start)) {
    const start = Math.max(target.start, read.start),
      end = Math.min(target.end, read.end)
    total += Math.max(0, end - Math.max(start, right))
    right = Math.max(right, end)
  }
  return total
}

test.each(['zlib', 'tracks_zlib'])(
  '%s raw queries read their index without downloading summary payloads',
  async (name) => {
    const { bytes, raw, levels } = fixture(name),
      { reader, reads } = capturedReader(bytes)
    try {
      await reader.getHeader()
      reads.length = 0
      const result = await reader.getValues('chr1', 0, 64, { tracks: ['ones'] })
      expect([...result.tracks[0].values]).toEqual([
        ...expectedValues('toy', 'chr1', 'ones', 0, 64),
      ])
      expect(covered(reads, raw)).toBe(raw.end - raw.start)
      for (const section of levels)
        expect(reads.some((read) => intersects(read, section))).toBe(false)
    } finally {
      await reader.close()
    }
  },
)

test.each([
  ['zlib', 'catalog'],
  ['zlib', 'summary'],
  ['tracks_zlib', 'catalog'],
  ['tracks_zlib', 'summary'],
] as const)(
  '%s closes during %s loading without later probes or cache fills',
  async (name, stage) => {
    const { bytes, start, levels } = fixture(name),
      { reader, reads, control } = capturedReader(bytes),
      pause = gate(stage === 'catalog' ? { start, end: start + 8 } : levels[0])
    await reader.getHeader()
    control.pause = pause
    const outcome = reader.getSummary(0).then(
      () => ({ name: 'unexpected success' }),
      (error: Error) => error,
    )
    try {
      await pause.entered.promise
      const before = reads.length
      await reader.close()
      expect(await outcome).toHaveProperty('name', 'AbortError')
      expect(pause.signal?.aborted).toBe(true)
      expect(reader.getDiagnostics().cacheBytes).toBe(0)
      pause.release.resolve()
      await pause.finished.promise
      await setImmediate()
      expect(reads).toHaveLength(before)
      expect(reader.getDiagnostics().cacheBytes).toBe(0)
    } finally {
      pause.release.resolve()
      await outcome
      await reader.close()
    }
  },
)

test.each([
  ['zlib', false],
  ['zlib', true],
  ['tracks_zlib', false],
  ['tracks_zlib', true],
] as const)(
  '%s shares section probes and cancels them only when all callers abort (all: %s)',
  async (name, all) => {
    const { bytes, start } = fixture(name),
      { reader, reads, control } = capturedReader(bytes),
      pause = gate({ start, end: start + 8 }),
      first = new AbortController(),
      second = new AbortController()
    await reader.getHeader()
    control.pause = pause
    const a = reader.getSummary(0, 0, { signal: first.signal }).then(
      () => ({ name: 'unexpected success' }),
      (error: Error) => error,
    )
    const b = reader.getSummary(0, 1, { signal: second.signal }).then(
      (result) => result,
      (error: Error) => error,
    )
    try {
      await pause.entered.promise
      first.abort()
      expect(await a).toHaveProperty('name', 'AbortError')
      expect(pause.signal?.aborted).toBe(false)
      if (all) {
        second.abort()
        expect(await b).toHaveProperty('name', 'AbortError')
        expect(pause.signal?.aborted).toBe(true)
      }
      pause.release.resolve()
      await pause.finished.promise
      const result = await b
      if (!all) {
        expect(result).toHaveProperty('available', true)
        if ('sums' in result)
          expect([...result.sums]).toEqual(
            oracle.files[name].groups[0].zooms[0].sums.flat().map(decodeNumber),
          )
      }
      await setImmediate()
      expect(
        reads.filter((read) => intersects(read, pause.target)),
      ).toHaveLength(1)
      if (all) expect(reader.getDiagnostics().cacheBytes).toBe(0)
    } finally {
      pause.release.resolve()
      await Promise.all([a, b])
      await reader.close()
    }
  },
)

test.each(['zlib', 'tracks_zlib'])(
  '%s zoom discovery probes headers without downloading index or summary payloads',
  async (name) => {
    const { bytes, raw, levels } = fixture(name),
      { reader, reads } = capturedReader(bytes)
    try {
      await reader.getHeader()
      reads.length = 0
      expect(await reader.getZoomLevels({ tracks: ['ones'] })).toEqual(
        levels.slice(1).map((section, index) => ({
          level: index + 1,
          factor: section.factor,
          binSize: oracle.files[name].tile * section.factor,
          groups: [0],
        })),
      )
      expect(reads.length).toBeGreaterThan(0)
      for (const section of [raw, ...levels])
        expect(reads.some((read) => intersects(read, section))).toBe(false)
    } finally {
      await reader.close()
    }
  },
)

test.each(['zlib', 'tracks_zlib'])(
  '%s summary queries fetch only the selected level payload',
  async (name) => {
    const { bytes, raw, levels } = fixture(name),
      { reader, reads } = capturedReader(bytes)
    try {
      await reader.getHeader()
      reads.length = 0
      const result = await reader.getSummary(0, 1),
        expected = oracle.files[name].groups[0].zooms[0]
      expect([...result.bins]).toEqual(expected.ids)
      expect([...result.sums]).toEqual(expected.sums.flat().map(decodeNumber))
      expect(covered(reads, levels[1])).toBe(levels[1].end - levels[1].start)
      for (const section of [raw, levels[0], ...levels.slice(2)])
        expect(reads.some((read) => intersects(read, section))).toBe(false)
      expect(reader.getDiagnostics()).toMatchObject({ dataBytes: 0 })
    } finally {
      await reader.close()
    }
  },
)

test.each(['zlib', 'tracks_zlib'])(
  '%s defers an unused zoom CRC failure until that zoom is read and retries failures',
  async (name) => {
    const { bytes, levels } = fixture(name)
    bytes[levels[1].start] ^= 1
    const { reader, reads } = capturedReader(bytes)
    try {
      expect([
        ...(await reader.getValues('chr1', 0, 64, { tracks: ['ones'] }))
          .tracks[0].values,
      ]).toEqual([...expectedValues('toy', 'chr1', 'ones', 0, 64)])
      const base = await reader.getSummary(0)
      expect([...base.sums]).toEqual(
        oracle.files[name].groups[0].summary!.sums.flat().map(decodeNumber),
      )
      expect(
        (await reader.getZoomLevels({ tracks: ['ones'] })).length,
      ).toBeGreaterThan(0)
      for (let attempt = 0; attempt < 2; attempt++) {
        const before = reads.length
        await expect(reader.getSummary(0, 1)).rejects.toThrow(/CRC-32 mismatch/)
        expect(
          reads.slice(before).some((read) => intersects(read, levels[1])),
        ).toBe(true)
      }
      expect([...(await reader.getSummary(0)).sums]).toEqual([...base.sums])
    } finally {
      await reader.close()
    }
  },
)

test.each(['zlib', 'tracks_zlib'])(
  '%s summary access does not require validating an unread raw index',
  async (name) => {
    const { bytes, start, raw } = fixture(name)
    bytes[start + 4] ^= 1
    const { reader, reads } = capturedReader(bytes)
    try {
      const result = await reader.getSummary(0)
      expect([...result.sums]).toEqual(
        oracle.files[name].groups[0].summary!.sums.flat().map(decodeNumber),
      )
      for (let attempt = 0; attempt < 2; attempt++) {
        const before = reads.length
        await expect(
          reader.getValues('chr1', 0, 64, { tracks: ['ones'] }),
        ).rejects.toThrow(/CRC-32 mismatch/)
        expect(reads.slice(before).some((read) => intersects(read, raw))).toBe(
          true,
        )
      }
      expect([...(await reader.getSummary(0)).sums]).toEqual([...result.sums])
    } finally {
      await reader.close()
    }
  },
)

test.each(['zlib', 'tracks_zlib'])(
  '%s rejects invalid section headers before unsafe filehandle reads',
  async (name) => {
    for (const corruption of [
      'index count',
      'summary count',
      'summary length',
      'zoom count',
      'zoom factor',
    ] as const) {
      const { bytes, start, levels, zoomCount } = fixture(name),
        view = new DataView(bytes.buffer)
      if (corruption === 'index count') view.setUint32(start, 0xffffffff, true)
      else if (corruption === 'summary count')
        view.setUint32(levels[0].header, 0xffffffff, true)
      else if (corruption === 'summary length')
        view.setUint32(levels[0].header + 4, 0xffffffff, true)
      else if (corruption === 'zoom count') view.setUint32(zoomCount, 13, true)
      else view.setUint32(levels[1].header - 4, 3, true)
      const { reader, invalidReads, reads } = capturedReader(bytes)
      try {
        await reader.getHeader()
        reads.length = 0
        await expect(
          reader.getZoomLevels({ tracks: ['ones'] }),
          corruption,
        ).rejects.toBeInstanceOf(FigWigError)
        expect(invalidReads, corruption).toHaveLength(0)
        for (const section of levels)
          expect(
            reads.some((read) => intersects(read, section)),
            corruption,
          ).toBe(false)
      } finally {
        await reader.close()
      }
    }
  },
)

test.each(['zlib', 'tracks_zlib'])(
  '%s enforces selected summary CRC and zlib integrity with verify disabled',
  async (name) => {
    for (const level of [0, 1]) {
      for (const repairCrc of [false, true]) {
        const { bytes, levels } = fixture(name),
          section = levels[level]
        bytes[section.end - 1] ^= 1
        if (repairCrc)
          new DataView(bytes.buffer).setUint32(
            section.checksum,
            crc32(bytes.subarray(section.start, section.end)),
            true,
          )
        const { reader } = capturedReader(bytes, { verify: false })
        try {
          await expect(reader.getSummary(0, level)).rejects.toThrow(
            repairCrc ? /Adler-32 mismatch/ : /CRC-32 mismatch/,
          )
        } finally {
          await reader.close()
        }
      }
    }
  },
)
