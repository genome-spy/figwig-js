# Measured benchmark results

Generated: 2026-10-27T18:34:52.512Z. Node v26.8.1; Apple M5; darwin/arm64; 10 logical CPUs.

These timings exclude header/metadata initialization (recorded separately in JSON). Each pattern has one untimed JIT warm-up on a separate reader; every cold sample creates a fresh reader, and its paired warm sample reuses it. Network simulation uses one shared bandwidth reservation timeline across responses, with 16 KiB body chunks. No external network is used.

| File | Network | Pattern | Cache | n | Median ms | p95 ms | Requests | Body bytes | Index bytes | Data bytes | Chunks inflated | Cache bytes |
|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| sparse-n24-tile4096-g4-positions-l0-s1701.fw | local | A-single-track-10kb | cold | 3 | 4.19 | 4.42 | 2 | 6599 | 3679 | 2920 | 0 | 40239 |
| sparse-n24-tile4096-g4-positions-l0-s1701.fw | local | A-single-track-10kb | warm | 3 | 0.04 | 0.06 | 0 | 0 | 0 | 0 | 0 | 40239 |
| sparse-n24-tile4096-g4-positions-l0-s1701.fw | local | A-all-tracks-10kb | cold | 3 | 5.69 | 5.70 | 12 | 38853 | 22053 | 16800 | 0 | 236685 |
| sparse-n24-tile4096-g4-positions-l0-s1701.fw | local | A-all-tracks-10kb | warm | 3 | 0.14 | 0.16 | 0 | 0 | 0 | 0 | 0 | 236685 |
| sparse-n24-tile4096-g4-positions-l0-s1701.fw | local | B-single-track-100kb | cold | 3 | 3.63 | 3.81 | 2 | 21991 | 3679 | 18312 | 0 | 138783 |
| sparse-n24-tile4096-g4-positions-l0-s1701.fw | local | B-single-track-100kb | warm | 3 | 0.06 | 0.07 | 0 | 0 | 0 | 0 | 0 | 138783 |
| sparse-n24-tile4096-g4-positions-l0-s1701.fw | local | B-all-tracks-100kb | cold | 3 | 6.38 | 7.18 | 12 | 131797 | 22053 | 109744 | 0 | 830649 |
| sparse-n24-tile4096-g4-positions-l0-s1701.fw | local | B-all-tracks-100kb | warm | 3 | 0.45 | 0.69 | 0 | 0 | 0 | 0 | 0 | 830649 |
| sparse-n24-tile4096-g4-positions-l0-s1701.fw | typical | A-single-track-10kb | cold | 3 | 173.86 | 173.97 | 2 | 6599 | 3679 | 2920 | 0 | 40239 |
| sparse-n24-tile4096-g4-positions-l0-s1701.fw | typical | A-single-track-10kb | warm | 3 | 0.10 | 0.11 | 0 | 0 | 0 | 0 | 0 | 40239 |
| sparse-n24-tile4096-g4-positions-l0-s1701.fw | typical | A-all-tracks-10kb | cold | 3 | 178.32 | 183.99 | 12 | 38853 | 22053 | 16800 | 0 | 236685 |
| sparse-n24-tile4096-g4-positions-l0-s1701.fw | typical | A-all-tracks-10kb | warm | 3 | 0.40 | 0.63 | 0 | 0 | 0 | 0 | 0 | 236685 |
| sparse-n24-tile4096-g4-positions-l0-s1701.fw | typical | B-single-track-100kb | cold | 3 | 175.79 | 178.90 | 2 | 21991 | 3679 | 18312 | 0 | 138783 |
| sparse-n24-tile4096-g4-positions-l0-s1701.fw | typical | B-single-track-100kb | warm | 3 | 0.12 | 0.12 | 0 | 0 | 0 | 0 | 0 | 138783 |
| sparse-n24-tile4096-g4-positions-l0-s1701.fw | typical | B-all-tracks-100kb | cold | 3 | 201.03 | 202.31 | 12 | 131797 | 22053 | 109744 | 0 | 830649 |
| sparse-n24-tile4096-g4-positions-l0-s1701.fw | typical | B-all-tracks-100kb | warm | 3 | 1.22 | 1.44 | 0 | 0 | 0 | 0 | 0 | 830649 |

Full samples include initialization, index loading, decompression, decoding time, chunk fetches, and cache hit/miss counts in the adjacent JSON file. Small repetition counts support exploratory comparisons; p95 is interpolated and is not a stable tail-latency estimate.
