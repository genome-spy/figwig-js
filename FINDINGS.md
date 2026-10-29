# Figwig format, writer and reader findings

The format findings arose during integration work in GenomeSpy. These notes
retain format improvement proposals and unresolved writer/reader opportunities.
Format and writer observations refer to Figwig 0.2.0 at
[`c0e5d6522c677b9f03cd6831e2dbcea759866628`](https://github.com/jmschrei/figwig/tree/c0e5d6522c677b9f03cd6831e2dbcea759866628),
using its [frozen v1 specification](https://github.com/jmschrei/figwig/blob/c0e5d6522c677b9f03cd6831e2dbcea759866628/docs/format.rst)
and the pinned independent [conformance oracle](test/fixtures/README.md).
Format extensions below are proposals for upstream Figwig, not implemented v1
features. Python writer configuration, opportunities in this repository's
figwig-js reader, and GenomeSpy adapter policies have separate sections; they do
not all require format changes.

## Figwig format: existing limits

### Missingness and summary precision

Omitted raw tiles and unwritten bases mean **zero**; explicit NaNs preserve
missing observations. Zero background can suit count/pileup data within a valid
assay domain. Masked tracks and observations restricted to selected regions need
a different missingness policy; upstream's
[usage guidance](https://github.com/jmschrei/figwig/blob/c0e5d6522c677b9f03cd6831e2dbcea759866628/docs/figwig.rst#what-the-format-is-for-and-what-it-is-not)
includes methylation and conservation examples where missing differs from zero.

Tile summaries omit NaNs and round sums to float32. Zooms accumulate those
rounded tile sums in float64. Neither stores valid-base counts. Consequently:

- Stored sums cannot supply denominators for general missing-aware means or
  determine whether a bin contains NaNs.
- Nonzero counts cannot substitute for valid-base counts: measured zeros belong
  in the denominator.
- Float64 zoom storage cannot recover precision lost in tile sums.
- Sum-only summaries cannot describe peak envelopes or variability.

Ten observed bases scoring 10 in a 100-base bin have observed-base mean **10**;
zero-filling the other 90 bases gives **1**. A wholly unobserved bin similarly
becomes zero instead of missing. For known fully observed data, means can use
actual genomic width.

### Summary resolution

In both storage orders, the finest stored summary bin spans one header tile;
additional zoom levels use tile-size multiples of `4^k`. Adding zoom levels only
provides coarser summaries. Finer summaries require a smaller header tile size
under v1, coupling summary resolution to raw tiling in position order.

### Spatial access and track coupling

- Position order has one compressed live-index stream per group, without
  independently addressable regional pages. Track order has a flat block index
  per track and always one track per group.
- Each summary/zoom level is a genome-wide stream per group, without indexed
  regional blocks inside a level.
- Compressed chunks couple tracks. Larger groups favor coordinated many-track
  reads; smaller groups reduce subset overfetch but can require more requests.

The format determines which bytes are compressed together. Immediate versus
lazy summary fetching, range coalescing and caching are reader policies.

## Figwig format: proposed upstream extensions

1. **Sum and valid-base count per track/bin at every resolution.** Count measured
   zeros, exclude NaNs and chromosome padding, and add counts at coarser levels.
   Define sparse omission so observed zero signal remains distinguishable from a
   wholly missing bin. Preserve the implicit-zero meaning of existing v1 omitted
   raw tiles.
2. **Float64 base sums.** Remove mandatory float32 tile-sum rounding before zoom
   accumulation. This does not eliminate all floating-point rounding.
3. **Summary resolution independent of raw tile size.** Allow finer summaries
   without fragmenting position-order raw chunks. Pair this with spatial summary
   blocks: finer genome-wide streams alone can increase download and memory costs.
4. **Spatial summary blocks.** Add independently indexed fetch units by
   chromosome/region and resolution so regional queries at any stored summary
   resolution need only nearby blocks.
5. **Seekable position-order live indexes.** Use independent pages or blocks and
   directories for bounded spatial access within a group.
6. **Optional min/max summaries.** Define them over valid values, including
   zeros, to support peak envelopes. They serve a different purpose from means
   or integrated signal.

Define extension versioning and sparse-omission rules explicitly. Validate
sum/count pyramids against raw statistics for all-missing bins, measured zeros,
partial chromosome ends and exact brush edges.

Counts enable missing-aware means (`sum / count`), missing bins (`count == 0`),
and NaN propagation when count is below the actual genomic bin width.
Precomputed bins still approximate arbitrary viewport/brush boundaries: exact
measurements need finer or raw reads at partial edges. Genomic-base counts also
cannot provide coverage-weighted methylation without the appropriate methylated
and total observation counts.

## Python writer: opportunities within v1

### NaN run-selection heuristic

The pinned writer's
[`_scan_row`](https://github.com/jmschrei/figwig/blob/c0e5d6522c677b9f03cd6831e2dbcea759866628/figwig/_figwig_kernels.py#L366-L379)
counts adjacent NaNs as changes. That estimate can exclude runs at the
[candidate gate](https://github.com/jmschrei/figwig/blob/c0e5d6522c677b9f03cd6831e2dbcea759866628/figwig/_figwig_kernels.py#L785-L800),
although [`_run_bytes` and `_collect_runs`](https://github.com/jmschrei/figwig/blob/c0e5d6522c677b9f03cd6831e2dbcea759866628/figwig/_figwig_kernels.py#L477-L510)
already coalesce consecutive NaNs. **Dense missing-region payloads are a writer
choice; v1 already supports constant NaN runs.**

Evaluate NaN-aware change counting or a fast path for wholly missing rows. Add
writer regressions and measure conversion cost, encoding choices, file size and
reader decoding work before claiming a benefit. Compact missing runs would not
replace multiresolution summaries for general overviews.

### Layout selection

Tile size, storage order and track grouping are existing writer configuration,
not format extensions. Smaller tiles permit finer summaries, but in position
order they can also increase raw chunk and live-index entry counts for the same
covered regions. Track-order raw blocks have independent entry counts and
extents. Finer summaries increase potential summary-bin counts in either order.
Evaluate summary resolution, index working sets and data overfetch for both
cohort-wide and small-subset panning; no one configuration suits every workload.

## figwig-js: current policies and opportunities

- Stored-summary queries require `missing: 'zero'` and compatible bin alignment.
  With `useSummaries: true` and `missing: 'omit'`, queries fall back to raw data.
  `requireSummaries` rejects raw fallback for the entire batch, including feature
  queries. It bounds the query strategy, not total index/summary download size or
  browser memory.
- Rounded omission-aware **sums** could use existing stored sums without counts;
  the current missing-policy restriction is stricter than v1 requires for that
  operation. General omission-aware **means** and NaN propagation still need
  information absent from v1 summaries.
- Raw indexes, section headers and selected summary levels are loaded
  independently. Bounds and integrity checks apply to requested sections;
  validation of unused payloads is deferred. Selective loading reduces unrelated
  section reads without creating spatial access inside a whole-level stream.
  Header probes and range coalescing still trade request latency against bytes.
- Index cache weights account for parsed chunk descriptors and tile arrays,
  conservatively including raw-index bytes. A query's group working set can
  exceed the cache budget and cause repeated downloads and parsing. Compact
  section metadata is cached with decoded summaries under
  `summaryCacheBytes`, independently of raw-index eviction. Size each cache for
  its working set while preserving allocation limits, cancellation and cache
  ownership. Larger caches help warm navigation but do not reduce the initial
  whole-stream read.
- Evaluate raw-query CPU optimizations by separating inflation, integrity
  checking, decoding and aggregation costs. Faster execution does not reduce
  required transfer volume. Any worker-backed reader would also need to preserve
  validation, allocation limits, cancellation and cache ownership while moving
  work off the UI thread.

## GenomeSpy integration: caller policies and prototypes

Choosing acceptable screen pixels per bin and using stored summaries at closer
zoom levels are adapter policies. Existing summaries can avoid raw reads when
the caller accepts coarser output bins. figwig-js must honor the requested
resolution and missing-value semantics; it cannot silently make that tradeoff or
create finer stored summaries. The genomic span at which an adapter switches to
raw data depends on its policy and viewport width, not a fixed format limit.

Count sidecars or validity-mask tracks could prototype missing-aware pyramids
within v1. Known retained regions do not establish per-track coverage within
those regions. A BigWig overview with Figwig detail is another integration
option; none of these conventions is built into this reader.
