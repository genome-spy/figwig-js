#!/usr/bin/env python3
"""Deterministic benchmark signals written by pinned upstream FigWigWriter.

This script creates no JavaScript correctness expectations. It only generates
performance workloads. Small test fixtures have a separate regeneration script.
"""

import argparse
import json
import pathlib
import subprocess
import sys
import time

PIN = 'c0e5d6522c677b9f03cd6831e2dbcea759866628'


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--upstream', type=pathlib.Path, required=True)
    parser.add_argument('--output', type=pathlib.Path, default=pathlib.Path('benchmarks/fixtures'))
    parser.add_argument('--profile', choices=['sparse', 'dense', 'mixed', 'collection'], default='mixed')
    parser.add_argument('--tracks', type=int, default=24)
    parser.add_argument('--length', type=int, default=8_000_000, help='chr1 length')
    parser.add_argument('--second-length', type=int, default=2_000_000, help='chr2 length')
    parser.add_argument('--tile', type=int, choices=[1024, 4096, 16384, 65536], default=4096)
    parser.add_argument('--group', type=int, default=4)
    parser.add_argument('--order', choices=['positions', 'tracks'], default='positions')
    parser.add_argument('--level', type=int, default=6)
    parser.add_argument('--zooms', type=int, default=4)
    parser.add_argument('--density', type=float, default=0.02)
    parser.add_argument('--seed', type=int, default=1701)
    parser.add_argument('--chunk-bases', type=int, default=1_048_576)
    parser.add_argument('--matrix', action='store_true', help='Generate all 4 tile sizes x 4 group sizes, in position order, plus the requested track-order layout')
    return parser.parse_args()


def main():
    args = arguments()
    actual = subprocess.check_output(['git', '-C', str(args.upstream), 'rev-parse', 'HEAD'], text=True).strip()
    if actual != PIN:
        raise SystemExit(f'Expected upstream commit {PIN}, found {actual}')
    sys.path.insert(0, str(args.upstream.resolve()))
    import numpy as np
    from figwig import FigWigWriter

    if min(args.tracks, args.length, args.second_length, args.group, args.chunk_bases) < 1:
        raise SystemExit('Tracks, chromosome lengths, group size, and chunk size must be positive')
    if not 0 <= args.density <= 1:
        raise SystemExit('Density must be between 0 and 1')
    args.output.mkdir(parents=True, exist_ok=True)
    configs = [(args.tile, args.group, args.order)]
    if args.matrix:
        configs = [(tile, group, 'positions') for tile in (1024, 4096, 16384, 65536) for group in (1, 4, 8, 24)]
        configs += [(args.tile, args.group, 'tracks')]
    for tile, group, order in configs:
        name = f'{args.profile}-n{args.tracks}-tile{tile}-g{group}-{order}-l{args.level}-s{args.seed}'
        path = args.output / f'{name}.fw'
        chroms = {'chr1': args.length, 'chr2': args.second_length}
        track_specs = []
        for index in range(args.tracks):
            is_count = args.profile in ('sparse', 'collection') or (args.profile == 'mixed' and index % 2 == 0)
            track_specs.append({'name': f'track{index}', 'dtype': 'uint32' if is_count else 'float32', 'assay': 'count' if is_count else 'continuous'})
        parameters = {
            'upstream_commit': PIN, 'profile': args.profile, 'tracks': args.tracks,
            'chromosomes': chroms, 'tile': tile, 'group': group if order == 'positions' else 1, 'requested_group': group, 'order': order,
            'compression_level': args.level, 'compression_engine': 'zlib', 'zooms': args.zooms,
            'density': args.density, 'seed': args.seed, 'chunk_bases': args.chunk_bases,
        }
        before = time.perf_counter()
        # A dedicated RNG per track means changing grouping or layout does not
        # change the underlying values; every compared file represents the same
        # signals when its other parameters are identical.
        rngs = [np.random.default_rng(np.random.SeedSequence([args.seed, index])) for index in range(args.tracks)]
        with FigWigWriter(path, chroms, track_specs, genome='synthetic', attributes={'benchmark': parameters}, tile=tile, groups=group, order=order, level=args.level, engine='zlib', zooms=args.zooms, n_jobs=2) as writer:
            for chrom, length in chroms.items():
                for start in range(0, length, args.chunk_bases):
                    width = min(args.chunk_bases, length - start)
                    values = np.zeros((1, args.tracks, width), dtype=np.float64)
                    positions = np.arange(start, start + width)
                    for index, (track, rng) in enumerate(zip(track_specs, rngs)):
                        if track['dtype'] == 'uint32':
                            mask = rng.random(width) < args.density
                            values[0, index, mask] = rng.integers(1, 32, int(mask.sum()))
                        else:
                            row = (np.sin(positions / (1000 + index * 173)) + 2 + rng.normal(0, .05, width)).astype(np.float32)
                            if args.profile == 'mixed':
                                row[(positions // 8192 + index) % 17 == 0] = np.nan
                            values[0, index] = row
                    writer.write(chrom, [start], values)
        parameters['file'] = path.name
        parameters['file_bytes'] = path.stat().st_size
        parameters['generation_seconds'] = time.perf_counter() - before
        (args.output / f'{name}.json').write_text(json.dumps(parameters, indent=2) + '\n')
        print(json.dumps(parameters), flush=True)


if __name__ == '__main__':
    main()
