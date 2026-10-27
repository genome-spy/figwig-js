# Implement `@genome-spy/figwig`: standalone JavaScript/TypeScript Figwig reader

## Objective

Implement a production-quality, read-only JavaScript/TypeScript library for the **Figwig v1 binary format**, published eventually as `@genome-spy/figwig`.

The package should follow the architectural conventions of GMOD's JavaScript genomics libraries, particularly `@gmod/bbi`, `@gmod/tabix`, `@gmod/indexedfasta`, and `generic-filehandle2`.

The library must:

- Work in modern browsers and Node.js.
- Support local files, browser `Blob` objects, and remote HTTP files through `generic-filehandle2`.
- Read Figwig files efficiently using random-access byte reads, including HTTP Range requests.
- Support both position-ordered and track-ordered Figwig files.
- Decode every encoding supported by the frozen Figwig v1 specification.
- Support selecting arbitrary subsets of tracks.
- Read genomic regions across multiple tracks efficiently.
- Expose both typed-array-oriented and interval-oriented query APIs.
- Read tile summaries and optional zoom levels.
- Handle concurrent queries, cancellation, and caching appropriately.
- Include comprehensive correctness, robustness, and performance tests.
- Include reproducible benchmarks over a locally simulated HTTP connection with configurable latency and bandwidth.

**Implement the package, its tests, its benchmark infrastructure, and its documentation. Do not stop after planning or creating scaffolding.**

This is the first phase of a larger project. The package must remain independent of GenomeSpy's visualization engine and applications.

## 1. Repositories and reference material

Study these repositories before implementing the reader.

### Figwig: authoritative specification and reference implementation

- Repository: https://github.com/jmschrei/figwig
- Binary format: https://github.com/jmschrei/figwig/blob/main/docs/format.rst
- Usage documentation: https://github.com/jmschrei/figwig/blob/main/docs/figwig.rst
- Kaitai Struct definition: https://github.com/jmschrei/figwig/blob/main/docs/figwig.ksy
- Independent Python reference reader: https://github.com/jmschrei/figwig/blob/main/tests/format_reference.py
- Synthetic fixture generator: https://github.com/jmschrei/figwig/blob/main/tests/format_fixtures.py
- Conformance tests: https://github.com/jmschrei/figwig/blob/main/tests/test_format.py
- Main Python implementation: https://github.com/jmschrei/figwig/blob/main/figwig/figwig.py

The Figwig file format has a frozen version 1 specification. Treat that specification as authoritative. Use the Python implementation and independent reference reader to resolve ambiguities, but do not assume that every implementation detail is a format requirement.

Review the exact specification, particularly the binary layout, index structure, chunk encodings, compression, summary semantics, integrity checks, and limits.

Pin the Python Figwig version or source commit used for generating fixtures and expected results. Record it in the test documentation so the results are reproducible.

### GMOD JavaScript packages

- https://github.com/GMOD/generic-filehandle2
- https://github.com/GMOD/bbi-js
- https://github.com/GMOD/indexedfasta-js
- https://github.com/GMOD/tabix-js
- https://github.com/GMOD/shared-read-cache
- https://github.com/GMOD/range-cache-filehandle

Examine their public APIs, package structure, TypeScript conventions, browser compatibility, caching strategies, batching, cancellation handling, and tests.

Pay particular attention to:

- The `GenericFilehandle` interface.
- `BigWig.getHeader()`, `getFeatures()`, and `getFeaturesMulti()`.
- Typed-array feature APIs in `@gmod/bbi`.
- Read coalescing and concurrent requests.
- `SharedReadCache` and its abort semantics.
- Byte-range caching through `@gmod/range-cache-filehandle`.
- HTTP simulation and network benchmarking in GMOD's BBI repository.

Use these packages for architectural guidance, not as code that must be copied.

## 2. Repository structure and independence

Create a new, standalone GitHub repository:

**Repository:** `genome-spy/figwig-js`  
**npm package:** `@genome-spy/figwig`  
**License:** MIT

Do not implement the package inside the GenomeSpy monorepo. Do not modify the GenomeSpy repository.

If GitHub authentication and permissions are available, create the repository under the `genome-spy` organization. Otherwise, initialize a standalone local Git repository and document the steps needed to create and connect the GitHub remote.

Use a conventional TypeScript npm package structure:

```text
figwig-js/
├── .github/
│   └── workflows/
├── src/
│   ├── index.ts
│   ├── figwig.ts
│   ├── format/
│   ├── readers/
│   ├── decoding/
│   └── utils/
├── test/
│   ├── fixtures/
│   ├── conformance/
│   ├── integration/
│   └── browser/
├── benchmarks/
│   ├── fixtures/
│   ├── server/
│   ├── scripts/
│   └── RESULTS.md
├── scripts/
├── README.md
├── LICENSE
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

This is a suggested structure; adjust it to avoid unnecessary fragmentation.

### Requirements

- The repository must be fully self-contained.
- Use TypeScript and ESM-first packaging.
- Support modern browsers and Node.js.
- Use `generic-filehandle2` for storage-independent random access.
- Provide generated TypeScript declarations.
- Use Vitest for unit and integration tests.
- Use Playwright for actual browser tests.
- Use GitHub Actions for continuous integration.
- Provide npm scripts for building, linting, testing, type checking, and benchmarking.
- Include deterministic synthetic test fixtures derived from the upstream Python Figwig implementation.
- Include scripts for regenerating fixtures and expected results using a pinned upstream version.
- Keep large benchmark datasets out of Git, generating them on demand.
- Ensure tests and benchmarks can run without GenomeSpy.
- Ensure the published package contains only necessary runtime files and declarations.

### Dependencies and publishing

The package must not depend on any GenomeSpy package.

Keep runtime dependencies minimal. Prefer established, portable libraries over custom implementations where appropriate.

Configure `package.json` for eventual publication to npm as `@genome-spy/figwig`, with public package access.

The package must build and pass its tests independently of the GenomeSpy monorepo.

Set up GitHub Actions to run unit tests, conformance tests, type checking, linting, and browser smoke tests.

Keep expensive performance benchmarks separate from routine CI, preferably runnable manually through a GitHub Actions workflow.

Do not publish to npm automatically during the initial implementation.

### Repository initialization

1. Create the standalone project.
2. Initialize Git and add an appropriate `.gitignore`.
3. Configure the package and development tooling.
4. Implement the library, tests, fixtures, benchmarks, and documentation specified in the remaining sections.
5. Run all required verification steps.
6. Commit the completed implementation.
7. Create or connect the GitHub repository if permissions allow.
8. Report the repository URL, commit, test results, and benchmark results.

Do not introduce a dependency on the GenomeSpy monorepo merely to share its build configuration, test infrastructure, or utilities.

## 3. Public API

Design a compact, well-typed API inspired by `@gmod/bbi`, but adapted to Figwig's multitrack structure.

The exact names and return types may be refined after studying the format, but the following capabilities are required.

### Construction

Support a supplied `GenericFilehandle`:

```ts
import { FigWig } from "@genome-spy/figwig";
import { RemoteFile } from "generic-filehandle2";

const fw = new FigWig({
  filehandle: new RemoteFile("https://example.org/signals.fw"),
});
```

Optionally support convenience constructors using `{ url }` or `{ path }`, following GMOD conventions.

The parser should not care whether the filehandle accesses HTTP, the local filesystem, or a browser Blob.

### Metadata

Provide methods corresponding to:

```ts
const header = await fw.getHeader();

const tracks = await fw.getTracks();

const selected = await fw.selectTracks({
  assay: "ATAC-seq",
  biosample: "K562",
});
```

Expose:

- Format version and storage order.
- Reference genome identifier.
- Chromosome names and lengths.
- Tile size.
- Track names, dtypes, group identifiers, and metadata.
- Global statistics.
- Available zoom levels and their genomic bin sizes.

Metadata must be cached after loading.

Track selection should support names, integer indices, and matching metadata attributes. Preserve the original order unless the caller explicitly requests another order.

### Reading genomic values

Expose a per-region numeric API, for example:

```ts
const result = await fw.getValues(
  "chr1",
  1_000_000,
  1_010_000,
  {
    tracks: ["atac", "dnase"],
    signal,
  }
);
```

Also provide a batched version accepting several genomic regions.

Requirements:

- Zero-based, half-open genomic coordinates.
- Arbitrary track subsets.
- Stable output ordering.
- Typed arrays instead of arrays of JavaScript objects for numeric values.
- Avoid unnecessary copies.
- Preserve NaNs and distinguish them from zeros.
- Preserve numeric precision correctly, including large integers and float64 values.

Consider using a collection of per-track typed arrays to preserve heterogeneous native dtypes, or an explicitly documented common output dtype.

Do not silently coerce values in ways that lose precision. For example, `uint32` values greater than 2^24 cannot necessarily be represented exactly as `float32`.

Set reasonable allocation limits so accidental requests cannot exhaust memory.

### Binned genomic values

Implement efficient binned reads, for example:

```ts
const bins = await fw.getBins(
  "chr1",
  1_000_000,
  2_000_000,
  {
    tracks: ["atac", "dnase"],
    binSize: 1000,
    aggregation: "mean",
    signal,
  }
);
```

Support at least sums and means, with explicit semantics for missing data.

Use Figwig's existing tile summaries and zoom levels when they are suitable for the requested operation.

**Do not treat Figwig zoom summaries as equivalent to BigWig zoom records.** Figwig stores sums but not the full collection of BigWig summary statistics, particularly covered-base counts.

Do not use precomputed sums to produce missing-aware means unless the necessary denominator is known. Fall back to full-resolution data where required for correctness.

Missing values, NaNs, partial bins, chromosome boundaries, and bin alignment must be documented and tested.

### Interval-oriented API

Provide a lightweight convenience API resembling GMOD's BigWig reader:

```ts
const features = await fw.getFeatures(
  "chr1",
  1_000_000,
  2_000_000,
  {
    tracks: ["atac", "dnase"],
    basesPerSpan: 1000,
    signal,
  }
);
```

Suggested records:

```ts
{
  track: "atac",
  start: 1000000,
  end: 1001000,
  score: 1.25,
}
```

Also implement `getFeaturesMulti()` so several genomic regions can be queried in a single logical operation.

The interval API should be built on the same underlying query machinery as the typed-array API, not a separate decoder.

Preserve track identity in results.

Avoid creating huge numbers of interval objects unnecessarily. Prefer typed-array results internally and construct objects only when explicitly requested.

Keep the public API manageable. Additional methods are welcome where they clearly reflect Figwig capabilities, but avoid introducing unnecessary abstractions.

## 4. Figwig binary decoding

Implement a standards-compliant Figwig v1 reader.

### Header and metadata

Implement parsing and validation for:

- The 128-byte header.
- Magic bytes and format version.
- Required and optional feature bits.
- File offsets and lengths.
- Chromosome table.
- Track statistics table.
- JSON metadata.
- Index directory.

Use explicit little-endian reads.

The format contains unsigned 64-bit offsets. JavaScript cannot precisely represent all possible uint64 values as `number`.

Use `BigInt` where necessary while parsing and validating offsets. Since `generic-filehandle2` accepts numeric byte positions, reject offsets beyond `Number.MAX_SAFE_INTEGER` with a clear error instead of silently rounding them.

### Position-ordered files

Implement the complete position-order index:

- Runs.
- Live-tile records.
- Compressed live-tile index.
- Chunk offsets derived from runs and chunk sizes.
- Implicit all-zero tiles.
- Group-level indexing.
- Tile summaries.
- Optional zoom levels.

Indexes should be loaded lazily for selected track groups and cached for future queries.

An important detail: the live-tile index is stored as compressed arrays covering an entire group. A single genomic query generally requires loading that group's index, but it must not require reading the entire data region.

### Track-ordered files

Implement track-order indexes and blocks:

- Chromosome identifiers.
- First and last positions.
- Entry counts.
- File offsets and compressed lengths.
- Block encodings.

Use efficient lookup of blocks overlapping requested genomic regions.

Do not assume that position-ordered and track-ordered files can share an identical index lookup strategy.

### Chunk representations

Support every Figwig v1 chunk representation:

1. Dense.
2. Sparse.
3. Runs.
4. Matrix.

Also support track-order blocks.

Support all specified element types:

- uint8, uint16, uint32.
- int8, int16, int32.
- float32, float64.
- The special implicit-one representation.

Implement the variable-length integer encoding used by sparse and run representations.

Respect track groups, element layout, padding, alignment, and per-chunk type selection.

Handle NaNs correctly.

A chunk's stored numeric type may differ from the declared type of an individual track. The reader must follow the actual chunk encoding.

### Compression

Figwig uses zlib-wrapped DEFLATE streams, not an arbitrary proprietary compression format.

Choose a browser-compatible implementation.

Evaluate a lightweight JavaScript solution such as `fflate`, potentially with native `DecompressionStream` as an alternative.

Prioritize correctness and portability for the initial implementation. Do not introduce a mandatory WebAssembly dependency without measured justification.

Compressed chunks should be decompressed independently.

Support chunks that are stored uncompressed because compression would not reduce their size.

### Validation and corruption detection

Follow the specification's required integrity checks:

- Header checksum.
- Metadata/table checksum.
- Group-index checksums.
- Summary and zoom checksums.
- Compressed payload validation.
- Required checks of stored chunks.

Validate offsets, sizes, element counts, ordering, and array bounds before allocating or reading memory.

Reject truncated or malformed files with useful errors.

Do not silently ignore unsupported required features or unsupported file versions.

Where the specification allows optional full chunk CRC verification, provide an appropriate configurable verification mode.

## 5. Efficient random access

Design the reader for HTTP Range access from the beginning.

A region query must not download the entire Figwig file.

The normal sequence should be approximately:

1. Read the fixed header.
2. Read the metadata tables and index directory.
3. Load indexes only for the selected track groups.
4. Identify relevant chunks.
5. Fetch the required byte ranges.
6. Decompress and decode the selected data.

Avoid unnecessary serial network round trips.

### Batch queries

`getFeaturesMulti()` and batched numeric reads must share a query plan.

For requests involving overlapping regions or several tracks within the same group:

- Identify duplicate chunks.
- Fetch each required chunk once.
- Coalesce adjacent or sufficiently nearby file ranges.
- Limit concurrent requests to a configurable, sensible number.
- Decode shared chunks only once when practical.
- Return results in the input region and track order.

Make coalescing configurable or internally tunable so its behavior can be benchmarked.

### Caching

Implement two conceptually separate caching layers.

**Raw byte-range caching:** Prefer existing `@gmod/range-cache-filehandle` functionality rather than duplicating it in the Figwig package.

**Parsed-data caching:** Cache headers, metadata, group indexes, and optionally decoded chunks.

Parsed-data caches must have bounded memory usage.

Study `@gmod/shared-read-cache` before implementing request sharing and abort handling.

If two active queries require the same group index or chunk, cancellation of one query must not invalidate the work still needed by the other.

Do not cache failed promises indefinitely.

Consider that Figwig files may be appended to in place. Document the assumption that cached remote files are immutable and recommend versioned URLs. Do not attempt to solve remote cache invalidation by repeatedly redownloading file headers.

### Efficient output

Avoid expanding sparse chunks into large dense intermediate arrays when the caller only needs sparse entries or aggregated values.

Do not optimize prematurely at the expense of correctness, but structure the decoder so such optimizations are possible.

Keep the public API independent of the cache implementation.

## 6. Synthetic Figwig test data

Use Figwig's **existing synthetic fixture generator** as the foundation of the conformance tests:

https://github.com/jmschrei/figwig/blob/main/tests/format_fixtures.py

It generates these files:

| File | Purpose |
|---|---|
| `zlib.fw` | Compressed, position-ordered data |
| `stored.fw` | Uncompressed chunks |
| `tracks.fw` | Uncompressed, track-ordered data |
| `tracks_zlib.fw` | Compressed, track-ordered data |
| `appended.fw` | File with appended tracks and unused historical structures |
| `merged.fw` | Merged file |
| `blocks.fw` | Track-order data with multiple blocks |

These fixtures exercise different chunk encodings, numeric types, groups, NaNs, chromosome boundaries, summaries, and zoom levels.

Provide a reproducible script for generating them with a pinned Python Figwig version or commit.

Keep small deterministic fixture files available to the normal JavaScript test suite so that running ordinary tests does not require Python, network access, or a running Figwig writer.

If necessary, copy or adapt the Python fixture generator into the test tooling, preserving its attribution and license notices.

### Independent correctness oracle

Use the Python `FigWigReader` and the independent reference reader in `tests/format_reference.py` as correctness oracles.

Generate expected results independently of the JavaScript reader.

For example, create deterministic requests containing:

- Several chromosomes.
- Several windows per chromosome.
- Windows crossing tile boundaries.
- Windows extending to chromosome boundaries.
- Selected tracks from different groups.
- Different combinations and orders of tracks.
- Sparse and dense signals.
- NaNs and implicit zeros.
- Numeric extremes.
- Multiple zoom levels.

Store the expected results in a machine-readable form.

Where JSON cannot faithfully represent values such as NaN or exact numeric types, use an explicit representation, such as a separate validity mask, dtype information, or binary arrays.

For exact floating-point values, compare precisely when the format guarantees exact representation. Use documented numeric tolerances only when arithmetic or aggregation genuinely requires them.

Do not generate expected values using the JavaScript implementation under test.

### Randomized property tests

In addition to the fixed fixtures, generate deterministic random queries.

Compare the JavaScript results against Python across:

- Random start and end positions.
- Random combinations of tracks.
- Different window sizes.
- Overlapping windows.
- Repeated queries.
- Reordered regions.
- Different storage orders.
- Different encodings.

Use a fixed random seed.

Include tests where the result consists entirely of zeros and tests where the selected track has no values in a requested tile.

### Robustness tests

Test at least:

- Bad magic bytes.
- Unsupported format version.
- Unsupported required feature bits.
- Invalid header checksum.
- Truncated metadata and indexes.
- Invalid chunk offsets and sizes.
- Corrupt compressed payloads.
- Incorrect CRCs.
- Invalid track names and identifiers.
- Unknown chromosomes.
- Empty intervals.
- Out-of-range coordinates.
- Unsafe uint64 offsets.
- Excessive requested output allocations.
- Cancellation before and during reads.
- Concurrent queries sharing the same index or chunk.

The tests should show that malformed files fail safely rather than causing large allocations, hangs, or misleading output.

## 7. Larger synthetic performance datasets

The existing format fixtures are suitable for correctness but too small to measure realistic performance.

Create a separate deterministic synthetic dataset generator using the Python Figwig writer.

Generate several larger datasets with different characteristics:

**Sparse count signals:** Many tracks, low nonzero density, mostly small integer values.

**Dense floating-point signals:** Several tracks with continuously varying float32 values.

**Mixed signals:** Some sparse and some dense tracks, including stretches of missing data.

**Large multitrack collection:** Tens to hundreds of tracks, exercising different group sizes and layouts.

Use practical sizes, for example tens to a few hundred megabytes, without making the normal test suite depend on large files.

Generate these datasets on demand for benchmarks.

Support configurable parameters:

- Number of tracks.
- Chromosome lengths.
- Tile size.
- Tracks per group.
- Position versus track order.
- Compression level.
- Number of zoom levels.
- Signal density.
- Random seed.

Document the generator's parameters and record file sizes.

Include both small and large tile configurations, especially 1,024, 4,096, 16,384, and 65,536 bp where appropriate.

Include grouping configurations of 1, 4, 8, and 24 tracks for a representative 24-track workload.

Do not commit unnecessarily large binary benchmark files to the repository.

## 8. HTTP Range integration tests

Implement a local HTTP test server using Node.js.

The server must support real byte-range requests against the generated `.fw` files.

It should correctly implement:

- `Range: bytes=start-end`.
- HTTP 206 responses.
- `Content-Range`.
- `Content-Length`.
- `Accept-Ranges: bytes`.
- HTTP 416 for unsatisfiable ranges.
- CORS headers, including exposing `Content-Range`.
- Cancellation and client disconnects.

Avoid transparent whole-response compression that would invalidate the file's byte offsets.

Record:

- Number of HTTP requests.
- Requested byte ranges.
- Actual response body bytes transferred.
- Number of concurrent requests.
- Cancelled requests.
- Total bytes transferred during a query.

Test the reader with both `LocalFile` and `RemoteFile`, using exactly the same files and queries.

**The remote tests must prove that only relevant byte ranges are transferred, not that the entire file is downloaded and subsequently sliced locally.**

Test multiple queries against the same filehandle, including warm caches and overlapping queries.

### Simulated network conditions

Extend the local HTTP server with configurable network simulation:

- Fixed response latency.
- Bandwidth throttling.
- Optional deterministic jitter.
- Concurrent request limits.

Implement bandwidth throttling over the response body rather than simply sleeping once before sending all data.

Ideally, enforce a shared bandwidth budget across concurrent responses so that running many parallel requests does not unrealistically multiply total available bandwidth.

A reasonable initial benchmark matrix is:

| Scenario | Latency | Bandwidth |
|---|---:|---:|
| Local baseline | 0 ms | Unlimited |
| Fast connection | 20 ms | 100 Mbit/s |
| Typical remote connection | 80 ms | 50 Mbit/s |
| High-latency connection | 150 ms | 10 Mbit/s |

The exact values can be tuned, but keep the simulations deterministic and reproducible.

Benchmarks should run on localhost without relying on a real external network.

Keep these performance benchmarks separate from ordinary correctness tests so that routine CI remains fast.

## 9. Performance benchmarks

Create a benchmark runner that measures the reader in several realistic access patterns.

### Query patterns

Benchmark at least the following:

**A. Single-track, small region**

- One selected track.
- A short genomic interval, such as 10 kb.
- Representative of focused genome browsing.

**B. Many tracks, small region**

- 24 selected tracks.
- A genomic interval of approximately 100 kb.
- Representative of a cohort-oriented genome browser.

**C. Sparse track selection**

- A few tracks selected from a file containing many tracks.
- Compare tracks from the same group and different groups.
- Measure unnecessary byte transfers caused by shared chunks.

**D. Larger genomic region**

- Multiple selected tracks.
- A region of approximately 10 Mb.
- Read at a coarser resolution.

**E. Panning**

- Repeated overlapping region requests.
- Small sequential movements.
- Measure caching benefits.

**F. Zooming**

- Move between high and low genomic resolutions.
- Measure the costs of loading and reusing summaries.
- Distinguish initial zoom-summary downloads from subsequent reads.

**G. Changing track selection**

- Start with all 24 tracks.
- Change to six tracks.
- Change to a different six tracks.
- Return to all 24.

This should reuse the existing filehandle and cached indexes.

**H. Batch queries**

- Read several regions on different chromosomes in one call.
- Compare batched requests against sequential independent queries.
- Measure the effectiveness of byte-range coalescing.

### Metrics

For every benchmark, record:

- Wall-clock duration.
- HTTP request count.
- Total transferred bytes.
- Index bytes transferred.
- Data bytes transferred.
- Number of compressed chunks fetched.
- Number of chunks decompressed.
- Index-loading time.
- Decompression time.
- Numeric decoding time.
- Peak or estimated retained cache memory.
- Cache hit rates where available.

Separate cold-cache and warm-cache measurements.

Run enough repetitions to report median and variability, preferably p95 or interquartile range where practical.

Document warm-up behavior, including JIT compilation and first-use decompressor initialization if applicable.

Do not mix initialization time into query-time metrics without stating so explicitly.

### Compression and layout comparisons

Compare different Figwig configurations:

- Position order versus track order.
- Different tile sizes.
- Different track-group sizes.
- Sparse versus dense signals.
- Different compression levels where useful.

Measure file size as well as query performance.

An especially important comparison is selecting one track out of 24 versus selecting all 24 tracks.

The expected behavior should not be assumed in advance. Measure it.

### Optional BigWig baseline

If it can be implemented without compromising the Figwig reader's correctness work, include a reference benchmark using `@gmod/bbi`.

Generate equivalent synthetic BigWig files from the same underlying signals, for example using Figwig's `fw2bw` converter.

Compare equivalent numerical queries, aggregation semantics, and cache states.

Use the same HTTP simulation and comparable query resolutions.

Report the combined size of the BigWig files and the Figwig file.

Keep this as a secondary comparative benchmark, not a dependency for passing the Figwig conformance tests.

## 10. Browser compatibility testing

Node.js tests alone are insufficient.

Include at least one actual browser test, preferably using the repository's existing Playwright infrastructure.

The browser test should:

1. Load a Figwig fixture from a local HTTP server.
2. Fetch metadata through HTTP Range requests.
3. Select a subset of tracks.
4. Read a genomic region.
5. Compare the returned values with independently generated expected results.
6. Test an overlapping request.
7. Verify cancellation behavior.
8. Confirm that the browser bundle does not depend on Node built-ins.

Use a real browser environment, not only jsdom.

Test with Chromium at minimum. Additional Firefox and WebKit smoke tests are desirable if practical.

## 11. Benchmark analysis and reporting

Produce a Markdown report at:

```text
packages/figwig/benchmarks/RESULTS.md
```

The report should describe:

- Hardware and runtime environment.
- Node.js version.
- Browser version where relevant.
- Python Figwig version or pinned commit.
- Dataset-generation parameters.
- Simulated network settings.
- Benchmark methodology.
- Numeric results in readable tables.
- File sizes.
- Cold-cache and warm-cache behavior.
- Performance differences between layouts and group sizes.
- Significant bottlenecks.
- Limitations of the measurements.

Do not claim a speedup without measured evidence.

In particular, investigate whether the following Figwig characteristics meaningfully affect HTTP performance:

1. Whole-group compressed tile indexes.
2. Transferring chunks containing unselected tracks.
3. The relationship between tile size, index size, and transferred data.
4. Zoom-summary loading.
5. Repeated queries and cache reuse.
6. Large track collections divided into many groups.

Distinguish between measured bottlenecks and theoretical concerns.

Provide reproducible benchmark commands.

Do not hardcode measured numbers into source documentation as general performance claims.

## 12. Documentation

Create a clear README covering:

- What Figwig is.
- Supported format version.
- Installation.
- Browser and Node.js compatibility.
- Opening remote, local, and Blob-backed files.
- Reading metadata and selecting tracks.
- Reading genomic regions.
- Reading several tracks.
- Reading binned signals.
- Reading tile summaries and zoom levels.
- Cancellation.
- Caching.
- Coordinate conventions.
- Missing data and NaN semantics.
- Numeric precision.
- Known limitations.

Show a minimal example that reads two tracks from one Figwig file.

Include a format-support table and links to the authoritative Figwig documentation.

Document explicitly that the initial package does not write Figwig files.

Document any differences from the Python API, especially output layout and aggregation semantics.

## 13. Automated development workflow

Follow this general sequence:

**Step 1: Inspect.** Understand the exact Figwig format, Python reference implementation, fixture generator, and GMOD API patterns. Make a short implementation plan.

**Step 2: Scaffold.** Create the independent npm package, public exports, build scripts, test configuration, and basic documentation.

**Step 3: Implement basic parsing.** Header, chromosome table, track metadata, statistics, and indexes.

**Step 4: Implement full decoding.** All v1 chunk representations, numeric types, both storage orders, and summaries.

**Step 5: Establish correctness.** Generate the official synthetic fixtures and expected results from Python. Build comprehensive tests and resolve mismatches.

**Step 6: Implement query APIs.** Batched regions, arbitrary track selection, typed-array outputs, interval features, and binned values.

**Step 7: Optimize I/O.** Lazy indexes, range coalescing, concurrent reads, shared request handling, cancellation, and bounded caches.

**Step 8: Validate remote access.** Run HTTP Range integration tests and actual browser tests.

**Step 9: Benchmark.** Generate realistic synthetic datasets, run local and simulated network benchmarks, and compare layout and grouping strategies.

**Step 10: Document and verify.** Finalize the README, benchmark report, scripts, and package configuration. Run all available tests, linting, type checking, and builds.

Use incremental commits if that is appropriate to the working environment.

Run the relevant commands yourself and fix failures. Do not simply provide instructions for someone else to run them.

If dependencies or external resources are unavailable, report the exact limitation and complete as much as possible without inventing results.

## 14. Acceptance criteria

The implementation is successful when:

- [ ] `@genome-spy/figwig` builds independently.
- [ ] No GenomeSpy runtime packages are required.
- [ ] The same parser works with `LocalFile`, `RemoteFile`, and `BlobFile`.
- [ ] Both Figwig v1 storage orders are supported.
- [ ] All specified chunk encodings and numeric types are supported.
- [ ] Synthetic format fixtures decode correctly.
- [ ] Randomized queries agree with Python reference results.
- [ ] Tile summaries and zoom levels are read correctly.
- [ ] HTTP Range access works without downloading whole files.
- [ ] Multiple regions and track subsets can be queried efficiently.
- [ ] Concurrent queries and cancellation behave correctly.
- [ ] Malformed files fail safely.
- [ ] At least one real browser test passes.
- [ ] Reproducible simulated-network benchmarks execute successfully.
- [ ] The benchmark report includes actual measured results.
- [ ] The package has appropriate public documentation and TypeScript declarations.

Prioritize verified correctness over benchmark scores. Do not compromise the binary format's semantics to make a benchmark look better.

## 15. Explicitly out of scope

Do **not** implement or modify GenomeSpy's data sources, visualization grammar, application, sample collection handling, or other visualization functionality.

In particular:

- Do not implement `FigWigSource`.
- Do not modify `BigWigSource`.
- Do not modify `IntervalUrlSource`.
- Do not extend GenomeSpy's data schema.
- Do not implement reactive `visibleSamples` integration.
- Do not implement a Figwig writer.
- Do not modify or run the ENCODE mouse fetal-development dataset recipe.
- Do not convert the 24 ENCODE BigWigs yet.
- Do not attempt visual comparison against GenomeSpy.

Those tasks belong to a later integration and validation phase.

The current work should end with a **standalone, tested, benchmarked Figwig JavaScript library**, ready to be used by GenomeSpy or other applications.

## 16. Final deliverables

When finished, report:

1. The package structure and public API implemented.
2. Which parts of Figwig v1 are supported.
3. Tests executed and their results.
4. Browser compatibility tests performed.
5. Benchmark configurations and measured results.
6. Important performance findings, including HTTP index and chunk overhead.
7. Any remaining limitations or known bugs.
8. The commands needed to reproduce tests and benchmarks.
9. Any architectural recommendations for the later GenomeSpy integration phase, without implementing that phase.

If performance testing indicates that the Figwig format is poorly suited to some HTTP access patterns, explain the evidence. Do not modify the Figwig binary format or introduce a nonstandard extension in this phase.

The principal goal is to establish a correct, reusable, GMOD-style JavaScript implementation of Figwig and obtain trustworthy evidence about its performance over HTTP.
