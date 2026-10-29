# Decompression backend constraints

The reader requires bounded output, RFC1950 header and Adler32 validation,
exact declared output length, and rejection of trailing or concatenated input.
Any alternative backend must preserve these checks, browser compatibility and
aggregate allocation limits, including when batching.

The [historical GMOD libdeflate experiment](https://github.com/genome-spy/figwig-js/blob/b0bac083052deaf0a5a3f6d61e200967909c3c79/benchmarks/DECOMPRESSION.md)
and [raw samples](https://github.com/genome-spy/figwig-js/blob/b0bac083052deaf0a5a3f6d61e200967909c3c79/benchmarks/measurements/decompression.json)
are preserved in Git history. The inspected BGZF/BBI APIs did not provide all
required validation; that finding applies to the versions pinned in the report.
Its timings used an older Pako backend and do not describe current performance.
