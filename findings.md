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

- The workspace initially contained only `prompt.md`, with no Git repository.
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
