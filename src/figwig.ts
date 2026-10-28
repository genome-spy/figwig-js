import { RemoteFile } from 'generic-filehandle2'
import type { GenericFilehandle } from 'generic-filehandle2'
import { SharedReadCache } from '@gmod/shared-read-cache'
import type {
  BinOptions,
  BinsResult,
  Diagnostics,
  DType,
  Feature,
  FeatureOptions,
  FigWigOptions,
  Header,
  MissingPolicy,
  NumericArray,
  ReadOptions,
  Region,
  Summary,
  Track,
  TrackSelection,
  ValuesResult,
  ZoomLevel,
} from './types.js'
import { dtypeWidths, parseFixed, parseTables } from './format/header.js'
import type { MetadataState } from './format/header.js'
import { parseGroup, parseSummary } from './format/group.js'
import type { ChunkRef, GroupIndex } from './format/group.js'
import { decodeBlock, decodeChunk, validateKind } from './decoding/chunk.js'
import type { DecodedChunk, DecodedTrack } from './decoding/chunk.js'
import { aborted, check, crc, lowerBound } from './utils/binary.js'
import { inflateZlib } from './utils/inflate.js'
import { ChunkReads, ReadQueue, readExact } from './utils/io.js'

const constructors = {
  uint8: Uint8Array,
  uint16: Uint16Array,
  uint32: Uint32Array,
  int8: Int8Array,
  int16: Int16Array,
  int32: Int32Array,
  float32: Float32Array,
  float64: Float64Array,
}
function diagnostic(): Diagnostics {
  return {
    readRequests: 0,
    indexBytes: 0,
    dataBytes: 0,
    chunksFetched: 0,
    chunksDecompressed: 0,
    indexLoadMs: 0,
    decompressionMs: 0,
    decodingMs: 0,
    chunkCacheHits: 0,
    chunkCacheMisses: 0,
    cacheBytes: 0,
  }
}
function limit(
  value: number | undefined,
  fallback: number,
  name: string,
  minimum = 0,
): number {
  const n = value ?? fallback
  if (!Number.isSafeInteger(n) || n < minimum)
    throw new RangeError(`Invalid ${name}`)
  return n
}
function representable(value: number, dtype: DType): boolean {
  if (dtype === 'float64') return true
  if (dtype === 'float32')
    return Number.isNaN(value) || Math.fround(value) === value
  const width = dtypeWidths[dtype] * 8,
    unsigned = dtype.startsWith('u')
  return (
    Number.isInteger(value) &&
    value >= (unsigned ? 0 : -(2 ** (width - 1))) &&
    value <= (unsigned ? 2 ** width - 1 : 2 ** (width - 1) - 1)
  )
}
function validAggregationOptions(
  aggregation: 'sum' | 'mean',
  missing: MissingPolicy,
): boolean {
  return (
    ['sum', 'mean'].includes(aggregation) &&
    ['propagate', 'omit', 'zero'].includes(missing)
  )
}

/** Immutable-file, read-only Figwig v1 random-access reader. */
export class FigWig {
  readonly filehandle: GenericFilehandle
  private readonly options: Required<Omit<FigWigOptions, 'filehandle' | 'url'>>
  private readonly queue: ReadQueue
  private readonly metadata: SharedReadCache<string, MetadataState>
  private readonly groups: SharedReadCache<number, GroupIndex>
  private readonly chunks: SharedReadCache<string, DecodedChunk>
  private readonly summaries: SharedReadCache<string, Summary>
  private readonly reads: ChunkReads
  private readonly lifetime = new AbortController()
  private closePromise?: Promise<void>
  private metrics = diagnostic()

  constructor(options: FigWigOptions) {
    if (Number(!!options.filehandle) + Number(!!options.url) !== 1)
      throw new TypeError('Provide exactly one of filehandle or url')
    this.filehandle = options.filehandle ?? new RemoteFile(options.url!)
    this.options = {
      verify: options.verify ?? true,
      maxOutputBytes: limit(
        options.maxOutputBytes,
        256 * 1024 ** 2,
        'maxOutputBytes',
      ),
      maxReadBytes: limit(
        options.maxReadBytes,
        64 * 1024 ** 2,
        'maxReadBytes',
        128,
      ),
      maxInflatedBytes: limit(
        options.maxInflatedBytes,
        128 * 1024 ** 2,
        'maxInflatedBytes',
      ),
      indexCacheBytes: limit(
        options.indexCacheBytes,
        32 * 1024 ** 2,
        'indexCacheBytes',
      ),
      chunkCacheBytes: limit(
        options.chunkCacheBytes,
        64 * 1024 ** 2,
        'chunkCacheBytes',
      ),
      summaryCacheBytes: limit(
        options.summaryCacheBytes,
        32 * 1024 ** 2,
        'summaryCacheBytes',
      ),
      maxConcurrentRequests: limit(
        options.maxConcurrentRequests,
        6,
        'maxConcurrentRequests',
        1,
      ),
      coalesceGap: limit(options.coalesceGap, 4096, 'coalesceGap'),
      maxCoalescedBytes: limit(
        options.maxCoalescedBytes,
        4 * 1024 ** 2,
        'maxCoalescedBytes',
        1,
      ),
      maxFeatures: limit(options.maxFeatures, 1_000_000, 'maxFeatures'),
    }
    this.queue = new ReadQueue(this.options.maxConcurrentRequests)
    this.metadata = new SharedReadCache({ maxSize: 1 })
    // SharedReadCache keeps its final settled entry even above the budget.
    // An uncacheable weight drops oversized entries while preserving sharing.
    this.groups = new SharedReadCache({
      maxSize: this.options.indexCacheBytes,
      sizeOf: (g) =>
        g.byteLength <= this.options.indexCacheBytes ? g.byteLength : NaN,
    })
    this.chunks = new SharedReadCache({
      maxSize: this.options.chunkCacheBytes,
      sizeOf: (g) => {
        const size = g.byteLength + g.tracks.length * 128 + 64
        return size <= this.options.chunkCacheBytes ? size : NaN
      },
    })
    this.summaries = new SharedReadCache({
      maxSize: this.options.summaryCacheBytes,
      sizeOf: (s) => {
        const size = s.bins.byteLength + s.sums.byteLength + 128
        return size <= this.options.summaryCacheBytes ? size : NaN
      },
    })
    this.reads = new ChunkReads(
      (offset, size, signal) => this.read(offset, size, 'dataBytes', signal),
      this.options.coalesceGap,
      Math.min(this.options.maxCoalescedBytes, this.options.maxReadBytes),
    )
  }

  private signal(signal?: AbortSignal): AbortSignal {
    const combined = signal
      ? AbortSignal.any([this.lifetime.signal, signal])
      : this.lifetime.signal
    aborted(combined)
    return combined
  }
  // A close/abort can land after an inner promise settles but before its
  // caller resumes, including when every requested value was cached.
  private completed<T>(value: T, signal?: AbortSignal): T {
    aborted(this.lifetime.signal)
    aborted(signal)
    return value
  }
  private async read(
    offset: number,
    size: number,
    category: 'indexBytes' | 'dataBytes',
    signal?: AbortSignal,
  ) {
    signal = this.signal(signal)
    const result = await readExact(
      this.filehandle,
      this.queue,
      offset,
      size,
      this.options.maxReadBytes,
      signal,
    )
    aborted(signal)
    this.metrics.readRequests++
    this.metrics[category] += result.length
    return result
  }
  private state(signal?: AbortSignal) {
    signal = this.signal(signal)
    return this.metadata.get('metadata', signal, async (shared) => {
      const header = await this.read(0, 128, 'indexBytes', shared)
      aborted(shared)
      const fixed = parseFixed(header)
      const stat = await this.filehandle.stat()
      aborted(shared)
      check(
        Number.isSafeInteger(stat.size) && fixed.length <= stat.size,
        'file length exceeds physical file size',
      )
      const bytes = await this.read(
        fixed.chroms,
        fixed.index + 8 * fixed.nGroups - fixed.chroms,
        'indexBytes',
        shared,
      )
      aborted(shared)
      return parseTables(fixed, bytes)
    })
  }
  private group(id: number, state: MetadataState, signal?: AbortSignal) {
    signal = this.signal(signal)
    return this.groups.get(id, signal, async (shared) => {
      const started = performance.now(),
        start = state.directory[id],
        end = state.directory[id + 1] ?? state.fixed.length
      const bytes = await this.read(start, end - start, 'indexBytes', shared)
      aborted(shared)
      const group = parseGroup(bytes, id, state, this.options.maxInflatedBytes)
      this.metrics.indexLoadMs += performance.now() - started
      return group
    })
  }
  async getHeader(options: { signal?: AbortSignal } = {}): Promise<Header> {
    return this.completed(
      (await this.state(options.signal)).header,
      options.signal,
    )
  }
  async getTracks(
    options: { signal?: AbortSignal } = {},
  ): Promise<readonly Track[]> {
    return this.completed(
      (await this.getHeader(options)).tracks,
      options.signal,
    )
  }
  async selectTracks(
    selection: TrackSelection,
    options: { signal?: AbortSignal } = {},
  ): Promise<Track[]> {
    return this.select(
      this.completed((await this.state(options.signal)).header, options.signal),
      selection,
    )
  }
  private select(header: Header, selection?: TrackSelection): Track[] {
    if (selection === undefined) return [...header.tracks]
    if (!Array.isArray(selection)) {
      if (selection === null || typeof selection !== 'object')
        throw new TypeError('Invalid track selection')
      return header.tracks.filter((track) =>
        Object.entries(selection).every(
          ([key, value]) =>
            Object.hasOwn(track.metadata, key) &&
            Object.is(track.metadata[key], value),
        ),
      )
    }
    const seen = new Set<number>()
    return selection.map((id) => {
      const track =
        typeof id === 'number'
          ? Number.isInteger(id)
            ? header.tracks[id]
            : undefined
          : header.tracks.find((t) => t.name === id)
      if (!track) throw new RangeError(`Unknown track: ${String(id)}`)
      if (seen.has(track.index))
        throw new RangeError(`Duplicate track selection: ${track.name}`)
      seen.add(track.index)
      return track
    })
  }
  private region(header: Header, region: Region) {
    const chr = header.chromosomes.find((c) => c.name === region.chromosome)
    if (!chr) throw new RangeError(`Unknown chromosome: ${region.chromosome}`)
    if (
      !Number.isSafeInteger(region.start) ||
      !Number.isSafeInteger(region.end) ||
      region.start < 0 ||
      region.end < region.start ||
      region.end > chr.length
    )
      throw new RangeError(
        `Invalid interval ${region.chromosome}:${region.start}-${region.end}; chromosome length ${chr.length}`,
      )
    return chr
  }
  private output(bytes: number) {
    if (!Number.isSafeInteger(bytes) || bytes > this.options.maxOutputBytes)
      throw new RangeError('Requested output exceeds maxOutputBytes')
  }
  async getValues(
    chromosome: string,
    start: number,
    end: number,
    options: ReadOptions = {},
  ): Promise<ValuesResult> {
    return this.completed(
      (await this.getValuesMulti([{ chromosome, start, end }], options))[0],
      options.signal,
    )
  }
  async getValuesMulti(
    regions: readonly Region[],
    options: ReadOptions = {},
  ): Promise<ValuesResult[]> {
    options = { ...options, signal: this.signal(options.signal) }
    const state = await this.state(options.signal)
    aborted(options.signal)
    const { header } = state,
      tracks = this.select(header, options.tracks)
    regions.forEach((r) => this.region(header, r))
    this.output(
      regions.reduce(
        (sum, r) =>
          sum +
          (r.end - r.start) *
            tracks.reduce((s, t) => s + dtypeWidths[t.dtype], 0),
        0,
      ),
    )
    const results = regions.map((region) => ({
      ...region,
      tracks: tracks.map((track) => ({
        track,
        values: new constructors[track.dtype](
          region.end - region.start,
        ) as NumericArray,
      })),
    }))
    await this.visitDecoded(
      state,
      regions,
      tracks,
      options,
      (track, base, regionIndex, outputIndex) => {
        const region = regions[regionIndex]
        this.copy(
          track,
          base,
          region.start,
          region.end,
          results[regionIndex].tracks[outputIndex].values,
          header.tileSize,
        )
      },
    )
    return this.completed(results, options.signal)
  }
  /** Numeric, binned, and interval queries share the same index/range plan.
   * Consume a bounded window of chunks at a time in physical file order, so
   * aggregation order is deterministic and decode buffers cannot accumulate
   * for an entire chromosome outside the cache's memory budget. */
  private async visitDecoded(
    state: MetadataState,
    regions: readonly Region[],
    tracks: readonly Track[],
    options: ReadOptions,
    visit: (
      track: DecodedTrack,
      base: number,
      regionIndex: number,
      outputIndex: number,
    ) => void,
  ): Promise<void> {
    aborted(options.signal)
    if (!tracks.length || !regions.some((r) => r.end > r.start)) return
    const { header } = state,
      chromosomes = regions.map((r) => this.region(header, r))
    const groupIds = [...new Set(tracks.map((t) => t.group))]
    const indexes = new Map(
      await Promise.all(
        groupIds.map(
          async (id) =>
            [id, await this.group(id, state, options.signal)] as const,
        ),
      ),
    )
    aborted(options.signal)
    const refs = new Map<string, ChunkRef>()
    const plans: { ref: ChunkRef; regionIndex: number }[] = []
    for (const [id, index] of indexes) {
      for (let regionIndex = 0; regionIndex < regions.length; regionIndex++) {
        const r = regions[regionIndex],
          ch = chromosomes[regionIndex]
        if (r.start === r.end) continue
        if (header.order === 'positions') {
          const first = ch.tileOffset + Math.floor(r.start / header.tileSize),
            last = ch.tileOffset + Math.ceil(r.end / header.tileSize)
          for (
            let k = lowerBound(index.tiles, first);
            k < index.tiles.length && index.tiles[k] < last;
            k++
          ) {
            const ref = index.chunks[k]
            refs.set(ref.key, ref)
            plans.push({ ref, regionIndex })
          }
        } else {
          let lo = 0,
            hi = index.chunks.length
          while (lo < hi) {
            const mid = Math.floor((lo + hi) / 2),
              b = index.chunks[mid]
            if (b.chrom! < ch.id || (b.chrom === ch.id && b.last! < r.start))
              lo = mid + 1
            else hi = mid
          }
          for (let k = lo; k < index.chunks.length; k++) {
            const ref = index.chunks[k]
            if (ref.chrom !== ch.id || ref.first! >= r.end) break
            refs.set(ref.key, ref)
            plans.push({ ref, regionIndex })
          }
        }
      }
      // Keep the map key used so invalid future group lookup cannot be hidden.
      check(state.members[id].length > 0, 'empty selected group')
    }
    const selectedByGroup = new Map<
      number,
      { outputIndex: number; slot: number }[]
    >()
    tracks.forEach((track, outputIndex) => {
      const selected = selectedByGroup.get(track.group) ?? []
      selected.push({ outputIndex, slot: state.trackSlots[track.index] })
      selectedByGroup.set(track.group, selected)
    })
    const regionsByChunk = new Map<string, number[]>()
    for (const { ref, regionIndex } of plans) {
      const list = regionsByChunk.get(ref.key) ?? []
      list.push(regionIndex)
      regionsByChunk.set(ref.key, list)
    }
    const ordered = [...refs.values()].sort(
      (a, b) => a.offset - b.offset || a.group - b.group,
    )
    let first = 0
    while (first < ordered.length) {
      let end = first,
        estimatedBytes = 0
      // A sparse implicit-one payload expands by at most 12x into offsets and
      // binary64 values. Use the actual storage width for a tighter bound.
      // A single large chunk may fill the whole window and is independently
      // checked by the decoder against maxInflatedBytes before allocation.
      while (end < ordered.length) {
        const ref = ordered[end]
        const count = state.members[ref.group].length,
          { kind, width } = validateKind(ref.kind, ref.n !== undefined)
        const numericBytes =
          ref.n !== undefined
            ? ref.n * 12
            : kind === 1
              ? count * header.tileSize * 8
              : Math.ceil((ref.raw * 12) / (width + (kind === 3 ? 2 : 1)))
        const estimate =
          Math.min(this.options.maxInflatedBytes, numericBytes) +
          count * 128 +
          64
        if (
          end > first &&
          estimatedBytes + estimate > this.options.maxInflatedBytes
        )
          break
        estimatedBytes += estimate
        end++
      }
      const batch = ordered.slice(first, end)
      const chunks = await Promise.all(
        batch.map((ref) => this.chunk(ref, state, options.signal)),
      )
      for (let i = 0; i < batch.length; i++) {
        aborted(options.signal)
        const ref = batch[i],
          chunk = chunks[i]
        for (const regionIndex of regionsByChunk.get(ref.key)!) {
          const chr = chromosomes[regionIndex]
          const base =
            ref.tile === undefined
              ? 0
              : (ref.tile - chr.tileOffset) * header.tileSize
          for (const { outputIndex, slot } of selectedByGroup.get(ref.group)!)
            visit(chunk.tracks[slot], base, regionIndex, outputIndex)
        }
      }
      first = end
    }
  }
  private chunk(ref: ChunkRef, state: MetadataState, signal?: AbortSignal) {
    signal = this.signal(signal)
    if (this.chunks.has(ref.key)) this.metrics.chunkCacheHits++
    else this.metrics.chunkCacheMisses++
    return this.chunks.get(ref.key, signal, async (shared) => {
      check(
        ref.raw <= this.options.maxInflatedBytes,
        'chunk exceeds maxInflatedBytes',
      )
      const bytes = await this.reads.get(ref, shared)
      aborted(shared)
      this.metrics.chunksFetched++
      if (this.options.verify || (state.fixed.codec === 1 && ref.kind & 128))
        crc(bytes, ref.crc, 'chunk')
      let payload = bytes
      if (state.fixed.codec === 1 && !(ref.kind & 128)) {
        const before = performance.now()
        payload = inflateZlib(bytes, ref.raw, this.options.maxInflatedBytes)
        this.metrics.decompressionMs += performance.now() - before
        this.metrics.chunksDecompressed++
      }
      const before = performance.now()
      const decoded =
        ref.n === undefined
          ? decodeChunk(
              payload,
              ref.kind,
              state.members[ref.group].length,
              state.fixed.tile,
              this.options.maxInflatedBytes,
            )
          : decodeBlock(
              payload,
              ref.kind,
              ref.n,
              ref.first!,
              ref.last!,
              this.options.maxInflatedBytes,
            )
      const storageCode = (ref.kind >>> 3) & 15
      for (let slot = 0; slot < decoded.tracks.length; slot++) {
        const dtype = state.members[ref.group][slot].dtype
        // Decoding already rejects infinities. Float32 storage is exact in
        // float32, and every decoded value is representable in float64.
        if (dtype === 'float64' || (dtype === 'float32' && storageCode === 6))
          continue
        for (const v of decoded.tracks[slot].values)
          if (!representable(v, dtype))
            check(
              false,
              `chunk value cannot be represented in declared ${dtype} dtype`,
            )
      }
      this.metrics.decodingMs += performance.now() - before
      return decoded
    })
  }
  private copy(
    track: DecodedTrack,
    base: number,
    start: number,
    end: number,
    out: NumericArray,
    tileSize: number,
  ) {
    if (!track.offsets) {
      const lo = Math.max(start, base),
        hi = Math.min(end, base + track.values.length)
      if (hi > lo)
        out.set(track.values.subarray(lo - base, hi - base), lo - start)
    } else if (track.runs) {
      const positions = track.offsets
      let i = Math.max(0, lowerBound(positions, Math.max(0, start - base)) - 1)
      for (; i < positions.length && base + positions[i] < end; i++) {
        const lo = Math.max(start, base + positions[i]),
          hi = Math.min(end, base + (positions[i + 1] ?? tileSize))
        if (hi > lo) out.fill(track.values[i], lo - start, hi - start)
      }
    } else {
      for (
        let i = lowerBound(track.offsets, Math.max(0, start - base));
        i < track.offsets.length && base + track.offsets[i] < end;
        i++
      )
        out[base + track.offsets[i] - start] = track.values[i]
    }
  }
  /** Add decoded entries directly to output bins. Runs use value * covered
   * bases rather than expansion; missing counters only store NaN bases because
   * every unwritten base is a valid zero included in a mean's denominator. */
  private aggregate(
    track: DecodedTrack,
    base: number,
    result: BinsResult,
    outputIndex: number,
    tileSize: number,
    missing: MissingPolicy,
    nanCounts?: Uint32Array,
  ) {
    const out = result.tracks[outputIndex].values,
      { start, end, binSize } = result
    const add = (value: number, first: number, last: number) => {
      let lo = Math.max(start, first)
      const hi = Math.min(end, last)
      if (lo >= hi || value === 0) return
      let bin = Math.floor((lo - start) / binSize)
      const nan = Number.isNaN(value)
      while (lo < hi) {
        const stop = Math.min(hi, start + (bin + 1) * binSize),
          width = stop - lo
        if (nan) {
          if (missing === 'propagate') out[bin] = NaN
          else if (nanCounts) nanCounts[bin] += width
        } else out[bin] += value * width
        lo = stop
        bin++
      }
    }
    if (!track.offsets) {
      const first = Math.max(start, base),
        last = Math.min(end, base + track.values.length)
      for (let position = first; position < last; position++)
        add(track.values[position - base], position, position + 1)
    } else if (track.runs) {
      const offsets = track.offsets
      for (
        let i = Math.max(0, lowerBound(offsets, Math.max(0, start - base)) - 1);
        i < offsets.length && base + offsets[i] < end;
        i++
      ) {
        add(
          track.values[i],
          base + offsets[i],
          base + (offsets[i + 1] ?? tileSize),
        )
      }
    } else {
      for (
        let i = lowerBound(track.offsets, Math.max(0, start - base));
        i < track.offsets.length && base + track.offsets[i] < end;
        i++
      ) {
        const position = base + track.offsets[i]
        add(track.values[i], position, position + 1)
      }
    }
  }
  async getSummary(
    group: number,
    level = 0,
    options: { signal?: AbortSignal } = {},
  ): Promise<Summary> {
    const signal = this.signal(options.signal)
    const state = await this.state(signal)
    aborted(signal)
    if (
      !Number.isInteger(group) ||
      group < 0 ||
      group >= state.fixed.nGroups ||
      !Number.isInteger(level) ||
      level < 0
    )
      throw new RangeError('Invalid group or summary level')
    const summary = await this.summaries.get(
      `${group}:${level}`,
      signal,
      async (shared) => {
        const index = await this.group(group, state, shared)
        aborted(shared)
        const ref = index.summaries[level]
        if (!ref)
          throw new RangeError(
            `Zoom level ${level} is unavailable for group ${group}`,
          )
        return parseSummary(ref, group, state, this.options.maxInflatedBytes)
      },
    )
    return this.completed(summary, signal)
  }
  async getZoomLevels(options: ReadOptions = {}): Promise<ZoomLevel[]> {
    options = { ...options, signal: this.signal(options.signal) }
    const state = await this.state(options.signal)
    aborted(options.signal)
    const tracks = this.select(state.header, options.tracks)
    const levels = new Map<number, ZoomLevel>()
    await Promise.all(
      [...new Set(tracks.map((t) => t.group))].map(async (group) => {
        const index = await this.group(group, state, options.signal)
        aborted(options.signal)
        index.summaries.slice(1).forEach((s, i) => {
          const level = i + 1,
            item = levels.get(level) ?? {
              level,
              factor: s.factor,
              binSize: s.factor * state.fixed.tile,
              groups: [],
            }
          item.groups.push(group)
          levels.set(level, item)
        })
      }),
    )
    aborted(options.signal)
    return [...levels.values()]
      .sort((a, b) => a.level - b.level)
      .map((l) => ({ ...l, groups: l.groups.sort((a, b) => a - b) }))
  }
  async getBins(
    chromosome: string,
    start: number,
    end: number,
    options: BinOptions,
  ): Promise<BinsResult> {
    return this.completed(
      (await this.getBinsMulti([{ chromosome, start, end }], options))[0],
      options.signal,
    )
  }
  async getBinsMulti(
    regions: readonly Region[],
    options: BinOptions,
  ): Promise<BinsResult[]> {
    options = { ...options, signal: this.signal(options.signal) }
    const { binSize, aggregation = 'mean', missing = 'propagate' } = options
    if (
      !Number.isSafeInteger(binSize) ||
      binSize < 1 ||
      !validAggregationOptions(aggregation, missing)
    )
      throw new RangeError('Invalid binSize, aggregation, or missing policy')
    const state = await this.state(options.signal)
    aborted(options.signal)
    const tracks = this.select(state.header, options.tracks)
    regions.forEach((r) => this.region(state.header, r))
    const countMissing = missing === 'omit' && aggregation === 'mean'
    // Output coordinates + binary64 sums, plus at most one uint32 NaN count
    // per track/bin. No allocation is proportional to the genomic span.
    this.output(
      regions.reduce(
        (s, r) =>
          s +
          Math.ceil((r.end - r.start) / binSize) *
            (8 + tracks.length * (countMissing ? 12 : 8)),
        0,
      ),
    )
    const results: BinsResult[] = regions.map((r) => {
      const n = Math.ceil((r.end - r.start) / binSize)
      return {
        ...r,
        binSize,
        source: 'values',
        starts: Uint32Array.from(
          { length: n },
          (_, i) => r.start + i * binSize,
        ),
        ends: Uint32Array.from({ length: n }, (_, i) =>
          Math.min(r.end, r.start + (i + 1) * binSize),
        ),
        tracks: tracks.map((track) => ({ track, values: new Float64Array(n) })),
      }
    })
    const fallback: number[] = []
    for (let i = 0; i < regions.length; i++) {
      if (
        options.useSummaries &&
        missing === 'zero' &&
        (await this.summaryBins(results[i], state, options))
      )
        results[i].source = 'summary'
      else fallback.push(i)
    }
    const missingCounts = countMissing
      ? results.map((r) => r.tracks.map(() => new Uint32Array(r.starts.length)))
      : undefined
    if (fallback.length)
      await this.visitDecoded(
        state,
        fallback.map((i) => regions[i]),
        tracks,
        options,
        (track, base, regionIndex, outputIndex) => {
          const index = fallback[regionIndex]
          this.aggregate(
            track,
            base,
            results[index],
            outputIndex,
            state.fixed.tile,
            missing,
            missingCounts?.[index][outputIndex],
          )
        },
      )
    if (aggregation === 'mean')
      for (let i = 0; i < results.length; i++) {
        const result = results[i]
        for (let t = 0; t < result.tracks.length; t++)
          for (let b = 0; b < result.starts.length; b++) {
            const count =
              result.ends[b] -
              result.starts[b] -
              (missingCounts?.[i][t][b] ?? 0)
            result.tracks[t].values[b] = count
              ? result.tracks[t].values[b] / count
              : NaN
          }
      }
    aborted(options.signal)
    return results
  }
  private async summaryBins(
    result: BinsResult,
    state: MetadataState,
    options: BinOptions,
  ): Promise<boolean> {
    const chr = this.region(state.header, result),
      tile = state.fixed.tile
    if (
      result.start % tile ||
      result.binSize % tile ||
      (result.end % tile && result.end !== chr.length)
    )
      return false
    const ids = [...new Set(result.tracks.map((t) => t.track.group))]
    const summaries = new Map<number, Summary>()
    await Promise.all(
      ids.map(async (id) => {
        const index = await this.group(id, state, options.signal)
        aborted(options.signal)
        let level = 0
        for (let k = 1; k < index.summaries.length; k++) {
          const size = tile * index.summaries[k].factor
          if (
            result.start % size === 0 &&
            result.binSize % size === 0 &&
            (result.end % size === 0 || result.end === chr.length)
          )
            level = k
        }
        summaries.set(id, await this.getSummary(id, level, options))
      }),
    )
    aborted(options.signal)
    if ([...summaries.values()].some((s) => !s.available)) return false
    for (const { track, values } of result.tracks) {
      const s = summaries.get(track.group)!,
        slot = state.trackSlots[track.index]
      const offset = state.header.chromosomes
        .slice(0, chr.id)
        .reduce((n, c) => n + Math.ceil(c.tileCount / s.factor), 0)
      const lo = offset + result.start / s.binSize,
        hi = offset + Math.ceil(result.end / s.binSize)
      for (
        let j = lowerBound(s.bins, lo);
        j < s.bins.length && s.bins[j] < hi;
        j++
      ) {
        const b = Math.floor(
          ((s.bins[j] - offset) * s.binSize - result.start) / result.binSize,
        )
        if (b >= 0 && b < values.length)
          values[b] += s.sums[j * s.tracks.length + slot]
      }
    }
    return true
  }
  async getFeatures(
    chromosome: string,
    start: number,
    end: number,
    options: FeatureOptions = {},
  ): Promise<Feature[]> {
    return this.completed(
      (await this.getFeaturesMulti([{ chromosome, start, end }], options))[0],
      options.signal,
    )
  }
  async getFeaturesMulti(
    regions: readonly Region[],
    options: FeatureOptions = {},
  ): Promise<Feature[][]> {
    options = { ...options, signal: this.signal(options.signal) }
    const span = options.basesPerSpan ?? 1
    const { aggregation = 'mean', missing = 'propagate' } = options
    if (!Number.isSafeInteger(span) || span < 1)
      throw new RangeError('Invalid basesPerSpan')
    if (!validAggregationOptions(aggregation, missing))
      throw new RangeError('Invalid aggregation or missing policy')
    const state = await this.state(options.signal)
    aborted(options.signal)
    const tracks = this.select(state.header, options.tracks)
    regions.forEach((r) => this.region(state.header, r))
    const potential = regions.reduce(
      (n, r) => n + Math.ceil((r.end - r.start) / span) * tracks.length,
      0,
    )
    if (potential > this.options.maxFeatures)
      throw new RangeError(
        'Requested features exceed maxFeatures; use typed arrays or a larger basesPerSpan',
      )
    const values =
      span === 1
        ? await this.getValuesMulti(regions, options)
        : await this.getBinsMulti(regions, { ...options, binSize: span })
    aborted(options.signal)
    // Binned results already applied the policy; their NaNs may be arithmetic.
    const zeroMissing =
      span === 1 &&
      (missing === 'zero' || (missing === 'omit' && aggregation === 'sum'))
    return values.map((result) => {
      const features: Feature[] = []
      for (const t of result.tracks)
        for (let i = 0; i < t.values.length; i++) {
          let score = t.values[i]
          if (zeroMissing && Number.isNaN(score)) score = 0
          if (options.includeZeros === false && score === 0) continue
          features.push({
            track: t.track.name,
            trackIndex: t.track.index,
            start: result.start + i * span,
            end: Math.min(result.end, result.start + (i + 1) * span),
            score,
          })
        }
      return features
    })
  }
  getDiagnostics(): Diagnostics {
    return {
      ...this.metrics,
      cacheBytes:
        this.groups.totalSize +
        this.chunks.totalSize +
        this.summaries.totalSize,
    }
  }
  resetDiagnostics() {
    this.metrics = diagnostic()
  }
  clearCache() {
    this.groups.clear()
    this.chunks.clear()
    this.summaries.clear()
  }
  close(): Promise<void> {
    if (!this.closePromise) {
      // Store the promise before abort events run: a listener may call close()
      // again. Deferring the handle call also turns synchronous throws into a
      // single memoized rejection, just like an asynchronous close failure.
      this.closePromise = Promise.resolve().then(() => this.filehandle.close())
      this.lifetime.abort(
        new DOMException('Figwig reader is closed', 'AbortError'),
      )
      this.clearCache()
      this.metadata.clear()
    }
    return this.closePromise
  }
}
