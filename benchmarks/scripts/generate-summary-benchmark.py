#!/usr/bin/env python3
"""Write paired ordinary/restarted benchmarks with the same sparse raw signal.

Each output runs in a fresh child process. One small untimed write warms kernel
signatures before timing construction. Peak RSS includes imports, warmup, input
arrays and the writer, and is reported for that independent process.
"""

import argparse
import hashlib
import importlib.util
import json
import os
import platform
import resource
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--upstream", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=ROOT / "benchmarks/fixtures/summary-restarts")
    parser.add_argument("--bins", type=int, default=65536)
    parser.add_argument("--tracks", type=int, default=8)
    parser.add_argument("--tile", type=int, default=16)
    parser.add_argument("--seed", type=int, default=1701)
    parser.add_argument("--single", choices=["positions_legacy", "positions_restarts", "tracks_legacy", "tracks_restarts"], help=argparse.SUPPRESS)
    return parser.parse_args()


def main():
    args = arguments()
    args.output = args.output.resolve()
    args.upstream = args.upstream.resolve()
    args.output.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("NUMBA_CACHE_DIR", str(ROOT / "benchmarks/results/summary-benchmark-numba"))
    if args.bins < 16384 or args.tracks < 1 or args.tile < 16 or args.tile > 65536 or args.tile & (args.tile - 1):
        raise SystemExit("At least 16,384 bins, positive tracks and a supported power-of-two tile size are required")
    if args.single is None:
        for mode in ["positions_legacy", "positions_restarts", "tracks_legacy", "tracks_restarts"]:
            subprocess.run([sys.executable, str(Path(__file__).resolve()),
                            "--upstream", str(args.upstream), "--output", str(args.output),
                            "--bins", str(args.bins), "--tracks", str(args.tracks),
                            "--tile", str(args.tile), "--seed", str(args.seed), "--single", mode], check=True)
        files = {mode: json.loads((args.output / f"{mode}.json").read_text()) for mode in
                 ["positions_legacy", "positions_restarts", "tracks_legacy", "tracks_restarts"]}
        assert len({file["signalSha256"] for file in files.values()}) == 1
        for order in ["positions", "tracks"]:
            assert files[f"{order}_legacy"]["summariesSha256"] == files[f"{order}_restarts"]["summariesSha256"]
            assert files[f"{order}_legacy"]["rawDataSha256"] == files[f"{order}_restarts"]["rawDataSha256"]
        manifest = {"files": files, "generatorSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
        (args.output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        print(json.dumps({"manifest": str(args.output / "manifest.json")}))
        return

    sys.path.insert(0, str(args.upstream))
    from figwig import FigWigWriter
    from tests import format_reference
    from tests.summary_reference import read_index

    loader = importlib.util.spec_from_file_location("summary_fixture_tools", ROOT / "scripts/generate-summary-fixtures.py")
    tools = importlib.util.module_from_spec(loader)
    loader.loader.exec_module(tools)
    snapshot = tools.source_snapshot(args.upstream)
    source_dir = args.output / "writer-source"
    for name in snapshot["sourceSha256"]:
        copy = source_dir / name
        copy.parent.mkdir(parents=True, exist_ok=True)
        copy.write_bytes((args.upstream / name).read_bytes())
    (args.output / "writer-source.patch").write_bytes(subprocess.check_output(
        ["git", "-C", str(args.upstream), "diff", "--binary", "HEAD", "--", "figwig", "tests", "docs"]))

    order, mode = args.single.rsplit("_", 1)
    indexed = mode == "restarts"
    chroms = {"chr1": args.bins * args.tile - 3,
              "chr2": min(2048, max(1, args.bins // 16)) * args.tile + 5,
              "empty": 1024 * args.tile - 7}
    tracks = [{"name": f"track{i}", "dtype": "float32"} for i in range(args.tracks)]
    rng = np.random.default_rng(args.seed)
    data = []
    signal = hashlib.sha256()
    input_started = time.perf_counter()
    for name, length in chroms.items():
        bins = (length + args.tile - 1) // args.tile
        if name == "empty":
            continue
        tile_ids = np.arange(bins, dtype=np.int64)
        if name == "chr1" and bins > 10240:
            tile_ids = tile_ids[(tile_ids < 8192) | (tile_ids >= 10240)]
        values = rng.normal(size=(args.tracks, len(tile_ids))).astype("<f4")
        positions = np.tile(tile_ids * args.tile, args.tracks)
        track_ids = np.repeat(np.arange(args.tracks, dtype=np.int64), len(tile_ids))
        for array in [positions.astype("<i8"), track_ids.astype("<i8"), values]:
            signal.update(array.tobytes())
        data.append((name, positions, track_ids, values.ravel()))
    input_seconds = time.perf_counter() - input_started

    with tempfile.TemporaryDirectory(dir=args.output) as warm:
        with FigWigWriter(Path(warm) / "warm.fw", {"warm": args.tile}, tracks,
                          tile=args.tile, groups=args.tracks, order=order, level=6,
                          zooms=5, n_jobs=2, summary_index=indexed) as writer:
            writer.write_sparse("warm", np.zeros(args.tracks, dtype=np.int64),
                                np.arange(args.tracks, dtype=np.int64), np.ones(args.tracks, dtype=np.float32))
    target = args.output / f"{args.single}.fw"
    before = time.perf_counter()
    with FigWigWriter(target, chroms, tracks, tile=args.tile, groups=args.tracks,
                      order=order, level=6, zooms=5, n_jobs=2,
                      summary_index=indexed, genome="summary-benchmark",
                      attributes={"seed": args.seed}) as writer:
        for chrom, positions, track_ids, values in data:
            writer.write_sparse(chrom, positions, track_ids, values)
    seconds = time.perf_counter() - before
    # Capture process high-water mark before the independent full-file oracle.
    rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    peak_bytes = int(rss if sys.platform == "darwin" else rss * 1024)
    reference = format_reference.File(target)
    index = read_index(target)
    assert (index is not None) == indexed
    summaries = hashlib.sha256()
    for group in reference.groups:
        summaries.update(group.summary[0].astype("<u4").tobytes())
        summaries.update(group.summary[1].astype("<f4").tobytes())
        for _, bins, sums in group.zooms:
            summaries.update(bins.astype("<u4").tobytes())
            summaries.update(sums.astype("<f8").tobytes())
    record = {
        "file": target.name, "order": order, "summaryIndex": indexed,
        "fileBytes": target.stat().st_size,
        "sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
        "signalSha256": signal.hexdigest(), "summariesSha256": summaries.hexdigest(),
        "rawDataSha256": hashlib.sha256(reference.bytes[128:reference.metadata.get(
            "org.figwig.summary-restarts", {}).get("offset", reference.header.chroms)]).hexdigest(),
        "chromosomes": chroms, "tracks": args.tracks, "tile": args.tile,
        "bins": args.bins, "seed": args.seed, "writer": snapshot,
        "inputSeconds": input_seconds, "generationSeconds": seconds,
        "processPeakRssBytes": peak_bytes, "python": platform.python_version(),
        "numpy": np.__version__, "platform": platform.platform(),
    }
    (args.output / f"{args.single}.json").write_text(json.dumps(record, indent=2) + "\n")
    print(json.dumps({key: record[key] for key in ["file", "fileBytes", "generationSeconds", "processPeakRssBytes"]}))


if __name__ == "__main__":
    main()
