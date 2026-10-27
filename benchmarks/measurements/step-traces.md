# Measured benchmark results

Generated: 2026-10-27T18:35:13.431Z. Node v26.8.1; Apple M5; darwin/arm64; 10 logical CPUs.

These timings exclude header/metadata initialization (recorded separately in JSON). Each pattern has one untimed JIT warm-up on a separate reader; every cold sample creates a fresh reader, and its paired warm sample reuses it. Network simulation uses one shared bandwidth reservation timeline across responses, with 16 KiB body chunks. No external network is used.

| File | Network | Pattern | Cache | n | Median ms | p95 ms | Requests | Body bytes | Index bytes | Data bytes | Chunks inflated | Cache bytes |
|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| mixed-n24-tile4096-g4-positions-l6-s1701.fw | typical | E-panning | cold | 3 | 1168.74 | 1172.04 | 14 | 2830767 | 135760 | 2695007 | 98 | 10588064 |
| mixed-n24-tile4096-g4-positions-l6-s1701.fw | typical | E-panning | warm | 3 | 7.04 | 7.76 | 0 | 0 | 0 | 0 | 0 | 10588064 |
| mixed-n24-tile4096-g4-positions-l6-s1701.fw | typical | F-zooming | cold | 3 | 239.47 | 239.59 | 4 | 306666 | 135760 | 170906 | 6 | 1416584 |
| mixed-n24-tile4096-g4-positions-l6-s1701.fw | typical | F-zooming | warm | 3 | 1.24 | 1.27 | 0 | 0 | 0 | 0 | 0 | 1416584 |
| mixed-n24-tile4096-g4-positions-l6-s1701.fw | typical | G-track-selection | cold | 3 | 984.12 | 985.88 | 12 | 4404291 | 408369 | 3995922 | 150 | 17235873 |
| mixed-n24-tile4096-g4-positions-l6-s1701.fw | typical | G-track-selection | warm | 3 | 4.83 | 5.38 | 0 | 0 | 0 | 0 | 0 | 17235873 |

Full samples include initialization, index loading, decompression, decoding time, chunk fetches, and cache hit/miss counts in the adjacent JSON file. Small repetition counts support exploratory comparisons; p95 is interpolated and is not a stable tail-latency estimate.
