# Benchmarks

Keep generated data, measurements, profiles and reports local. Fixtures go in
ignored `benchmarks/fixtures/`; results go in ignored `benchmarks/results/`.
Historical investigations remain linked from [RESULTS.md](RESULTS.md) and
[DECOMPRESSION.md](DECOMPRESSION.md).

## Generate workloads

Use the pinned Python environment in [test/fixtures/README.md](../test/fixtures/README.md).
The benchmark generator writes performance inputs, never correctness expectations.

```sh
git clone https://github.com/jmschrei/figwig.git /tmp/figwig-reference
git -C /tmp/figwig-reference checkout c0e5d6522c677b9f03cd6831e2dbcea759866628
uv run --python 3.12 --with-requirements scripts/requirements-fixtures.txt \
  benchmarks/scripts/generate.py --upstream /tmp/figwig-reference \
  --profile sparse --tracks 24 --length 500000 --second-length 125000 --matrix
```

This compact matrix covers four tile sizes and four position-group sizes, plus
one track-order file. It does not model full-genome index overhead. Other profiles
are `dense`, `mixed`, `masked` and `collection`; see `generate.py --help` for sizes,
compression and layout options. Defaults generate a substantial ten-million-base
mixed dataset. Per-track RNGs keep signals comparable across layouts; keep seed,
chromosome lengths and `--chunk-bases` fixed. Manifests record writer parameters
and file sizes. Compressed bytes can vary with the system zlib version.

## Run HTTP benchmarks

```sh
npm run benchmark -- --scenarios local,typical --repetitions 5 \
  --patterns A,B,C,H --match sparse
python3 benchmarks/scripts/summarize.py benchmarks/results/latest.json
```

`--directory` chooses the fixture directory; positional filenames select files
inside it. Otherwise every `.fw` directly in that directory runs. `--patterns`
accepts names or prefixes; `--match` filters filenames. `--output` defaults to
`benchmarks/results/latest.json` and also writes an adjacent Markdown table.
I/O controls include `--coalesce-gap`, `--max-concurrent`, `--max-coalesced-mib`,
`--chunk-cache-mib` and `--index-cache-mib`; defaults match the reader.

| Network   | Response latency | Shared bandwidth |
| --------- | ---------------: | ---------------: |
| `local`   |             0 ms |        Unlimited |
| `fast`    |            20 ms |       100 Mbit/s |
| `typical` |            80 ms |        50 Mbit/s |
| `high`    |           150 ms |        10 Mbit/s |

The localhost server serves actual byte ranges without loading whole files.
Responses share a body-bandwidth timeline, with default 16 KiB chunks and server
concurrency eight. The model excludes TCP loss, connection setup, HTTP/2 effects
and proxy caches.

Patterns: **A/B** compare one versus all tracks over 10/100 kb; **C** compares
within-group and across-group selection; **D** uses stored summaries; **E** pans;
**F** changes resolution; **G** changes track selections; **H** compares batched
and sequential windows; **I** compares all versus four collection tracks; **J**
compares all file tracks using raw bins, base summaries and the first zoom level.
Windows clip to dataset lengths. C cases may select different track counts when
groups contain fewer than four tracks; compare equal-count cases.

Each pattern warms code on an independent reader. Each repetition then creates
a reader, records metadata initialization separately, and runs a cold/warm pair.
Cold query times include first group-index loads but exclude initialization.
Warm patterns reuse parsed caches, including reuse within multi-step patterns.
OS caches and Node connections are warm; no external byte-cache wrapper is added.
JSON retains every sample and I/O, phase and cache metrics. Tables show medians
and interpolated p95; small sample counts do not establish tail latency. Index
phase times can overlap, and cache estimates are neither RSS nor peak memory.

## Profile Node and Chromium

After `npx playwright install chromium`, profile the small conformance inputs:

```sh
FIGWIG_PROFILE_BASELINE=HEAD FIGWIG_PROFILE_CASES=named600,track-cold \
  node --import tsx benchmarks/scripts/profile.mjs 2000
```

The baseline defaults to `HEAD`; set it to a commit to compare revisions. Both
variants use installed dependencies. Case-name prefixes select workloads; larger
cases require the corresponding generated fixtures listed in `profile.mjs`.
The duration argument is milliseconds per CPU phase. Profiles, bundles and maps
are saved under `benchmarks/results/profiles/`; the summary defaults to
`benchmarks/results/profiles-cpu.json`. Override these with
`FIGWIG_PROFILE_OUTPUT` and `FIGWIG_PROFILE_SUMMARY`. Summaries record commit IDs
and a hash/reference to any dirty source patch saved alongside the profiles.

For a local converted file, set `FIGWIG_GAP_FILE`, select `gap-bins` or
`gap-summary`, and optionally set `FIGWIG_GAP_QUERY` to JSON containing
`chromosome`, `start`, `end` and `binSize`. Summary controls align to 65,536-base
bins with zero-filled missing values; exact bins omit missing values.

```sh
node benchmarks/scripts/analyze-navigation-trace.mjs /absolute/path/to/trace.json
```

The trace analyzer requires one V8 profile and defaults to
`benchmarks/results/navigation-trace.json`; an optional second argument changes
the output. It fingerprints the trace and summarizes `.fw` responses and weighted
CPU samples without copying the trace. Inclusive CPU rows overlap. Profiled
times are diagnostic evidence, separate from uninstrumented query timings.

Follow [AGENTS.md](../AGENTS.md) for performance evidence: keep concise measurements
in the commit message body, PR description or changeset. Retain raw artifacts
locally or attach them when needed; do not commit each run or append a diary.
