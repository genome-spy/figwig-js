# @genome-spy/figwig

[![npm version](https://img.shields.io/npm/v/%40genome-spy%2Ffigwig?logo=npm)](https://www.npmjs.com/package/@genome-spy/figwig)
[![CI](https://img.shields.io/github/actions/workflow/status/genome-spy/figwig-js/ci.yml?branch=main&label=CI&logo=github)](https://github.com/genome-spy/figwig-js/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/genome-spy/figwig-js)](LICENSE)

A standalone, read-only TypeScript reader for **Figwig v1**, a binary format for
multitrack genomic signals. Uses `generic-filehandle2` random access in Node.js
and modern browsers. Independent of GenomeSpy and its visualization engine.

The implementation follows the [frozen format specification](https://github.com/jmschrei/figwig/blob/c0e5d6522c677b9f03cd6831e2dbcea759866628/docs/format.rst).
See [FINDINGS.md](FINDINGS.md) for format and implementation findings, and the
[benchmarks](benchmarks/RESULTS.md) for measured performance and limitations.

## Installation and compatibility

```sh
npm install @genome-spy/figwig generic-filehandle2
```

To install a checkout, build it with `npm ci && npm run build` and install its
tarball from `npm pack`.

ESM and TypeScript declarations are provided. Runtime requirements:
Node.js 22+ or a modern browser with `fetch`, `BigInt`, `AbortController`, `AbortSignal.any()`,
`TextDecoder`, and typed arrays. No Node polyfills or WebAssembly asset is required.

The reader uses `pako-esm2`, also used by GMOD's BGZF reader, so applications
can share the same ESM inflater when their dependency versions align.

## Open a file and read two tracks

```ts
import { FigWig } from '@genome-spy/figwig'
import { RemoteFile } from 'generic-filehandle2'

const fw = new FigWig({
  filehandle: new RemoteFile('https://example.org/signals.fw'),
})
const result = await fw.getValues('chr1', 1_000_000, 1_010_000, {
  tracks: ['atac', 'dnase'],
})
for (const { track, values } of result.tracks) {
  console.log(track.name, track.dtype, values) // one native typed array per track
}
await fw.close()
```

`new FigWig({ url })` is a remote convenience constructor. To open local files
or browser Blobs, supply the appropriate filehandle:

```ts
import { LocalFile } from 'generic-filehandle2' // Node.js
const local = new FigWig({ filehandle: new LocalFile('/data/signals.fw') })
```

```ts
import { BlobFile } from 'generic-filehandle2' // browser or Node.js Blob
const fromBlob = new FigWig({ filehandle: new BlobFile(fileInput.files[0]) })
```

A remote server must honor byte ranges and, for browser cross-origin requests,
expose `Content-Range` through CORS. HTTP validation is the filehandle's
responsibility; plain `RemoteFile` may accept an ignored initial range request.

## Metadata and track selection

```ts
const header = await fw.getHeader()
console.log(header.order, header.tileSize, header.genome)
console.log(header.chromosomes) // { id, name, length, tileOffset, tileCount }
console.log(header.attributes, header.statistics)
const tracks = await fw.getTracks()
const selected = await fw.selectTracks({ assay: 'ATAC-seq', biosample: 'K562' })
```

Each track has `index`, `name`, `dtype`, `group`, `metadata` (its original JSON
record, including custom attributes), and `statistics`. Metadata is cached and
deeply frozen. Track statistics follow the format: `nonzero`, `min`, and `max`
exclude both zero and NaN; `sum` excludes NaN.

The `tracks` query option accepts an array of names or integer indices, including
mixed arrays, or an object matching metadata attributes with exact equality.
Omitting it selects every track; `[]` selects none. Explicit lists preserve
caller order, filters preserve file order, and duplicate or unknown identifiers
raise an error. Attribute matching is shallow.

## Regions, batches, and features

Coordinates are **zero-based, half-open**; chromosome names are case-sensitive.
Unknown chromosomes or invalid bounds raise `RangeError` without clipping.
Empty intervals return empty arrays.

```ts
const regions = [
  { chromosome: 'chr1', start: 100, end: 200 },
  { chromosome: 'chr2', start: 500, end: 600 },
]
const batches = await fw.getValuesMulti(regions, { tracks: ['atac', 'dnase'] })
```

Batches preserve region order and share indexes, chunks, and range coalescing.
Overlapping regions decode a required chunk once. Each numeric result contains
`chromosome`, `start`, `end`, and `tracks: [{ track, values }]`. Values are always
independent caller-owned output arrays, with no cached-array aliasing.
`getBinsMulti()` and `getFeaturesMulti()` provide the same multi-region interface
for bins and feature objects.

```ts
const features = await fw.getFeatures('chr1', 100, 200, {
  tracks: ['atac'],
  basesPerSpan: 10,
  aggregation: 'mean',
  missing: 'omit',
})
// features[0]: { track: 'atac', trackIndex: 0, start: 100, end: 110, score: ... }
```

Features are objects ordered by selected track, then coordinate. `basesPerSpan`
defaults to 1, preserving raw values including negative zero; larger spans use
the binning API below. Missing policies apply at every span, and
`includeZeros: false` filters zeros afterward; the default keeps them.
Remaining NaNs are included.
The default limit is one million potential records per batch, checked before
reading data. Use numeric APIs or larger spans for larger requests.

## Binned values and missing data

`getBins()` and `getBinsMulti()` add arbitrary binning as a reader convenience.
The Figwig format stores raw values and fixed tile/zoom sums. Consumers could
implement aggregation using `getValues()` and `getSummary()`, but keeping it in
the reader lets sparse entries and runs aggregate directly, without dense
per-base query results or consumer-managed windowing.

```ts
const bins = await fw.getBins('chr1', 1_000_000, 2_000_000, {
  tracks: ['atac', 'dnase'],
  binSize: 1000,
  aggregation: 'mean',
  missing: 'omit',
})
// bins.starts / bins.ends: Uint32Array; per-track values: Float64Array
```

Bins start at the query's `start`, with a final partial bin ending at `end`.
`binSize` must be a positive safe integer. The default aggregation is `mean`.
Unwritten bases and implicit zero tiles hold **zero**, and count toward means.
The format cannot distinguish an unwritten base from an explicitly written zero.
NaNs remain distinct from zero:

| `missing`             | Sum                                 | Mean                                             |
| --------------------- | ----------------------------------- | ------------------------------------------------ |
| `propagate` (default) | NaN if any base is NaN              | NaN if any base is NaN                           |
| `omit`                | Sum non-NaN bases; all-NaN bin is 0 | Divide by non-NaN base count; all-NaN bin is NaN |
| `zero`                | Treat NaN as zero                   | Divide by actual bin width, including NaNs       |

Means use actual bin widths or observed-base counts, excluding chromosome padding.
Aggregation uses float64; large totals can lose precision, and rounding can
differ from base-by-base addition.
`maxOutputBytes` includes coordinates and NaN-count workspace for omission-aware
means.

Precomputed summaries are an **explicit approximation opt-in**:

```ts
const coarse = await fw.getBins('chr1', 0, 1_048_576, {
  tracks: ['atac'],
  binSize: 65_536,
  aggregation: 'sum',
  missing: 'zero',
  useSummaries: true,
})
console.log(coarse.source) // 'summary' when aligned and available; otherwise 'values'
```

This reader requires `missing: 'zero'` for all summary use, even sums. Tile-aligned
requests use the coarsest compatible zoom per group; unaligned requests or
unavailable summaries fall back to raw data. Tile sums are rounded to float32,
and float64 zoom sums accumulate those rounded values. Summaries have no
valid-base counts and may differ from full-resolution results. See
[FINDINGS.md](FINDINGS.md) for format limits versus reader policies.

Set `requireSummaries: true` to forbid raw-data fallback across the entire batch.
It implies summary use without needing `useSummaries: true`, and rejects
incompatible missing policies, unaligned bins or unavailable summaries. Metadata
and summary reads may still occur. This applies to bin and feature queries,
including `basesPerSpan: 1`.

## Tile summaries and zooms

```ts
const levels = await fw.getZoomLevels({ tracks: ['atac', 'dnase'] })
// [{ level, factor, binSize, groups }], discovered lazily
const tiles = await fw.getSummary(0) // group 0, tile sums
const zoom = await fw.getSummary(0, 1) // group 0, first zoom, if available
```

A summary returns `available`, `factor`, `binSize`, `bins`, `sums`, and `tracks`.
Sums are bin-major, then track slot: `sums[i * tracks.length + slot]`.
Tile sums use `Float32Array`; zoom sums use `Float64Array`. Omitted bins are zero
if `available` is true; false means no summary was stored. Bin numbers cover the
genome in chromosome-table order. For factor `f`, a chromosome starts after the
sum of `ceil(previousChromosome.tileCount / f)` bins. No bin crosses chromosomes.

Summary arrays are cached and **read-only by convention**; copy before editing.
Absent zoom levels raise `RangeError`. Zoom availability is queried separately
from the fixed header so metadata reads do not load every group index.

## Precision, integrity, cancellation, and caching

Per-base arrays preserve declared dtypes (`uint8/16/32`, `int8/16/32`,
`float32/64`), including uint32 values above 2²⁴. V1 has no uint64 signal dtype;
uint64 file offsets above `Number.MAX_SAFE_INTEGER` are rejected before I/O.

Header/table/index/summary CRCs and zlib integrity checks are always enforced.
`verify: false` disables optional chunk CRC checks; stored chunks in codec 1
remain CRC-checked. Zlib checks include declared size, Adler32 and trailing input.

```ts
const controller = new AbortController()
const pending = fw.getValues('chr1', 0, 10000, {
  tracks: ['atac'],
  signal: controller.signal,
})
controller.abort()
await pending.catch((error) => console.log(error.name)) // AbortError
```

One caller's cancellation preserves shared work needed by others; reads cancel
when all waiters abort. Failed reads can be retried. Synchronous decoding is not
interruptible; cancellation is checked between stages.

Metadata is cached for the reader's lifetime. Indexes, summaries and chunks have
separate budgets; oversized entries are not retained, and zero budgets disable
retention while keeping in-flight sharing. `clearCache()` clears these caches
while retaining metadata.

`close()` permanently shuts down the reader: pending and future queries reject
with `AbortError`, caches clear, and the handle closes once. Repeated calls share
the same promise, including failures. Operations that ignore cancellation may
finish, but cannot start later reads or refill caches. Returned arrays remain valid.

Raw byte-range caching is delegated to external filehandles, such as
[`@gmod/range-cache-filehandle`](https://github.com/GMOD/range-cache-filehandle).
Files are assumed **immutable** for a reader's lifetime. Use versioned URLs and
open a new reader/filehandle after appending or replacing a file.

Important constructor defaults (bytes unless otherwise stated):

| Option                  |   Default | Purpose                                                                             |
| ----------------------- | --------: | ----------------------------------------------------------------------------------- |
| `maxOutputBytes`        |   256 MiB | Total numeric output allocation per batch                                           |
| `maxReadBytes`          |    64 MiB | One filehandle read, including metadata/group records                               |
| `maxInflatedBytes`      |   128 MiB | One inflated payload / decoded chunk / parsed index                                 |
| `indexCacheBytes`       |    32 MiB | Retained parsed group records                                                       |
| `chunkCacheBytes`       |    64 MiB | Retained decoded chunks                                                             |
| `summaryCacheBytes`     |    32 MiB | Retained decoded summaries                                                          |
| `maxConcurrentRequests` |         6 | Reader-wide filehandle read concurrency                                             |
| `coalesceGap`           |      4096 | Maximum gap fetched between nearby chunks                                           |
| `maxCoalescedBytes`     |     4 MiB | Target maximum coalesced range; a larger single chunk is allowed within read limits |
| `maxFeatures`           | 1,000,000 | Maximum potential interval objects per batch                                        |

Limits are configurable and can reject otherwise valid very large v1 files.
They bound individual allocations and retained caches, not total process memory
across arbitrary numbers of concurrent queries. Diagnostics from
`getDiagnostics()` report reads, index/data bytes, chunk hits/fetches/inflates,
timings, and estimated cache bytes. `resetDiagnostics()` resets counters.

## Format support and limits

Supports both v1 storage orders, all four chunk encodings and element codes 0–8,
zlib/uncompressed/stored chunks, statistics, tile summaries, zooms, and
appended/merged files. Unknown optional features are ignored; unsupported
required features and versions are rejected.

Writing, BigWig conversion, plotting integration and automatic remote invalidation
are out of scope. Chromium is tested; Firefox and WebKit remain untested.

## Development and reproducibility

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and checks, and the
[fixture documentation](test/fixtures/README.md) for the pinned independent Python
oracle. Ordinary tests need neither Python nor external network access; HTTP
tests use localhost. CI checks Node 22/24 and Chromium.

See [RELEASING.md](RELEASING.md) for changelogs and npm trusted publishing, and
[CHANGELOG.md](CHANGELOG.md) for release notes.

Performance experiments run separately: [commands](benchmarks/README.md),
[HTTP results](benchmarks/RESULTS.md), and [decompression results](benchmarks/DECOMPRESSION.md).

## Figwig vs BigWig

### HTTP access and layout tradeoffs

Figwig supports HTTP Range reads, but its
[layout](https://github.com/jmschrei/figwig/blob/c0e5d6522c677b9f03cd6831e2dbcea759866628/docs/format.rst)
has coarser fetch units than [BigWig's spatial indexes](https://github.com/ucscGenomeBrowser/kent/blob/master/src/inc/bbiFile.h):

- **Indexes:** With position order, this reader loads selected groups' entire
  compressed live-tile indexes. Track order uses a flat index per track.
  BigWig can fetch relevant index nodes.
- **Track groups:** Compressed chunks couple tracks. Large groups favor
  many-track queries; small groups reduce subset overfetch but can require
  more requests.
- **Summaries:** Each Figwig tile-summary or zoom level is one genome-wide
  stream per group. BigWig zoom data is spatially indexed.

Our reader also fetches compressed summaries and zooms during initial group
loading. This is an implementation choice: deferred summary loading and
coalesced group-index requests could reduce overhead within v1.

See [FINDINGS.md](FINDINGS.md) for the format/implementation distinction and
[benchmarks](benchmarks/RESULTS.md) for measurements. No equivalent BigWig
baseline was measured; these tradeoffs do not establish a universal ranking.

### Browser visualization tradeoffs

This package primarily targets browsers. The formats differ in what a viewer
can display efficiently:

| Aspect         | BigWig                                           | Figwig                                         |
| -------------- | ------------------------------------------------ | ---------------------------------------------- |
| Samples/cells  | Separate files; external collection metadata     | Many tracks and their metadata in one file     |
| Zoom summaries | Min/max, sums, squared sums, covered-base counts | Rounded sums only                              |
| Missing values | Gaps distinct from explicit zeros                | Implicit zero; use NaN to preserve missingness |
| Signal values  | Float32                                          | Integer types and float32/float64              |

See the [BigWig summary layout](https://github.com/ucscGenomeBrowser/kent/blob/master/src/inc/bbiFile.h)
and [value types](https://github.com/ucscGenomeBrowser/kent/blob/master/src/inc/bwgInternal.h).
Figwig suits coordinated sample/cell views, but its sum-only zooms cannot
distinguish sharp peaks from broad plateaus or provide variability and
NaN-aware means without finer reads. Rendering must handle its different dtypes;
`bw2fw --missing nan` preserves gaps when converting BigWigs.

Worker placement, copying, and decompression backends are reader choices.
Chromium correctness is tested; comparative browser throughput, frame times,
and memory use remain unmeasured.

## Built with AI agents

The initial implementation was developed with Codex AI agents from the
[implementation brief](PROMPT.md), with human direction on scope and design
choices. A coordinating agent integrated parallel work on binary decoding,
Python conformance fixtures, HTTP benchmarks and browser tests. The brief
prioritized frozen-spec fidelity, numeric precision and NaN semantics,
independent verification, and reproducible cold/warm measurements.

GMOD's API style was intentional to ease integration with GenomeSpy, which
already uses many GMOD packages; this package has no GenomeSpy runtime dependency.

## Acknowledgements

Thanks to:

- [Jacob Schreiber](https://github.com/jmschrei), author of
  [Figwig](https://github.com/jmschrei/figwig), for the format, Python
  implementation, specification, conformance fixtures, and reference reader
  that made this implementation possible.
- [Colin Diesh](https://github.com/cmdcolin), developer and maintainer of many
  GMOD JavaScript packages, for the genomics I/O libraries and API conventions
  this package builds on, including
  [`generic-filehandle2`](https://github.com/GMOD/generic-filehandle2) and
  [`@gmod/shared-read-cache`](https://github.com/GMOD/shared-read-cache).
