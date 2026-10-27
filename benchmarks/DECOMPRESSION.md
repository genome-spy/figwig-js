# Decompression experiment: GMOD libdeflate WASM

Measured 27 October 2026 on Apple M5, macOS arm64, Node.js v26.8.1. This is a
CPU microbenchmark of real Figwig payloads, separate from the HTTP measurements
in `RESULTS.md`. Raw samples are in `measurements/decompression.json`.

The libdeflate WASM backend is a promising optimization, particularly for larger
chunks and batches. The exact current GMOD APIs are not interchangeable with
this reader's strict RFC1950 decoder. The production package retains its verified
Pako implementation; this experiment adds no runtime dependency or vendored WASM.

## Source versions and compatibility

- [`@gmod/bgzf-filehandle` 6.8.2](https://github.com/GMOD/bgzf-filehandle/tree/02a8f4619316f189d8bb571da54af6214e9d8a26),
  commit `02a8f4619316f189d8bb571da54af6214e9d8a26`.
- [`@gmod/bbi` 12.0.0](https://github.com/GMOD/bbi-js/tree/a7eefcc0c9830f5dbbd8bded268a8dacdfaf96f5),
  commit `a7eefcc0c9830f5dbbd8bded268a8dacdfaf96f5`.
- This reader's Pako 2.2.0 wrapper, including zlib header validation, bounded
  output, exact declared length, Adler32 verification and trailing-byte rejection.
- Figwig writer/reference source commit
  `c0e5d6522c677b9f03cd6831e2dbcea759866628`; Python 3.12.13, NumPy 2.5.4,
  Numba 0.68.0, llvmlite 0.50.0.

Both GMOD WASM crates use Rust `libdeflater` and its freestanding libdeflate
backend. The BGZF package exposes BGZF/gzip operations, not an ordinary zlib
inflate operation. Its exact WASM module rejected an unmodified Figwig zlib
stream with `invalid bgzf header`. BGZF limits both raw and total compressed
block size to 65,536 bytes, whereas Figwig chunks and track-order blocks may be
larger. The BGZF experiment below copies an eligible stream's unchanged raw
DEFLATE bytes into a valid synthetic BGZF header/trailer without recompression.
That is an experimental measurement adapter, not a supported Figwig read path.

BBI exposes a batch raw-inflate operation usable with larger Figwig streams.
Its Rust implementation skips each stream's first two bytes and calls raw
`deflate_decompress`, ignoring the RFC1950 checksum. It also does not return the
consumed compressed-input length. See the pinned
[BBI Rust implementation](https://github.com/GMOD/bbi-js/blob/a7eefcc0c9830f5dbbd8bded268a8dacdfaf96f5/crate/src/lib.rs)
and [BGZF Rust implementation](https://github.com/GMOD/bgzf-filehandle/blob/02a8f4619316f189d8bb571da54af6214e9d8a26/crate/src/lib.rs).

## Method

The benchmark selects at most 128 evenly spaced compressed data payloads per
file, excluding chunks stored without compression. Every WASM result is compared
byte for byte with the strict Pako output before timing. It uses the checked-in
`zlib`, `tracks_zlib`, and `blocks` conformance files and these deterministic
larger benchmark profiles (seed 1701, tile 4096, group 4, zlib level 6, four zooms):

- Sparse: 24 tracks, chromosomes 500,000 and 125,000 bp, density 0.02.
- Dense: eight float32 tracks, chromosomes 2,000,000 and 500,000 bp.
- Mixed: 24 alternating count/float tracks, chromosomes 8,000,000 and 2,000,000 bp,
  including NaN stretches.

Input file reading, chunk-index parsing, assembling BBI batches, creating the
synthetic BGZF envelopes, their CRC calculation, and initial correctness checks
are excluded from warm timings. WASM's input/output copies and asynchronous
wrapper calls remain included. Excluding experimental repacking makes its
numbers an upper bound on an integrated adapter's throughput. Full Figwig chunk
CRC verification, numeric decoding, query planning and HTTP are excluded from
all variants.

Each path is warmed twice. Seven measured repetitions rotate variant order to
reduce ordering bias. A repetition loops over the fixed sample set until at
least 8 MiB of raw data is processed, capped at 1,024 passes for very tiny
fixtures. All variants in one row process the same samples and pass count.
`p95` below is the nearest-rank value; with seven samples it is the maximum, not
a reliable estimate of deployment tail latency. Other development work was
running on the machine; these measurements are comparative evidence, not an
isolated hardware capability claim.

The `header+Adler` variants validate RFC1950 headers, output length and Adler32
in JavaScript after native inflation. They remain unable to reject trailing or
concatenated streams. The strict Pako column performs those additional checks.
The `raw` variants omit zlib envelope validation and therefore establish a
backend speed ceiling rather than an equivalent correctness comparison.

## Warm throughput

Values are MiB/s of decompressed bytes. BGZF values use eligible payloads only;
large track-order blocks are reported separately. BBI batch32 preassembles up to
32 compressed chunks and inflates them in one call.

| Samples | Chunks | Pako strict | BBI raw single | BBI + header/Adler | BBI + header/Adler batch32 | BGZF rewrap + header/Adler |
|---|---:|---:|---:|---:|---:|---:|
| official-position/BGZF-eligible | 45 | 39.2 | 33.0 | 32.4 | 193.9 | 162.1 |
| official-track/BGZF-eligible | 69 | 97.6 | 192.5 | 177.2 | 274.8 | 261.2 |
| official-track/over-BGZF-limit | 2 | 139.9 | 511.4 | 423.4 | 424.7 | — |
| sparse24/BGZF-eligible | 128 | 66.4 | 173.8 | 163.0 | 186.5 | 174.1 |
| dense8/BGZF-eligible | 128 | 110.7 | 370.8 | 165.0 | 165.6 | 166.2 |
| mixed24/BGZF-eligible | 128 | 133.5 | 481.4 | 183.2 | 184.3 | 182.4 |

Raw BBI output is approximately 3.4× the strict Pako throughput for the dense
sample. Adding the JavaScript checksum reduces that measured gain to about
1.5×. Sparse samples show a different balance. Single-call BBI is slower than
Pako on the tiny position-order fixture, while batching those tiny streams is
substantially faster. BGZF's reusable native decompressor also avoids the
per-call setup visible in the BBI single-stream path. These are workload-specific
microbenchmark results, not end-to-end query speedups.

### Timing variability

The following are total milliseconds per repeated sample set, median / p95.
Pass counts differ between datasets, so compare variants within a row.

| Samples | Passes | Raw MiB per repetition | Pako strict median / p95 | BBI + header/Adler median / p95 | BGZF + header/Adler median / p95 |
|---|---:|---:|---:|---:|---:|
| official-position/BGZF-eligible | 1024 | 3.07 | 78.25 / 97.53 | 94.77 / 99.95 | 18.94 / 19.62 |
| official-track/BGZF-eligible | 180 | 8.04 | 82.44 / 93.33 | 45.40 / 47.29 | 30.80 / 32.13 |
| official-track/over-BGZF-limit | 13 | 8.12 | 58.06 / 58.72 | 19.19 / 19.37 | — |
| sparse24/BGZF-eligible | 94 | 8.02 | 120.82 / 123.73 | 49.18 / 50.04 | 46.05 / 46.61 |
| dense8/BGZF-eligible | 2 | 15.89 | 143.50 / 146.80 | 96.28 / 104.67 | 95.61 / 101.70 |
| mixed24/BGZF-eligible | 2 | 10.15 | 76.06 / 76.96 | 55.42 / 56.08 | 55.65 / 61.49 |

## Bundle and first-use cost

These are standalone decoder assets, not the whole Figwig package. Pako is a
minified browser bundle of this reader's strict decoder and its dependency;
GMOD assets are the exact checked-in inlined bundles. Gzip sizes include their
JavaScript and embedded base64 WASM. Actual app bundlers and HTTP compression
may produce different totals.

| Decoder asset | JavaScript bytes | Gzipped bytes | Embedded WASM bytes |
|---|---:|---:|---:|
| `inflate-wasm-inlined.js` | 60,281 | 24,092 | 33879 |
| `bgzf-wasm-inlined.js` | 52,088 | 21,418 | 29907 |
| `pako-strict.mjs` | 48,597 | 15,790 | — |

Each cold sample runs in a fresh Node process. The timer starts before importing
the local decoder module and ends after its first real payload decode; Node
startup is excluded. Local filesystem cache is warm, and no HTTP download is
included. The Pako bundle removes TypeScript-loader cost from that comparison.
First-call timings include the WASM data-URL fetch and instantiation, or Pako's
first decode/JIT work, plus a small base64 input-preparation step.

| Decoder | Import median ms | First call median ms | Combined median ms | Combined p95 ms |
|---|---:|---:|---:|---:|
| bbi | 0.56 | 12.02 | 12.62 | 12.95 |
| bgzf | 0.51 | 11.73 | 12.25 | 13.60 |
| pako | 1.20 | 4.24 | 5.45 | 5.52 |

Both upstream inlined bundles use browser APIs (`fetch` on a data URL and
`WebAssembly.instantiate`) and contain no Node filesystem requirement. These
external WASM adapters were exercised in Node only during this experiment;
no browser performance or independent external-WASM browser compatibility result
is claimed. The production Pako reader passes the actual Chromium suite.
A strict CSP may require permission for WASM compilation and the data-URL
initialization approach; a future adapter should let the host supply its WASM
asset rather than force one packaging policy.

## Required validation is different

These probes mutate the same valid stream. The output-size probe supplies a
limit one byte below the known output. Accepting a trailing or concatenated
stream conflicts with the Figwig v1 single-stream validation requirement.

| Probe | Pako strict | BBI raw | BBI + header/Adler |
|---|---|---|---|
| valid | accepted | accepted | accepted |
| bad header | rejected | accepted | rejected |
| bad Adler32 | rejected | accepted | rejected |
| trailing DEFLATE byte | rejected | accepted | accepted |
| concatenated streams | rejected | accepted | accepted |
| declared output too small | rejected | rejected | rejected |

Ordinary zlib input to the BGZF WASM API: **rejected**, as expected for that API.
BGZF synthetic rewrapping cannot remove its 64 KiB format limit, and does not
supply the strict consumed-input information missing from the raw backend.

BBI bounds each output by the supplied maximum block size, but reserves
`numberOfBlocks * maximumBlockSize` plus scratch space when batching. A real
Figwig adapter needs an aggregate batch-allocation limit, not only a per-chunk
limit, and should avoid excessive reservation for mixed-size batches. WASM
linear memory grows and may remain retained after a large query. The JS result
is copied out of that memory; it is not a zero-copy view directly usable forever.

## Recommendation

Keep the strict Pako path as the initial portable default. The measurements
justify investigating a dedicated optional libdeflate WASM adapter with a
reusable decompressor and batched calls. A suitable native entrypoint should
verify the zlib wrapper/checksum, report both consumed input and produced output,
accept exact output bounds, and return errors without invalidating the instance.
The caller must check consumed input equals the complete stream length and
produced output equals Figwig's declared size. Libdeflate's
[`libdeflate_zlib_decompress_ex` API](https://github.com/ebiggers/libdeflate/blob/master/libdeflate.h)
provides the relevant native primitive; exposing it would require additional
bindings and verification, not a direct import of the current GMOD BGZF API.
Native checksum work could also avoid the JavaScript Adler pass that consumes a
substantial fraction of the measured dense-data gain.

That future path should retain a lazy Pako fallback, run the same corruption
and browser conformance suite, cap combined batch output, and be benchmarked
with actual HTTP queries before becoming mandatory. BBI's fused BigWig numeric
parsers are specific to its record formats; they do not parse Figwig chunks.

## Reproduce

Generate the sparse, dense and mixed files with the parameters above using
`benchmarks/scripts/generate.py` and the pinned Python environment documented in
`test/fixtures/README.md`. For example, the dense command is:

```sh
/tmp/figwig-python/bin/python benchmarks/scripts/generate.py \
  --upstream /tmp/figwig-upstream --profile dense --tracks 8 \
  --length 2000000 --second-length 500000 --tile 4096 --group 4
```

Then obtain the pinned GMOD sources and run the optional experiment:

```sh
git clone https://github.com/GMOD/bbi-js.git /tmp/figwig-bbi-js
git -C /tmp/figwig-bbi-js checkout a7eefcc0c9830f5dbbd8bded268a8dacdfaf96f5
git clone https://github.com/GMOD/bgzf-filehandle.git /tmp/figwig-bgzf-filehandle
git -C /tmp/figwig-bgzf-filehandle checkout 02a8f4619316f189d8bb571da54af6214e9d8a26
node --import tsx benchmarks/scripts/decompression.ts \
  --bbi-checkout /tmp/figwig-bbi-js \
  --bgzf-checkout /tmp/figwig-bgzf-filehandle --repetitions 7
```

The script checks both source commits, reads only the metadata/index and selected
payload ranges needed for the microbenchmark, verifies decoded byte equality,
prints throughput, and writes raw samples to
`benchmarks/measurements/decompression.json`. External clones and generated
benchmark binaries are not runtime or normal-test dependencies.
