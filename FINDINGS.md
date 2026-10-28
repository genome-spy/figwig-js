# Development findings

## TLDR: priorities for interactive browser use

1. **Format extension: add valid-base counts to summaries at every resolution.**
   Sums alone cannot provide general missing-aware means or distinguish an
   unobserved bin from measured zero signal. Count measured zeros, exclude NaNs,
   and prefer float64 base sums to avoid inheriting float32 tile-sum rounding.
2. **Format extension: make summaries spatially addressable.** Independently
   indexed blocks by chromosome/region and resolution would let browsers fetch
   only visible overview data. Deferring downloads of whole levels is a separate
   figwig-js improvement that needs no format change.
3. **Python writer, within v1: revisit NaN run selection.** The inspected writer
   counts consecutive NaNs as separate changes even though v1 run chunks can
   encode them compactly. This can exclude an efficient encoding for long missing
   regions. Test the heuristic and measure reconversion before claiming a gain.
4. **Format extension: make position-order live indexes seekable.** V1 stores a
   group's live index as one compressed stream; figwig-js currently loads that
   whole stream. Independent pages or blocks would provide bounded spatial
   access for readers.

**Also format work:** optional min/max summaries would support peak envelopes.
**Only implementation work:** decompressor choice, workers, caching, deferred
summary downloads and request coalescing can improve this JS reader without
changing v1. They cannot reconstruct absent summary counts.

## Scope and evidence

| Scope             | What a finding describes                                                                                        |
| ----------------- | --------------------------------------------------------------------------------------------------------------- |
| **Figwig format** | Stored information or layout shared by conforming implementations; proposed changes require a format extension. |
| **Python writer** | Encoding choices in the inspected upstream writer; other writers can produce different valid v1 files.          |
| **figwig-js**     | This library's API, numeric representation, fetching, caching and implementation choices.                       |
| **Evidence**      | Results from particular files and this reader, rather than universal format performance.                        |

Format and writer observations refer to Figwig 0.2.0 at
[`c0e5d6522c677b9f03cd6831e2dbcea759866628`](https://github.com/jmschrei/figwig/tree/c0e5d6522c677b9f03cd6831e2dbcea759866628),
using its [frozen v1 specification](https://github.com/jmschrei/figwig/blob/c0e5d6522c677b9f03cd6831e2dbcea759866628/docs/format.rst).
Proposed extensions below are not implemented format features.

Evidence comes from the pinned independent [Python conformance oracle](test/fixtures/README.md),
[synthetic HTTP benchmarks](benchmarks/RESULTS.md),
[decompression experiments](benchmarks/DECOMPRESSION.md), and a local GenomeSpy
integration. HTTP and decompression timings are Node measurements, not browser
throughput or frame-time results. No equivalent BigWig baseline was measured.

## Figwig format: existing limits and proposed extensions

These findings concern information and access units defined by v1. They do not
prescribe a particular JavaScript API or decompression library.

### Existing v1: missingness and summary precision

Omitted raw tiles and unwritten bases mean **zero**; explicit NaNs preserve
missing observations. Zero background can be appropriate for count/pileup data
within a valid assay domain. Masked tracks and observations restricted to selected
regions need a different missingness policy. The upstream
[usage guidance](https://github.com/jmschrei/figwig/blob/c0e5d6522c677b9f03cd6831e2dbcea759866628/docs/figwig.rst#what-the-format-is-for-and-what-it-is-not)
includes methylation and conservation examples where missing differs from zero.

Tile summaries omit NaNs and round sums to float32. Zooms accumulate those
rounded tile sums in float64. Neither stores valid-base counts. Consequently:

- Stored sums alone cannot supply valid-base denominators for general masked-data
  means, or determine whether a bin contains NaNs.
- A nonzero count cannot substitute for a valid-base count: measured zeros
  belong in the denominator.
- Float64 zoom storage cannot recover precision already lost in tile sums.
- Sum-only summaries cannot describe peak envelopes or variability.

For example, ten observed bases scoring 10 in a 100-base bin have observed-base
mean **10**. Treating the other 90 bases as zero gives **1**. A wholly unobserved
bin likewise becomes zero instead of missing. Substituting a zero-filled mean is
an explicit statistical choice, not an equivalent approximation of that mean.
For known fully observed data, means can instead use genomic width.

### Existing v1: spatial access and track coupling

- Position order has one compressed live-index stream per group, without
  independently addressable regional pages. Track order has a flat block index
  per track and always one track per group.
- Each summary/zoom level is a genome-wide stream per group, without indexed
  regional blocks inside a level.
- Compressed chunks couple tracks. Larger groups favor coordinated many-track
  reads; smaller groups reduce subset overfetch but can require more requests.

The layout determines which bytes are compressed together. Whether a reader
fetches all summary levels immediately, how it batches ranges, and its cache
policy are separate implementation decisions.

### Proposed format extensions

- **Sum and valid-base count per track/bin at every resolution:** count valid
  zeros, exclude NaNs and chromosome padding, and add counts at coarser levels.
  Define sparse omission so zero signal with observations remains distinguishable
  from a wholly missing bin. Existing v1 omitted raw tiles must retain their
  implicit-zero meaning.
- **Float64 base sums:** remove mandatory float32 tile-sum rounding before zoom
  accumulation. This does not eliminate all floating-point rounding.
- **Spatial summary blocks and seekable live indexes:** add independent fetch
  units and directories by region/resolution, rather than requiring readers to
  work through a whole compressed stream.
- **Optional min/max:** define them over valid values, including zeros, for peak
  envelopes. They serve a different purpose from means or integrated signal.

Counts enable missing-aware means (`sum / count`), missing bins (`count == 0`),
and NaN propagation when `count` is below the actual genomic bin width.
Precomputed bins still approximate arbitrary viewport/brush boundaries: exact
measurements need finer or raw reads at partial edges. Genomic-base counts also
cannot provide coverage-weighted methylation without the appropriate methylated
and total observation counts.

## Python writer: opportunities within v1

### NaN run-selection heuristic

The inspected
[`_scan_row`](https://github.com/jmschrei/figwig/blob/c0e5d6522c677b9f03cd6831e2dbcea759866628/figwig/_figwig_kernels.py#L366-L379)
intentionally counts adjacent NaNs as changes. That estimate can exclude runs at
the [candidate gate](https://github.com/jmschrei/figwig/blob/c0e5d6522c677b9f03cd6831e2dbcea759866628/figwig/_figwig_kernels.py#L785-L800),
although [`_run_bytes` and `_collect_runs`](https://github.com/jmschrei/figwig/blob/c0e5d6522c677b9f03cd6831e2dbcea759866628/figwig/_figwig_kernels.py#L477-L510)
already coalesce consecutive NaNs. **Dense missing-region payloads are a writer
choice; v1 already supports constant NaN runs.**

Evaluate NaN-aware change counting or a fast path for wholly missing rows. Add
writer regressions, reconvert the regional dataset below, and measure write cost,
encoding choices and reader decoding work. **The benefit is not yet verified.**
Compact missing runs would reduce this expansion, but would not replace
multiresolution summaries for general overviews.

### Layout selection and guidance

Choosing existing tile sizes, storage order and track groups is writer-side
configuration, not a new format feature or a figwig-js requirement. Evaluate both
cohort-wide and small-subset panning. Larger tiles can reduce index overhead while
increasing data overfetch; no one grouping/tile choice suits every workload.
The measured examples below help motivate workload-based guidance.

## figwig-js: implementation policies and engineering decisions

The choices here belong to this library. Other conforming readers may implement
fetching, aggregation and memory representation differently.

### Current summary and fetching policies

- **Summary API policy:** figwig-js requires `missing: 'zero'` and compatible bin
  alignment for all stored-summary use. With `useSummaries: true` and
  `missing: 'omit'`, it currently falls back to raw data.
- **A v1-compatible JS opportunity:** rounded omission-aware **sums** could use
  existing stored sums without valid-base counts. The blanket `missing: 'zero'`
  restriction is stricter than the format requires for that operation. General
  omission-aware **means** and NaN propagation still need information that v1
  summaries do not store.
- **Fetching policy:** this reader loads a selected group's live/block index
  together with all compressed summary/zoom sections, then inflates summaries
  lazily. Deferred summary downloads and coalesced group-index requests can
  improve this behavior within v1. They do not create spatial access inside a
  whole-level summary stream.

### Maintenance invariants

- **Numeric representation:** binary64 internal decoding preserves large uint32
  values even when group storage dtype differs from the declared track dtype.
  Raw output arrays retain each track's dtype; bins return float64. Keep NaNs
  and raw negative zero. Resolve stable group-local slots once with metadata.
- **Aggregation:** `getBins()` is a library convenience, not a native arbitrary-bin
  format primitive. Sharing the decoded-chunk visitor permits direct sparse/run
  aggregation without dense region-sized query arrays. Retain bounded decode
  windows and deterministic accumulation order.
- **Integrity and allocation:** validate extents, counts, CRCs and allocation
  estimates before allocating. Tiny payloads can describe thousands of track
  objects. Cache budgets and per-section limits are separate constraints;
  neither is a total-process-memory guarantee.
- **Binary handling:** respect fetched views' `byteOffset`; copy before zeroing
  CRC fields. Validate uint64 values before converting to safe JS numbers.
  Follow indexed offsets: valid appended v1 files may contain historical tables
  in their data region.
- **Cancellation:** preserve work wanted by another caller. Reader shutdown must
  cancel cache waiters and prevent late reads/cache fills, including warm-cache
  continuations. Save the close promise before abort listeners can reenter it.
- **API contracts:** unit features apply missing policies before zero filtering
  without losing raw precision or imposing float64 bin-buffer costs. Public
  types and corruption errors should agree with runtime behavior.
- **Verification:** keep the independent Python/specification oracle, corrupt-file
  tests, real HTTP accounting and browser checks. Test summaries against the
  summary oracle, not assumed exact raw sums.

### Measured optimization candidates

The [2026-10-28 probes](benchmarks/RESULTS.md#optimization-opportunity-probes--2026-10-28)
compare temporary prototypes against `eaf7556` in Node 24 and Chromium, retaining
production code and v1. Raw samples and reproduction commands are in that report.

- **Named selection (implemented):** a lazy name-to-track map avoids repeated linear scans.
  The large sparse selection benefits most; four selected tracks showed no
  resolved Chromium benefit. Preserve ordering, identifier errors and metadata
  lifetime. The reader releases the map at close; clearing data caches keeps it
  with metadata. Numeric IDs continue to avoid the map and its allocation.
- **Group-index I/O:** coalesce adjacent group records with the existing range
  policy. The ownership-preserving prototype reduced reads from 48 to 25 with
  identical transferred bytes in the measured 24-group query. Copy group slices
  into independent buffers or explicitly account for shared backing buffers;
  otherwise a small cached group can retain an entire coalesced response.
  Retain per-group CRCs, cancellation and configured limits.
- **Dense aggregation:** calculate dense bin boundaries once per bin/chunk
  intersection while retaining the accumulation order. Pure dense cases improved,
  but the tested mixed-data case regressed in Chromium. Resolve that tradeoff
  before treating the prototype as a general binning improvement.
- **CRC loops:** slicing by eight retained checks and improved the measured cold
  dense query less than the isolated CRC microbenchmark suggested. It adds seven
  KiB of lookup tables. Validate small and unaligned inputs and startup/bundle
  cost before prioritizing it over the larger query-level opportunities.

### Compressed track-block size

The v1 position-order compressed-size bound does not apply to track-order
blocks. The specification bounds a block's raw bytes by `12 * n + 64`, but blocks
always use zlib in codec 1, even when compression expands them. A 65,536-entry
float64 block has 786,432 raw bytes. Node zlib with `{ level: 0, memLevel: 1 }`
produced a valid 786,918-byte stream. Both the pinned specification reader and
Python `FigWigReader(verify=True)` accepted the complete file; figwig-js formerly
rejected it against a 786,560-byte compressed-size cap.

The reader now applies that compressed-size bound only to position order,
preserving raw-size, data-region and configured read limits for both orders.
`test/group.test.ts` covers expanded float64 blocks, exact decoding and the
retained raw-size, extent and position-order compressed-size checks. These are
reader compatibility and validation policies, rather than format extensions.

### Empty zoom streams

Only a base summary has an absent-summary representation. Each listed v1 zoom
requires a zlib stream, including when it has zero bins. A zoom record with
`n = n_bytes = crc = 0` is malformed: the pinned specification reader rejects
it, although the pinned Python package reader accepts it. Its behavior alone is
therefore not an adequate oracle for this case.

figwig-js now rejects zero-length zoom streams while parsing the group, instead
of returning `available: false`. Regressions in `test/group.test.ts` cover both
storage orders, absent base summaries, valid compressed empty summaries/zooms,
and zlib integrity for zero-bin zooms. The absence and integrity rules belong to
v1; this corrects the reader without changing the format.

### Chromosome-name corruption errors

Invalid UTF-8 chromosome names previously escaped as `TextDecoder`'s
`TypeError`, unlike invalid metadata text. The reader now wraps name-decoding
failures in the public `FigWigError`, preserving the original error as `cause`,
so callers can consistently identify corrupt files. `test/errors.test.ts`
repairs the header/table CRCs of malformed names in both storage orders to
exercise this error path. Valid UTF-8 names and binary extent checks retain
their existing behavior; this is a reader error-contract correction.

### Inflate-only entry point and bundle size

The choice of decompressor is specific to this JS implementation. Its strict
synchronous Pako path checks bounded output, RFC1950 headers, Adler32, exact
produced length, and trailing/concatenated input. It now imports `Inflate` from
[`pako-esm2` 2.0.2](https://github.com/cmdcolin/pako-esm), Colin Diesh's ESM fork.
GenomeSpy's inspected lockfile resolves the same version through
[`@gmod/bgzf-filehandle` 6.7.0](https://github.com/GMOD/bgzf-filehandle/blob/v6.7.0/package.json#L51-L54),
used by BAM and Tabix. Matching versions and ESM resolution let both readers
share an inflater; different installed versions or CommonJS resolution can still
duplicate it. Compression code is tree-shaken out, and the old CommonJS subpath
and local type shim are no longer needed.

Despite its version number, this fork derives from Pako 1. Its finish flag can
accept a nonfinal DEFLATE block even when output length and Adler32 match. The
adapter passes `false` and requires automatic stream termination; a regression
test covers the missing-final-block case. Keep these checks when changing
decompressors.

An esbuild 0.28.2 browser/ES2022 probe of the packed API reduced gzip size from
22,051 to 21,430 bytes versus the previous Pako 2.2 inflate-only import. Exporting
both the API and BGZF 6.7.0 reduced it from 74,979 to 67,551 bytes: the metafile
confirmed one shared ESM inflater and no encoder. This used minification and
`gzipSync`'s default level, with normal npm resolution and no aliases. It is a
dependency-sharing probe, not a measurement of GenomeSpy's complete bundle or
decompression speed. Earlier root-entry Pako measurements remain historical.

The [GMOD libdeflate experiment](benchmarks/DECOMPRESSION.md) measured dense-chunk
raw BBI inflation at 370.8 MiB/s versus 110.7 MiB/s for strict Pako. Adding JS
header/Adler checks reduced it to 165.0 MiB/s; the tested adapter still accepted
trailing/concatenated data. It was not a conformant replacement. BGZF's framing
and 64 KiB limits are not a direct match for Figwig chunks.

A future native binding needs bounded output, consumed-input and produced-output
counts, strict zlib validation and aggregate batch-allocation limits. Measure
copying, startup/asset costs and memory as well as throughput.
`DecompressionStream('deflate')` passed exploratory checksum/truncation/trailing
probes in Node and Chromium; async integration and native-buffer allocation checks
remain JS implementation work.

### Parser-generation experiment

The [Kaitai experiment](https://github.com/genome-spy/figwig-js/blob/505ab34ec457d03662545c05945ad31db3e3d7f1/benchmarks/KAITAI.md)
compiled the schema and passed conformance checks, but still needed substantial
semantic, integrity and typed-array adapters. Its recorded whole-API bundle grew
from 21,866 to 26,527 bytes with gzip level 9 (+21.32%); performance was not
measured. Keeping the handwritten parser is a figwig-js engineering decision,
not a limitation or requirement of the file format.

## Evidence: particular files and this reader

### Regional conversion and missing data

The local GenomeSpy experiment used the
[ENCODE mouse fetal-development recipe](https://github.com/genome-spy/genomespy-dataset-recipes/tree/f88b5ac737dd77d26eaebbcf7310e280237cf375/recipes/encode-mouse-fetal-development-mm10):
24 H3K27ac tracks across three tissues, four stages and two replicates. Regional
BigWigs retained a 10 Mb window and three 1 Mb windows while preserving full
chromosome lengths. Outside those windows, observations were not retained.

Conversion used the pinned Python writer, position order, eight tracks per group,
16,384-base tiles, four zoom levels and `--missing nan`. The resulting file was
89,734,106 bytes. Static inspection found:

| Indexed property                             |                           Observation |
| -------------------------------------------- | ------------------------------------: |
| Chunks                                       |                                95,376 |
| Declared uncompressed payload total          | 48,851,496,832 bytes (about 45.5 GiB) |
| Dense chunks                                 |                                92,985 |
| Dense chunks wholly outside retained windows |                                92,979 |

These are **indexed payload totals, not peak memory or elapsed-time measurements**.
They describe one conversion. The generated data and conversion scripts are not
archived in this repository.

The attribution matters:

- **Python writer:** its encoding choices produced the dense payloads; another
  v1 writer could encode missing runs differently.
- **Format:** stored sums lack the valid-base counts needed for the requested
  missing-aware overview means.
- **figwig-js:** its current omission-aware mean query therefore visits raw
  chunks. A small binned result does not imply little raw decoding in this path.
- **Integration:** cache hits avoid repeat decoding and workers help responsiveness.
  A count sidecar or validity-mask track could prototype a missing-aware pyramid
  within v1. Known retained regions can avoid outer gaps but do not establish
  per-track coverage inside them. A BigWig overview with Figwig detail is another
  possible bridge. None of these integration conventions is currently built in.

### HTTP/layout measurements

In this reader's synthetic benchmarks, an all-24-track 10 kb query required
48 requests with one-track groups and two with a 24-track group. For another
fixed sparse profile, extending the genome from 625 kb to 10 Mb increased one
group's initial index transfer from 3,892 to 52,894 bytes despite a 10 kb query.
See the [benchmark report](benchmarks/RESULTS.md) for parameters.

Track coupling and compressed fetch units come from the layout. Request counts
and timings also reflect this reader's fetching/coalescing strategy and cache
settings; they are not fixed properties of Figwig. Coalescing can reduce requests
while transferring gaps. Zero-request warm queries only show that the measured
working sets fit those caches.

## Development work by owner

1. **Python writer:** test NaN-aware run selection and reconvert the regional
   dataset, preserving NaNs. Archive the setup and compare declared payload,
   actual decode work, file size and write cost.
2. **Format:** prototype spatial sum/count summaries with float64 base sums.
   Compare with raw statistics for all-missing bins, measured zeros, partial
   chromosome ends and exact brush edges. Define versioning and sparse omission.
3. **figwig-js:** defer unneeded summary downloads, coalesce index reads, and
   evaluate rounded omission-aware summary sums. `requireSummaries` now prevents
   raw fallback for the entire batch, including feature queries; it requires
   compatible summaries and `missing: 'zero'`. This bounds the query strategy,
   not total summary/index download size or browser memory.
4. **Integration and validation:** prototype masks/count sidecars and measure
   first-open latency, panning, sample selection, frame responsiveness and memory/GC
   in browsers. Compare cold/cached reads with equivalent missingness and summary
   precision. A BigWig comparison must use the same statistic and account for
   initialization.
