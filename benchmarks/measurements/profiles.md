# Measured benchmark results

Generated: 2026-10-27T18:34:46.411Z. Node v26.8.1; Apple M5; darwin/arm64; 10 logical CPUs.

These timings exclude header/metadata initialization (recorded separately in JSON). Each pattern has one untimed JIT warm-up on a separate reader; every cold sample creates a fresh reader, and its paired warm sample reuses it. Network simulation uses one shared bandwidth reservation timeline across responses, with 16 KiB body chunks. No external network is used.

| File | Network | Pattern | Cache | n | Median ms | p95 ms | Requests | Body bytes | Index bytes | Data bytes | Chunks inflated | Cache bytes |
|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| dense-n8-tile4096-g4-positions-l6-s1701.fw | local | A-single-track-10kb | cold | 3 | 7.34 | 8.60 | 2 | 244312 | 18864 | 225448 | 4 | 616448 |
| dense-n8-tile4096-g4-positions-l6-s1701.fw | local | A-single-track-10kb | warm | 3 | 0.05 | 0.06 | 0 | 0 | 0 | 0 | 0 | 616448 |
| dense-n8-tile4096-g4-positions-l6-s1701.fw | local | A-all-tracks-10kb | cold | 3 | 11.68 | 12.30 | 4 | 486837 | 37918 | 448919 | 8 | 1233086 |
| dense-n8-tile4096-g4-positions-l6-s1701.fw | local | A-all-tracks-10kb | warm | 3 | 0.10 | 0.11 | 0 | 0 | 0 | 0 | 0 | 1233086 |
| dense-n8-tile4096-g4-positions-l6-s1701.fw | local | B-single-track-100kb | cold | 3 | 26.91 | 27.16 | 2 | 1490223 | 18864 | 1471359 | 26 | 3512704 |
| dense-n8-tile4096-g4-positions-l6-s1701.fw | local | B-single-track-100kb | warm | 3 | 0.11 | 0.12 | 0 | 0 | 0 | 0 | 0 | 3512704 |
| dense-n8-tile4096-g4-positions-l6-s1701.fw | local | B-all-tracks-100kb | cold | 3 | 52.10 | 53.07 | 4 | 2963223 | 37918 | 2925305 | 52 | 7025598 |
| dense-n8-tile4096-g4-positions-l6-s1701.fw | local | B-all-tracks-100kb | warm | 3 | 0.72 | 0.86 | 0 | 0 | 0 | 0 | 0 | 7025598 |
| dense-n8-tile4096-g4-positions-l6-s1701.fw | local | D-coarse-large-region | cold | 3 | 2.32 | 2.41 | 2 | 37918 | 37918 | 0 | 0 | 182966 |
| dense-n8-tile4096-g4-positions-l6-s1701.fw | local | D-coarse-large-region | warm | 3 | 0.05 | 0.05 | 0 | 0 | 0 | 0 | 0 | 182966 |
| dense-n8-tile4096-g4-positions-l6-s1701.fw | local | E-panning | cold | 3 | 119.02 | 121.32 | 14 | 5657446 | 37918 | 5619528 | 100 | 13344702 |
| dense-n8-tile4096-g4-positions-l6-s1701.fw | local | E-panning | warm | 3 | 2.81 | 3.48 | 0 | 0 | 0 | 0 | 0 | 13344702 |
| dense-n8-tile4096-g4-positions-l6-s1701.fw | local | F-zooming | cold | 3 | 10.39 | 11.16 | 4 | 372982 | 37918 | 335064 | 6 | 997590 |
| dense-n8-tile4096-g4-positions-l6-s1701.fw | local | F-zooming | warm | 3 | 0.18 | 0.19 | 0 | 0 | 0 | 0 | 0 | 997590 |
| dense-n8-tile4096-g4-positions-l6-s1701.fw | local | G-track-selection | cold | 3 | 52.98 | 57.21 | 4 | 2963223 | 37918 | 2925305 | 52 | 7025598 |
| dense-n8-tile4096-g4-positions-l6-s1701.fw | local | G-track-selection | warm | 3 | 2.42 | 2.53 | 0 | 0 | 0 | 0 | 0 | 7025598 |
| dense-n8-tile4096-g4-positions-l6-s1701.fw | local | I-all-file-tracks-10kb | cold | 3 | 11.35 | 13.70 | 4 | 486837 | 37918 | 448919 | 8 | 1233086 |
| dense-n8-tile4096-g4-positions-l6-s1701.fw | local | I-all-file-tracks-10kb | warm | 3 | 0.10 | 0.11 | 0 | 0 | 0 | 0 | 0 | 1233086 |
| dense-n8-tile4096-g4-positions-l6-s1701.fw | local | I-scattered-file-tracks-10kb | cold | 3 | 11.57 | 14.84 | 4 | 486837 | 37918 | 448919 | 8 | 1233086 |
| dense-n8-tile4096-g4-positions-l6-s1701.fw | local | I-scattered-file-tracks-10kb | warm | 3 | 0.06 | 0.06 | 0 | 0 | 0 | 0 | 0 | 1233086 |
| dense-n8-tile4096-g4-positions-l6-s1701.fw | local | H-batch | cold | 3 | 28.25 | 29.01 | 9 | 1525084 | 37918 | 1487166 | 28 | 3714494 |
| dense-n8-tile4096-g4-positions-l6-s1701.fw | local | H-batch | warm | 3 | 0.25 | 0.26 | 0 | 0 | 0 | 0 | 0 | 3714494 |
| dense-n8-tile4096-g4-positions-l6-s1701.fw | local | H-sequential | cold | 3 | 31.21 | 34.96 | 10 | 1525084 | 37918 | 1487166 | 28 | 3714494 |
| dense-n8-tile4096-g4-positions-l6-s1701.fw | local | H-sequential | warm | 3 | 0.27 | 0.33 | 0 | 0 | 0 | 0 | 0 | 3714494 |
| dense-n8-tile4096-g4-positions-l6-s1701.fw | typical | A-single-track-10kb | cold | 3 | 223.96 | 226.98 | 2 | 244312 | 18864 | 225448 | 4 | 616448 |
| dense-n8-tile4096-g4-positions-l6-s1701.fw | typical | A-single-track-10kb | warm | 3 | 0.07 | 0.08 | 0 | 0 | 0 | 0 | 0 | 616448 |
| dense-n8-tile4096-g4-positions-l6-s1701.fw | typical | A-all-tracks-10kb | cold | 3 | 268.57 | 273.08 | 4 | 486837 | 37918 | 448919 | 8 | 1233086 |
| dense-n8-tile4096-g4-positions-l6-s1701.fw | typical | A-all-tracks-10kb | warm | 3 | 0.25 | 0.25 | 0 | 0 | 0 | 0 | 0 | 1233086 |
| dense-n8-tile4096-g4-positions-l6-s1701.fw | typical | B-single-track-100kb | cold | 3 | 464.05 | 464.55 | 2 | 1490223 | 18864 | 1471359 | 26 | 3512704 |
| dense-n8-tile4096-g4-positions-l6-s1701.fw | typical | B-single-track-100kb | warm | 3 | 0.18 | 0.18 | 0 | 0 | 0 | 0 | 0 | 3512704 |
| dense-n8-tile4096-g4-positions-l6-s1701.fw | typical | B-all-tracks-100kb | cold | 3 | 716.80 | 717.57 | 4 | 2963223 | 37918 | 2925305 | 52 | 7025598 |
| dense-n8-tile4096-g4-positions-l6-s1701.fw | typical | B-all-tracks-100kb | warm | 3 | 0.92 | 0.95 | 0 | 0 | 0 | 0 | 0 | 7025598 |
| dense-n8-tile4096-g4-positions-l6-s1701.fw | typical | D-coarse-large-region | cold | 3 | 93.32 | 94.67 | 2 | 37918 | 37918 | 0 | 0 | 182966 |
| dense-n8-tile4096-g4-positions-l6-s1701.fw | typical | D-coarse-large-region | warm | 3 | 0.08 | 0.09 | 0 | 0 | 0 | 0 | 0 | 182966 |
| dense-n8-tile4096-g4-positions-l6-s1701.fw | typical | E-panning | cold | 3 | 1665.59 | 1668.14 | 14 | 5657446 | 37918 | 5619528 | 100 | 13344702 |
| dense-n8-tile4096-g4-positions-l6-s1701.fw | typical | E-panning | warm | 3 | 7.38 | 7.65 | 0 | 0 | 0 | 0 | 0 | 13344702 |
| dense-n8-tile4096-g4-positions-l6-s1701.fw | typical | F-zooming | cold | 3 | 245.06 | 246.56 | 4 | 372982 | 37918 | 335064 | 6 | 997590 |
| dense-n8-tile4096-g4-positions-l6-s1701.fw | typical | F-zooming | warm | 3 | 0.45 | 0.59 | 0 | 0 | 0 | 0 | 0 | 997590 |
| dense-n8-tile4096-g4-positions-l6-s1701.fw | typical | G-track-selection | cold | 3 | 716.24 | 720.77 | 4 | 2963223 | 37918 | 2925305 | 52 | 7025598 |
| dense-n8-tile4096-g4-positions-l6-s1701.fw | typical | G-track-selection | warm | 3 | 2.40 | 2.85 | 0 | 0 | 0 | 0 | 0 | 7025598 |
| dense-n8-tile4096-g4-positions-l6-s1701.fw | typical | I-all-file-tracks-10kb | cold | 3 | 260.54 | 263.73 | 4 | 486837 | 37918 | 448919 | 8 | 1233086 |
| dense-n8-tile4096-g4-positions-l6-s1701.fw | typical | I-all-file-tracks-10kb | warm | 3 | 0.13 | 0.27 | 0 | 0 | 0 | 0 | 0 | 1233086 |
| dense-n8-tile4096-g4-positions-l6-s1701.fw | typical | I-scattered-file-tracks-10kb | cold | 3 | 257.15 | 263.65 | 4 | 486837 | 37918 | 448919 | 8 | 1233086 |
| dense-n8-tile4096-g4-positions-l6-s1701.fw | typical | I-scattered-file-tracks-10kb | warm | 3 | 0.11 | 0.21 | 0 | 0 | 0 | 0 | 0 | 1233086 |
| dense-n8-tile4096-g4-positions-l6-s1701.fw | typical | H-batch | cold | 3 | 465.84 | 472.35 | 9 | 1525084 | 37918 | 1487166 | 28 | 3714494 |
| dense-n8-tile4096-g4-positions-l6-s1701.fw | typical | H-batch | warm | 3 | 0.51 | 0.55 | 0 | 0 | 0 | 0 | 0 | 3714494 |
| dense-n8-tile4096-g4-positions-l6-s1701.fw | typical | H-sequential | cold | 3 | 718.88 | 726.92 | 10 | 1525084 | 37918 | 1487166 | 28 | 3714494 |
| dense-n8-tile4096-g4-positions-l6-s1701.fw | typical | H-sequential | warm | 3 | 0.65 | 0.79 | 0 | 0 | 0 | 0 | 0 | 3714494 |
| collection-n96-tile4096-g8-positions-l6-s1701.fw | local | A-single-track-10kb | cold | 3 | 4.42 | 4.77 | 2 | 25041 | 20254 | 4787 | 4 | 127674 |
| collection-n96-tile4096-g8-positions-l6-s1701.fw | local | A-single-track-10kb | warm | 3 | 0.03 | 0.03 | 0 | 0 | 0 | 0 | 0 | 127674 |
| collection-n96-tile4096-g8-positions-l6-s1701.fw | local | A-all-tracks-10kb | cold | 3 | 6.05 | 6.63 | 6 | 75087 | 60823 | 14264 | 12 | 382279 |
| collection-n96-tile4096-g8-positions-l6-s1701.fw | local | A-all-tracks-10kb | warm | 3 | 0.13 | 0.16 | 0 | 0 | 0 | 0 | 0 | 382279 |
| collection-n96-tile4096-g8-positions-l6-s1701.fw | local | B-single-track-100kb | cold | 3 | 5.65 | 5.65 | 2 | 51152 | 20254 | 30898 | 26 | 326318 |
| collection-n96-tile4096-g8-positions-l6-s1701.fw | local | B-single-track-100kb | warm | 3 | 0.06 | 0.07 | 0 | 0 | 0 | 0 | 0 | 326318 |
| collection-n96-tile4096-g8-positions-l6-s1701.fw | local | B-all-tracks-100kb | cold | 3 | 8.97 | 9.04 | 6 | 153240 | 60823 | 92417 | 78 | 976903 |
| collection-n96-tile4096-g8-positions-l6-s1701.fw | local | B-all-tracks-100kb | warm | 3 | 0.39 | 0.54 | 0 | 0 | 0 | 0 | 0 | 976903 |
| collection-n96-tile4096-g8-positions-l6-s1701.fw | local | D-coarse-large-region | cold | 3 | 2.29 | 2.32 | 1 | 20254 | 20254 | 0 | 0 | 94026 |
| collection-n96-tile4096-g8-positions-l6-s1701.fw | local | D-coarse-large-region | warm | 3 | 0.02 | 0.04 | 0 | 0 | 0 | 0 | 0 | 94026 |
| collection-n96-tile4096-g8-positions-l6-s1701.fw | local | E-panning | cold | 3 | 12.61 | 13.66 | 7 | 79513 | 20254 | 59259 | 50 | 541694 |
| collection-n96-tile4096-g8-positions-l6-s1701.fw | local | E-panning | warm | 3 | 0.46 | 0.47 | 0 | 0 | 0 | 0 | 0 | 541694 |
| collection-n96-tile4096-g8-positions-l6-s1701.fw | local | F-zooming | cold | 3 | 4.22 | 4.41 | 2 | 23726 | 20254 | 3472 | 3 | 142502 |
| collection-n96-tile4096-g8-positions-l6-s1701.fw | local | F-zooming | warm | 3 | 0.16 | 0.18 | 0 | 0 | 0 | 0 | 0 | 142502 |
| collection-n96-tile4096-g8-positions-l6-s1701.fw | local | G-track-selection | cold | 3 | 9.12 | 9.75 | 6 | 153240 | 60823 | 92417 | 78 | 976903 |
| collection-n96-tile4096-g8-positions-l6-s1701.fw | local | G-track-selection | warm | 3 | 1.71 | 1.77 | 0 | 0 | 0 | 0 | 0 | 976903 |
| collection-n96-tile4096-g8-positions-l6-s1701.fw | local | I-all-file-tracks-10kb | cold | 3 | 11.33 | 12.06 | 24 | 299605 | 243089 | 56516 | 48 | 1524461 |
| collection-n96-tile4096-g8-positions-l6-s1701.fw | local | I-all-file-tracks-10kb | warm | 3 | 0.31 | 0.35 | 0 | 0 | 0 | 0 | 0 | 1524461 |
| collection-n96-tile4096-g8-positions-l6-s1701.fw | local | I-scattered-file-tracks-10kb | cold | 3 | 5.24 | 5.32 | 8 | 100045 | 81057 | 18988 | 16 | 509549 |
| collection-n96-tile4096-g8-positions-l6-s1701.fw | local | I-scattered-file-tracks-10kb | warm | 3 | 0.03 | 0.03 | 0 | 0 | 0 | 0 | 0 | 509549 |
| collection-n96-tile4096-g8-positions-l6-s1701.fw | local | H-batch | cold | 3 | 4.26 | 4.27 | 5 | 35857 | 20254 | 15603 | 14 | 210170 |
| collection-n96-tile4096-g8-positions-l6-s1701.fw | local | H-batch | warm | 3 | 0.05 | 0.06 | 0 | 0 | 0 | 0 | 0 | 210170 |
| collection-n96-tile4096-g8-positions-l6-s1701.fw | local | H-sequential | cold | 3 | 8.66 | 8.66 | 5 | 35857 | 20254 | 15603 | 14 | 210170 |
| collection-n96-tile4096-g8-positions-l6-s1701.fw | local | H-sequential | warm | 3 | 0.07 | 0.09 | 0 | 0 | 0 | 0 | 0 | 210170 |
| collection-n96-tile4096-g8-positions-l6-s1701.fw | typical | A-single-track-10kb | cold | 3 | 177.68 | 178.36 | 2 | 25041 | 20254 | 4787 | 4 | 127674 |
| collection-n96-tile4096-g8-positions-l6-s1701.fw | typical | A-single-track-10kb | warm | 3 | 0.12 | 0.12 | 0 | 0 | 0 | 0 | 0 | 127674 |
| collection-n96-tile4096-g8-positions-l6-s1701.fw | typical | A-all-tracks-10kb | cold | 3 | 186.88 | 186.89 | 6 | 75087 | 60823 | 14264 | 12 | 382279 |
| collection-n96-tile4096-g8-positions-l6-s1701.fw | typical | A-all-tracks-10kb | warm | 3 | 0.29 | 0.32 | 0 | 0 | 0 | 0 | 0 | 382279 |
| collection-n96-tile4096-g8-positions-l6-s1701.fw | typical | B-single-track-100kb | cold | 3 | 185.95 | 187.09 | 2 | 51152 | 20254 | 30898 | 26 | 326318 |
| collection-n96-tile4096-g8-positions-l6-s1701.fw | typical | B-single-track-100kb | warm | 3 | 0.11 | 0.12 | 0 | 0 | 0 | 0 | 0 | 326318 |
| collection-n96-tile4096-g8-positions-l6-s1701.fw | typical | B-all-tracks-100kb | cold | 3 | 203.32 | 210.20 | 6 | 153240 | 60823 | 92417 | 78 | 976903 |
| collection-n96-tile4096-g8-positions-l6-s1701.fw | typical | B-all-tracks-100kb | warm | 3 | 0.89 | 1.45 | 0 | 0 | 0 | 0 | 0 | 976903 |
| collection-n96-tile4096-g8-positions-l6-s1701.fw | typical | D-coarse-large-region | cold | 3 | 91.09 | 91.41 | 1 | 20254 | 20254 | 0 | 0 | 94026 |
| collection-n96-tile4096-g8-positions-l6-s1701.fw | typical | D-coarse-large-region | warm | 3 | 0.06 | 0.10 | 0 | 0 | 0 | 0 | 0 | 94026 |
| collection-n96-tile4096-g8-positions-l6-s1701.fw | typical | E-panning | cold | 3 | 625.84 | 626.02 | 7 | 79513 | 20254 | 59259 | 50 | 541694 |
| collection-n96-tile4096-g8-positions-l6-s1701.fw | typical | E-panning | warm | 3 | 2.30 | 3.51 | 0 | 0 | 0 | 0 | 0 | 541694 |
| collection-n96-tile4096-g8-positions-l6-s1701.fw | typical | F-zooming | cold | 3 | 179.15 | 179.88 | 2 | 23726 | 20254 | 3472 | 3 | 142502 |
| collection-n96-tile4096-g8-positions-l6-s1701.fw | typical | F-zooming | warm | 3 | 0.46 | 0.46 | 0 | 0 | 0 | 0 | 0 | 142502 |
| collection-n96-tile4096-g8-positions-l6-s1701.fw | typical | G-track-selection | cold | 3 | 206.98 | 208.12 | 6 | 153240 | 60823 | 92417 | 78 | 976903 |
| collection-n96-tile4096-g8-positions-l6-s1701.fw | typical | G-track-selection | warm | 3 | 2.15 | 3.02 | 0 | 0 | 0 | 0 | 0 | 976903 |
| collection-n96-tile4096-g8-positions-l6-s1701.fw | typical | I-all-file-tracks-10kb | cold | 3 | 393.42 | 396.53 | 24 | 299605 | 243089 | 56516 | 48 | 1524461 |
| collection-n96-tile4096-g8-positions-l6-s1701.fw | typical | I-all-file-tracks-10kb | warm | 3 | 0.78 | 0.93 | 0 | 0 | 0 | 0 | 0 | 1524461 |
| collection-n96-tile4096-g8-positions-l6-s1701.fw | typical | I-scattered-file-tracks-10kb | cold | 3 | 188.96 | 189.04 | 8 | 100045 | 81057 | 18988 | 16 | 509549 |
| collection-n96-tile4096-g8-positions-l6-s1701.fw | typical | I-scattered-file-tracks-10kb | warm | 3 | 0.10 | 0.12 | 0 | 0 | 0 | 0 | 0 | 509549 |
| collection-n96-tile4096-g8-positions-l6-s1701.fw | typical | H-batch | cold | 3 | 178.39 | 178.52 | 5 | 35857 | 20254 | 15603 | 14 | 210170 |
| collection-n96-tile4096-g8-positions-l6-s1701.fw | typical | H-batch | warm | 3 | 0.18 | 0.20 | 0 | 0 | 0 | 0 | 0 | 210170 |
| collection-n96-tile4096-g8-positions-l6-s1701.fw | typical | H-sequential | cold | 3 | 435.33 | 436.61 | 5 | 35857 | 20254 | 15603 | 14 | 210170 |
| collection-n96-tile4096-g8-positions-l6-s1701.fw | typical | H-sequential | warm | 3 | 0.47 | 0.49 | 0 | 0 | 0 | 0 | 0 | 210170 |

Full samples include initialization, index loading, decompression, decoding time, chunk fetches, and cache hit/miss counts in the adjacent JSON file. Small repetition counts support exploratory comparisons; p95 is interpolated and is not a stable tail-latency estimate.
