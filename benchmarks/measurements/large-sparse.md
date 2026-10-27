# Measured benchmark results

Generated: 2026-10-27T18:35:01.479Z. Node v26.8.1; Apple M5; darwin/arm64; 10 logical CPUs.

These timings exclude header/metadata initialization (recorded separately in JSON). Each pattern has one untimed JIT warm-up on a separate reader; every cold sample creates a fresh reader, and its paired warm sample reuses it. Network simulation uses one shared bandwidth reservation timeline across responses, with 16 KiB body chunks. No external network is used.

| File | Network | Pattern | Cache | n | Median ms | p95 ms | Requests | Body bytes | Index bytes | Data bytes | Chunks inflated | Cache bytes |
|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| sparse-n24-tile4096-g4-positions-l6-s1701.fw | local | A-single-track-10kb | cold | 3 | 4.46 | 4.97 | 2 | 54746 | 52894 | 1852 | 3 | 349782 |
| sparse-n24-tile4096-g4-positions-l6-s1701.fw | local | A-single-track-10kb | warm | 3 | 0.03 | 0.05 | 0 | 0 | 0 | 0 | 0 | 349782 |
| sparse-n24-tile4096-g4-positions-l6-s1701.fw | local | A-all-tracks-10kb | cold | 3 | 8.85 | 9.29 | 12 | 328727 | 317527 | 11200 | 18 | 2099515 |
| sparse-n24-tile4096-g4-positions-l6-s1701.fw | local | A-all-tracks-10kb | warm | 3 | 0.10 | 0.12 | 0 | 0 | 0 | 0 | 0 | 2099515 |
| sparse-n24-tile4096-g4-positions-l6-s1701.fw | local | D-coarse-large-region | cold | 3 | 2.97 | 3.13 | 2 | 105834 | 105834 | 0 | 0 | 683954 |
| sparse-n24-tile4096-g4-positions-l6-s1701.fw | local | D-coarse-large-region | warm | 3 | 0.07 | 0.09 | 0 | 0 | 0 | 0 | 0 | 683954 |
| sparse-n24-tile4096-g4-positions-l6-s1701.fw | local | H-batch | cold | 3 | 6.28 | 6.41 | 10 | 120718 | 105834 | 14884 | 26 | 781474 |
| sparse-n24-tile4096-g4-positions-l6-s1701.fw | local | H-batch | warm | 3 | 0.08 | 0.09 | 0 | 0 | 0 | 0 | 0 | 781474 |
| sparse-n24-tile4096-g4-positions-l6-s1701.fw | local | H-sequential | cold | 3 | 11.04 | 11.13 | 10 | 120718 | 105834 | 14884 | 26 | 781474 |
| sparse-n24-tile4096-g4-positions-l6-s1701.fw | local | H-sequential | warm | 3 | 0.16 | 0.18 | 0 | 0 | 0 | 0 | 0 | 781474 |
| sparse-n24-tile4096-g4-positions-l6-s1701.fw | typical | A-single-track-10kb | cold | 3 | 184.18 | 184.45 | 2 | 54746 | 52894 | 1852 | 3 | 349782 |
| sparse-n24-tile4096-g4-positions-l6-s1701.fw | typical | A-single-track-10kb | warm | 3 | 0.13 | 0.13 | 0 | 0 | 0 | 0 | 0 | 349782 |
| sparse-n24-tile4096-g4-positions-l6-s1701.fw | typical | A-all-tracks-10kb | cold | 3 | 232.00 | 232.97 | 12 | 328727 | 317527 | 11200 | 18 | 2099515 |
| sparse-n24-tile4096-g4-positions-l6-s1701.fw | typical | A-all-tracks-10kb | warm | 3 | 0.23 | 0.40 | 0 | 0 | 0 | 0 | 0 | 2099515 |
| sparse-n24-tile4096-g4-positions-l6-s1701.fw | typical | D-coarse-large-region | cold | 3 | 105.82 | 105.83 | 2 | 105834 | 105834 | 0 | 0 | 683954 |
| sparse-n24-tile4096-g4-positions-l6-s1701.fw | typical | D-coarse-large-region | warm | 3 | 0.09 | 0.13 | 0 | 0 | 0 | 0 | 0 | 683954 |
| sparse-n24-tile4096-g4-positions-l6-s1701.fw | typical | H-batch | cold | 3 | 279.85 | 283.23 | 10 | 120718 | 105834 | 14884 | 26 | 781474 |
| sparse-n24-tile4096-g4-positions-l6-s1701.fw | typical | H-batch | warm | 3 | 0.21 | 0.23 | 0 | 0 | 0 | 0 | 0 | 781474 |
| sparse-n24-tile4096-g4-positions-l6-s1701.fw | typical | H-sequential | cold | 3 | 456.24 | 457.65 | 10 | 120718 | 105834 | 14884 | 26 | 781474 |
| sparse-n24-tile4096-g4-positions-l6-s1701.fw | typical | H-sequential | warm | 3 | 0.27 | 0.56 | 0 | 0 | 0 | 0 | 0 | 781474 |

Full samples include initialization, index loading, decompression, decoding time, chunk fetches, and cache hit/miss counts in the adjacent JSON file. Small repetition counts support exploratory comparisons; p95 is interpolated and is not a stable tail-latency estimate.
