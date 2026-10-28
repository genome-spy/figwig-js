# Kaitai parser sources

This experiment derives `figwig.ksy` from Jacob Schreiber's Figwig v1 schema at
`c0e5d6522c677b9f03cd6831e2dbcea759866628`. The unchanged original is retained in
[`scripts/vendor/figwig.ksy`](../scripts/vendor/figwig.ksy), with its MIT license
in [`LICENSES/figwig.txt`](../LICENSES/figwig.txt).

The local schema is intentionally adapted for this reader:

- Parse already fetched ranges and inflated payloads. Omit whole-file seeks,
  automatic decompression and unused whole-file/container types. HTTP range
  planning and the bounded zlib implementation remain in the reader.
- Retain the upstream header, chromosome, statistics, run/block index,
  live-index, summary, element and varint layouts. Small prefix/header and
  integer-array types let adapters validate counts before repeated parsing.
- Limit varints to three groups. The adapter rejects a continuation flag on
  the third group. Use `groups.size == 3` explicitly: the JavaScript compiler's
  repeat-until `_index` check is emitted after incrementing its loop counter.
- Read numeric payload arrays in windows of at most 4096 elements, converting
  generated JavaScript arrays into the reader's typed arrays. Parse sparse
  varints individually to avoid retaining an object graph for the whole chunk.

## Generation

```sh
npm ci
npm run parser:generate
npm run parser:check
```

The compiler, runtime, YAML loader and esbuild are locked development
dependencies. The compiler is the official JavaScript build; Java is not needed.
Generated TypeScript files contain JavaScript with `@ts-nocheck` and are tracked
in `src/kaitai/generated/`. Edit the schema or generator, never those outputs.
CI checks that regeneration reproduces both files exactly.

`scripts/generate-parser.mjs` replaces the compiler's UMD module wrapper with
ESM without changing generated field-reading code. It also bundles the official
Kaitai 0.11.0 runtime into a portable ESM module. Optional Node `zlib` and legacy
`iconv-lite` hooks become unavailable-feature stubs. They are not used by the
reader: decompression uses its existing strict Pako inflater and UTF-8 uses the
existing modern `TextDecoder`. Consumers need no new bundler aliases, Node
polyfills, compiler, or separate Kaitai installation. Runtime and schema licenses
are included in the published package's `LICENSES/` directory.

## Validation boundary

Kaitai describes binary structure; it does not make this schema a complete
Figwig validator. TypeScript adapters still check CRCs, extents, counts,
allocation estimates, index ordering, metadata, dtypes and numeric semantics.
`ParseStream` overrides uint64 reading to validate a `BigInt` before converting
to a safe JavaScript number, restricts reads/seeks to the fetched view, and uses
strict UTF-8 decoding that preserves a literal leading BOM.

Generated repeated values use ordinary JavaScript arrays. The query/cache APIs
still expose native typed arrays and preserve independent caller-owned results.
Payload staging is bounded by a fixed window; live-index and summary staging
have conservative allocation checks. These estimates are not measurements of
peak process/browser memory, and garbage-collection timing is unspecified.

The JavaScript compiler does not generate TypeScript declarations. Adapters
therefore keep small structural interfaces. Generation checks catch stale
artifacts; relevant conformance tests must catch schema/property mismatches
that the handwritten interfaces cannot detect statically.

See [the comparison](../benchmarks/KAITAI.md) for results and remaining questions.
