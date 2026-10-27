#!/usr/bin/env python3
"""Print selected median benchmark metrics from raw JSON (no invented samples)."""
import argparse
import json
import statistics
from collections import defaultdict

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('results', nargs='+')
parser.add_argument('--patterns', default='A,B,C,D,E,F,G,H,I')
args = parser.parse_args()
patterns = args.patterns.split(',')
for path in args.results:
    result = json.load(open(path))
    print(f'\n{path}')
    groups = defaultdict(list)
    for sample in result['samples']:
        if any(sample['pattern'] == pattern or sample['pattern'].startswith(pattern + '-') for pattern in patterns):
            groups[(sample['file'], sample['scenario'], sample['pattern'], sample['cache'])].append(sample)
    print('| File | Network | Pattern | Cache | ms | Requests | Bytes | Index | Data | Inflated | Inflate ms | Decode ms | Cache bytes |')
    print('|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|')
    for key, samples in groups.items():
        def median(metric):
            return statistics.median(item[metric] for item in samples)
        print('| ' + ' | '.join(key) + ' | ' + ' | '.join(f'{median(metric):.2f}' if metric.endswith('Ms') or metric == 'milliseconds' else f'{median(metric):g}' for metric in ('milliseconds', 'requests', 'transferredBytes', 'indexBytes', 'dataBytes', 'chunksDecompressed', 'decompressionMs', 'decodingMs', 'cacheBytes')) + ' |')
