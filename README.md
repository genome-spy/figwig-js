# @genome-spy/figwig

A standalone, read-only TypeScript reader for **Figwig v1**, a binary format for
multitrack genomic signals. Uses `generic-filehandle2` random access in Node.js
and modern browsers. Independent of GenomeSpy and its visualization engine.

The implementation follows the [frozen format specification](https://github.com/jmschrei/figwig/blob/c0e5d6522c677b9f03cd6831e2dbcea759866628/docs/format.rst).
See also [Python usage](https://github.com/jmschrei/figwig/blob/c0e5d6522c677b9f03cd6831e2dbcea759866628/docs/figwig.rst),
the [conformance oracle](test/fixtures/README.md), [measured benchmarks](benchmarks/RESULTS.md),
and the implementation log in [findings.md](findings.md).

## Installation and compatibility

```sh
npm install @genome-spy/figwig generic-filehandle2
```

The package is configured for public npm publication; this initial implementation
does not publish automatically. Until released, build the checkout with
`npm ci && npm run build` and install its tarball from `npm pack`.

ESM and generated TypeScript declarations are provided. Runtime requirements:
Node.js 22+ or a modern browser with `fetch`, `BigInt`, `AbortController`,
`TextDecoder`, and typed arrays. The browser build has no Node built-ins or
mandatory WebAssembly asset. Actual Chromium coverage is described below.

The reader uses Pako's inflate-only entry point to keep compression code out of
browser bundles. Browser applications need a bundler with CommonJS support,
such as Vite or esbuild; Node.js can import the built ESM package directly.

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
expose `Content-Range` through CORS. The reader never calls `readFile()`.
HTTP behavior of supplied handles remains their responsibility; in particular,
plain `RemoteFile` may accept a server that ignores the initial range request.
Our integration tests verify actual 206 responses and transferred body bytes.

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
exclude both zero and NaN; `sum` excludes NaN. The minimum is therefore positive
for a track whose nonzero values are all positive.

The `tracks` query option accepts an array of names or integer indices, including
mixed arrays, or an object matching metadata attributes with exact equality.
Omitting it selects every track; `[]` selects none. Explicit lists preserve
caller order, filters preserve file order, and duplicate or unknown identifiers
raise an error. Attribute matching is shallow. Group membership and slot order
come from metadata, including files whose groups contain nonadjacent tracks.

## Regions, batches, and features

All coordinates are **zero-based, half-open**. Chromosome names are exact and
case-sensitive. Unknown chromosomes, negative/fractional coordinates, reversed
intervals, and ends past a chromosome raise `RangeError`; bounds are not silently
clipped. An empty interval at any valid boundary returns empty arrays.

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

```ts
const features = await fw.getFeatures('chr1', 100, 200, {
  tracks: ['atac'],
  basesPerSpan: 10,
  aggregation: 'mean',
  missing: 'omit',
})
// { track: 'atac', trackIndex: 0, start: 100, end: 110, score: ... }
const featureBatches = await fw.getFeaturesMulti(regions, {
  tracks: ['atac'],
  basesPerSpan: 10,
})
```

Features are ordered by selected track, then coordinate. By default a feature
covers one base and includes zeros and NaNs; `includeZeros: false` drops only
zero scores. Larger `basesPerSpan` uses the binning API below. The default limit
is one million potential feature records per logical batch, checked before
reading data. Use typed arrays or increase span for larger requests.

## Binned values and missing data

```ts
const bins = await fw.getBins('chr1', 1_000_000, 2_000_000, {
  tracks: ['atac', 'dnase'],
  binSize: 1000,
  aggregation: 'mean',
  missing: 'omit',
})
// bins.starts / bins.ends: Uint32Array; per-track values: Float64Array
const binBatches = await fw.getBinsMulti(regions, {
  tracks: ['atac'],
  binSize: 100,
  aggregation: 'sum',
})
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

Means never divide by a padded tile width or a requested width past a chromosome.
Aggregations use binary64 arithmetic and return float64; ordinary floating-point
rounding and loss of precision in sufficiently large totals still apply.
Sparse entries and run segments aggregate directly without a region-sized dense
array. Runs use value times covered width, and chunks accumulate in deterministic
file order; the last bits can differ from repeated base-by-base addition or a
different file layout. `maxOutputBytes` includes the bin-coordinate arrays and
any NaN-count workspace used for omission-aware means.

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

The reader uses the coarsest compatible zoom per group when bins align to its
grid. A chromosome's last bin may be partial; zero padding contributes nothing.
Unaligned requests or unavailable summaries fall back to full-resolution data.
Set `requireSummaries: true` to forbid that fallback. It enables summary use even
without `useSummaries: true` and rejects incompatible missing policies, unaligned
regions, or unavailable summaries before reading any raw chunks in the entire
batch. Metadata and summary reads may still occur. This option also applies to
`getFeatures()` / `getFeaturesMulti()` and never bypasses the requirement when
`basesPerSpan` is 1. Summary use requires `missing: 'zero'` even for sums, because it cannot propagate
NaNs or recover valid-base counts. Tile sums are rounded to float32 by the format;
zoom sums are float64 sums of those rounded values. Thus even a sum may differ
from full resolution. Figwig summaries are not BigWig zoom records.

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

Per-base output arrays preserve each track's declared dtype (`uint8/16/32`,
`int8/16/32`, `float32/64`). Chunk storage types are decoded independently.
In particular, uint32 values above 2²⁴ and float64 values retain their precision.
No uint64 signal dtype exists in v1. Header and index uint64 offsets are parsed
as `BigInt`; offsets above `Number.MAX_SAFE_INTEGER` are rejected before I/O.

Header, tables, group indexes, summaries, and zoom CRCs are always checked.
Zlib streams must have the declared decoded size, a valid Adler checksum, and
no trailing bytes. Stored chunks in codec 1 always check their CRC. All other
chunk CRC checks are also enabled by default (`verify: true`); `verify: false`
disables only the optional checks. Malformed counts, ordering, and payloads
raise errors rather than returning misleading data.

```ts
const controller = new AbortController()
const pending = fw.getValues('chr1', 0, 10000, {
  tracks: ['atac'],
  signal: controller.signal,
})
controller.abort()
await pending.catch((error) => console.log(error.name)) // AbortError
```

Shared work uses `@gmod/shared-read-cache`: one caller's cancellation does not
abort a chunk or index still needed by another caller. A read is cancelled when
all its waiters abort. Failed reads are removed and can be retried. CPU decoding
is synchronous; cancellation is observed between I/O and decoding stages.

Header metadata is cached for the reader's lifetime. Parsed indexes, summaries,
and decoded chunks have separate byte budgets. Large single entries can be read
without being retained; zero cache budgets disable retention while keeping
in-flight sharing. Cache byte accounting estimates object overhead. `clearCache()`
clears parsed group/summary/chunk caches while retaining metadata, and `close()`
clears everything and closes the supplied filehandle.

Raw byte-range caching is delegated to external filehandles, such as
[`@gmod/range-cache-filehandle`](https://github.com/GMOD/range-cache-filehandle).
The reader does not implement another persistent raw-range cache. Files are
assumed **immutable** for a reader's lifetime. Use versioned URLs for remote
files; reopen a new reader and filehandle after appending or replacing a file.

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
Network-level transferred-body metrics come from the benchmark server.

## Format support and limits

| Figwig v1 feature                                           | Support                                |
| ----------------------------------------------------------- | -------------------------------------- |
| Position-order runs and whole-group compressed live indexes | Yes; lazy selected groups              |
| Track-order sparse blocks                                   | Yes; chromosome/position binary search |
| Dense, sparse, matrix, runs                                 | All                                    |
| Numeric element codes 0–8, including implicit one           | All                                    |
| Native heterogeneous track dtypes and NaNs                  | Yes                                    |
| Zlib, codec 0, stored chunks within codec 1                 | Yes                                    |
| Global statistics, tile summaries, optional zoom levels     | Yes                                    |
| Appended/merged files and unused historical bytes           | Yes                                    |
| Unknown optional features                                   | Ignored as required by v1              |
| Unsupported required features / versions                    | Rejected                               |
| Writing or editing Figwig files                             | Out of scope                           |

Compared with Python, outputs are per-track native arrays instead of one common
numeric matrix, coordinate bounds are explicit errors, and NaN aggregation and
rounded-summary use are explicit options. There is no automatic remote file
invalidation, plotting integration, writer, or BigWig conversion. Chromium is
tested; Firefox and WebKit have not been exercised in this implementation.

## Development and reproducibility

This branch evaluates a Kaitai-generated binary parser. See the
[parser comparison](benchmarks/KAITAI.md) for bundle sizes, correctness evidence,
developer experience and expected performance tradeoffs, and the
[schema notes](schema/README.md) for generation instructions.

```sh
npm ci
npm run format:check
npm run typecheck
npm run lint
npm test
npx playwright install chromium
npm run test:browser
npm run build
npm pack --dry-run
```

Normal tests require neither Python nor a network connection. HTTP tests start
a localhost server. Chromium tests compare against the independent Python oracle
and build a browser bundle with no Node polyfills. GitHub Actions runs these
checks on Node 22 and 24; performance benchmarks run manually.

Small fixtures and expected values are checked in; see
[fixture regeneration instructions](test/fixtures/README.md). Larger datasets
are generated on demand, kept out of Git, and measured entirely through localhost
latency/bandwidth simulation. See [benchmark commands](benchmarks/README.md),
[results](benchmarks/RESULTS.md), and the [decompression investigation](benchmarks/DECOMPRESSION.md).

For later visualization integration, share a reader across track changes and
panning, batch genomic windows, pass cancellation signals, keep numeric arrays
until object records are explicitly needed, and choose track grouping based on
the measured access pattern. Validate any use of rounded summaries against the
application's missing-data and precision requirements.

## Figwig vs BigWig

### HTTP access and layout tradeoffs

Figwig supports HTTP Range reads, but its
[layout](https://github.com/jmschrei/figwig/blob/c0e5d6522c677b9f03cd6831e2dbcea759866628/docs/format.rst)
has coarser fetch units than [BigWig's spatial indexes](https://github.com/ucscGenomeBrowser/kent/blob/master/src/inc/bbiFile.h):

- **Indexes:** A position-order query loads a group's entire compressed
  live-tile index; track order uses a flat index per track. BigWig can fetch
  relevant index nodes.
- **Track groups:** Compressed chunks couple tracks. Large groups favor
  many-track queries; small groups reduce subset overfetch but can require
  more requests.
- **Summaries:** Each Figwig tile-summary or zoom level is one genome-wide
  stream per group. BigWig zoom data is spatially indexed.

Our reader also fetches compressed summaries and zooms during initial group
loading. This is an implementation choice: deferred summary loading and
coalesced group-index requests could reduce overhead within v1.

In the [synthetic benchmarks](benchmarks/RESULTS.md), querying all 24 tracks over
10 kb required 48 requests with one-track groups versus two with one 24-track
group, excluding header initialization. All 903 warm samples needed zero
requests because their working sets fit the caches. No equivalent BigWig
baseline was measured; BigWig also reads whole compressed blocks, so these
results establish tradeoffs rather than a universal ranking.

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
Python conformance fixtures, HTTP benchmarks, and browser tests. Agents also
reviewed changes and ran builds, tests, and compatibility checks.

The brief emphasized:

- Follow the frozen Figwig v1 specification, supporting both storage orders
  while preserving numeric precision and NaN semantics.
- Intentionally follow GMOD's API style to ease integration with GenomeSpy,
  which already relies on many GMOD packages, while keeping this Node.js/browser
  package standalone with no GenomeSpy runtime dependency.
- Verify against a pinned Python implementation and independent reference
  reader, including malformed files, real HTTP Range transfers, and Chromium.
- Measure cold/warm behavior under reproducible localhost latency and bandwidth
  simulation, prioritizing correctness over benchmark scores.

[findings.md](findings.md) records challenges, corrected assumptions, and design
decisions; the [benchmark report](benchmarks/RESULTS.md) retains measured results
and their limitations.

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
