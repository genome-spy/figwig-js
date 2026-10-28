# Figwig JavaScript HTTP benchmark results

Measured on 2026-10-27. These are observations for synthetic files and this
implementation, not general speed guarantees. The standalone repository places
this report at `benchmarks/RESULTS.md`; no `packages/figwig` monorepo is needed.

## Environment and method

- CPU: Apple M5, 10 logical CPUs; 32 GiB RAM.
- Runtime: Node v26.8.1, darwin/arm64.
- Reader query/decode implementation: commit `7dae4ad72bb5b3b7d01e327ef1381a75a99d24d5`;
  all seven runs were repeated after the final bounded-window planner changes.
- Writer: Python 3.12.13; Figwig 0.2.0; NumPy 2.5.4, Numba 0.68.0;
  upstream commit `c0e5d6522c677b9f03cd6831e2dbcea759866628`.
- Compression: Python zlib 1.2.12, level 6 except the explicitly uncompressed comparison.
- Browser performance was not measured here; actual browser correctness tests
  are separate from these Node HTTP benchmarks.
- 1,806 recorded query samples across seven runs, including cold and warm
  pairs. Each case has three repetitions and one untimed warm-up on another reader.
- Header/metadata initialization is timed separately and excluded from query
  times. A cold query includes its first selected-group index loads. A warm
  query immediately repeats the same pattern on the same reader. No external
  raw-range cache wrapper is added.
- Default reader concurrency is six, coalescing gap 4,096 bytes, coalesced-read
  cap 4 MiB, decoded-chunk cache 64 MiB and group-index cache 32 MiB.
- The localhost server applies latency to every response and throttles 16 KiB
  body chunks through one shared bandwidth timeline. Its independent protocol
  tests cover 206, 416, HEAD, CORS, shared bandwidth, concurrency and cancellation.

| Scenario | Response latency | Shared bandwidth |
|---|---|---|
| local | 0 ms | Unlimited |
| fast | 20 ms | 100 Mbit/s |
| typical | 80 ms | 50 Mbit/s |
| high | 150 ms | 10 Mbit/s |

Raw samples and all phase/cache metrics are retained in
[`measurements/`](measurements/). Each JSON has an adjacent table including
median and interpolated p95. Three samples support exploratory comparisons;
they do not establish a reliable tail-latency distribution. Measurements were
collected during development on a shared workstation, without CPU-frequency
pinning or process isolation.

First-open header/metadata medians for the mixed file, excluded from the query tables:

| Network | Initialization ms |
|---|---|
| local | 3.15 |
| fast | 50.17 |
| typical | 170.93 |
| high | 313.20 |

## Datasets

Every dataset has two chromosomes and seed 1701. The small sparse layout matrix
uses chromosome lengths 500,000 and 125,000, 24 tracks, density 0.02, four zoom
levels, all four tile sizes and all four position-group sizes. One track-order
file represents the same signals. In track order every track is its own group;
the writer ignores the requested group size. JSON manifests record that fact.

| Dataset | Tracks | Chromosome lengths | File bytes | Tile bp | Tracks/group | Order |
|---|---|---|---|---|---|---|
| Sparse24 compact baseline | 24 | 500,000 + 125,000 | 592,388 | 4096 | 4 | positions |
| Sparse24 track-order | 24 | 500,000 + 125,000 | 777,511 | 4096 | 1 | tracks |
| Mixed24 | 24 | 8,000,000 + 2,000,000 | 390,392,513 | 4096 | 4 | positions |
| Dense8 | 8 | 2,000,000 + 500,000 | 68,600,780 | 4096 | 4 | positions |
| Sparse96 collection | 96 | 2,000,000 + 500,000 | 8,874,394 | 4096 | 8 | positions |
| Sparse24 long chromosomes | 24 | 8,000,000 + 2,000,000 | 9,376,472 | 4096 | 4 | positions |

Mixed tracks alternate sparse counts and varying float32 signals, with NaN
stretches in float tracks. Dense signals are noisy continuous float32 values.
Large files are generated on demand and excluded from Git. The 390 MB mixed
file and 68.6 MB dense file exercise substantially larger payloads than the
conformance fixtures. Generator parameters and complete file sizes for every
layout are retained in raw result metadata.

## Track groups and storage order

The table below uses the same 10 kb interval in the compact sparse dataset.
All times are cold medians on the typical simulated connection. Header
initialization is excluded. The group-24 file necessarily transfers the same
chunks for one selected track and all 24 tracks.

| Layout | 1 track ms | 1 track bytes | Requests | 24 tracks ms | 24 tracks bytes | Requests |
|---|---|---|---|---|---|---|
| positions, g1 | 170.64 | 3,217 | 2 | 697.23 | 74,934 | 48 |
| positions, g4 | 172.88 | 6,431 | 2 | 177.32 | 38,121 | 12 |
| positions, g8 | 172.49 | 10,517 | 2 | 177.35 | 30,873 | 6 |
| positions, g24 | 177.79 | 25,654 | 2 | 175.90 | 25,654 | 2 |
| tracks, g1 | 178.69 | 26,094 | 2 | 567.01 | 618,446 | 25 |

Many one-track position groups minimize bytes for a single selected track, but
all-track reads need many separate group-index and data requests. Six allowed
concurrent requests turn those requests into several latency rounds. Grouping
reduces this request overhead while increasing transfer for small subsets.
Track-order blocks can span much more than a 10 kb interval in these sparse
signals, so short-window reads overfetch more block data. These observations
depend on signal density and block layout; they do not establish a universal
ranking of storage orders.

Within the group-4 position file, four selected tracks in one group transfer
19,939 bytes over 100 kb, while four tracks in different groups transfer 79,793 bytes. Their medians are 177.63 and 187.62 ms respectively.

## Tile size and whole-group indexes

One selected track, 10 kb window, group size four, compact sparse files:

| Tile bp | File bytes | Index bytes | Data bytes | Total query bytes | Local ms |
|---|---|---|---|---|---|
| 1,024 | 777,556 | 13,171 | 2,126 | 15,297 | 3.40 |
| 4,096 | 592,388 | 3,892 | 2,539 | 6,431 | 3.27 |
| 16,384 | 529,054 | 1,408 | 2,327 | 3,735 | 3.29 |
| 65,536 | 509,834 | 675 | 8,792 | 9,467 | 3.40 |

Larger tiles reduce index bytes but eventually transfer more irrelevant bases.
The smallest transfer here occurs at tile size 16,384; this is a measured result
for this particular sparse signal and window alignment, not a tuning rule.
Position-index compression covers all live tiles of a selected group. Querying
a short interval therefore still loads that whole-group index.

| Same group-4 sparse profile | Genome bases | Index bytes | Data bytes | Total bytes | Typical ms |
|---|---|---|---|---|---|
| Compact | 625,000 | 3,892 | 2,539 | 6,431 | 172.88 |
| Long chromosomes | 10,000,000 | 52,894 | 1,852 | 54,746 | 184.18 |

The window positions differ because the pattern centers each query within its
chromosome. Signal seed, density, tile size and grouping remain fixed. This
comparison demonstrates measured index growth, without extrapolating to a
whole human genome.

## Larger mixed-signal file and network conditions

Cold median times for the 390 MB mixed file. The requested large-region bins
cover the aligned prefix of chr1 (7,995,392 bp), six selected tracks and 65,536 bp
sum bins. Summary use is explicit and treats NaNs as zero; these stored sums
have the format's rounded tile-sum semantics.

| Workload | Local ms | Fast ms | Typical ms | High-latency ms | Typical warm ms |
|---|---|---|---|---|---|
| 1 track / 10 kb | 6.24 | 72.27 | 204.58 | 457.65 | 0.06 |
| 24 tracks / 10 kb | 17.09 | 138.72 | 336.99 | 1044.98 | 0.39 |
| 24 tracks / 100 kb | 88.35 | 508.07 | 975.89 | 3861.28 | 1.74 |
| 6 tracks / coarse ~8 Mb sums | 3.17 | 37.85 | 110.59 | 264.42 | 0.07 |
| 6 overlapping pans | 70.66 | 497.16 | 1151.82 | 3436.55 | 5.05 |
| Resolution changes | 10.10 | 92.84 | 238.85 | 568.46 | 0.89 |
| 24 → 6 → 6 → 24 tracks | 90.93 | 512.25 | 984.25 | 3881.06 | 4.75 |
| Several regions batched | 18.85 | 174.13 | 412.49 | 1127.03 | 0.59 |
| Several regions sequential | 20.17 | 211.82 | 589.53 | 1464.54 | 0.58 |

Selected cold typical-connection metrics (the adjacent JSON retains all metrics):

| Workload | Requests | Index bytes | Data bytes | Chunks fetched | Chunks inflated | Data inflate ms | Decode ms | Retained cache bytes |
|---|---|---|---|---|---|---|---|---|
| 1 track / 10 kb | 2 | 67,689 | 87,031 | 3 | 3 | 4.03 | 1.81 | 653,681 |
| 24 tracks / 10 kb | 12 | 408,369 | 493,829 | 18 | 18 | 11.96 | 7.68 | 3,923,385 |
| 24 tracks / 100 kb | 12 | 408,369 | 3,995,922 | 150 | 150 | 63.63 | 25.35 | 17,235,873 |
| 6 tracks / coarse ~8 Mb sums | 2 | 135,760 | 0 | 0 | 0 | 0.00 | 0.00 | 713,880 |
| 6 overlapping pans | 14 | 135,760 | 2,695,007 | 98 | 98 | 65.79 | 29.42 | 10,588,064 |
| Resolution changes | 4 | 135,760 | 170,906 | 6 | 6 | 6.31 | 3.89 | 1,416,584 |

The 100 kb all-track request transfers about 4.4 MB from a 390 MB file, rather
than fetching the entire file. Data decompression is a substantial component
of the local baseline. With imposed latency/bandwidth, network waiting dominates
that same workload. The data-inflate timer excludes compressed index and summary
inflation; index-load time includes network, validation and index parsing and
sums concurrently overlapping group loads, so it can exceed query wall time.
Retained cache bytes estimate parsed structures and typed arrays, not process
RSS or JavaScript object/allocator overhead. Header metadata is excluded from
that cache estimate. Data-byte counts include gaps fetched by range coalescing.

## Zooms, panning and cache reuse

This implementation initially fetches a selected group's complete index record,
including compressed tile and zoom summaries. It decompresses summaries only
when requested. Consequently, the first zoom read after full-resolution access
can need no additional HTTP requests: summary payload bytes were already included
in the initial index transfer. That is a reader implementation choice and a
visible component of the reported index overhead.

The separate typical-connection trace records each step, rather than inferring
zoom behavior from aggregate times:

| Pattern | Step | Median ms | Requests | Index bytes | Data bytes |
|---|---|---|---|---|---|
| E | pan-0 | 464.67 | 4 | 135,760 | 1,348,577 |
| E | pan-1 | 135.00 | 2 | 0 | 258,277 |
| E | pan-2 | 143.42 | 2 | 0 | 286,359 |
| E | pan-3 | 143.88 | 2 | 0 | 287,002 |
| E | pan-4 | 134.08 | 2 | 0 | 228,652 |
| E | pan-5 | 144.80 | 2 | 0 | 286,140 |
| F | full-resolution | 234.77 | 4 | 135,760 | 170,906 |
| F | first-tile-summary | 2.80 | 0 | 0 | 0 |
| F | first-coarse-zoom | 0.37 | 0 | 0 | 0 |
| F | repeated-tile-summary | 0.51 | 0 | 0 | 0 |
| G | selection-0-24-tracks | 981.11 | 12 | 408,369 | 3,995,922 |
| G | selection-1-6-tracks | 0.52 | 0 | 0 | 0 |
| G | selection-2-6-tracks | 0.51 | 0 | 0 | 0 |
| G | selection-3-24-tracks | 1.96 | 0 | 0 | 0 |

Across the recorded 903 warm samples, the total HTTP request count is 0. Output allocation and copying still take time, even when all required decoded chunks remain cached. These measured decoded working sets fit the configured caches; larger queries can evict chunks and require more reads.

## Dense signals and a 96-track collection

Typical-connection cold medians; A's all-track case intentionally caps selection
at 24 tracks, whereas I selects every track in the file.

| Workload | Median ms | Requests | Index bytes | Data bytes | Retained cache bytes |
|---|---|---|---|---|---|
| Dense8, one / 10 kb | 223.96 | 2 | 18,864 | 225,448 | 616,448 |
| Dense8, all8 / 100 kb | 716.80 | 4 | 37,918 | 2,925,305 | 7,025,598 |
| Collection96, one / 10 kb | 177.68 | 2 | 20,254 | 4,787 | 127,674 |
| Collection96, first24 / 10 kb | 186.88 | 6 | 60,823 | 14,264 | 382,279 |
| Collection96, all96 / 10 kb | 393.42 | 24 | 243,089 | 56,516 | 1,524,461 |
| Collection96, four scattered / 10 kb | 188.96 | 8 | 81,057 | 18,988 | 509,549 |

The 96-track file has twelve position groups. Reading all 96 tracks loads more
groups and consumes additional concurrency rounds; changing only which four
tracks are selected also changes how many groups are needed. This is a measured
cost of the chosen layout, not evidence that a track count alone predicts
performance.

## Compression and batching tradeoffs

| Compression level | File bytes | All24 / 100 kb typical ms | Query bytes | Chunks inflated |
|---|---|---|---|---|
| 0 | 670,140 | 201.03 | 131,797 | 0 |
| 6 | 592,388 | 192.35 | 119,666 | 156 |

Compression changes both payload size and the writer's chosen chunk
representations. Level zero therefore is not merely the same chunks with a
codec disabled. The complete raw samples retain local baseline comparisons too.

Batching reduces serial latency where the joint query can coalesce ranges and
share chunks. It does not always reduce bytes: in the local tile-65,536/group-1
sparse case, batched H transfers 75,771 bytes versus 62,146 sequentially, because
coalescing also fetches gaps. The `coalesceGap`, concurrency and read-size options
allow this tradeoff to be measured for another workload. A lower request count
can help latency while increasing irrelevant bytes; both metrics must be kept.

## Limitations and later integration

- These synthetic signals and short chromosome matrix do not replace a full
  human-genome benchmark with thousands of tracks. Whole-group index overhead
  can differ substantially at that scale.
- Only Node performance was measured. Browser correctness uses actual Chromium
  separately; browser performance, Firefox and WebKit remain future measurements.
- The network model is deterministic but excludes connection establishment,
  TLS, packet loss, HTTP/2 behavior and real proxy caches. Timer granularity and
  application work can lower effective throughput below the configured budget.
- No BigWig baseline was measured. No cross-format speedup is claimed.
- Cold samples have warm JIT, OS file cache and HTTP connection pools, while
  parsed caches begin empty. Header initialization must be added for end-to-end
  first-open latency; its per-sample values are present in JSON.
- Summary queries deliberately use NaN-as-zero sums. Missing-aware means must
  use full-resolution data unless a valid denominator is available. Tile sums
  are rounded by the format, so summary bins are not exact floating-point sums.
- Future GenomeSpy integration should reuse one reader per immutable/versioned
  file, select tracks before reading, choose group layouts for actual cohort
  access patterns, use explicit aggregation semantics and cancel obsolete views.
  This phase does not add any GenomeSpy integration or change the binary format.

## Reproduce

See [`README.md`](README.md) for all generator parameters and environment setup.
The retained commands are in each raw JSON's `args` field. After the Python setup in that README, regenerate the measured datasets with:

```sh
.venv/bin/python benchmarks/scripts/generate.py --upstream /tmp/figwig-reference \
  --profile sparse --length 500000 --second-length 125000 --matrix
.venv/bin/python benchmarks/scripts/generate.py --upstream /tmp/figwig-reference \
  --profile mixed
.venv/bin/python benchmarks/scripts/generate.py --upstream /tmp/figwig-reference \
  --profile dense --tracks 8 --length 2000000 --second-length 500000
.venv/bin/python benchmarks/scripts/generate.py --upstream /tmp/figwig-reference \
  --profile collection --tracks 96 --length 2000000 --second-length 500000 --group 8
.venv/bin/python benchmarks/scripts/generate.py --upstream /tmp/figwig-reference \
  --profile sparse --output benchmarks/fixtures/large-sparse
.venv/bin/python benchmarks/scripts/generate.py --upstream /tmp/figwig-reference \
  --profile sparse --length 500000 --second-length 125000 --level 0
```

Then run the retained query configurations:

```sh
npm run benchmark -- --scenarios local --patterns A,B,C,H --repetitions 3 \
  --output benchmarks/measurements/matrix-local.json benchmarks/fixtures/sparse*-l6-*.fw
npm run benchmark -- --scenarios typical --patterns A,B,C,H --repetitions 3 \
  --output benchmarks/measurements/matrix-typical.json \
  sparse-n24-tile4096-g1-positions-l6-s1701.fw \
  sparse-n24-tile4096-g4-positions-l6-s1701.fw \
  sparse-n24-tile4096-g8-positions-l6-s1701.fw \
  sparse-n24-tile4096-g24-positions-l6-s1701.fw \
  sparse-n24-tile4096-g4-tracks-l6-s1701.fw
npm run benchmark -- --scenarios all --repetitions 3 \
  --output benchmarks/measurements/mixed-networks.json \
  mixed-n24-tile4096-g4-positions-l6-s1701.fw
npm run benchmark -- --scenarios local,typical --patterns A,B,D,E,F,G,H,I \
  --repetitions 3 --output benchmarks/measurements/profiles.json \
  dense-n8-tile4096-g4-positions-l6-s1701.fw \
  collection-n96-tile4096-g8-positions-l6-s1701.fw
npm run benchmark -- --scenarios local,typical --patterns A,B --repetitions 3 \
  --output benchmarks/measurements/compression.json \
  sparse-n24-tile4096-g4-positions-l0-s1701.fw
npm run benchmark -- --scenarios local,typical --patterns A,D,H --repetitions 3 \
  --directory benchmarks/fixtures/large-sparse \
  --output benchmarks/measurements/large-sparse.json
npm run benchmark -- --scenarios typical --patterns E,F,G --repetitions 3 \
  --output benchmarks/measurements/step-traces.json \
  mixed-n24-tile4096-g4-positions-l6-s1701.fw
python3 benchmarks/scripts/report.py
```

The matrix shell glob selects only the 17 level-six sparse files. The large sparse file uses a separate `large-sparse` output directory
because it intentionally shares a configuration filename with the compact file.
The separate [`DECOMPRESSION.md`](DECOMPRESSION.md) report evaluates decompressor
alternatives with independently retained raw timing samples.

## Optimization opportunity probes — 2026-10-28

These experiments compare the production reader at
`eaf75569b5bfcc0a6673e3af211042c5ac9f071f` with temporary source transformations.
They do not change production code. The portable bundles run in Node 24.22.1
and Chromium 156.0.8078.4 on Apple M5, darwin/arm64. Existing deterministic
benchmark files above and the pinned `zlib.fw` conformance fixture supply inputs.

Each case has three warm-up queries per variant and seven measured samples,
rotating variant order between samples. Reported times are medians of per-query
sample means. Warm bins repeat three queries per sample; named selections repeat
20; cold queries run once. A warm query retains parsed/decoded caches and has
zero file reads in these measurements. A cold query clears parsed caches before
each repetition, excludes header initialization, and uses actual localhost HTTP
ranges. CPU cases have no simulated latency or bandwidth limit. The many-group
case adds 80 ms per response and a shared 50 Mbit/s bandwidth limit, with reader
concurrency six and server concurrency eight.

Every prototype's measured output is compared element by element with the
baseline outside timing using `Object.is`, including NaNs and signed zero. This
is equivalence evidence for these workloads, not a substitute for corruption,
allocation, cancellation and browser regression tests before shipping a change.
Initial name-map construction is in warm-up, so its first-use cost is excluded.
Small timings are subject to browser timer resolution, JIT tiering and GC; these
are shared-workstation exploratory measurements, not general speed guarantees.

### CPU and warm-query candidates

Values are milliseconds per query, baseline → prototype. Raw samples are in
[`measurements/opportunities.json`](measurements/opportunities.json). An earlier
run without the four- and 96-track cases is retained in
[`measurements/opportunities-initial.json`](measurements/opportunities-initial.json)
to expose run-to-run variability.

| Prototype / workload | Node | Chromium |
|---|---:|---:|
| Cached name map: 600 names of 1,215 tracks, 64 bp | 8.022 → 0.061 | 7.070 → 0.065 |
| Cached name map: all 96 collection tracks, 10 kb | 0.724 → 0.525 | 0.295 → 0.230 |
| Cached name map: four scattered collection tracks, 10 kb | 0.037 → 0.029 | 0.020 → 0.020 |
| Dense bin loop: all eight dense tracks, 200 kb | 5.839 → 4.904 | 5.500 → 3.700 |
| Dense bin loop: all 24 mixed tracks, 200 kb | 11.358 → 11.396 | 8.200 → 8.967 |
| CRC slicing by eight: all eight dense tracks, cold 200 kb | 101.594 → 91.076 | 95.000 → 89.700 |

**Name lookup is the clearest small CPU change.** Explicit names currently call
`header.tracks.find()` once per selection entry. A lazy map removes the repeated
scans of the frozen track array. The 600-track case uses a deliberately sparse
conformance fixture, so copying values is cheap and selection dominates; it
should not be generalized to longer dense windows. The collection cases show a
smaller practical benefit, and no resolved Chromium benefit for four tracks.
Keep order, duplicate/unknown-name validation, immutable track identity, and
reader-lifetime cleanup. Numeric selections already bypass name scans.

**Dense binning is promising but needs more profiling.** The prototype iterates
over a bin's portion of a dense chunk, calculating the bin boundary once, while
retaining the original value-addition order and NaN handling. Production invokes
an interval helper with min/max/division for each base. Dense Chromium time fell
33% in the later run and 68% in the initial run, showing substantial variability.
The mixed workload consistently regressed about 9% in Chromium; this prototype
should not be shipped as a general aggregation optimization without resolving
that tradeoff. Dense bins use width 1,000; mixed bins use 997, both omission-aware
means over `chr1:1000000-1200000`.

**CRC optimization has a smaller complete-query effect than its microbenchmark.**
A table-driven loop processing eight bytes at once retains CRC verification and
adds seven KiB of lookup tables. A synthetic one-MiB CRC operation improved from
4.476 to 0.721 ms in Node and 4.037 to 1.288 ms in the later Chromium run. The
initial Chromium scalar baseline was 1.738 ms, showing why that isolated ratio
is not a stable whole-reader prediction. The complete cold dense query improved
about 10% in Node and 6% in Chromium, with unchanged five reads and 5,503,598 data
bytes. Prioritize the larger measured opportunities, and check short/unaligned
inputs, all CRC vectors, startup and bundle cost before adopting this change.

### Coalesced group-index reads

The many-group case selects all 24 sparse tracks in one-track position groups,
over `chr1:166666-176666`. Adjacent group records currently require one read per
group, even though chunk payload reads already have a coalescer. A prototype
uses the same coalescing policy for group records. It copies each returned group
into its own backing buffer before parsing: otherwise an individually cached
group could retain a whole coalesced response without accounting for it.

Results of the ownership-preserving prototype are recorded separately in
[`measurements/opportunities-index-owned.json`](measurements/opportunities-index-owned.json).
The coalescing rows in the two earlier runs predate this ownership copy and are
historical comparisons, not the recommended implementation.

| Engine | Baseline ms | Coalesced ms | Filehandle reads | Index bytes | Data bytes |
|---|---:|---:|---:|---:|---:|
| Node | 705.17 | 450.85 | 48 → 25 | 57,522 → 57,522 | 17,412 → 17,412 |
| Chromium | 4031.40 | 2111.00 | 48 → 25 | 57,522 → 57,522 | 17,412 → 17,412 |

This is about 36% less query time in Node and 48% in Chromium for this network
model and layout, without extra transferred group/data bytes. All 96 required
chunks are still fetched and decoded. Absolute Node/Chromium times include their
respective HTTP scheduling behavior; neither is a prediction for remote hosting.
The benefit will be smaller when a query touches only one group, or when groups
are nonadjacent and coalescing would fetch substantial gaps. Preserve per-group
integrity checks, per-caller cancellation, cache sharing, request/read limits and
cache ownership when integrating. This is a reader I/O change within v1.

### Priority and reproduction

Start with the name map and coalesced group-index reads. Profile dense binning
further before integrating its mixed-data regression. CRC slicing is a lower
priority; existing stored-summary and decompressor opportunities remain as
described in `FINDINGS.md` and `DECOMPRESSION.md`, without new measurements here.
No production optimization, dependency change or format change is made by these
probes. The source transformations deliberately fail when their matching source
changes, rather than silently benchmarking the unmodified implementation.

Use Node 24, the installed Chromium used by the browser suite, and the existing
dataset-generation instructions above. Generate dense8, mixed24, collection96,
and the sparse position-order tile4096/group1 matrix entry. Then run:

```sh
node --import tsx benchmarks/scripts/opportunities.mjs 7
node --import tsx benchmarks/scripts/opportunities.mjs 7 manygroup \
  benchmarks/measurements/opportunities-index-owned.json
```

The optional third argument filters case-name prefixes, separated by commas;
the fourth chooses the output JSON. For example, `7 named` measures only named
selections. The script builds temporary browser-compatible bundles, tests them
in Node and Chromium against actual HTTP ranges, writes samples/diagnostics,
prints medians, and removes its temporary bundles. No runtime sources are edited.

### Implemented name lookup cache

The production reader now lazily builds a name-to-track map on its first named
selection. It preserves numeric/filter selection behavior and releases the map
at close. `test/track-selection.test.ts` exercises identity, mixed identifiers,
ordering, duplicate and unknown-name errors, object-prototype-like names, cache
clears and close in both storage orders; the independent oracle remains unchanged.

The benchmark script now reads baseline runtime sources from pinned Git revision
`eaf7556`, so experiments remain reproducible after runtime changes. Pass
`production` as the fifth argument to compare the working tree with that baseline;
production reports include the runtime diff for provenance. The name-cache run
is retained in [`measurements/name-map-production.json`](measurements/name-map-production.json),
using the same method and seven samples described above:

| Named warm query | Node baseline → implementation ms | Chromium baseline → implementation ms |
|---|---:|---:|
| 600 tracks / 64 bp | 8.489 → 0.085 | 7.315 → 0.060 |
| 96 tracks / 10 kb | 0.816 → 0.660 | 0.290 → 0.225 |
| Four tracks / 10 kb | 0.040 → 0.035 | 0.020 → 0.020 |

```sh
node --import tsx benchmarks/scripts/opportunities.mjs 7 named \
  benchmarks/measurements/name-map-production.json production
```

These are warm-query measurements; they exclude map construction and do not
claim a measurable benefit for every selection size.

### Implemented group-index coalescing

The production reader now uses the existing range coalescer for group-index
reads as well as chunk reads. Both paths share the reader's request queue and
configured coalescing/read limits. Every cached group receives an independent
copy of its record before parsing, preserving cache accounting after eviction.

The new regressions cover both orders, actual HTTP and Chromium range counts,
per-group CRCs and retries, buffer ownership with a cache holding only one group,
read/coalescing limits, cancellation of one/all callers, and close with queued
reads. The independent binary fixtures/oracle are unchanged.

Seven-sample production comparisons with the same 24-group workload and network
model are in
[`measurements/index-coalescing-production.json`](measurements/index-coalescing-production.json).
They include the runtime diff from the pinned baseline:

| Engine | Baseline ms | Implementation ms | Reads | Index bytes | Data bytes |
|---|---:|---:|---:|---:|---:|
| Node | 707.15 | 449.63 | 48 → 25 | 57,522 → 57,522 | 17,412 → 17,412 |
| Chromium | 4044.50 | 2122.00 | 48 → 25 | 57,522 → 57,522 | 17,412 → 17,412 |

All outputs match the baseline element by element; both fetch/decode 96 chunks.
The measured time reductions are about 36% and 48%, respectively, for this
specific network/layout workload. This does not establish the same benefit for
single-group queries or other hosting conditions.

```sh
node --import tsx benchmarks/scripts/opportunities.mjs 7 manygroup \
  benchmarks/measurements/index-coalescing-production.json production
```

## Sampling profiler results — 2026-10-28

The earlier opportunities came from source inspection followed by controlled
baseline/prototype and production benchmarks. They were not discovered with a
sampling profiler. This follow-up uses actual V8 CPU sampling through Node's
Inspector and Chromium's DevTools Protocol, plus browser request timelines.

### Capture method

- Baseline: `eaf75569b5bfcc0a6673e3af211042c5ac9f071f`; current reader:
  `187709e90622f516bd36dc06ffc059c0a4cf5fe8`.
- Node 24.22.1 and Chromium 156.0.8078.4 on Apple M5, darwin/arm64.
- Thirty CPU profiles: fourteen in Node and sixteen in Chromium. Each CPU-bound
  phase runs for at least two seconds, after three untimed warm-up queries and
  an explicit GC. Each delayed-network capture runs one cold query after
  loading metadata. Node's profile also includes the localhost server running
  in its process; Chromium's profile samples the renderer main thread only.
- Requested sampling interval: 1,000 microseconds. Actual sample intervals vary;
  summaries weight samples by `timeDeltas` and resolve bundle frames through
  source maps. CPU phases generally contain about 1,600 samples. Inclusive time
  includes callees and cannot be added across nested rows; self time excludes
  callees. Percentages below exclude explicit `(idle)` samples unless stated.
- Warm workloads retain decoded caches and issue zero reads. Cold workloads
  clear parsed caches before each query. Baseline/current outputs are checked
  element by element with `Object.is` outside capture. Startup, source loading,
  warm-up, comparison and report generation are outside the capture windows.
- Profiled wall times include instrumentation overhead and are not replacements
  for the separate unprofiled benchmark medians. The short network captures have
  few active samples, so their function-level CPU rankings are not reliable.

The source-mapped summaries and provenance are retained in
[`measurements/profiles-cpu.json`](measurements/profiles-cpu.json). Raw
`.cpuprofile` files, browser request timelines, bundle sources and source maps
are generated under `benchmarks/results/profiles/` (ignored by Git; about 5.6 MiB
for this run). Raw CPU files use V8's `.cpuprofile` JSON format, with bundle
source maps alongside them. No runtime sources changed during this investigation.

### What the profiles show

| Chromium workload | Observed CPU attribution | Implication |
|---|---|---|
| Baseline 600-name warm query | `select()` 93.7% inclusive | Confirms repeated selection scans dominated this sparse, short-window case. |
| Current 600-name warm query | `select()` 19.7%; `visitDecoded()` 33.3%; output-building callback 24.8% inclusive | The remaining work is distributed among planning, selection bookkeeping and output creation. These are shares of a much faster query, not comparable absolute costs. |
| Current eight-track dense warm bins | `aggregate()` 97.9% inclusive; `add()` 62.8% self | Per-base bin aggregation is the next CPU target for this workload. |
| Current 24-track mixed warm bins | `aggregate()` / `add()` 96.7% inclusive | Aggregation is also the hotspot here, but the earlier dense-loop prototype regressed on this case. Profiling alone does not establish a safe general speedup. |
| Current cold dense values | `inflateZlib()` 76.7% inclusive; `inflater.onData` 28.1%; CRC32 10.1% | Inflation and checksum processing dominate more than numeric decoding. The callback is inside the inflater, so its share is already included in 76.7%. |
| Current cold sparse 96-track values | `inflateZlib()` 42.7% inclusive; output-array callback about 10.2% self | Costs are more distributed; applying dense-data conclusions unchanged would be misleading. |
| Current cold track-order values | `inflateZlib()` 58.3% inclusive; callback 30.2% | The strict inflation/checksum path is also material for track-order data. |

Node corroborates these shapes: baseline selection is 91.1% inclusive, current
warm mixed aggregation is 93.8%, and current cold dense inflation is 69.5%, with
its callback about 25.1%. Optimized/inlined frames can attribute cost to a caller
rather than a helper, so exact percentages and anonymous-frame names differ
between runtimes.

The callback attribution is actionable beyond a broad “decompression is slow”
observation. Its line-level ticks concentrate in the Adler32 accumulation loop
at `src/utils/inflate.ts:43-45`, rather than the output-buffer copy. Investigate
that loop or a strict backend with native checksum validation, preserving all
existing RFC1950 checks and allocation bounds. No speedup is claimed for an
unimplemented checksum change. Likewise, investigate aggregation across dense,
sparse/run and NaN-heavy cases before adopting the prior dense-loop prototype.
The already-fast warm named path is a lower priority despite its visible shares
of planning/output work.

### Browser cache scheduling changes the network result

The delayed many-group captures are predominantly waiting: Chromium reports
98.5% idle samples for the baseline and 98.1% for the current reader in its
default cache configuration. The request timelines show several range requests
created together, but sent sequentially: the first six baseline requests have
`sendStart` delays of roughly 0, 84, 167, 252, 337 and 420 ms. None of these
responses is a disk-cache hit, and the test server sends `Cache-Control: no-store`.

Disabling Chromium's cache through DevTools removes most of that pre-send
queueing in this setup: the first six sends occur within roughly 0.6 ms of each
request's timing origin. This points to cache-related browser request
serialization; the exact internal Chromium cache mechanism was not traced.
The earlier 4.04 s → 2.12 s result therefore includes this browser scheduling
behavior, rather than just the configured response latency and bandwidth.

A separate **unprofiled seven-sample** comparison confirms the difference with
cache disabled; raw samples are in
[`measurements/index-coalescing-cache-disabled.json`](measurements/index-coalescing-cache-disabled.json):

| Runtime / cache policy | Baseline median ms | Current median ms | Reads |
|---|---:|---:|---:|
| Node, same follow-up run | 702.47 | 445.59 | 48 → 25 |
| Chromium, cache disabled | 698.50 | 446.60 | 48 → 25 |

Index bytes remain 57,522, data bytes 17,412, and both decode 96 chunks. Coalescing
still reduces this workload's elapsed time by about 36% with concurrent sends.
These measurements qualify the previous browser timing, rather than establishing
a universal cache policy or recommending that consumers disable browser caching.
HTTP protocols, response headers, proxy/CDN caches and browser versions can
produce different scheduling.

### Reproduce

Use the existing benchmark-generation instructions for dense8, mixed24,
collection96 and sparse24/tile4096/group1, plus the pinned conformance fixtures.
With Node 24 and the installed Chromium:

```sh
node --import tsx benchmarks/scripts/profile.mjs 2000
node --import tsx benchmarks/scripts/opportunities.mjs 7 manygroup \
  benchmarks/measurements/index-coalescing-cache-disabled.json production cache-disabled
```

The profiler writes CPU profiles and request timelines under the ignored results
folder, plus the tracked-size summary JSON. The final optional argument to the
opportunity runner disables Chromium's cache only; it is a measurement control,
not a reader option or production behavior change.

## Adler32 accumulation optimization — 2026-10-28

The production inflater now combines eight sequential Adler32 updates using
`b += 8*a + 8*x0 + 7*x1 + ... + x7`, then adds the eight bytes to `a`.
It retains the 5,552-byte reduction window and scalar tails. All arithmetic
remains exact integer arithmetic in JavaScript numbers; no signed bitwise
operations are introduced in accumulation. Zlib framing, output/allocation
bounds, final-block, trailing-input and checksum validation remain unchanged.
Regression tests compare native zlib checksums for short tails, reduction/output
chunk boundaries and all-255 data, including sums beyond signed int32.

The controlled baseline is `187709e90622f516bd36dc06ffc059c0a4cf5fe8`, including the
name-cache and index-coalescing changes. Eleven unprofiled samples per variant
alternate execution order after three warm-up queries. Cold queries clear parsed
caches but retain metadata, over localhost HTTP with no simulated latency and
unlimited bandwidth. Chromium's cache is disabled. Each query's values match the
baseline element by element with `Object.is`; reads and decoded chunks are
unchanged. Raw samples and the runtime diff are in
[`measurements/adler-production.json`](measurements/adler-production.json).

| Cold values query | Node baseline → optimized ms | Chromium baseline → optimized ms |
|---|---:|---:|
| Eight dense tracks / 200 kb | 105.58 → 85.31 | 107.70 → 84.80 |
| 24 mixed tracks / 200 kb | 179.77 → 137.01 | 175.20 → 130.40 |
| 96 sparse tracks / 200 kb | 45.19 → 41.89 | 37.60 → 34.10 |
| Track-order fixture / 200 kb | 10.29 → 8.13 | 11.60 → 8.90 |
| Three selected toy tracks / 300 bp | 0.506 → 0.501 | 0.900 → 0.900 |

This is a workload-specific complete-query improvement of about 9–26% in the
four larger Chromium cases; the small case has no resolved Chromium difference.
It is not a network-latency speedup or a claim for all compressed files.

Eight follow-up CPU profiles are summarized in
[`measurements/adler-cpu.json`](measurements/adler-cpu.json), with raw captures in
ignored `benchmarks/results/adler-profiles/`. In cold dense reads, the inflater
callback drops from 24.8% to 3.4% of sampled active time in Node and 27.3% to 4.5%
in Chromium. These are profiled attribution shares, not the benchmark timings.

With Node 24 and the existing generated datasets:

```sh
FIGWIG_BENCH_BASELINE=187709e90622f516bd36dc06ffc059c0a4cf5fe8 \
  node --import tsx benchmarks/scripts/opportunities.mjs 11 \
  dense-cold,mixed-cold,sparse-cold,track-cold,toy-cold \
  benchmarks/measurements/adler-production.json production cache-disabled
FIGWIG_PROFILE_BASELINE=187709e90622f516bd36dc06ffc059c0a4cf5fe8 \
FIGWIG_PROFILE_CASES=dense-cold,track-cold \
FIGWIG_PROFILE_OUTPUT=benchmarks/results/adler-profiles \
FIGWIG_PROFILE_SUMMARY=benchmarks/measurements/adler-cpu.json \
  node --import tsx benchmarks/scripts/profile.mjs 2000
```

## Bin aggregation optimization — 2026-10-28

The production reader now calculates dense bin boundaries once per bin/chunk
intersection and accumulates into a local copy of the existing output value.
Each addition stays in the original visitation order, including across chunks;
separately summing each chunk would change binary64 cancellation and rounding.
One-base dense bins have a direct loop. Sparse point chunks use a clipped point
loop without the general interval helper. Runs retain their existing interval
arithmetic, and implicit zero gaps remain unexpanded. NaN policies and omit-mean
denominators are unchanged. New tests compare exact sums and NaN counts across
dense/sparse chunks, partial bins, one-base bins, extreme values, all missing
policies and reversed chunk visitation against a scalar reference.

The initial dense-only implementation regressed on one-base bins; its samples
are retained in
[`measurements/binning-dense-only.json`](measurements/binning-dense-only.json).
The mixed workload uses sparse chunks throughout this query, explaining why
changing only dense aggregation did not resolve its hotspot. An intermediate
version grouped sparse entries by bin, but showed a small Chromium track-order
regression. The final direct point loop avoids that tradeoff and is simpler.

The independent baseline is `76018bb0638eb831600a94967c492a49a2a03998`, which
already includes the Adler32 optimization. Eleven unprofiled samples per variant
alternate execution order after three untimed warm-up queries. Each timed sample
contains 10 queries, 50 for the small toy/track-order cases, or three for one-base
bins; times below are per-query medians. These warm queries retain decoded caches
and issue zero reads. Chromium's network cache is disabled. Every output value
matches the baseline with `Object.is`, checked outside timing. Raw samples,
diagnostics and the runtime diff are in
[`measurements/binning-production.json`](measurements/binning-production.json).
Environment: Node 24.22.1 and Chromium 156.0.8078.4 on Apple M5, darwin/arm64.

| Warm binned query | Node baseline → optimized ms | Chromium baseline → optimized ms |
|---|---:|---:|
| Eight dense tracks / 200 kb, bins 1,000 bp | 5.710 → 5.020 | 5.540 → 1.080 |
| 24 mixed tracks / 200 kb, bins 997 bp | 16.196 → 8.190 | 8.280 → 7.560 |
| 96 sparse tracks / 200 kb, bins 1,000 bp | 3.652 → 2.256 | 1.980 → 1.690 |
| Track-order fixture / 200 kb, bins 1,000 bp | 0.588 → 0.442 | 0.476 → 0.446 |
| Toy fixture / 300 bp, bins 17 bp | 0.522 → 0.512 | 0.648 → 0.630 |
| Eight masked tracks / 200 kb, omit | 7.312 → 3.401 | 5.680 → 2.600 |
| Same masked tracks, zero | 5.774 → 2.859 | 5.280 → 2.300 |
| Same masked tracks, propagate | 5.723 → 5.082 | 5.580 → 4.140 |
| Eight dense tracks / 200 kb, bins 1 bp | 18.050 → 17.859 | 17.400 → 13.867 |
| Track-order fixture / 200 kb, bins 1 bp | 9.379 → 9.086 | 9.200 → 8.767 |

All use mean aggregation and omit missing values unless another policy is
specified. Masked queries use bins of 1,000 bp. Gains depend strongly on the
workload and runtime: Chromium's dense case improves about 80%, mixed about 9%,
sparse about 15%, and masked omit about 54%. Small toy and one-base Node
differences are too small to establish a useful general benefit. The measured
cases have no observed median slowdown with the final implementation; this does
not guarantee all input distributions or browser versions improve.

The masked profile uses the pinned writer with deterministic float32 signals
and NaN stretches covering roughly 94% of positions. Its ignored binary is
4,041,052 bytes; its sidecar records all generation parameters. Generate it with
the same Python environment and pinned upstream checkout used above:

```sh
.venv/bin/python benchmarks/scripts/generate.py \
  --upstream /tmp/figwig-reference --profile masked --tracks 8 \
  --length 2000000 --second-length 500000 --tile 4096 --group 4
FIGWIG_BENCH_BASELINE=76018bb0638eb831600a94967c492a49a2a03998 \
  node --import tsx benchmarks/scripts/opportunities.mjs 11 \
  dense-warm,mixed-warm,sparse-warm,track-warm,toy-warm,masked-warm \
  benchmarks/measurements/binning-production.json production cache-disabled
FIGWIG_PROFILE_BASELINE=76018bb0638eb831600a94967c492a49a2a03998 \
FIGWIG_PROFILE_CASES=dense-bins,mixed-bins \
FIGWIG_PROFILE_OUTPUT=benchmarks/results/binning-profiles \
FIGWIG_PROFILE_SUMMARY=benchmarks/measurements/binning-cpu.json \
  node --import tsx benchmarks/scripts/profile.mjs 2000
```

Eight follow-up sampling profiles are summarized in
[`measurements/binning-cpu.json`](measurements/binning-cpu.json), with raw captures
and source maps in ignored `benchmarks/results/binning-profiles/`. These use the
same two-second capture method described above. Aggregation remains the main CPU
cost after the change; a smaller complete-query time does not imply its share of
remaining CPU must fall. Use the unprofiled table for speed comparisons.

## Dense NaN gap queries — 2026-10-28

The regional ENCODE mouse recipe's `h3k27ac.fw` stores gaps as explicit dense
NaNs for all 24 tracks. Its 16,384-base tiles contain eight tracks per group.
The input is 89,771,464 bytes; its SHA-256 and exact query parameters are retained
in [`measurements/gap-dataset.json`](measurements/gap-dataset.json). The dataset
itself is local and is not copied into the repository. The tested gap is
`chr10:10000000-12000000`, with 2,000-base bins, mean aggregation, `missing: 'omit'`
and all tracks. It models GenomeSpy's below-tile-resolution path in fast mode.

### Diagnosis and fix

Before changing runtime sources, actual Node Inspector and Chromium CDP sampling
profiles reproduced the slowdown. This query visits 369 dense all-NaN chunks;
each becomes 1 MiB of decoded binary64 values. The working set exceeds the
default 64 MiB decoded cache, so sequential repeated queries have zero chunk
cache hits and inflate/decode all 369 chunks again. In the Chromium repeated
query profile, `readValues` accounts for 29.2% of active self time, the inflater
callback 25.4%, `inflate_fast` 20.3%, and aggregation 16.8%.

The decoder now checks all values of a dense float tile before compacting an
entirely NaN tile into the existing run representation. The retained numeric
buffers total `4 + 8 * tracks` bytes (68 here) and own their memory. A finite value
anywhere leaves the dense decoding path intact, preserving measured zeros and
negative zero. Nonfinite invalid values still fail validation; existing bounds,
checksums and strict zlib checks remain in place. This changes neither format
nor missing-value policy. Raw values still return native caller-owned arrays;
NaN runs contribute their exact covered width to omit-mean denominators.

The new `nan_positions` and `nan_tracks` fixtures are generated by the pinned
Python writer and checked against both its reader and the independent
specification reader. They cover full missing tiles, mixed values/zeros and
unwritten regions. Existing fixture records, signals and provenance were
unchanged by regeneration. Additional decoder tests exercise float32/float64,
late finite/invalid values, truncation and allocation limits. Public API and
Chromium tests cover partial bins, all policies and cache retention under a
1 KiB decoded-cache budget.

### Controlled timings

Baseline: `5265c56` (release 0.2.0). Node 24.22.1, Chromium 156.0.8078.4, Apple M5,
darwin/arm64. Eleven unprofiled samples alternate variants after three warm-up
queries, over localhost with no simulated latency/bandwidth limit. Chromium
network cache is disabled. Repeated queries retain reader caches; cold queries
clear parsed caches but retain the header. Each timed sample runs one query.
Every output value matches the baseline with `Object.is` outside timing.

| Runtime / cache policy | Baseline median ms | Fixed median ms | Decompressed chunks per query |
|---|---:|---:|---:|
| Node, repeated | 487.79 | 1.46 | 369 → 0 |
| Node, parsed caches cleared | 500.43 | 275.09 | 369 → 369 |
| Chromium, repeated | 422.90 | 0.50 | 369 → 0 |
| Chromium, parsed caches cleared | 448.10 | 268.10 | 369 → 369 |

Cold queries transfer identical bytes: 264,858 index bytes and 197,415 data
bytes in six reads. Repeated baseline queries transfer the 197,415 data bytes
again in five reads; the fixed reader issues zero reads and has 369 chunk cache
hits. Total accounted retained cache weight, including group indexes, drops
from 77,457,306 to 11,755,038 bytes. This is not a peak-process-memory measurement.
Raw samples and the runtime diff are in
[`measurements/gap-production.json`](measurements/gap-production.json).

The large repeated-query benefit comes from eliminating cache churn as well as
per-base aggregation. Cold reads improve about 40% in Chromium but still have
to verify and inflate the dense stored data. These are measurements of this
NaN-heavy gap, not a claim for absent records or all genomic regions.

Eleven-sample controls are in
[`measurements/gap-controls.json`](measurements/gap-controls.json). Ordinary
dense/mixed/sparse reads show small changes in both directions (roughly 0–2%
for the larger cold cases). The dense Chromium cold median is 80.0 → 81.4 ms;
no broad non-missing-data speedup is claimed. Warm dense/mixed bins stay close,
while the existing masked omit/zero/propagate cases improve from 2.55/2.44/4.50
to 0.64/0.58/0.36 ms in Chromium because many of their chunks also compact.

### Sampling follow-up and reproduction

The before-change profiles are summarized in
[`measurements/gap-cpu-before.json`](measurements/gap-cpu-before.json) and the
baseline/fixed comparison in
[`measurements/gap-cpu-after.json`](measurements/gap-cpu-after.json). Raw captures,
network timelines, bundle sources and maps are ignored under
`benchmarks/results/gap-profiles-before/` and `gap-profiles-after/`. Each phase
samples at a requested 1 ms interval for at least two seconds after warm-up.
Profiled wall times include instrumentation; use the separate table for timings.
The fixed repeated-query profiles perform no inflation or numeric decoding.
The fixed Chromium cold profile is instead dominated by the inflater callback
(41.3%) and `inflate_fast` (36.5%); these are shares of less total work.

Set `FIGWIG_GAP_FILE` to the local recipe's `output/figwig/h3k27ac.fw`, then run:

```sh
export FIGWIG_GAP_FILE=/absolute/path/to/output/figwig/h3k27ac.fw
FIGWIG_BENCH_BASELINE=5265c56 \
  node --import tsx benchmarks/scripts/opportunities.mjs 11 gap \
  benchmarks/measurements/gap-production.json production cache-disabled
FIGWIG_PROFILE_BASELINE=5265c56 FIGWIG_PROFILE_CASES=gap-bins \
FIGWIG_PROFILE_OUTPUT=benchmarks/results/gap-profiles-after \
FIGWIG_PROFILE_SUMMARY=benchmarks/measurements/gap-cpu-after.json \
  node --import tsx benchmarks/scripts/profile.mjs 2000
FIGWIG_BENCH_BASELINE=5265c56 \
  node --import tsx benchmarks/scripts/opportunities.mjs 11 \
  dense-cold,mixed-cold,sparse-cold,track-cold,toy-cold,dense-warm,mixed-warm,masked-warm \
  benchmarks/measurements/gap-controls.json production cache-disabled
```

The helper serves the existing file over localhost without modifying it or
uploading it. Stored summaries cannot establish that a zero-sum tile has no
observed values, so this fix does not use summaries or statistics to skip reads.
A future writer improvement could encode uniform NaN spans as short runs to
reduce initial inflation work, but is outside this reader change.
