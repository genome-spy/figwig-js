# Reproducible HTTP benchmarks

For Node/Chromium sampling CPU profiles and request timelines, run
`node --import tsx benchmarks/scripts/profile.mjs 2000` after generating the
datasets below. See the [profiler results](RESULTS.md#sampling-profiler-results--2026-10-28)
for workloads, interpretation and the browser-cache scheduling control. Raw CPU
profiles, source maps and timelines go into the ignored `benchmarks/results/profiles/`
folder; source-mapped summaries go into `benchmarks/measurements/profiles-cpu.json`.

The benchmark server runs on localhost and sends actual byte-range bodies. It
never loads a complete `.fw` merely to slice a requested response. The generator
uses upstream Python FigWigWriter at commit
`c0e5d6522c677b9f03cd6831e2dbcea759866628` (Figwig 0.2.0), with one fixed RNG per
track so layout comparisons represent the same signal.

## Generate data

Use the Python environment described in `test/fixtures/README.md` or the environment
created by the fixture regeneration script. Point `--upstream` at that exact
checkout. A fresh setup is:

```sh
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r scripts/requirements-fixtures.txt
git clone https://github.com/jmschrei/figwig.git /tmp/figwig-reference
git -C /tmp/figwig-reference checkout c0e5d6522c677b9f03cd6831e2dbcea759866628
.venv/bin/python benchmarks/scripts/generate.py --upstream /tmp/figwig-reference
```

```sh
.venv/bin/python benchmarks/scripts/generate.py \
  --upstream /tmp/figwig-reference --profile mixed \
  --tracks 24 --length 8000000 --second-length 2000000 \
  --tile 4096 --group 4 --order positions --level 6 --zooms 4 \
  --density 0.02 --seed 1701
```

Profiles are `sparse` (low-density positive integer counts), `dense` (varying
float32 signals), `mixed` (alternating counts/float32 with NaN stretches),
`masked` (float32 signals with NaNs covering roughly 94% of positions), and
`collection` (counts, intended for tens or hundreds of tracks). `--tracks`,
`--length`, `--second-length`, `--tile`, `--group`, `--order`, `--level`, `--zooms`,
`--density`, `--seed`, and `--chunk-bases` are configurable. File sizes and full
parameters are saved beside each binary as JSON. Defaults produce a substantial
24-track, ten-million-base mixed dataset. The generator streams bounded windows
instead of retaining all underlying tracks/chromosomes in RAM. Changing
`--chunk-bases` changes RNG draw interleaving for sparse signals; keep it fixed
when comparing configurations. Compressed bytes can vary across system zlib
versions; recorded measurements used zlib 1.2.12.

A compact matrix isolates overhead before running more expensive large files:

```sh
.venv/bin/python benchmarks/scripts/generate.py \
  --upstream /tmp/figwig-reference --profile sparse \
  --tracks 24 --length 500000 --second-length 125000 --matrix
```

This creates 16 position-order files covering tiles 1,024 / 4,096 / 16,384 /
65,536 and groups 1 / 4 / 8 / 24, plus one track-order file at the requested tile
and group size. Track order always stores one track per group; its manifest
records actual `group:1` and `requested_group` separately. This compact matrix
does not model index overhead for a full
human genome; generate longer chromosomes separately before drawing such
conclusions. Do not commit generated benchmark binaries.

## Run

```sh
npm run benchmark -- --scenarios all --repetitions 5
npm run benchmark -- --scenarios local,typical --repetitions 3 \
  --patterns A,B,C,H --match sparse --output benchmarks/measurements/matrix.json
npm run benchmark -- --scenarios local,fast,typical,high --repetitions 3 \
  --output benchmarks/measurements/mixed.json \
  mixed-n24-tile4096-g4-positions-l6-s1701.fw
```

`--directory` changes the fixture directory. Positional filenames choose files
from that directory; omission runs every `.fw` directly in it. `--patterns`
accepts exact names or prefixes (`A,B,C,D,E,F,G,H,I`). `--match` filters filenames by substring. `--coalesce-gap` (bytes), `--max-concurrent`, `--max-coalesced-mib`, `--chunk-cache-mib`, and `--index-cache-mib` make I/O/cache comparisons reproducible; defaults match the reader. `--output` writes raw JSON
and an adjacent Markdown table. The report in `RESULTS.md` identifies the exact
commands used for recorded measurements.

| Network   | Fixed response latency | Shared body bandwidth |
| --------- | ---------------------: | --------------------: |
| `local`   |                   0 ms |             Unlimited |
| `fast`    |                  20 ms |            100 Mbit/s |
| `typical` |                  80 ms |             50 Mbit/s |
| `high`    |                 150 ms |             10 Mbit/s |

The server can additionally set deterministic nonnegative jitter, a request
concurrency limit (default 8), and body chunk size (default 16 KiB). Body chunks
reserve time from one shared timeline; simultaneous responses share the stated
bandwidth. Each response has separate latency. This model excludes TCP loss,
connection establishment, HTTP/2 multiplexing, persistent proxy caches, and
other real-network effects.

## Patterns and measurement boundaries

- **A:** One track and all 24 tracks over the same 10 kb interval.
- **B:** One track and all 24 tracks over the same 100 kb interval.
- **C:** Up to four tracks within one group versus up to four across groups.
  When a group holds fewer than four tracks, the selected counts differ; compare
  equal-count cases or the A/B workloads for selection overhead.
- **D:** Up to 10 Mb at bins of 16 tiles, using stored sums when applicable.
- **E:** Six overlapping 100 kb panning requests, moving 20 kb each time.
- **F:** Full-resolution, tile sums, coarser zoom sums, then tile sums again.
- **G:** All 24, first six, another six, then all 24 on the same reader.
- **H:** Multiple windows across both chromosomes, batched versus sequential.
- **I:** Every track in a large collection versus four scattered tracks, over 10 kb.

Windows clip to dataset lengths so every profile can run all patterns. Every
pattern first executes once on an independent reader to warm JIT/decompressor
code. Each repetition then constructs another reader, times header/metadata
initialization separately, runs a cold query, and immediately repeats that
pattern against the same parsed caches. A cold query therefore excludes header
initialization but includes initially needed group indexes. A warm multi-step
pattern may internally reuse data loaded in its earlier steps. No raw byte cache
wrapper is added: reported reuse comes from this reader's parsed indexes and
chunks. OS file cache and Node's HTTP connection pool are warm.

JSON contains every sample, duration, initialization duration, request count,
actual completed body-write bytes, index/data read bytes, chunk fetch/decode
counts, index/decompression/decoding time (index time sums overlapping group loads, so can exceed query wall time), retained parsed-cache estimate, and
cache hits/misses. The Markdown companion reports medians and interpolated p95.
Small sample counts do not establish reliable tail latency. Cache memory is a
reader estimate, not process RSS or a garbage-collector peak. On cancellation,
server body bytes count completed write callbacks; TCP buffers may already hold
some bytes when a client disconnects.

The optional BigWig baseline is not implemented in this phase; comparisons here
are among equivalent Figwig signals and layouts, never inferred BigWig numbers.
