#!/usr/bin/env python3
"""Regenerate the curated report from retained benchmark samples."""
import json
import pathlib
import statistics

ROOT = pathlib.Path(__file__).resolve().parents[1]
NAMES = ['matrix-local', 'matrix-typical', 'mixed-networks', 'profiles', 'compression', 'large-sparse', 'step-traces']
RUNS = {name: json.loads((ROOT / 'measurements' / f'{name}.json').read_text()) for name in NAMES}
MIXED = 'mixed-n24-tile4096-g4-positions-l6-s1701.fw'
DENSE = 'dense-n8-tile4096-g4-positions-l6-s1701.fw'
COLLECTION = 'collection-n96-tile4096-g8-positions-l6-s1701.fw'


def file(tile=4096, group=4, order='positions', level=6):
    return f'sparse-n24-tile{tile}-g{group}-{order}-l{level}-s1701.fw'


def samples(run, filename, pattern, network='typical', cache='cold'):
    result = [s for s in RUNS[run]['samples'] if s['file'] == filename and s['pattern'] == pattern and s['scenario'] == network and s['cache'] == cache]
    if not result:
        raise ValueError(f'Missing samples: {run}/{filename}/{pattern}/{network}/{cache}')
    return result


def median(ss, key):
    return statistics.median(s[key] for s in ss)


def number(value):
    return f'{value:,.0f}' if float(value).is_integer() else f'{value:,.2f}'


def ms(ss):
    return f"{median(ss, 'milliseconds'):.2f}"


def table(headers, rows):
    return '\n'.join(['| ' + ' | '.join(headers) + ' |', '|' + '|'.join(['---'] * len(headers)) + '|'] + ['| ' + ' | '.join(map(str, row)) + ' |' for row in rows])


env = RUNS['mixed-networks']['environment']
all_samples = [s for run in RUNS.values() for s in run['samples']]
body = f'''# Figwig JavaScript HTTP benchmark results

Measured on 2026-10-27. These are observations for synthetic files and this
implementation, not general speed guarantees. The standalone repository places
this report at `benchmarks/RESULTS.md`; no `packages/figwig` monorepo is needed.

## Environment and method

- CPU: {env['cpu']}, {env['logicalCpus']} logical CPUs; {env['totalMemoryBytes'] / 1024 ** 3:g} GiB RAM.
- Runtime: Node {env['node']}, {env['platform']}/{env['architecture']}.
- Reader query/decode implementation: commit `7dae4ad72bb5b3b7d01e327ef1381a75a99d24d5`;
  all seven runs were repeated after the final bounded-window planner changes.
- Writer: Python 3.12.13; Figwig 0.2.0; NumPy 2.5.4, Numba 0.68.0;
  upstream commit `c0e5d6522c677b9f03cd6831e2dbcea759866628`.
- Compression: Python zlib 1.2.12, level 6 except the explicitly uncompressed comparison.
- Browser performance was not measured here; actual browser correctness tests
  are separate from these Node HTTP benchmarks.
- {len(all_samples):,} recorded query samples across seven runs, including cold and warm
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

{table(['Scenario', 'Response latency', 'Shared bandwidth'], [['local', '0 ms', 'Unlimited'], ['fast', '20 ms', '100 Mbit/s'], ['typical', '80 ms', '50 Mbit/s'], ['high', '150 ms', '10 Mbit/s']])}

Raw samples and all phase/cache metrics are retained in
[`measurements/`](measurements/). Each JSON has an adjacent table including
median and interpolated p95. Three samples support exploratory comparisons;
they do not establish a reliable tail-latency distribution. Measurements were
collected during development on a shared workstation, without CPU-frequency
pinning or process isolation.

## Datasets

Every dataset has two chromosomes and seed 1701. The small sparse layout matrix
uses chromosome lengths 500,000 and 125,000, 24 tracks, density 0.02, four zoom
levels, all four tile sizes and all four position-group sizes. One track-order
file represents the same signals. In track order every track is its own group;
the writer ignores the requested group size. JSON manifests record that fact.

'''
initializations = [[scenario, f"{statistics.median(s['initializationMs'] for s in RUNS['mixed-networks']['samples'] if s['scenario'] == scenario):.2f}"] for scenario in ['local', 'fast', 'typical', 'high']]
body = body.replace('## Datasets', 'First-open header/metadata medians for the mixed file, excluded from the query tables:\n\n' + table(['Network', 'Initialization ms'], initializations) + '\n\n## Datasets')
rows = []
for run, filename, label in [('matrix-local', file(), 'Sparse24 compact baseline'), ('matrix-local', file(order='tracks'), 'Sparse24 track-order'), ('mixed-networks', MIXED, 'Mixed24'), ('profiles', DENSE, 'Dense8'), ('profiles', COLLECTION, 'Sparse96 collection'), ('large-sparse', file(), 'Sparse24 long chromosomes')]:
    dataset = RUNS[run]['datasets'][filename]
    rows.append([label, dataset['tracks'], ' + '.join(f'{v:,}' for v in dataset['chromosomes'].values()), number(dataset['bytes']), dataset['tile'], dataset['group'], dataset['order']])
body += table(['Dataset', 'Tracks', 'Chromosome lengths', 'File bytes', 'Tile bp', 'Tracks/group', 'Order'], rows)
body += '''

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

'''
rows = []
for group in [1, 4, 8, 24]:
    single = samples('matrix-typical', file(group=group), 'A-single-track-10kb')
    all_tracks = samples('matrix-typical', file(group=group), 'A-all-tracks-10kb')
    rows.append([f'positions, g{group}', ms(single), number(median(single, 'transferredBytes')), number(median(single, 'requests')), ms(all_tracks), number(median(all_tracks, 'transferredBytes')), number(median(all_tracks, 'requests'))])
single = samples('matrix-typical', file(order='tracks'), 'A-single-track-10kb')
all_tracks = samples('matrix-typical', file(order='tracks'), 'A-all-tracks-10kb')
rows.append(['tracks, g1', ms(single), number(median(single, 'transferredBytes')), number(median(single, 'requests')), ms(all_tracks), number(median(all_tracks, 'transferredBytes')), number(median(all_tracks, 'requests'))])
body += table(['Layout', '1 track ms', '1 track bytes', 'Requests', '24 tracks ms', '24 tracks bytes', 'Requests'], rows)
body += '''

Many one-track position groups minimize bytes for a single selected track, but
all-track reads need many separate group-index and data requests. Six allowed
concurrent requests turn those requests into several latency rounds. Grouping
reduces this request overhead while increasing transfer for small subsets.
Track-order blocks can span much more than a 10 kb interval in these sparse
signals, so short-window reads overfetch more block data. These observations
depend on signal density and block layout; they do not establish a universal
ranking of storage orders.

Within the group-4 position file, four selected tracks in one group transfer
'''
same = samples('matrix-typical', file(), 'C-same-group')
cross = samples('matrix-typical', file(), 'C-different-groups')
body += f"{number(median(same, 'transferredBytes'))} bytes over 100 kb, while four tracks in different groups transfer {number(median(cross, 'transferredBytes'))} bytes. Their medians are {ms(same)} and {ms(cross)} ms respectively.\n"
body += '''
## Tile size and whole-group indexes

One selected track, 10 kb window, group size four, compact sparse files:

'''
rows = []
for tile in [1024, 4096, 16384, 65536]:
    ss = samples('matrix-local', file(tile=tile), 'A-single-track-10kb', 'local')
    rows.append([number(tile), number(RUNS['matrix-local']['datasets'][file(tile=tile)]['bytes']), number(median(ss, 'indexBytes')), number(median(ss, 'dataBytes')), number(median(ss, 'transferredBytes')), ms(ss)])
body += table(['Tile bp', 'File bytes', 'Index bytes', 'Data bytes', 'Total query bytes', 'Local ms'], rows)
body += '''

Larger tiles reduce index bytes but eventually transfer more irrelevant bases.
The smallest transfer here occurs at tile size 16,384; this is a measured result
for this particular sparse signal and window alignment, not a tuning rule.
Position-index compression covers all live tiles of a selected group. Querying
a short interval therefore still loads that whole-group index.

'''
small = samples('matrix-typical', file(), 'A-single-track-10kb')
large = samples('large-sparse', file(), 'A-single-track-10kb')
body += table(['Same group-4 sparse profile', 'Genome bases', 'Index bytes', 'Data bytes', 'Total bytes', 'Typical ms'], [['Compact', '625,000', number(median(small, 'indexBytes')), number(median(small, 'dataBytes')), number(median(small, 'transferredBytes')), ms(small)], ['Long chromosomes', '10,000,000', number(median(large, 'indexBytes')), number(median(large, 'dataBytes')), number(median(large, 'transferredBytes')), ms(large)]])
body += '''

The window positions differ because the pattern centers each query within its
chromosome. Signal seed, density, tile size and grouping remain fixed. This
comparison demonstrates measured index growth, without extrapolating to a
whole human genome.

## Larger mixed-signal file and network conditions

Cold median times for the 390 MB mixed file. The requested large-region bins
cover the aligned prefix of chr1 (7,995,392 bp), six selected tracks and 65,536 bp
sum bins. Summary use is explicit and treats NaNs as zero; these stored sums
have the format's rounded tile-sum semantics.

'''
patterns = [('A-single-track-10kb', '1 track / 10 kb'), ('A-all-tracks-10kb', '24 tracks / 10 kb'), ('B-all-tracks-100kb', '24 tracks / 100 kb'), ('D-coarse-large-region', '6 tracks / coarse ~8 Mb sums'), ('E-panning', '6 overlapping pans'), ('F-zooming', 'Resolution changes'), ('G-track-selection', '24 → 6 → 6 → 24 tracks'), ('H-batch', 'Several regions batched'), ('H-sequential', 'Several regions sequential')]
rows = []
for pattern, label in patterns:
    rows.append([label] + [ms(samples('mixed-networks', MIXED, pattern, scenario)) for scenario in ['local', 'fast', 'typical', 'high']] + [ms(samples('mixed-networks', MIXED, pattern, 'typical', 'warm'))])
body += table(['Workload', 'Local ms', 'Fast ms', 'Typical ms', 'High-latency ms', 'Typical warm ms'], rows)
body += '\n\nSelected cold typical-connection metrics (the adjacent JSON retains all metrics):\n\n'
rows = []
for pattern, label in patterns[:6]:
    ss = samples('mixed-networks', MIXED, pattern)
    rows.append([label, number(median(ss, 'requests')), number(median(ss, 'indexBytes')), number(median(ss, 'dataBytes')), number(median(ss, 'chunksFetched')), number(median(ss, 'chunksDecompressed')), f"{median(ss, 'decompressionMs'):.2f}", f"{median(ss, 'decodingMs'):.2f}", number(median(ss, 'cacheBytes'))])
body += table(['Workload', 'Requests', 'Index bytes', 'Data bytes', 'Chunks fetched', 'Chunks inflated', 'Data inflate ms', 'Decode ms', 'Retained cache bytes'], rows)
body += '''

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

'''
rows = []
for pattern in ['E-panning', 'F-zooming', 'G-track-selection']:
    ss = samples('step-traces', MIXED, pattern)
    for index in range(len(ss[0]['steps'])):
        steps = [sample['steps'][index] for sample in ss]
        rows.append([pattern[0], steps[0]['name'], f"{statistics.median(s['milliseconds'] for s in steps):.2f}", number(statistics.median(s['diagnostics']['readRequests'] for s in steps)), number(statistics.median(s['diagnostics']['indexBytes'] for s in steps)), number(statistics.median(s['diagnostics']['dataBytes'] for s in steps))])
body += table(['Pattern', 'Step', 'Median ms', 'Requests', 'Index bytes', 'Data bytes'], rows)
warm = [s for s in all_samples if s['cache'] == 'warm']
body += f"\n\nAcross the recorded {len(warm):,} warm samples, the total HTTP request count is {sum(s['requests'] for s in warm):,}. Output allocation and copying still take time, even when all required decoded chunks remain cached. These measured decoded working sets fit the configured caches; larger queries can evict chunks and require more reads.\n"
body += '''
## Dense signals and a 96-track collection

Typical-connection cold medians; A's all-track case intentionally caps selection
at 24 tracks, whereas I selects every track in the file.

'''
rows = []
for filename, label, pattern in [(DENSE, 'Dense8, one / 10 kb', 'A-single-track-10kb'), (DENSE, 'Dense8, all8 / 100 kb', 'B-all-tracks-100kb'), (COLLECTION, 'Collection96, one / 10 kb', 'A-single-track-10kb'), (COLLECTION, 'Collection96, first24 / 10 kb', 'A-all-tracks-10kb'), (COLLECTION, 'Collection96, all96 / 10 kb', 'I-all-file-tracks-10kb'), (COLLECTION, 'Collection96, four scattered / 10 kb', 'I-scattered-file-tracks-10kb')]:
    ss = samples('profiles', filename, pattern)
    rows.append([label, ms(ss), number(median(ss, 'requests')), number(median(ss, 'indexBytes')), number(median(ss, 'dataBytes')), number(median(ss, 'cacheBytes'))])
body += table(['Workload', 'Median ms', 'Requests', 'Index bytes', 'Data bytes', 'Retained cache bytes'], rows)
body += '''

The 96-track file has twelve position groups. Reading all 96 tracks loads more
groups and consumes additional concurrency rounds; changing only which four
tracks are selected also changes how many groups are needed. This is a measured
cost of the chosen layout, not evidence that a track count alone predicts
performance.

## Compression and batching tradeoffs

'''
rows = []
for level, run in [(0, 'compression'), (6, 'matrix-typical')]:
    name = file(level=level)
    ss = samples(run, name, 'B-all-tracks-100kb')
    rows.append([level, number(RUNS[run]['datasets'][name]['bytes']), ms(ss), number(median(ss, 'transferredBytes')), number(median(ss, 'chunksDecompressed'))])
body += table(['Compression level', 'File bytes', 'All24 / 100 kb typical ms', 'Query bytes', 'Chunks inflated'], rows)
body += '''

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
.venv/bin/python benchmarks/scripts/generate.py --upstream /tmp/figwig-reference \\
  --profile sparse --length 500000 --second-length 125000 --matrix
.venv/bin/python benchmarks/scripts/generate.py --upstream /tmp/figwig-reference \\
  --profile mixed
.venv/bin/python benchmarks/scripts/generate.py --upstream /tmp/figwig-reference \\
  --profile dense --tracks 8 --length 2000000 --second-length 500000
.venv/bin/python benchmarks/scripts/generate.py --upstream /tmp/figwig-reference \\
  --profile collection --tracks 96 --length 2000000 --second-length 500000 --group 8
.venv/bin/python benchmarks/scripts/generate.py --upstream /tmp/figwig-reference \\
  --profile sparse --output benchmarks/fixtures/large-sparse
.venv/bin/python benchmarks/scripts/generate.py --upstream /tmp/figwig-reference \\
  --profile sparse --length 500000 --second-length 125000 --level 0
```

Then run the retained query configurations:

```sh
npm run benchmark -- --scenarios local --patterns A,B,C,H --repetitions 3 \\
  --output benchmarks/measurements/matrix-local.json benchmarks/fixtures/sparse*-l6-*.fw
npm run benchmark -- --scenarios typical --patterns A,B,C,H --repetitions 3 \\
  --output benchmarks/measurements/matrix-typical.json \\
  sparse-n24-tile4096-g1-positions-l6-s1701.fw \\
  sparse-n24-tile4096-g4-positions-l6-s1701.fw \\
  sparse-n24-tile4096-g8-positions-l6-s1701.fw \\
  sparse-n24-tile4096-g24-positions-l6-s1701.fw \\
  sparse-n24-tile4096-g4-tracks-l6-s1701.fw
npm run benchmark -- --scenarios all --repetitions 3 \\
  --output benchmarks/measurements/mixed-networks.json \\
  mixed-n24-tile4096-g4-positions-l6-s1701.fw
npm run benchmark -- --scenarios local,typical --patterns A,B,D,E,F,G,H,I \\
  --repetitions 3 --output benchmarks/measurements/profiles.json \\
  dense-n8-tile4096-g4-positions-l6-s1701.fw \\
  collection-n96-tile4096-g8-positions-l6-s1701.fw
npm run benchmark -- --scenarios local,typical --patterns A,B --repetitions 3 \\
  --output benchmarks/measurements/compression.json \\
  sparse-n24-tile4096-g4-positions-l0-s1701.fw
npm run benchmark -- --scenarios local,typical --patterns A,D,H --repetitions 3 \\
  --directory benchmarks/fixtures/large-sparse \\
  --output benchmarks/measurements/large-sparse.json
npm run benchmark -- --scenarios typical --patterns E,F,G --repetitions 3 \\
  --output benchmarks/measurements/step-traces.json \\
  mixed-n24-tile4096-g4-positions-l6-s1701.fw
python3 benchmarks/scripts/report.py
```

The matrix shell glob selects only the 17 level-six sparse files. The large sparse file uses a separate `large-sparse` output directory
because it intentionally shares a configuration filename with the compact file.
The separate [`DECOMPRESSION.md`](DECOMPRESSION.md) report evaluates decompressor
alternatives with independently retained raw timing samples.
'''
(ROOT / 'RESULTS.md').write_text(body)
print(f'Wrote {ROOT / "RESULTS.md"}, based on {len(all_samples)} actual samples')
