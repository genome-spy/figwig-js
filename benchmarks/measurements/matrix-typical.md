# Measured benchmark results

Generated: 2026-10-27T18:31:06.527Z. Node v26.8.1; Apple M5; darwin/arm64; 10 logical CPUs.

These timings exclude header/metadata initialization (recorded separately in JSON). Each pattern has one untimed JIT warm-up on a separate reader; every cold sample creates a fresh reader, and its paired warm sample reuses it. Network simulation uses one shared bandwidth reservation timeline across responses, with 16 KiB body chunks. No external network is used.

| File | Network | Pattern | Cache | n | Median ms | p95 ms | Requests | Body bytes | Index bytes | Data bytes | Chunks inflated | Cache bytes |
|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| sparse-n24-tile4096-g1-positions-l6-s1701.fw | typical | A-single-track-10kb | cold | 3 | 170.64 | 170.87 | 2 | 3217 | 2436 | 781 | 2 | 25376 |
| sparse-n24-tile4096-g1-positions-l6-s1701.fw | typical | A-single-track-10kb | warm | 3 | 0.07 | 0.10 | 0 | 0 | 0 | 0 | 0 | 25376 |
| sparse-n24-tile4096-g1-positions-l6-s1701.fw | typical | A-all-tracks-10kb | cold | 3 | 697.23 | 699.18 | 48 | 74934 | 57522 | 17412 | 16 | 598314 |
| sparse-n24-tile4096-g1-positions-l6-s1701.fw | typical | A-all-tracks-10kb | warm | 3 | 0.31 | 0.70 | 0 | 0 | 0 | 0 | 0 | 598314 |
| sparse-n24-tile4096-g1-positions-l6-s1701.fw | typical | B-single-track-100kb | cold | 3 | 171.03 | 171.14 | 2 | 7121 | 2436 | 4685 | 2 | 50456 |
| sparse-n24-tile4096-g1-positions-l6-s1701.fw | typical | B-single-track-100kb | warm | 3 | 0.06 | 0.11 | 0 | 0 | 0 | 0 | 0 | 50456 |
| sparse-n24-tile4096-g1-positions-l6-s1701.fw | typical | B-all-tracks-100kb | cold | 3 | 720.16 | 721.14 | 48 | 171072 | 57522 | 113550 | 79 | 1217622 |
| sparse-n24-tile4096-g1-positions-l6-s1701.fw | typical | B-all-tracks-100kb | warm | 3 | 1.98 | 2.03 | 0 | 0 | 0 | 0 | 0 | 1217622 |
| sparse-n24-tile4096-g1-positions-l6-s1701.fw | typical | C-same-group | cold | 3 | 174.80 | 175.16 | 2 | 7121 | 2436 | 4685 | 2 | 50456 |
| sparse-n24-tile4096-g1-positions-l6-s1701.fw | typical | C-same-group | warm | 3 | 0.24 | 0.85 | 0 | 0 | 0 | 0 | 0 | 50456 |
| sparse-n24-tile4096-g1-positions-l6-s1701.fw | typical | C-different-groups | cold | 3 | 181.63 | 181.89 | 8 | 28650 | 9646 | 19004 | 13 | 203334 |
| sparse-n24-tile4096-g1-positions-l6-s1701.fw | typical | C-different-groups | warm | 3 | 0.26 | 0.34 | 0 | 0 | 0 | 0 | 0 | 203334 |
| sparse-n24-tile4096-g1-positions-l6-s1701.fw | typical | H-batch | cold | 3 | 438.33 | 440.96 | 25 | 28847 | 14399 | 14448 | 21 | 215543 |
| sparse-n24-tile4096-g1-positions-l6-s1701.fw | typical | H-batch | warm | 3 | 0.56 | 0.68 | 0 | 0 | 0 | 0 | 0 | 215543 |
| sparse-n24-tile4096-g1-positions-l6-s1701.fw | typical | H-sequential | cold | 3 | 443.72 | 448.76 | 30 | 28847 | 14399 | 14448 | 21 | 215543 |
| sparse-n24-tile4096-g1-positions-l6-s1701.fw | typical | H-sequential | warm | 3 | 0.57 | 0.61 | 0 | 0 | 0 | 0 | 0 | 215543 |
| sparse-n24-tile4096-g4-positions-l6-s1701.fw | typical | A-single-track-10kb | cold | 3 | 172.88 | 173.21 | 2 | 6431 | 3892 | 2539 | 4 | 40452 |
| sparse-n24-tile4096-g4-positions-l6-s1701.fw | typical | A-single-track-10kb | warm | 3 | 0.08 | 0.11 | 0 | 0 | 0 | 0 | 0 | 40452 |
| sparse-n24-tile4096-g4-positions-l6-s1701.fw | typical | A-all-tracks-10kb | cold | 3 | 177.32 | 182.39 | 12 | 38121 | 23350 | 14771 | 24 | 237982 |
| sparse-n24-tile4096-g4-positions-l6-s1701.fw | typical | A-all-tracks-10kb | warm | 3 | 0.28 | 0.30 | 0 | 0 | 0 | 0 | 0 | 237982 |
| sparse-n24-tile4096-g4-positions-l6-s1701.fw | typical | B-single-track-100kb | cold | 3 | 176.23 | 177.33 | 2 | 19939 | 3892 | 16047 | 26 | 138996 |
| sparse-n24-tile4096-g4-positions-l6-s1701.fw | typical | B-single-track-100kb | warm | 3 | 0.13 | 0.13 | 0 | 0 | 0 | 0 | 0 | 138996 |
| sparse-n24-tile4096-g4-positions-l6-s1701.fw | typical | B-all-tracks-100kb | cold | 3 | 192.35 | 193.97 | 12 | 119666 | 23350 | 96316 | 156 | 831946 |
| sparse-n24-tile4096-g4-positions-l6-s1701.fw | typical | B-all-tracks-100kb | warm | 3 | 1.00 | 1.54 | 0 | 0 | 0 | 0 | 0 | 831946 |
| sparse-n24-tile4096-g4-positions-l6-s1701.fw | typical | C-same-group | cold | 3 | 177.63 | 178.03 | 2 | 19939 | 3892 | 16047 | 26 | 138996 |
| sparse-n24-tile4096-g4-positions-l6-s1701.fw | typical | C-same-group | warm | 3 | 0.25 | 0.25 | 0 | 0 | 0 | 0 | 0 | 138996 |
| sparse-n24-tile4096-g4-positions-l6-s1701.fw | typical | C-different-groups | cold | 3 | 187.62 | 187.63 | 8 | 79793 | 15591 | 64202 | 104 | 554543 |
| sparse-n24-tile4096-g4-positions-l6-s1701.fw | typical | C-different-groups | warm | 3 | 0.26 | 0.34 | 0 | 0 | 0 | 0 | 0 | 554543 |
| sparse-n24-tile4096-g4-positions-l6-s1701.fw | typical | H-batch | cold | 3 | 263.44 | 263.57 | 9 | 24145 | 7783 | 16362 | 28 | 163787 |
| sparse-n24-tile4096-g4-positions-l6-s1701.fw | typical | H-batch | warm | 3 | 0.35 | 0.36 | 0 | 0 | 0 | 0 | 0 | 163787 |
| sparse-n24-tile4096-g4-positions-l6-s1701.fw | typical | H-sequential | cold | 3 | 436.99 | 438.86 | 10 | 24145 | 7783 | 16362 | 28 | 163787 |
| sparse-n24-tile4096-g4-positions-l6-s1701.fw | typical | H-sequential | warm | 3 | 0.48 | 0.61 | 0 | 0 | 0 | 0 | 0 | 163787 |
| sparse-n24-tile4096-g8-positions-l6-s1701.fw | typical | A-single-track-10kb | cold | 3 | 172.49 | 174.07 | 2 | 10517 | 5621 | 4896 | 4 | 61029 |
| sparse-n24-tile4096-g8-positions-l6-s1701.fw | typical | A-single-track-10kb | warm | 3 | 0.10 | 0.12 | 0 | 0 | 0 | 0 | 0 | 61029 |
| sparse-n24-tile4096-g8-positions-l6-s1701.fw | typical | A-all-tracks-10kb | cold | 3 | 177.35 | 178.27 | 6 | 30873 | 16818 | 14055 | 12 | 177090 |
| sparse-n24-tile4096-g8-positions-l6-s1701.fw | typical | A-all-tracks-10kb | warm | 3 | 0.24 | 0.29 | 0 | 0 | 0 | 0 | 0 | 177090 |
| sparse-n24-tile4096-g8-positions-l6-s1701.fw | typical | B-single-track-100kb | cold | 3 | 181.10 | 181.52 | 2 | 36348 | 5621 | 30727 | 26 | 257021 |
| sparse-n24-tile4096-g8-positions-l6-s1701.fw | typical | B-single-track-100kb | warm | 3 | 0.13 | 0.16 | 0 | 0 | 0 | 0 | 0 | 257021 |
| sparse-n24-tile4096-g8-positions-l6-s1701.fw | typical | B-all-tracks-100kb | cold | 3 | 192.65 | 193.33 | 6 | 108558 | 16818 | 91740 | 78 | 766830 |
| sparse-n24-tile4096-g8-positions-l6-s1701.fw | typical | B-all-tracks-100kb | warm | 3 | 1.29 | 1.44 | 0 | 0 | 0 | 0 | 0 | 766830 |
| sparse-n24-tile4096-g8-positions-l6-s1701.fw | typical | C-same-group | cold | 3 | 183.21 | 185.16 | 2 | 36348 | 5621 | 30727 | 26 | 257021 |
| sparse-n24-tile4096-g8-positions-l6-s1701.fw | typical | C-same-group | warm | 3 | 0.19 | 0.30 | 0 | 0 | 0 | 0 | 0 | 257021 |
| sparse-n24-tile4096-g8-positions-l6-s1701.fw | typical | C-different-groups | cold | 3 | 194.72 | 197.63 | 6 | 108558 | 16818 | 91740 | 78 | 766830 |
| sparse-n24-tile4096-g8-positions-l6-s1701.fw | typical | C-different-groups | warm | 3 | 0.23 | 0.28 | 0 | 0 | 0 | 0 | 0 | 766830 |
| sparse-n24-tile4096-g8-positions-l6-s1701.fw | typical | H-batch | cold | 3 | 176.96 | 177.52 | 5 | 21189 | 5621 | 15568 | 14 | 142865 |
| sparse-n24-tile4096-g8-positions-l6-s1701.fw | typical | H-batch | warm | 3 | 0.22 | 0.32 | 0 | 0 | 0 | 0 | 0 | 142865 |
| sparse-n24-tile4096-g8-positions-l6-s1701.fw | typical | H-sequential | cold | 3 | 433.86 | 434.94 | 5 | 21189 | 5621 | 15568 | 14 | 142865 |
| sparse-n24-tile4096-g8-positions-l6-s1701.fw | typical | H-sequential | warm | 3 | 0.30 | 0.39 | 0 | 0 | 0 | 0 | 0 | 142865 |
| sparse-n24-tile4096-g24-positions-l6-s1701.fw | typical | A-single-track-10kb | cold | 3 | 177.79 | 178.90 | 2 | 25654 | 12173 | 13481 | 4 | 136205 |
| sparse-n24-tile4096-g24-positions-l6-s1701.fw | typical | A-single-track-10kb | warm | 3 | 0.09 | 0.10 | 0 | 0 | 0 | 0 | 0 | 136205 |
| sparse-n24-tile4096-g24-positions-l6-s1701.fw | typical | A-all-tracks-10kb | cold | 3 | 175.90 | 176.76 | 2 | 25654 | 12173 | 13481 | 4 | 136205 |
| sparse-n24-tile4096-g24-positions-l6-s1701.fw | typical | A-all-tracks-10kb | warm | 3 | 0.31 | 0.31 | 0 | 0 | 0 | 0 | 0 | 136205 |
| sparse-n24-tile4096-g24-positions-l6-s1701.fw | typical | B-single-track-100kb | cold | 3 | 196.75 | 197.56 | 2 | 100126 | 12173 | 87953 | 26 | 723129 |
| sparse-n24-tile4096-g24-positions-l6-s1701.fw | typical | B-single-track-100kb | warm | 3 | 0.12 | 0.12 | 0 | 0 | 0 | 0 | 0 | 723129 |
| sparse-n24-tile4096-g24-positions-l6-s1701.fw | typical | B-all-tracks-100kb | cold | 3 | 195.34 | 195.87 | 2 | 100126 | 12173 | 87953 | 26 | 723129 |
| sparse-n24-tile4096-g24-positions-l6-s1701.fw | typical | B-all-tracks-100kb | warm | 3 | 1.03 | 1.62 | 0 | 0 | 0 | 0 | 0 | 723129 |
| sparse-n24-tile4096-g24-positions-l6-s1701.fw | typical | C-same-group | cold | 3 | 196.17 | 198.05 | 2 | 100126 | 12173 | 87953 | 26 | 723129 |
| sparse-n24-tile4096-g24-positions-l6-s1701.fw | typical | C-same-group | warm | 3 | 0.20 | 0.21 | 0 | 0 | 0 | 0 | 0 | 723129 |
| sparse-n24-tile4096-g24-positions-l6-s1701.fw | typical | C-different-groups | cold | 3 | 195.39 | 195.41 | 2 | 100126 | 12173 | 87953 | 26 | 723129 |
| sparse-n24-tile4096-g24-positions-l6-s1701.fw | typical | C-different-groups | warm | 3 | 0.12 | 0.13 | 0 | 0 | 0 | 0 | 0 | 723129 |
| sparse-n24-tile4096-g24-positions-l6-s1701.fw | typical | H-batch | cold | 3 | 181.69 | 181.89 | 4 | 56630 | 12173 | 44457 | 14 | 382797 |
| sparse-n24-tile4096-g24-positions-l6-s1701.fw | typical | H-batch | warm | 3 | 0.20 | 0.24 | 0 | 0 | 0 | 0 | 0 | 382797 |
| sparse-n24-tile4096-g24-positions-l6-s1701.fw | typical | H-sequential | cold | 3 | 442.72 | 442.92 | 5 | 56630 | 12173 | 44457 | 14 | 382797 |
| sparse-n24-tile4096-g24-positions-l6-s1701.fw | typical | H-sequential | warm | 3 | 0.53 | 0.54 | 0 | 0 | 0 | 0 | 0 | 382797 |
| sparse-n24-tile4096-g4-tracks-l6-s1701.fw | typical | A-single-track-10kb | cold | 3 | 178.69 | 178.86 | 2 | 26094 | 1143 | 24951 | 1 | 123347 |
| sparse-n24-tile4096-g4-tracks-l6-s1701.fw | typical | A-single-track-10kb | warm | 3 | 0.09 | 0.09 | 0 | 0 | 0 | 0 | 0 | 123347 |
| sparse-n24-tile4096-g4-tracks-l6-s1701.fw | typical | A-all-tracks-10kb | cold | 3 | 567.01 | 568.18 | 25 | 618446 | 27277 | 591169 | 24 | 2917225 |
| sparse-n24-tile4096-g4-tracks-l6-s1701.fw | typical | A-all-tracks-10kb | warm | 3 | 0.32 | 0.40 | 0 | 0 | 0 | 0 | 0 | 2917225 |
| sparse-n24-tile4096-g4-tracks-l6-s1701.fw | typical | B-single-track-100kb | cold | 3 | 176.84 | 177.47 | 2 | 26094 | 1143 | 24951 | 1 | 123347 |
| sparse-n24-tile4096-g4-tracks-l6-s1701.fw | typical | B-single-track-100kb | warm | 3 | 0.12 | 0.23 | 0 | 0 | 0 | 0 | 0 | 123347 |
| sparse-n24-tile4096-g4-tracks-l6-s1701.fw | typical | B-all-tracks-100kb | cold | 3 | 571.10 | 572.01 | 25 | 618446 | 27277 | 591169 | 24 | 2917225 |
| sparse-n24-tile4096-g4-tracks-l6-s1701.fw | typical | B-all-tracks-100kb | warm | 3 | 1.07 | 1.08 | 0 | 0 | 0 | 0 | 0 | 2917225 |
| sparse-n24-tile4096-g4-tracks-l6-s1701.fw | typical | C-same-group | cold | 3 | 176.91 | 179.10 | 2 | 26094 | 1143 | 24951 | 1 | 123347 |
| sparse-n24-tile4096-g4-tracks-l6-s1701.fw | typical | C-same-group | warm | 3 | 0.08 | 0.10 | 0 | 0 | 0 | 0 | 0 | 123347 |
| sparse-n24-tile4096-g4-tracks-l6-s1701.fw | typical | C-different-groups | cold | 3 | 199.11 | 201.31 | 5 | 103598 | 4555 | 99043 | 4 | 489063 |
| sparse-n24-tile4096-g4-tracks-l6-s1701.fw | typical | C-different-groups | warm | 3 | 0.15 | 0.18 | 0 | 0 | 0 | 0 | 0 | 489063 |
| sparse-n24-tile4096-g4-tracks-l6-s1701.fw | typical | H-batch | cold | 3 | 215.45 | 217.28 | 8 | 193551 | 6833 | 186718 | 12 | 909209 |
| sparse-n24-tile4096-g4-tracks-l6-s1701.fw | typical | H-batch | warm | 3 | 0.18 | 0.24 | 0 | 0 | 0 | 0 | 0 | 909209 |
| sparse-n24-tile4096-g4-tracks-l6-s1701.fw | typical | H-sequential | cold | 3 | 308.58 | 309.34 | 8 | 193551 | 6833 | 186718 | 12 | 909209 |
| sparse-n24-tile4096-g4-tracks-l6-s1701.fw | typical | H-sequential | warm | 3 | 0.32 | 0.50 | 0 | 0 | 0 | 0 | 0 | 909209 |

Full samples include initialization, index loading, decompression, decoding time, chunk fetches, and cache hit/miss counts in the adjacent JSON file. Small repetition counts support exploratory comparisons; p95 is interpolated and is not a stable tail-latency estimate.
