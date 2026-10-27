import type { GenericFilehandle } from 'generic-filehandle2'

export type DType =
  | 'uint8'
  | 'uint16'
  | 'uint32'
  | 'int8'
  | 'int16'
  | 'int32'
  | 'float32'
  | 'float64'
export type NumericArray =
  | Uint8Array
  | Uint16Array
  | Uint32Array
  | Int8Array
  | Int16Array
  | Int32Array
  | Float32Array
  | Float64Array
export interface Statistics {
  sum: number
  nonzero: number
  min: number
  max: number
}
export interface Track {
  readonly index: number
  readonly name: string
  readonly dtype: DType
  readonly group: number
  readonly metadata: Readonly<Record<string, unknown>>
  readonly statistics: Statistics
}
export interface Chromosome {
  readonly id: number
  readonly name: string
  readonly length: number
  readonly tileOffset: number
  readonly tileCount: number
}
export interface Header {
  readonly version: 1
  readonly order: 'positions' | 'tracks'
  readonly tileSize: number
  readonly codec: 0 | 1
  readonly compressionLevel: number
  readonly genome: string | null
  readonly attributes: Readonly<Record<string, unknown>>
  readonly metadata: Readonly<Record<string, unknown>>
  readonly chromosomes: readonly Chromosome[]
  readonly tracks: readonly Track[]
  readonly statistics: readonly Statistics[]
  readonly groupCount: number
  readonly length: number
}
export type TrackSelection =
  readonly (string | number)[] | Readonly<Record<string, unknown>>
export interface ReadOptions {
  signal?: AbortSignal
  tracks?: TrackSelection
}
export interface Region {
  chromosome: string
  start: number
  end: number
}
export interface TrackValues {
  track: Track
  values: NumericArray
}
export interface ValuesResult extends Region {
  tracks: TrackValues[]
}
export type MissingPolicy = 'propagate' | 'omit' | 'zero'
export interface BinOptions extends ReadOptions {
  binSize: number
  aggregation?: 'sum' | 'mean'
  /** NaN handling. Unwritten bases are always zeros. Default: propagate. */
  missing?: MissingPolicy
  /** Opt into rounded tile/zoom sums, only with missing:'zero' and aligned bins. */
  useSummaries?: boolean
}
export interface BinsResult extends ValuesResult {
  starts: Uint32Array
  ends: Uint32Array
  binSize: number
  source: 'values' | 'summary'
}
export interface Feature {
  track: string
  trackIndex: number
  start: number
  end: number
  score: number
}
export interface FeatureOptions extends ReadOptions {
  basesPerSpan?: number
  aggregation?: 'sum' | 'mean'
  missing?: MissingPolicy
  useSummaries?: boolean
  /** Include zero intervals; default true. NaNs are always included. */
  includeZeros?: boolean
}
export interface Summary {
  factor: number
  binSize: number
  bins: Uint32Array
  /** Bin-major, then track slot within this group. Cached arrays are read-only by convention. */
  sums: Float32Array | Float64Array
  tracks: readonly Track[]
  available: boolean
}
export interface ZoomLevel {
  level: number
  factor: number
  binSize: number
  groups: number[]
}
export interface Diagnostics {
  readRequests: number
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
}
export interface FigWigOptions {
  filehandle?: GenericFilehandle
  url?: string
  /** Verify CRCs of all chunks, beyond the mandatory zlib/stored-chunk checks. Default true. */
  verify?: boolean
  maxOutputBytes?: number
  maxReadBytes?: number
  maxInflatedBytes?: number
  indexCacheBytes?: number
  chunkCacheBytes?: number
  summaryCacheBytes?: number
  maxConcurrentRequests?: number
  coalesceGap?: number
  maxCoalescedBytes?: number
  maxFeatures?: number
}
