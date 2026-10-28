# Implementation findings

This log records observations from implementation and verification. Measurements
are evidence for the recorded setup, not general performance claims.

## Format and architecture

- The authoritative frozen v1 specification and independent Python reader are
  pinned to upstream commit `c0e5d6522c677b9f03cd6831e2dbcea759866628`.
- Track metadata dtypes describe output values; individual chunks choose a
  common storage dtype for their group. Decoding directly into float32 would
  silently lose large uint32 values. The decoder uses binary64 internally and
  returns per-track arrays in their declared dtypes.
- The format's kind numbers differ from the descriptive list in the task:
  matrix is kind 3 and runs is kind 4. The specification governs decoding.
- Summaries omit NaNs, store tile sums rounded to float32, and carry no valid
  base counts. Zooms sum those rounded tile sums in float64. Missing-aware
  means require reading full-resolution values; summary-based sums must be
  explicitly distinguished from exact full-resolution sums.
- Position indexes cover whole groups, whereas track-order records index
  sparse blocks. They require different overlap lookups. Appended files may
  contain historical tables inside the data region, so offsets cannot be
  inferred by scanning.
- Official fixtures contain over 1,200 tracks, including many empty tracks to
  force matrix encoding. They are small on disk but useful allocation and
  track-selection tests.

## Environment

- The workspace initially contained only the implementation brief (now
  `PROMPT.md`), with no Git repository.
- A sandboxed GitHub CLI check initially reported an invalid token because it
  could not access the network. Rechecking with network access confirmed a
  valid authenticated account. This was an environment diagnosis error, not a
  missing credential; repository creation can proceed.
- The default Python 3.14 environment does not provide the writer's numerical
  dependencies. Fixture tooling uses an isolated Python environment.
- Automatic approval review rejected creating a public repository because
  public source release was not explicitly authorized. Creating the requested
  repository privately was approved; `genome-spy/figwig-js` remains private.
- The HTTPS OAuth token could create the private repository but could not push
  GitHub Actions files because it lacks the `workflow` scope. The user's
  configured SSH Git credentials successfully pushed the complete implementation
  and workflows. No new token or credential-scope change was needed.

## Verification and measurements

- Both Python readers agree on every base of all seven official fixtures; the
  JavaScript reader passes all 42 conformance tests, including more than 400
  deterministic random windows. Native-array precision, NaNs, all summary and
  zoom records, append/merge, and both orders are covered.
- An independent review caught a subtle `Buffer` issue: `Buffer.slice()` is a
  view and its backing ArrayBuffer can have a nonzero offset. Copying a header
  into a plain Uint8Array before zeroing its CRC avoids corrupting caller-owned
  bytes and reading unrelated pooled memory. A regression test uses a pooled
  Buffer with a 37-byte prefix.
- A cache budget is not sufficient by itself. SharedReadCache retains its last
  settled entry even if oversized, and a decoded empty live tile can contain
  track objects despite holding zero numeric bytes. Oversized entries are now
  explicitly uncacheable; cache weights include estimated object overhead.
  Parsed index and decoded numeric allocations are also bounded before loops.
- The first binning implementation reused dense numeric outputs, which was
  correct but imposed full-region allocation costs on coarse queries. It now
  shares a decoded-chunk visitor with numeric queries and aggregates sparse
  entries and weighted run segments directly. A 200 kb sparse read into two
  tracks of bins succeeds with a 100-byte output budget; the corresponding
  full-resolution request correctly exceeds that budget. Decode windows bound
  temporary retention and preserve deterministic file-order arithmetic.
- Real Chromium 156.0.8078.4 passed HTTP Range/CORS, native dtype/oracle,
  overlapping-cache, track-order, Blob, and cancellation tests. The browser
  bundle builds without Node built-ins or LocalFile code.
- Pako was selected for the portable strict path after inspection showed that
  fflate's convenience zlib decoder does not itself provide the full Adler and
  consumed-input validation the format requires. Tests explicitly reject
  trailing bytes, concatenated streams, bad Adler checksums, and oversized
  decompression output.
- An initial comparison found `tracks_zlib.fw` larger than `tracks.fw`
  (231,533 versus 208,239 bytes), but investigation revealed different zoom
  counts (two versus one). That comparison cannot isolate compression overhead.
  Controlled benchmark configurations are required; filenames alone are
  insufficient evidence of equivalent layouts.
- Track order always has one track per group, regardless of the writer's
  requested grouping option. Group-size comparisons apply to position order.
  Benchmark generation pins the `zlib` engine; `auto` could select another
  installed compressor and silently change the comparison.
- Initial measured layout comparisons show that grouping reduces request rounds
  for all-track reads but increases single-track overfetch. Whole-group indexes
  shrink with larger tiles, while larger data chunks can increase transferred
  bytes. The benchmark report records actual datasets, medians, and limitations;
  no universal optimal layout is inferred.
- Group records currently fetch their compressed summary/zoom sections with the
  live/block index, then decode summaries lazily. Zoom first use can incur CPU
  work without another network read. Index-loading timings sum overlapping
  loads and must not be interpreted as critical-path elapsed time.
- The suggested GMOD `bgzf-filehandle` backend does use WASM libdeflate, but its
  public API expects gzip/BGZF and caps raw blocks at 64 KiB. BBI exposes raw
  DEFLATE for larger inputs, but lacks consumed-input and zlib-wrapper checks.
  On actual dense Figwig chunks, a measured BBI experiment reached 370.8 MiB/s
  raw versus 110.7 MiB/s for the strict Pako path; adding JS header/Adler checks
  reduced it to 165.0 MiB/s and still accepted trailing/concatenated streams.
  This establishes promise, not a conformant drop-in replacement. Full source
  revisions, setup/asset costs, semantic probes, and measurements are in
  `benchmarks/DECOMPRESSION.md`. No experimental adapter is used at runtime.

## Final local checks

- All 143 Node tests pass, including 42 Python-backed conformance tests, direct
  bins, strict zlib validation, malformed files, HTTP protocol/range accounting,
  cache reuse, and cancellation. Verified on Node 22.23.4 and Node 26.8.1.
- Three actual Chromium tests pass; Firefox and WebKit remain untested.
- TypeScript checking, ESLint, production build, and package-content inspection
  pass. The tarball contains only runtime JavaScript/declarations, README,
  license, and package metadata (21 files, about 26 KiB compressed).
- An isolated consumer installed the tarball outside the checkout, typechecked
  its declarations with no Node ambient types, and read native arrays, NaNs,
  large values, and bins correctly. npm publication was not performed.
- GitHub Actions passed every check on Ubuntu with Node 22 and 24, including
  the full test suite, actual Chromium, lint, types, build, and package inspection
  ([initial implementation run](https://github.com/genome-spy/figwig-js/actions/runs/40561210457)).

## Final benchmark observations

- All seven measurement sets were rerun against the final shared planner:
  1,806 recorded cold/warm samples, three repetitions per case. The 903 warm
  samples required zero HTTP requests; these decoded working sets fit the caches.
- On the 390 MB mixed 24-track file, reading all 24 tracks over 100 kb on the
  80 ms / 50 Mbit/s simulated connection took a 975.89 ms cold median and
  transferred 4,404,291 bytes in 12 requests. A warm repeat took 1.74 ms with no
  transfer. These query times exclude separately recorded header initialization.
- For sparse 24-track 10 kb reads, group size 1 used 48 requests and 697.23 ms
  when selecting every track; group size 24 used two requests and 175.90 ms.
  The tradeoff is larger unselected-track transfers for single-track queries.
- Extending the sparse genome from 625 kb to 10 Mb increased a selected group's
  initial index transfer from 3,892 to 52,894 bytes. A tiny genomic window does
  not imply a tiny whole-group index download.
- A six-track aligned ~8 Mb summary read used 135,760 index bytes and zero data
  chunk bytes, with a 110.59 ms cold median on the typical simulated network.
  This explicitly opts into rounded sums and NaN-as-zero semantics.
- Batching sometimes transfers more bytes because coalesced reads include gaps.
  Request counts, body bytes, phase timings, cache behavior, dataset parameters,
  and the synthetic-network limitations are all retained in `benchmarks/RESULTS.md`.

## Inflate-only entry point and bundle size

- A named `Inflate` import from Pako's root ESM entry did not remove all
  compression code from the browser build. Importing the explicitly exported
  `pako/lib/inflate.js` subpath produces a substantially smaller bundle, despite
  that submodule using CommonJS. The npm dependency remains the same package.
- Measured with esbuild 0.28.2, browser platform, ES2022 target, ESM output,
  minification, and Node 26.8.1 `gzipSync` at its default level. The baseline
  replaces only the inflater import with the root entry; no decoder logic differs.

  | Bundle                  | Root import minified bytes | Inflate-only minified bytes | Root import gzip bytes | Inflate-only gzip bytes |
  | ----------------------- | -------------------------: | --------------------------: | ---------------------: | ----------------------: |
  | Strict inflater wrapper |                     48,610 |                      24,114 |                 15,801 |                   8,643 |
  | Complete public API     |                     85,444 |                      60,921 |                 29,352 |                  21,748 |

- The complete bundle saves 7,604 gzip bytes (about 26%) in this setup. Bundle
  sizes are bundler/version-specific measurements rather than a size guarantee.
  Component gzip sizes are measured independently and are not additive.
- The inflate-only entry preserves synchronous decoding, output-allocation
  checks, Adler32 verification, and exact single-stream/trailing-byte validation.
  Browser builds require CommonJS-capable bundling; the existing esbuild and
  Chromium suite exercises that interoperation. Its build inspection now rejects
  Pako's full ESM entry and encoder modules.
- Pako exposes the subpath at runtime, but `@types/pako` declares the package
  root only. A narrow ambient declaration reuses its `Inflate` class type. The
  shim stays inside the build: public declarations expose no Pako types.
- Native `DecompressionStream('deflate')` also passed the checksum, truncation,
  and trailing-data probes in Node 22/26 and Chromium. It remains a viable
  alternative with an asynchronous internal refactor and separate native-buffer
  allocation testing; the selected change keeps the current synchronous design.

## GenomeSpy mouse-recipe integration (2026-10-28)

These findings arose while exercising Figwig in the real
[GenomeSpy App](https://github.com/genome-spy/genome-spy) with the
[ENCODE mouse fetal-development mm10 recipe](https://github.com/genome-spy/genomespy-dataset-recipes/tree/7e143f47849d977d83cb124fa896ca171b7f8046/recipes/encode-mouse-fetal-development-mm10)
from [genomespy-dataset-recipes](https://github.com/genome-spy/genomespy-dataset-recipes).
The recipe combines 24 H3K27ac tracks across three tissues, four embryonic stages
and two biological replicates. Its regional BigWigs retain a 10 Mb Ascl1 window
and three 1 Mb windows on four chromosomes, preserving original chromosome
lengths. Outside those windows, no observations were retained; absence is not
measured zero signal.

The local conversion used Python Figwig 0.2.0, position order, eight tracks per
group, 16384-base tiles, four zoom levels and `--missing nan`. It produced one
89,734,106-byte file from 111,314,653 bytes of regional BigWigs. GenomeSpy queried
it through this JavaScript reader, with reactive track selection, panning,
zooming, bookmarks and brush-derived sample metadata. The initial reader base
was `df1d737e5503c0463a35e94cf0b4d922a076ea91`; the subsequent validation-loop
optimization is `5416c0600075abea4a5a72f3664612daaaecac3e`.

### Whole-genome work is different from regional queries

- Improving regional fetch windows and per-value validation did not solve
  whole-genome overview loading. Coarse `getBinsMulti` queries with
  `missing: 'omit'` still decode the intersecting full-resolution chunks, even
  when the output contains only about one bin per screen pixel. Small output
  arrays do not imply small decoding work.
- Static inspection of this file's live indexes found 95,376 chunks with
  48,851,496,832 bytes of declared uncompressed payload (about 45.5 GiB).
  There were 92,985 dense chunks, overwhelmingly representing missing regions;
  92,979 were wholly outside the four retained intervals. Those dense payloads
  compress well, so file size and transferred bytes conceal the decoding cost.
  These are sums of indexed payload sizes, not peak resident-memory or elapsed
  time measurements. They describe this regional conversion, not every Figwig
  file or encoding.
- Larger caches, faster validation or worker decoding cannot remove that raw
  work. Workers can keep the UI responsive, and better caching can help repeats,
  but scalable overviews require either avoiding irrelevant chunks or using
  precomputed multiresolution data.

### Relaxing missing-data semantics changes the statistic

- The current exact omission-aware mean divides the sum of observed values by
  the number of observed bases. Measured zeros count as observations; NaNs do
  not. A bin with no observations remains missing.
- Treating missing bases as zero instead divides by the entire genomic bin
  width. For a 100-base bin with ten observed bases all scoring 10, the
  observed-base mean is 10, whereas the zero-filled mean is 1. A wholly missing
  bin becomes zero. In this recipe that would make unretained regions appear
  measured and dilute signal in bins crossing their boundaries.
- Such a policy can be an explicit overview approximation while raw data retain
  NaNs and scientific brush measurements use exact reads. It must not silently
  replace the omission-aware statistic or discard genuine zero observations.
- Existing tile sums omit NaNs but are rounded to float32; zoom sums accumulate
  those rounded values in float64. Neither carries valid-base counts. The
  reader's `useSummaries: true` with `missing: 'omit'` therefore falls back to
  raw values. Summary acceleration currently requires `missing: 'zero'` and
  alignment to the tile/zoom grid; incompatible requests also fall back.
- Allowing rounded sums and coarse bin alignment while retaining coverage counts
  is a separate, less invasive relaxation. It preserves missingness but produces
  approximate covered-base means. Existing nonzero counts cannot substitute for
  valid-base counts because measured zeros belong in the denominator.

### Missingness in the format's intended uses

- A plausible explanation for sum-only summaries is the format's implicit-zero
  model: unwritten bases are zero, and counts can be aggregated without a
  separate observed-base denominator. This is an inference from the design;
  the specification does not state why valid-base counts were omitted. NaNs
  are preserved in raw values, but summaries omit them without recording how
  many bases contributed, so the missing-aware aggregation contract is incomplete.
- For count or pileup tracks within a valid assay domain, a base with no
  detected event can correctly have value zero. Rounded sums and signal per genomic base are then useful
  without missingness counts. Raw-window reads, which are the format's main
  access pattern, can also preserve explicit NaNs without using summaries.
  These cases explain why the summary limitation need not dominate typical
  count-processing benchmarks. Uncallable or unassayed regions still need an
  explicit validity policy even in count data.
- The upstream [usage guidance](https://github.com/jmschrei/figwig/blob/c0e5d6522c677b9f03cd6831e2dbcea759866628/docs/figwig.rst#what-the-format-is-for-and-what-it-is-not)
  also names fold-change, p-value, conservation, mappability and prediction
  tracks as intended uses. It explicitly gives methylation zero versus
  unsequenced sites and conservation scores versus unaligned bases as examples
  that require `--missing nan`. Those distinctions are retained in raw data,
  but sum-only summaries cannot recover their observed-base means. Sparse
  observations, masked signal and predictions made only in selected windows
  have the same issue whenever absent values mean unknown rather than zero.
- The mouse recipe made the performance consequence unusually large because
  retained windows cover only a small part of the declared chromosomes. The
  semantic issue is broader: two tracks with identical observed signal but
  different missing coverage can have different zero-filled overview means.
  This is a real limitation for some documented uses, although it does not
  invalidate ordinary zero-background counts or raw-value window access.
- A valid-base count per track/bin would distinguish missing bins from measured
  zeros, provide omission-aware means (`sum / count`), and identify bins that
  should propagate NaN (`count < actual genomic bin width`). Counts must include
  measured zeros and add across zoom levels. A nonzero count is insufficient.
  Additional counts require storage and writer bookkeeping; float64 sums address
  the separate rounding issue. The current format stores neither per-bin valid
  counts nor missingness flags. Counts recover unweighted means of valid stored
  values; coverage-weighted methylation additionally requires the appropriate
  methylated and total observation counts.

### Format proposals and changes that do not require a new format

- **Proposed format improvement: valid-base counts at every summary level.**
  Add a sum and valid-base count per track/bin to tile summaries and every zoom
  level. Count measured zeros as valid, exclude NaNs, and add counts when
  building coarser levels. This enables omission-aware means (`sum / count`),
  missing bins (`count == 0`) and NaN propagation when the count is less than
  the actual genomic bin width, without decoding raw bases. Define sparse-summary
  omission so zero
  sums with valid observations remain distinguishable from missing bins. This
  addresses documented uses such as conservation and methylation, as well as
  masked or regional signals, where coverage must not dilute observed means.
  Prefer float64 sums at the base summary level as well as higher zoom levels,
  so higher levels do not inherit rounded float32 tile sums. Precomputed bins
  remain coarse representations: arbitrary brush boundaries still require
  finer or raw edge reads for exact interval measurements.
- **Region-addressable summary blocks:** make it possible to fetch only the
  relevant chromosome/region and resolution. Current summaries are whole-genome
  streams per group; the current reader fetches their compressed sections with
  the group index. Deferring unneeded levels is a reader optimization, whereas
  independently indexed blocks would address spatial access within a level.
- **Optional min/max summaries:** support overview peak envelopes, since means
  alone can hide narrow peaks. These are display statistics with a different
  meaning from a mean or integrated signal measurement.
- **Prototype coverage counts without changing v1:** a count sidecar or companion
  mask tracks can supply the missing denominator. A mask must mark every valid
  observation, including measured zero, and exclude missing bases. Existing
  rounded signal summaries plus counts yield missing-aware approximate means;
  an independently precomputed sum/count pyramid can control precision. Neither
  convention is built into the current GenomeSpy integration.
- **Improve the Python writer's NaN run selection without changing v1:** in the
  inspected 0.2.0 writer,
  [`_scan_row`](https://github.com/jmschrei/figwig/blob/c0e5d6522c677b9f03cd6831e2dbcea759866628/figwig/_figwig_kernels.py#L366-L379)
  counts consecutive NaNs as
  value changes at every base. That estimate can exclude the runs candidate,
  although `_run_bytes` and `_collect_runs` already treat consecutive NaNs as
  equal (see the
  [run helpers](https://github.com/jmschrei/figwig/blob/c0e5d6522c677b9f03cd6831e2dbcea759866628/figwig/_figwig_kernels.py#L477-L510)
  and [candidate gate](https://github.com/jmschrei/figwig/blob/c0e5d6522c677b9f03cd6831e2dbcea759866628/figwig/_figwig_kernels.py#L785-L800)).
  Existing v1 run chunks can represent a constant NaN stretch. Correcting
  that heuristic and regenerating the file should avoid the pathological dense
  expansion while preserving missingness; the improvement still needs a writer
  regression test and a measured reconversion. Compact missing runs alone do
  not replace multiresolution summaries for general whole-genome viewing.
- **Near-term integration options:** restricting queries to the known retained
  intervals can avoid this dataset's outer gaps, while preserving NaNs within
  those intervals. The four-region mask alone does not prove per-track coverage
  inside them. A hybrid using BigWig zoom data for overview and Figwig for detail
  is another practical option. Both require explicit integration; neither is a
  general Figwig format solution.

Native additional summary fields or indexed block layouts need an explicit
format extension. Existing v1 omitted tiles must keep their implicit-zero
meaning; a reader cannot reinterpret them as missing without new semantics.

The preferred direction is a coverage-aware overview pyramid for navigation,
with exact Figwig reads for detail and scientific brush calculations. These are
proposals derived from exercising the current format, not implemented format
extensions. The GenomeSpy experiment records its setup and browser measurements
in `docs/development/figwig-experiment.md` on its local
`experiment/figwig-integration` branch; recipe Figwig scripts, variant specs and
generated data remain local and uncommitted.

## Kaitai parser experiment (2026-10-28)

The [experiment branch](https://github.com/genome-spy/figwig-js/tree/experiment/kaitai-parser)
evaluates Kaitai 0.11.0 against handwritten-parser baseline
`64f6e2c3bb9f27997d61c0ca7e6fef92a45def5f`. Its
[comparison report](https://github.com/genome-spy/figwig-js/blob/505ab34ec457d03662545c05945ad31db3e3d7f1/benchmarks/KAITAI.md)
and [size data](https://github.com/genome-spy/figwig-js/blob/505ab34ec457d03662545c05945ad31db3e3d7f1/benchmarks/measurements/kaitai-size.json)
retain the implementation, reproduction instructions and limitations.

- **A missed initial evaluation:** the brief linked the upstream Kaitai schema,
  but the initial implementation went directly to handwritten parsing without
  comparing alternatives. The schema compiled successfully and was a viable
  starting point; there was no demonstrated reason to reject it initially.
- **Integration still requires custom code:** the experiment combines generated
  metadata/index structures and primitive/varint readers with handwritten payload
  sequencing, padding calculations and sparse reconstruction. HTTP range
  planning, bounded decompression, CRCs, metadata interpretation and allocation
  policy remain custom code. Exact uint64 checks, strict UTF-8/BOM handling and
  portable browser runtime packaging also needed explicit adaptation.
- **Generated code has its own failure modes:** a repeat-until index expression
  initially stopped valid varints after two bytes. Tests caught it; checking the
  group count explicitly fixes the three-byte limit. Repeated primitives produce
  JavaScript arrays, so payload parsing uses windows of at most 4096 values before
  conversion to typed arrays. Sparse varint objects remain ephemeral, and
  generated index/summary staging needs conservative allocation estimates.
- **Runtime size is only part of the cost:** the complete browser API grows from
  61,299 to 82,416 minified bytes, or from 21,866 to 26,527 gzipped bytes: +4,661
  bytes (+21.32%). Both builds retain all public exports with esbuild 0.28.2,
  browser ESM/ES2022 and gzip level 9. These are static code-size measurements,
  not performance benchmarks.
- **Correctness and developer experience:** 176 Node tests and three Chromium
  tests pass, including new boundary regressions. Declarative layouts help
  review, but substantial adapters, handwritten TypeScript interfaces and
  generation tooling remain. Generation checks catch stale artifacts; tests
  must catch schema/interface mismatches. Passing tests do not establish
  universal equivalence or greater correctness, and some allocation limits are
  intentionally stricter to account for generated staging.
- **Performance remains unmeasured:** generated objects, stream dispatch and
  conversion may add CPU/GC work during decoding. Decoded-cache hits largely
  bypass parsing. No timing, throughput, allocation or memory benchmarks were
  run; bounded staging does not establish peak resident memory.

Main retains the handwritten parser. The experiment remains available, but it
did not remove enough custom complexity to establish a clear overall advantage.
Performance measurements can follow if the schema-maintenance benefits warrant
further evaluation.

## KISS review follow-ups (2026-10-28)

- An eight-byte empty matrix can describe a group with thousands of tracks.
  Numeric-entry limits alone did not bound the per-track decoded descriptors.
  Decoding now checks the conservative `tracks * 128` descriptor/workspace
  estimate before allocation, independently of the existing numeric-buffer
  checks. This preserves the numeric-budget boundary and does not claim to
  bound total JavaScript heap usage.
- Position-order index parsing previously allocated run objects before checking
  their known budget. The run-count preflight now happens before reading or
  allocating those records; live-entry costs are still checked once available.
- Group-slot resolution scanned group members for every selected track on each
  query, including summaries. Metadata now stores each track's slot once in a
  `Uint32Array` (four bytes per track), and queries group selections in one pass.
  Regressions reorder metadata so group members are nonadjacent while retaining
  their encoded slot order; both raw reads and summaries must still agree.
- Corrupt payloads and invalid JSON previously threw plain `Error`, unlike
  checksum and decompression failures. Both now use the public `FigWigError`;
  invalid JSON retains its original parsing error as `cause`.
- Clearing `SharedReadCache` only detaches pending fills; it does not cancel
  them. Reader shutdown now composes a lifetime signal into all cache waiters
  and reads, so pending queries reject even when a filehandle ignores aborts.
  Late completions cannot start more reads or refill caches; `stat()` itself
  cannot be cancelled because its filehandle interface has no signal parameter.
- Warm-cache inner promises can settle just before `close()` while their public
  wrappers are still waiting to resume. Completion checks are needed as well as
  I/O checks to prevent those pending calls from returning after shutdown.
- The close promise is saved before abort listeners run, preventing reentrant
  or concurrent calls from closing the handle twice. Both synchronous and
  asynchronous handle-close failures are memoized. Native `AbortSignal.any()`
  composes cancellation without manual listener bookkeeping and is now named
  in the browser requirements.
- One-base features bypass binning to preserve native output budgets and raw
  numeric values, but that path also bypassed missing-value policies. A NaN
  now becomes zero for `missing: 'zero'` or an omission-aware sum, before zero
  filtering; propagation and omission-aware means retain NaN. Finite values
  and negative zero stay unchanged. Shared validation rejects invalid policies
  at every span, without routing unit spans through float64 bin buffers.
