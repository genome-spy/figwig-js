# @genome-spy/figwig

## 0.2.4

### Patch Changes

- d32c351: Read remote Figwig files when CORS does not expose `Content-Range`. Physical-size
  validation remains enabled when the size is known, and truncated reads are still
  rejected.

## 0.2.3

### Patch Changes

- d85cc76: Fetch raw indexes and selected summary levels independently, reducing unnecessary transfers. Integrity checks for unused sections are deferred until requested.
- b296834: Reuse cached summary metadata when raw indexes are evicted, reducing repeated index reads during summary queries.

## 0.2.2

### Patch Changes

- 7a18069: Reduce latency when reading new regions of missing data without changing missing-value or summary behavior.

## 0.2.1

### Patch Changes

- 4659039: Keep fully missing dense tiles compact so queries over NaN gaps avoid repeated decoding and per-base aggregation.

## 0.2.0

### Minor Changes

- Add `requireSummaries` to bin and feature queries so callers can reject requests
  that would fall back to full-resolution data.

### Patch Changes

- 76018bb: Reduce the CPU cost of reading compressed data while preserving strict zlib integrity checks.
- 187709e: Reduce HTTP requests for multi-group queries by coalescing nearby group-index reads while preserving cache budgets and cancellation.
- ebe4336: Read valid compressed track-order blocks even when zlib expansion exceeds the position-order chunk size limit.
- 23e68ef: Speed up repeated track selections by caching name lookups for each reader.
- 9f60f43: Published versions now get GitHub Releases with notes from the changelog.
- eaf7556: Report invalid UTF-8 chromosome names as FigWigError, preserving the underlying decoding error as the cause.
- b89eeb6: Speed up binned queries while preserving missing-value handling and numeric accumulation order.
- 8c3431e: Reject malformed zoom records that omit their required compressed stream.

## 0.1.0

### Minor Changes

- Initial Figwig v1 reader for browsers and Node.js, with random access through
  `generic-filehandle2` and a GMOD-style API.
- Native typed-array values, track selection, binned aggregation, interval
  features, and stored summaries across both storage orders and all v1 encodings.
- Strict integrity and allocation checks, bounded caches, shared cancellable
  reads, and the ESM inflater used by GMOD's BGZF reader.
