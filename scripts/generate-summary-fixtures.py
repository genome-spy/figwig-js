#!/usr/bin/env python3
"""Generate opt-in summary fixtures through Python and independent v1 readers.

The original nine pinned v1 fixtures are untouched. The manifest pins the
writer revision and every relevant source hash.
An existing snapshot is refreshed only with --update-source-snapshot.
Use the canonical entry point: scripts/generate-fixtures.py --summary-upstream
/absolute/path/to/figwig [--update-source-snapshot].
"""

import argparse
import hashlib
import importlib.util
import json
import os
import platform
import subprocess
import sys
import zlib
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
TILE = 16
SEED = 20261031
CHROMS = {"chrA": 191997, "chrB": 595, "empty": 257}
TRACKS = [{"name": f"signal{i}", "dtype": "float64" if i == 0 else "float32"}
          for i in range(9)]


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def source_snapshot(upstream):
    files = sorted((upstream / "figwig").glob("*.py"))
    files += [upstream / "tests/format_reference.py", upstream / "tests/summary_reference.py",
              upstream / "docs/format.rst", upstream / "docs/summary_restarts.rst"]
    return {
        "baseRevision": subprocess.check_output(
            ["git", "-C", str(upstream), "rev-parse", "HEAD"], text=True).strip(),
        "sourceSha256": {str(p.relative_to(upstream)): sha256(p.read_bytes()) for p in files},
        "trackedPatchSha256": sha256(subprocess.check_output(
            ["git", "-C", str(upstream), "diff", "--binary", "HEAD", "--", "figwig", "tests", "docs"])),
    }


def signals():
    rng = np.random.default_rng(SEED)
    result = {}
    for name, length in CHROMS.items():
        values = np.zeros((1, len(TRACKS), length), dtype=np.float64)
        bins = np.arange((length + TILE - 1) // TILE)
        if name != "empty":
            for track in range(7):
                values[0, track, bins * TILE] = rng.normal(0, track + 1, len(bins)).astype(np.float32)
            values[0, 0, 0] = 2**24 + 1  # raw float64 and rounded base-sum precision
            values[0, 0, 16] = 0
            values[0, 1, 32:36] = np.nan
            # The last track has available empty summaries despite explicit NaNs.
            values[0, 7, 8:12] = np.nan
            for local in bins[::257]:
                at = int(local * TILE)
                if at + 1 < length:
                    values[0, 6, at:at + 2] = [3, -3]
            if name == "chrA":
                values[:, :, 4096 * TILE:6144 * TILE] = 0
        result[name] = values
    return result


def number(value):
    value = float(value)
    if np.isnan(value):
        return "NaN"
    if np.isposinf(value):
        return "Infinity"
    if np.isneginf(value):
        return "-Infinity"
    if value == 0 and np.signbit(value):
        return "-0"
    return value


def query_specs():
    queries = [
        {"name": "base", "chromosome": "chrA", "start": 2048 * TILE,
         "end": 2112 * TILE, "binSize": TILE, "tracks": [0, 1, 6, 7]},
        {"name": "same-window-pan", "chromosome": "chrA", "start": 2064 * TILE,
         "end": 2128 * TILE, "binSize": TILE, "tracks": [0, 1, 6, 7]},
        {"name": "next-window-pan", "chromosome": "chrA", "start": 6144 * TILE,
         "end": 6208 * TILE, "binSize": TILE, "tracks": [0, 1, 6, 7]},
        {"name": "empty-window", "chromosome": "chrA", "start": 4096 * TILE,
         "end": 4160 * TILE, "binSize": TILE, "tracks": [0, 1, 6, 7]},
        {"name": "zoom", "chromosome": "chrA", "start": 2048 * TILE,
         "end": 2304 * TILE, "binSize": 4 * TILE, "tracks": [0, 1, 6, 7]},
        {"name": "partial-end", "chromosome": "chrA", "start": 11936 * TILE,
         "end": CHROMS["chrA"], "binSize": TILE, "tracks": [0, 6, 7]},
        {"name": "short-chromosome", "chromosome": "chrB", "start": 0,
         "end": CHROMS["chrB"], "binSize": TILE, "tracks": [0, 1, 6, 7]},
        {"name": "empty-chromosome", "chromosome": "empty", "start": 0,
         "end": CHROMS["empty"], "binSize": TILE, "tracks": [0, 7]},
        {"name": "empty-summary", "chromosome": "chrA", "start": 0,
         "end": 64 * TILE, "binSize": TILE, "tracks": [8]},
        {"name": "overview", "chromosome": "chrA", "start": 0,
         "end": CHROMS["chrA"], "binSize": 64 * TILE, "tracks": [0, 1, 6, 7]},
    ]

    return [{**query, "aggregation": "sum"} for query in queries]


def expected_query(file, query):
    chroms = list(file.chrom_sizes)
    chromosome = chroms.index(query["chromosome"])
    tile_counts = [(length + TILE - 1) // TILE for length in file.chrom_sizes.values()]
    factor = 1
    for k in range(1, len(file.groups[0].zooms) + 1):
        size = TILE * 4**k
        if query["start"] % size == 0 and query["binSize"] % size == 0 and (
                query["end"] % size == 0 or query["end"] == file.chrom_sizes[query["chromosome"]]):
            factor = 4**k
    span = TILE * factor
    offset = sum((n + factor - 1) // factor for n in tile_counts[:chromosome])
    n_output = (query["end"] - query["start"] + query["binSize"] - 1) // query["binSize"]
    output = {}
    for track in query["tracks"]:
        group_id = file.tracks[track]["group"]
        slot = file.group_tracks[group_id].index(track)
        group = file.groups[group_id]
        ids, sums = group.summary if factor == 1 else group.zooms[(factor.bit_length() - 1) // 2 - 1][1:]
        values = np.zeros(n_output, dtype=np.float64)
        for global_bin, row in zip(ids, sums):
            local_bin = int(global_bin) - offset
            position = local_bin * span
            if query["start"] <= position < query["end"]:
                values[(position - query["start"]) // query["binSize"]] += row[slot]
        output[file.tracks[track]["name"]] = [number(v) for v in values]
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--upstream", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=ROOT / "test/fixtures")
    parser.add_argument("--update-source-snapshot", action="store_true")
    args = parser.parse_args()
    upstream = args.upstream.resolve()
    args.output.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("NUMBA_CACHE_DIR", str(ROOT / "benchmarks/results/summary-fixtures/numba"))
    sys.path.insert(0, str(upstream))
    from figwig import FigWigReader, FigWigWriter
    from tests.summary_reference import read_index

    loader = importlib.util.spec_from_file_location("legacy_summary_reference", ROOT / "scripts/vendor/format_reference.py")
    reference = importlib.util.module_from_spec(loader)
    loader.loader.exec_module(reference)
    snapshot = source_snapshot(upstream)
    manifest_path = args.output / "summary-expected.json"
    if manifest_path.exists() and not args.update_source_snapshot:
        prior = json.loads(manifest_path.read_text())
        if prior["provenance"]["writer"] != snapshot:
            raise SystemExit("Writer snapshot changed; inspect it and use --update-source-snapshot explicitly")
    dataset = signals()
    dataset_hash = sha256(b"".join(values.astype("<f8").tobytes() for values in dataset.values()))
    result = {
        "provenance": {"writer": snapshot, "generatorSha256": sha256(Path(__file__).read_bytes()),
                       "python": platform.python_version(), "numpy": np.__version__,
                       "zlib": zlib.ZLIB_RUNTIME_VERSION},
        "dataset": {"seed": SEED, "tile": TILE, "chromosomes": CHROMS, "tracks": TRACKS,
                    "signalSha256": dataset_hash},
        "queries": query_specs(), "files": {},
    }
    expected = None
    for order in ("positions", "tracks"):
        baseline = None
        for enabled in (False, True):
            name = f"summary_{order}" + ("" if enabled else "_legacy")
            target = args.output / (name + ".fw")
            with FigWigWriter(target, CHROMS, TRACKS, tile=TILE, groups=8,
                              order=order, level=6, zooms=3, n_jobs=2,
                              summary_index=enabled, genome="summary-conformance",
                              attributes={"seed": SEED}) as writer:
                for chrom, values in dataset.items():
                    # Track 8 has no write calls, hence truly empty summaries in
                    # both orders; the NaN-only track retains v1 writer behavior.
                    writer.write(chrom, [0], values[:, :8], tracks=list(range(8)))
            file = reference.File(target)
            python = FigWigReader(target, verify=True)
            dense = file.dense()
            for chrom, values in dense.items():
                actual = python.read(chrom, [0], values.shape[1], dtype="float64")[0]
                assert np.array_equal(actual, values, equal_nan=True), (name, chrom, "Python/raw")
                assert np.array_equal(np.signbit(actual), np.signbit(values)), (name, chrom, "sign")
                assert np.array_equal(values, dataset[chrom][0], equal_nan=True), (name, chrom, "input")
            queries = [expected_query(file, query) for query in result["queries"]]
            if expected is None:
                expected = queries
            assert queries == expected, (name, "independent summary results")
            index = read_index(target)
            assert (index is not None) == enabled, (name, "extension presence")
            if baseline is None:
                baseline = file
            else:
                for old, new in zip(baseline.groups, file.groups):
                    pairs = [(old.summary, new.summary)] + [(a[1:], b[1:]) for a, b in zip(old.zooms, new.zooms)]
                    for left, right in pairs:
                        assert np.array_equal(left[0], right[0]) and left[1].tobytes() == right[1].tobytes()
            levels = []
            if index:
                for group in index["groups"]:
                    for level in group["levels"]:
                        levels.append({key: level[key] for key in ["level", "factor", "source_offset", "source_rows", "source_bytes", "source_crc", "window_bins", "index_offset"]} | {"group": group["group"]})
            result["files"][name] = {
                "file": target.name, "order": order, "summaryIndex": enabled,
                "size": target.stat().st_size, "sha256": sha256(target.read_bytes()),
                "groupCount": len(file.groups), "levels": levels,
            }
    for query, values in zip(result["queries"], expected):
        query["expected"] = values
    manifest_path.write_text(json.dumps(result, indent=2, allow_nan=False) + "\n")
    print(json.dumps({"manifest": str(manifest_path), "files": len(result["files"]), "signalSha256": dataset_hash}))


if __name__ == "__main__":
    main()
