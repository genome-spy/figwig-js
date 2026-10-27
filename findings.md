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
