import type { MetadataState } from './header.js'
import type { Summary } from '../types.js'
import { check, crc, Cursor, lowerBound } from '../utils/binary.js'
import { inflateZlib } from '../utils/inflate.js'
import { validateKind } from '../decoding/chunk.js'

export interface ChunkRef {
  key: string
  group: number
  offset: number
  size: number
  raw: number
  kind: number
  crc: number
  tile?: number
  chrom?: number
  first?: number
  last?: number
  n?: number
}
export interface SummaryRef {
  factor: number
  n: number
  bytes: Uint8Array
  binCount: number
}
export interface GroupIndex {
  chunks: ChunkRef[]
  tiles: Uint32Array
  summaries: SummaryRef[]
  byteLength: number
}
function extent(ref: ChunkRef, state: MetadataState, maxRaw: number) {
  const f = state.fixed
  check(
    ref.offset >= 128 && ref.size > 0 && ref.offset <= f.chroms - ref.size,
    'chunk offset or size outside data region',
  )
  check(
    ref.raw > 0 &&
      ref.raw % 8 === 0 &&
      ref.raw <= maxRaw &&
      ref.size <= maxRaw + 64,
    'invalid chunk raw size',
  )
  const info = validateKind(ref.kind, f.flags === 1, f.codec)
  check(
    (f.codec !== 0 && !info.stored) || ref.size === ref.raw,
    'stored chunk size differs from raw size',
  )
}
export function parseGroup(
  bytes: Uint8Array,
  group: number,
  state: MetadataState,
  maxInflated: number,
): GroupIndex {
  const c = new Cursor(bytes),
    f = state.fixed,
    chunks: ChunkRef[] = [],
    tracks = state.members[group].length
  const n = c.u32(),
    checksum = c.u32(),
    tiles: number[] = []
  if (f.flags & 1) {
    check(
      bytes.length + n * 112 <= maxInflated,
      'parsed block index allocation exceeds maxInflatedBytes',
    )
    c.need(n * 40)
    crc(bytes.subarray(c.at, c.at + n * 40), checksum, 'block index')
    let previous: ChunkRef | undefined
    for (let k = 0; k < n; k++) {
      const chrom = c.u32(),
        first = c.u32(),
        last = c.u32(),
        count = c.u32()
      const ref: ChunkRef = {
        key: `${group}:${k}`,
        group,
        chrom,
        first,
        last,
        n: count,
        offset: c.u64('block offset'),
        size: c.u32(),
        raw: c.u32(),
        kind: c.u32(),
        crc: c.u32(),
      }
      check(
        chrom < state.header.chromosomes.length &&
          first <= last &&
          last < state.header.chromosomes[chrom].length &&
          count > 0 &&
          count <= 65536 &&
          count <= last - first + 1,
        'invalid track block bounds',
      )
      check(
        !previous ||
          chrom > previous.chrom! ||
          (chrom === previous.chrom && first > previous.last!),
        'track blocks overlap or are out of order',
      )
      extent(ref, state, 12 * count + 64)
      previous = ref
      chunks.push(ref)
    }
    const byOffset = [...chunks].sort((a, b) => a.offset - b.offset)
    for (let i = 1; i < byOffset.length; i++)
      check(
        byOffset[i].offset >= byOffset[i - 1].offset + byOffset[i - 1].size,
        'blocks overlap in file',
      )
  } else {
    c.need(n * 32 + 8)
    check(
      bytes.length + n * 64 <= maxInflated,
      'parsed group index allocation exceeds maxInflatedBytes',
    )
    const runs: {
      first: number
      last: number
      offset: number
      size: number
    }[] = []
    for (let i = 0; i < n; i++)
      runs.push({
        first: c.u64('first tile'),
        last: c.u64('last tile'),
        offset: c.u64('run offset'),
        size: c.u64('run size'),
      })
    const live = c.u32(),
      length = c.u32(),
      start = c.at
    check(live <= state.nTiles, 'too many live tiles')
    check(
      bytes.length + live * 128 + n * 64 <= maxInflated,
      'parsed group index allocation exceeds maxInflatedBytes',
    )
    const stream = c.take(length)
    crc(bytes.subarray(8, start + length), checksum, 'group index')
    const raw = inflateZlib(stream, live * 17, maxInflated),
      v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
    for (let k = 0; k < live; k++) {
      const tile = v.getUint32(k * 4, true)
      check(
        tile < state.nTiles && (k === 0 || tile > tiles[k - 1]),
        'live tiles out of order or range',
      )
      tiles.push(tile)
      chunks.push({
        key: `${group}:${k}`,
        group,
        tile,
        offset: 0,
        kind: raw[4 * live + k],
        size: v.getUint32(5 * live + 4 * k, true),
        raw: v.getUint32(9 * live + 4 * k, true),
        crc: v.getUint32(13 * live + 4 * k, true),
      })
    }
    const tileRuns = [...runs].sort((a, b) => a.first - b.first),
      fileRuns = [...runs].sort((a, b) => a.offset - b.offset)
    for (let i = 0; i < runs.length; i++) {
      const run = tileRuns[i]
      check(
        run.first <= run.last &&
          run.last < state.nTiles &&
          run.offset >= 128 &&
          run.size > 0 &&
          run.offset <= f.chroms - run.size,
        'invalid run bounds',
      )
      check(
        i === 0 || run.first > tileRuns[i - 1].last,
        'runs overlap in tile range',
      )
      check(
        i === 0 ||
          fileRuns[i].offset >= fileRuns[i - 1].offset + fileRuns[i - 1].size,
        'runs overlap in file',
      )
    }
    let covered = 0
    for (const run of tileRuns) {
      const lo = lowerBound(tiles, run.first),
        hi = lowerBound(tiles, run.last + 1)
      check(lo === covered && hi > lo, 'run leaves live tiles uncovered')
      let offset = run.offset
      for (let k = lo; k < hi; k++) {
        const ref = chunks[k]
        ref.offset = offset
        extent(ref, state, 8 * tracks * f.tile + 16 * tracks + 64)
        offset += ref.size
      }
      check(offset === run.offset + run.size, 'run chunk sizes do not add up')
      covered = hi
    }
    check(covered === live, 'live tile has no run')
  }
  const summaries: SummaryRef[] = []
  const readSummary = (
    factor: number,
    n: number,
    length: number,
    checksum: number,
  ) => {
    const binCount = state.header.chromosomes.reduce(
      (s, ch) => s + Math.ceil(ch.tileCount / factor),
      0,
    )
    check(n <= binCount && (length > 0 || n === 0), 'invalid summary count')
    const compressed = c.take(length)
    crc(compressed, checksum, factor === 1 ? 'summary' : 'zoom')
    summaries.push({ factor, n, bytes: compressed, binCount })
  }
  readSummary(1, c.u32(), c.u32(), c.u32())
  if (f.optional & 1) {
    const levels = c.u32()
    check(levels <= 12, 'too many zoom levels')
    check(!levels || summaries[0].bytes.length > 0, 'zoom without summary')
    for (let i = 1; i <= levels; i++) {
      const factor = c.u32()
      check(factor === 4 ** i, 'invalid zoom factor')
      readSummary(factor, c.u32(), c.u32(), c.u32())
    }
  }
  check(c.at === bytes.length, 'group record extent mismatch')
  return {
    chunks,
    tiles: Uint32Array.from(tiles),
    summaries,
    byteLength: bytes.length + chunks.length * 112 + tiles.length * 4,
  }
}
export function parseSummary(
  ref: SummaryRef,
  group: number,
  state: MetadataState,
  maxInflated: number,
): Summary {
  const tracks = state.members[group],
    wide = ref.factor !== 1
  if (ref.bytes.length === 0)
    return {
      factor: ref.factor,
      binSize: ref.factor * state.fixed.tile,
      bins: new Uint32Array(),
      sums: new Float32Array(),
      tracks,
      available: false,
    }
  const raw = inflateZlib(
    ref.bytes,
    ref.n * (4 + (wide ? 8 : 4) * tracks.length),
    maxInflated,
  )
  const c = new Cursor(raw),
    bins = new Uint32Array(ref.n)
  for (let i = 0; i < ref.n; i++) {
    bins[i] = c.u32()
    check(
      bins[i] < ref.binCount && (i === 0 || bins[i] > bins[i - 1]),
      'summary bins out of order or range',
    )
  }
  const sums = wide
    ? new Float64Array(ref.n * tracks.length)
    : new Float32Array(ref.n * tracks.length)
  for (let i = 0; i < sums.length; i++) {
    c.need(wide ? 8 : 4)
    sums[i] = wide ? c.f64() : c.view.getFloat32(c.at, true)
    if (!wide) c.at += 4
  }
  return {
    factor: ref.factor,
    binSize: ref.factor * state.fixed.tile,
    bins,
    sums,
    tracks,
    available: true,
  }
}
