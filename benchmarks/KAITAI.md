# Kaitai parser experiment

This branch evaluates a Kaitai-generated structural parser against the
handwritten implementation at `64f6e2c3bb9f27997d61c0ca7e6fef92a45def5f`.
The public API, query planning, HTTP/cache behavior, Pako inflater and typed-array
results retain the same design. Both storage orders, all payload encodings,
summaries and zooms use generated binary readers. Domain validation and numeric
result construction remain TypeScript adapters.

This is a hybrid integration: metadata/index structures come from generated
types, while numeric payloads use generated primitive-array windows and per-entry
varints. Adapters still sequence sparse/matrix/block layouts, calculate padding
and value offsets, and reconstruct sparse tracks. The experiment does not use
the upstream schema as a complete, unmodified whole-file reader.

## Package size

Both versions bundle **all public exports** as browser ESM targeting ES2022,
using esbuild 0.28.2, minification, and gzip level 9. Both resolve the same locked
runtime dependencies. The compiler and YAML loader are development dependencies;
the portable Kaitai runtime and generated parser are included in the browser code.
Legal notices ship separately. These are static code-size measurements, not
latency, throughput, allocation or memory benchmarks.

| Whole public API      | Handwritten | Kaitai |            Change |
| --------------------- | ----------: | -----: | ----------------: |
| Minified bytes        |      61,299 | 82,416 | +21,117 (+34.45%) |
| Minified + gzip bytes |      21,866 | 26,527 |  +4,661 (+21.32%) |

The portable runtime alone is 12,982 minified bytes or 3,498 gzipped bytes.
This includes its ESM packaging and disabled optional hooks. It differs from
minifying the standalone upstream runtime directly, which previously measured
3,022 gzipped bytes. The whole-package difference also includes generated
structures, safety adapters and removed handwritten code; individual compressed
module sizes cannot simply be added.

Reproduce without switching branches or changing the working tree:

```sh
npm run parser:check
npm run compare:parser-size
# An alternate baseline ref and updating the checked-in JSON are optional:
npm run compare:parser-size -- 64f6e2 --write
```

The script reads baseline sources directly from Git into a temporary directory.
Exact settings and results are in [`measurements/kaitai-size.json`](measurements/kaitai-size.json).
These figures describe a complete browser entry retaining every public export;
individual applications may tree-shake differently. They do not describe npm
tarball size or the size of the compiler toolchain.

## Correctness evidence

All 176 Node tests pass, including independent Python-backed conformance,
corruption, aggregation and HTTP tests, along with all three Chromium 156
correctness tests. Generation, formatting, typechecking, lint, build and package
contents checks pass, as do built ESM and strict browser-only TypeScript smoke
checks. New integration tests
cover exact safe uint64 conversion, subarray isolation, malformed UTF-8 and BOM
handling, bounded three-byte varints, staging budgets and 4096-element window
boundaries including NaN, negative zero and infinity rejection.

The schema makes field layouts reviewable and can reduce transcription mistakes.
It does not automatically validate the format's semantics. The upstream schema
reads many CRCs and constraints without enforcing them, and its default runtime
integer/text behavior needed adaptations to match the existing reader. Those
checks remain explicit. During integration, a repeat-until index expression
initially stopped valid varints after two bytes; tests caught it and the schema
now checks group count explicitly.

This is evidence of compatibility on the tested inputs, not proof of universal
equivalence or greater correctness. Several allocation estimates are stricter
because generated index/summary arrays add staging; unusually tight configured
limits may reject a file that the handwritten reader accepted. Payload output
limits still budget retained typed arrays, with bounded temporary parsing windows
and separately checked sparse/matrix header workspace.

## Developer experience

Benefits:

- Binary field layouts and element-type switches are declarative and derived
  from the upstream format schema, with the original retained for comparison.
- Generation is reproducible with pinned npm tools; no JVM or consumer-side
  compiler is needed. CI detects stale generated parser/runtime files.
- Structural reads are separated from HTTP, cache, aggregation and semantic
  validation code. Existing public typed-array APIs remain usable unchanged.

Costs:

- The local schema is adapted rather than a drop-in copy. Upstream changes need
  review against both the original schema and these adaptations.
- Bounds, checksums, JSON-derived group membership, sparse reconstruction,
  numeric semantics and allocation policy still need handwritten adapters.
  This experiment does not eliminate or greatly simplify that code.
- Generated JavaScript lacks generated TypeScript declarations. Small adapter
  interfaces are maintained by hand; generation does not give complete static
  checking between the schema and those interfaces.
- The generation step, tracked generated files, portable runtime packaging and
  compiler-wrapper checks add tooling and upgrade maintenance. Generated stack
  traces are less direct than the original TypeScript readers.

## Expected performance, not measured

Network request planning, cache policy, decompression and aggregation algorithms
retain their existing design, so changing the parser should not intrinsically
reduce HTTP requests or raw data that must be decoded. Stricter allocation checks
can reject some requests that previously succeeded; actual JavaScript heap use
also exceeds the retained typed-array byte counts recorded by cache diagnostics.

Generated primitive reads add stream-method calls and temporary JavaScript arrays
before typed-array conversion. Sparse offsets also create short-lived varint
objects. This suggests additional CPU and garbage-collection work, especially
for CPU-bound local decoding or sparse chunks, but JIT inlining and other effects mean
the size of any difference is unknown. Payload staging is limited to 4096 values
per window; this reduces simultaneous retained staging, without establishing a
peak-memory guarantee or a performance ranking.

Queries served from the decoded-chunk and parsed-index caches largely bypass
parsing, so ordinary warm cache hits should not pay these decoding costs again.

No parser timing, throughput, frame-time, allocation or memory benchmarks were
run for this experiment. The existing Figwig overview/missingness limitations
also remain: Kaitai cannot supply missing summary coverage counts or avoid raw
work required by an incompatible summary query.

## Assessment

The experiment works and the compressed code overhead is modest in absolute
terms, although noticeable relative to this small package. It has useful
declarative format definitions, but substantial adapters and additional tooling
remain. Correctness is supported by the same oracle and extra boundary tests;
it is not automatically stronger merely because a generator is involved.

Keep this as an evaluation branch. Adoption should depend on whether maintaining
the schema-based structure is valuable enough to justify the additional code and
tooling. If it is, the next step is the deferred performance comparison, focusing
on cold remote reads, uncached dense/sparse/run decoding, decoded-cache hits,
and browser allocation/GC.
