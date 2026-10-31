#!/usr/bin/env python3
"""Generate small upstream conformance fixtures and independent sparse oracles.

Run with the pinned environment documented in test/fixtures/README.md. Expected
values come from the standalone specification reader, checked against Python's
FigWigReader. The JavaScript implementation is never imported here.
"""

import argparse
import hashlib
import importlib.metadata
import json
import platform
import random
import subprocess
import sys
import zlib
from pathlib import Path
from urllib.parse import unquote, urlparse

# Keep one canonical entry point for independently generated expectations. The
# experimental writer is a different pinned snapshot than the nine v1 fixtures.
if __name__ == '__main__' and any(
        arg.partition('=')[0] == '--summary-upstream' for arg in sys.argv[1:]):
    parser = argparse.ArgumentParser(description='Generate optional summary-index fixtures')
    parser.add_argument('--summary-upstream', type=Path, required=True)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--update-source-snapshot', action='store_true')
    args = parser.parse_args()
    command = [sys.executable, str(Path(__file__).with_name('generate-summary-fixtures.py')),
               '--upstream', str(args.summary_upstream)]
    if args.output is not None:
        command += ['--output', str(args.output)]
    if args.update_source_snapshot:
        command.append('--update-source-snapshot')
    subprocess.run(command, check=True)
    raise SystemExit(0)

import figwig  # noqa: E402
import numpy as np  # noqa: E402

sys.path.insert(0, str(Path(__file__).parent / "vendor"))
import format_fixtures as fixtures  # noqa: E402
import format_reference as reference  # noqa: E402

COMMIT = "c0e5d6522c677b9f03cd6831e2dbcea759866628"
ROOT = Path(__file__).resolve().parents[1] / "test" / "fixtures"


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
    return int(value) if value.is_integer() else value


def nested(values):
    return [[number(v) for v in row] for row in values]


def verify_upstream():
    """Refuse an arbitrary same-version install as a supposedly pinned oracle."""
    direct_url = importlib.metadata.distribution("figwig").read_text("direct_url.json")
    if direct_url is None:
        raise RuntimeError("Install Figwig using scripts/requirements-fixtures.txt; source provenance is missing")
    source = json.loads(direct_url)
    commit = source.get("vcs_info", {}).get("commit_id")
    if commit is None and source.get("url", "").startswith("file:"):
        directory = unquote(urlparse(source["url"]).path)
        commit = subprocess.check_output(["git", "-C", directory, "rev-parse", "HEAD"], text=True).strip()
        subprocess.run(["git", "-C", directory, "diff", "--quiet", "HEAD", "--", "figwig"], check=True)
    if commit != COMMIT:
        raise RuntimeError(f"Expected Figwig source {COMMIT}, found {commit}")


def main():
    verify_upstream()
    ROOT.mkdir(parents=True, exist_ok=True)
    paths = fixtures.write_all(ROOT)
    # Dense NaN tiles model gaps in regional BigWig conversions. Verify these
    # additions with the same pinned writer and independent specification reader.
    for order in ("positions", "tracks"):
        name = f"nan_{order}"
        path = ROOT / f"{name}.fw"
        tracks = [{"name": f"signal{i}", "dtype": "float32"} for i in range(4)]
        with figwig.FigWigWriter(path, {"missing": 128, "mixed": 64, "unwritten": 64}, tracks,
                tile=64, groups=4, order=order, level=6, zooms=1, n_jobs=2) as writer:
            writer.write("missing", [0], np.full((1, 4, 128), np.nan))
            mixed = np.full((1, 4, 64), np.nan)
            mixed[0, 0, -1] = 0
            mixed[0, 1, -1] = 2.5
            writer.write("mixed", [0], mixed)
        paths[name] = path
    result = {
        "provenance": {
            "repository": "https://github.com/jmschrei/figwig",
            "commit": COMMIT,
            "version": figwig.__version__,
            "python": platform.python_version(),
            "numpy": np.__version__,
            "numba": importlib.metadata.version("numba"),
            "llvmlite": importlib.metadata.version("llvmlite"),
            "zlib": zlib.ZLIB_RUNTIME_VERSION,
            "querySeed": 271828,
            "specialNumbers": ["NaN", "Infinity", "-Infinity", "-0"],
        },
        "datasets": {},
        "files": {},
    }
    all_kinds, all_codes, stored_flags = set(), set(), set()
    canonical_signals = {}
    for name, path in paths.items():
        spec = reference.File(path)
        dense = spec.dense()
        reader = figwig.FigWigReader(path, verify=True)
        assert spec.metadata == reader._metadata, (name, "metadata")
        assert spec.stats.tobytes() == reader.stats.tobytes(), (name, "statistics")
        assert spec.header.order == reader.order and spec.header.tile == reader.tile
        for chrom, values in dense.items():
            actual = reader.read(chrom, [0], values.shape[1], dtype="float64")[0]
            assert np.array_equal(values, actual, equal_nan=True), (name, chrom)
            assert np.array_equal(np.signbit(values), np.signbit(actual)), (name, chrom)
        dataset = "nan" if name.startswith("nan_") else "blocks" if name == "blocks" else "appended" if name in ("appended", "merged") else "toy"
        if dataset in canonical_signals:
            for chrom, values in dense.items():
                assert np.array_equal(values, canonical_signals[dataset][chrom], equal_nan=True), (name, chrom, "deduplicated dataset differs")
        else:
            canonical_signals[dataset] = dense
        if dataset not in result["datasets"]:
            signals = {}
            for chrom, values in dense.items():
                tracks = {}
                for track, row in zip(spec.tracks, values):
                    positions = np.flatnonzero(row != 0)
                    if len(positions):
                        tracks[track["name"]] = {
                            "positions": positions.tolist(),
                            "values": [number(v) for v in row[positions]],
                        }
                signals[chrom] = {"length": values.shape[1], "tracks": tracks}
            rng = random.Random(271828)
            queries = []
            names = [t["name"] for t in spec.tracks]
            for chrom, length in spec.chrom_sizes.items():
                boundaries = [(0, min(length, 10)), (max(0, length - 19), length), (0, length)]
                if length >= 70:
                    boundaries += [(60, 70), (63, min(length, 129))]
                for start, end in boundaries:
                    selected = list(dict.fromkeys(names[:15] + names[-1:]))
                    queries.append({"chromosome": chrom, "start": start, "end": end, "tracks": selected})
                for _ in range(20):
                    start = rng.randrange(length + 1)
                    end = rng.randrange(start, length + 1)
                    selected = rng.sample(names, min(len(names), rng.randint(1, 9)))
                    if len(names) > 15:
                        selected += rng.sample(names[:15], 3)
                        selected = list(dict.fromkeys(selected))
                    queries.append({"chromosome": chrom, "start": start, "end": end, "tracks": selected})
            result["datasets"][dataset] = {"chromosomes": signals, "queries": queries}
        groups = []
        for group_id, group in enumerate(spec.groups):
            record = {}
            if group.live is not None:
                record["kinds"] = group.live["kind"].tolist()
                record["tiles"] = group.live["tile"].tolist()
                for kind in group.live["kind"]:
                    all_kinds.add(int(kind) & 7)
                    all_codes.add((int(kind) >> 3) & 15)
                    stored_flags.add(bool(int(kind) & 128))
            else:
                record["blocks"] = [{field: int(block[field]) for field in reference.BLOCK.names} for block in group.blocks]
            if group.summary is not None:
                ids, sums = group.summary
                reader_ids, reader_sums = reader._tile_sums_of(group_id)
                assert np.array_equal(ids, reader_ids) and sums.tobytes() == reader_sums.tobytes(), (name, group_id, "summary")
                record["summary"] = {"ids": ids.tolist(), "sums": nested(sums)}
            else:
                assert reader._tile_sums_of(group_id) is None
            reader_zooms = reader._zoom_levels_of(group_id)
            assert len(group.zooms) == len(reader_zooms)
            for (factor, ids, sums), (other_factor, other_ids, other_sums) in zip(group.zooms, reader_zooms):
                assert factor == other_factor and np.array_equal(ids, other_ids) and sums.tobytes() == other_sums.tobytes(), (name, group_id, "zoom")
            record["zooms"] = [{"factor": factor, "ids": ids.tolist(), "sums": nested(sums)} for factor, ids, sums in group.zooms]
            groups.append(record)
        stats = [{field: number(row[field]) for field in reference.STATS.names} for row in spec.stats]
        result["files"][name] = {
            "dataset": dataset,
            "size": path.stat().st_size,
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "order": spec.header.order,
            "tile": spec.header.tile,
            "metadata": spec.metadata,
            "stats": stats,
            "groups": groups,
        }
        print(f"{name}: {path.stat().st_size:,} bytes; all values agree between independent and package readers")
    assert all_kinds == {1, 2, 3, 4}, all_kinds
    assert all_codes == set(range(9)), all_codes
    assert stored_flags == {False, True}, stored_flags
    result["coverage"] = {"chunkKinds": sorted(all_kinds), "elementCodes": sorted(all_codes), "storedFlags": sorted(stored_flags)}
    (ROOT / "expected.json").write_text(json.dumps(result, allow_nan=False, separators=(",", ":")) + "\n")
    print(f"expected.json: {(ROOT / 'expected.json').stat().st_size:,} bytes")


if __name__ == "__main__":
    main()
