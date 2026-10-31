# Regional summary access

Directly addressed pages replace the original B+ tree proposal to keep lookup,
validation and construction simple. The Python companion checkout
owns the binary contract in `docs/summary_restarts.rst` and its writer plan in
`SUMMARY_RESTARTS_PLAN.md`.

## Scope and rollout

- Python `FigWigWriter(..., summary_index=True)` and `write_figwig` opt in;
  the default is `False`. Files without an eligible level remain ordinary v1.
- figwig-js detects the index for aligned `getBins` and feature
  summary queries. Ordinary v1 fallback and explicit whole-level APIs remain.
- The 32 KiB target and 2,048-bin cap use profile 2 in the locator
  and root. Unsupported profiles, including the earlier 16 KiB profile 1, use
  ordinary v1 summaries. The core file format stays version 1.
- Python also uses the index in its existing selected-chromosome `tile_sums`
  and guarded exact integer `sums` paths. It keeps local file access and the
  existing public API; package e2e tests and local benchmarks cover those reads.
- Keep existing zero/NaN behavior, actual float32 base sums and float64 zoom
  bytes, aggregation order and resolution rules. Do not regenerate zooms from
  newly rounded base sums.
- No B+ tree, checkpoint dictionaries, duplicate summary pyramid, sidecar,
  converter, new Python regional API, statistics, worker or renderer work.
- Keep both repositories on their requested branches without commits or
  publication until separately requested.

## Verified baseline

Investigation revisions were Python Figwig
[`1052310689c5cc76a9a78c2e9fda30c698d8c16c`](https://github.com/jmschrei/figwig/tree/1052310689c5cc76a9a78c2e9fda30c698d8c16c)
and figwig-js
[`32d10ee6498334cecbcbe198199e8a39dbf415a6`](https://github.com/genome-spy/figwig-js/tree/32d10ee6498334cecbcbe198199e8a39dbf415a6).
The original nine fixtures and independent oracle remain pinned to
`c0e5d6522c677b9f03cd6831e2dbcea759866628`.
Between the Python revisions, `docs/figwig.ksy` and
`tests/format_reference.py` are unchanged; the format-text change concerns
`write_sparse` encoding choices, not the summary layout.

V1 stores one genome-wide zlib stream per group and summary level. Its decoded
layout is all listed `u4` bin IDs, followed by bin-major sums for every group
slot: `f4` for base summaries and `f8` for zooms. Python `_tile_sums_of` and
`_zoom_levels_of` inflate whole levels. The original JS
[`getSummary`/`summaryBins`](src/figwig.ts) likewise fetched a complete selected
level before selecting the region. [Section tests](test/section-reads.test.ts)
already proved independent level discovery, but not spatial access inside one.

Cold summary work therefore scaled with the complete selected levels, even for
a tiny viewport. A measured 64-bin query on the existing
`sparse-n24-tile1024-g8-positions-l6-s1701.fw` read its whole 9,504-byte base
stream and inflated 22,032 bytes for 612 genome-wide rows. It made eight
post-metadata reads, seven being discovery probes. A warm adjacent query made
zero reads. The dataset SHA-256 was
`b9c7bd568f53befbeacf5dc219ee9b112aca754976952eeb7c58b35f56560599`.

## Compatibility

The [frozen v1 specification](https://github.com/jmschrei/figwig/blob/1052310689c5cc76a9a78c2e9fda30c698d8c16c/docs/format.rst)
allows ignored optional bits, foreign JSON metadata and unused data-region
bytes before `chroms`. It requires existing group records to remain back to
back through declared `length`, reserved fields to keep their v1 values, and
every legacy summary to remain one complete zlib stream. Bytes after `length`
are outside the v1 file. Header/table CRCs protect discovery.

| Design or operation                                                          | Compatibility and policy                                                                                   |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Single zlib stream with full-flush restarts; directory in unused data region | Valid v1 core layout; unmodified readers return unchanged raw data and summaries, ignoring the accelerator |
| New reader, ordinary v1 file                                                 | Existing fallback; unknown optional bit alone must not trigger rejection                                   |
| New reader, stale valid root                                                 | Ignore accelerator and use the ordinary path                                                               |
| Recognized current-generation malformed directory or fragment                | Error; never return zeros or silently accept corruption                                                    |
| Ordinary track append                                                        | Preserve the foreign locator unchanged and clear the feature bit                                           |
| `append=True, summary_index=True`                                            | Reject before opening or modifying the file                                                                |
| Merge/reorder/new copies                                                     | Default to ordinary summaries; safe to discard the accelerator                                             |
| BGZF/gzip or concatenated zlib members replacing legacy payloads             | Incompatible with v1 single-stream framing                                                                 |
| Extra counted trailer/index fields or nonzero reserved zoom offset           | Not a valid v1 extension strategy, even if a permissive parser accepts it                                  |

Probes confirmed the distinction between conformance and acceptance: Python
and the independent reference accepted a counted trailer which JS rejected;
all three accepted a nonzero reserved zoom offset despite its required zero.
Those parser gaps do not authorize a writer layout change.

Discovery requires both optional bit `0x2` and the namespaced
metadata locator `org.figwig.summary-restarts` with version 2. A missing key
or unknown locator version falls back. This branch does not claim a registered
upstream feature assignment. The root contains the exact final 128-byte header,
so normal rewrites cannot reuse another generation's accelerator.

V1 explicitly requires ordinary append to preserve foreign metadata keys.
Clearing its optional bit invalidates the accelerator without violating that
rule. Automatic preservation or a summary-only refresh converter is deferred.

## Why full-flush restarts

[BigWig's layout](https://github.com/ucscGenomeBrowser/kent/blob/master/src/inc/bbiFile.h)
and [summary reader](https://github.com/ucscGenomeBrowser/kent/blob/master/src/lib/bbiRead.c)
combine resolution-specific lookup, spatial block indexes, coalesced reads and
independent decompression. The local Python BigWig writer already uses blocked
zoom storage; its reader loads a flat raw index and is not a paged HTTP zoom
reader to copy directly. BigWig's overlap-weighted statistics are outside scope.

[BGZF](https://samtools.github.io/hts-specs/SAMv1.pdf) uses concatenated gzip
members; v1 uses one zlib stream. Instead,
[`Z_FULL_FLUSH`](https://zlib.net/manual.html) resets DEFLATE history inside
that stream. `Z_SYNC_FLUSH` does not reset the dictionary and is insufficient.
The writer records boundaries; a reader must not scan for marker bytes.

A regional unit has two compressed ranges because v1 puts all IDs before all
sum rows. Each fragment ends in `00 00 ff ff`, begins after a history reset,
and records compressed/decoded CRCs plus exact output size. A fresh bounded raw
decoder appends the empty final block `03 00`, checks a true end and complete
input consumption, and validates both CRCs. The terminator provides framing,
not integrity. Keep the whole-zlib decoder's CRC/Adler/trailing-data checks.

Regional validation covers requested pages/fragments and defers unread bytes.
It does not establish the entire legacy stream's CRC/Adler. Explicit whole-level
APIs retain that complete check. Available empty streams still require ordinary
empty-zlib integrity validation before returning zeros.

## Selected binary design

The companion Python specification is authoritative. The structures are:

- A 256-byte root: `FWRSUM1\0`, version/size, root CRC, group-directory offset,
  group count, page capacity 102, decoded target 32 KiB, reserved zeros, and
  the exact final core header at bytes 64–191.
- One individually checksummed 32-byte locator per group. It names a variable
  catalog of 1–13 level records and verifies group/slot counts before following
  the pointer. Only selected groups are fetched.
- A 32-byte level record: source offset, index offset, source row count, source
  byte count, source CRC and window size. Position implies factor and dtype.
  Zero index/window size means the complete legacy stream is used.
- Directly addressed pages of at most 4,096 bytes: a 16-byte `FWRP` header
  with first window/count/CRC and up to 102 forty-byte descriptors. The last
  page is trimmed. No tree nodes or spatial keys are stored.
- A descriptor contains `n_rows`, `first_source_row`, then relative offset,
  compressed bytes, compressed CRC and decoded CRC for IDs and for sums.
  An empty descriptor is entirely zero.

Use existing level-global bin IDs. Window `j` contains IDs in `[j*B,(j+1)*B)`;
`B` is the largest power of two at most 2,048 with
`B*(4 + width*group_tracks) <= 32 KiB`. A storage window may include bins from
neighboring chromosomes; biological bins still never cross chromosome ends.
The existing chromosome-specific level offsets filter the requested interval.
This avoids per-chromosome padding and extra lookup tables.

All directory data is inside `[ROOT+256, chroms)`. Source streams remain inside
their original group-record extents. Check safe integer offsets, arithmetic,
counts and configured read/allocation limits before I/O or allocation. Requested
pages reject overlapping/out-of-order visible fragments and inconsistent row
ranks. Fragment output sizes follow from row count, group size and dtype.

Initially leave a level ordinary when both compressed and decoded sizes are
at most 64 KiB, or one row is wider than 32 KiB. Preserve the writer's existing
256 MiB summary cutoff. Count root, locators, catalogs and pages against a
16 MiB directory budget before allocating; deterministic per-group shares avoid
thread-order-dependent output. If no level qualifies, emit no extension.

Index storage is `256 + 32*groups + sum(32*levels_per_group)` plus
`40*ceil(total_level_bins/B) + 16*ceil(window_count/102)` for indexed levels.
The 16 MiB construction budget handles pathological cases. Dense arithmetic
pages are intentionally simpler than the original sparse B+ tree.

## Reader implementation and access sequence

1. Use ordinary header/table initialization and CRC validation. Physical file
   size may be unknown under CORS; declared length and explicit offsets suffice.
   Core metadata remains whole-table v1 I/O; this does not page raw indexes.
2. Discover/check the root lazily for regional summaries. Check its generation
   before interpreting a stale root with changed group counts. Fetch/check only
   the selected 32-byte locators and small level catalogs.
3. Select the same coarsest aligned factor as the existing API. Preserve
   `missing: 'zero'`, chromosome-end exceptions and `requireSummaries` behavior.
   Preflight all groups before modifying output or allowing raw fallback.
4. For a regional indexed level, validate its legacy header and first two zlib
   bytes, then fetch only arithmetic descriptor pages and selected fragments.
   Preserve aggregation order while decoding bounded batches.
5. For small/broad levels, use the already-known source descriptor to read the
   legacy header and complete stream together. Check CRC/Adler and share the
   whole-level result with public `getSummary`; do not rediscover every header.
6. Share in-flight reads under the existing all-waiters cancellation rule.
   Abort this query's outstanding work after failure, preserve unrelated
   waiters, and stop scheduling later groups/windows. Close and clear use the
   existing reader lifetime/cache ownership.

Directory metadata, parsed pages and owned decoded windows share
`summaryCacheBytes`, independently of raw-index retention. Never retain a small
view into a large coalesced response. Public binned outputs own their arrays.
Zero/tiny budgets retain no oversized settled entry. Check inflation limits
during decoding, not afterward. Whole-level APIs keep their documented shape
and cached-array read-only convention.

For one group/window, the cold path after core metadata is root + locator +
catalog + selected source-header probe + descriptor page + two fragments:
seven requests before coalescing. A repeat inside cached windows makes no
network reads. Crossing into a new window normally needs two fragments and
possibly a new page. Resolution changes reuse discovery but load that level's
windows. A broad overview uses a complete small stream in one request per group.

Position groups still couple tracks; selecting one of eight fetches its group's
regional data. Track order reduces subset overfetch and can require more
requests for many tracks. More caching does not remove cold whole-level cost;
conversely, ordinary whole-level caching can make later uncached-region pans
cheaper than regional fetching when that entire level already fits in memory.

## Alternatives retained from investigation

- In-file blocked copies simplify each regional payload to one complete zlib
  stream, but retain the legacy copy. Added storage is blocked-copy bytes plus
  its index, and the writer serializes/compresses another live pyramid.
- A sidecar store can leave an immutable source untouched, but requires explicit
  discovery and source-generation binding. A URL/header CRC is not a content
  identity; strong verification requires trusted immutable identity or a full
  source hash. This initial implementation does not add it.
- Existing-stream checkpoints need offsets, bit state and up to 32 KiB history
  per [zran access point](https://github.com/madler/zlib/blob/v1.3.1/examples/zran.h).
  Sparse rank lookup and partial validation are also needed. Browser native
  APIs do not restore arbitrary inflater state. This is more machinery than
  rewriting summaries with full-flush boundaries.
- If the v1 extension surfaces are rejected upstream, an honest v2 can replace
  legacy summaries with complete ID-plus-sum blocks. It must use a real new
  version rather than reinterpret v1 reserved fields or relabel gzip as zlib.

## Evidence and verification gates

The earlier disposable 16 KiB/profile-1 probes and
[evidence bundle](benchmarks/results/summary-index-feasibility.tgz) remain local
under ignored benchmark results. On macOS 26.5.1 arm64, Python 3.12.13,
NumPy 2.5.4, zlib 1.2.12, Node 26.8.1 and Chromium 156:

- All nine modified carrier fixtures matched the independent v1 oracle, pinned
  and current Python readers, and JS. Those probes did not serialize this final
  arithmetic directory, so current tests must validate the complete format.
- A dense 65,536-bin/eight-track Gaussian `f4` shape had 2,033,202 ordinary
  compressed bytes versus 2,047,966 restarted bytes: 0.73% compression overhead,
  excluding index storage. A 64-bin payload probe transferred 8,009 bytes and
  inflated 9,216 bytes versus 2,359,296 for the whole level. All 512 fragments
  decoded in Pako and native Chromium raw-DEFLATE; CORS hid physical length.
- Count shapes showed higher compression overhead: 7.39% for eight tracks at
  256-bin windows, 6.01% for one track at 1,024-bin windows. Tiny sparse levels
  could grow by more than 100%, supporting the bounded small-level fallback.
- A separate dense count probe's additional ID-plus-sum blocked copy occupied
  723,496 bytes alongside its original 620,645 bytes: 116.57% added summary
  storage before an index. Small compression-only timings did not establish
  writer speedups, browser latency or peak memory.

Use independent Python-generated paired fixtures in
`scripts/generate-summary-fixtures.py`; leave the original pinned nine intact.
New manifests pin the writer's base revision and actual source/spec hashes
while these branches remain uncommitted. Validate every raw value and actual
summary/zoom bytes with independent v1 and extension readers.

Required regressions cover both orders; multiple groups/levels/chromosomes;
rounded values, NaNs/zero/cancellation sums; available-empty versus absent;
window/page/chromosome edges; bad root/locator/catalog/page/fragment CRCs;
CRC-correct aliases and bad ranks; unsafe offsets/allocations; invalid wrappers,
dictionaries, truncation, end markers and excess output; stale generations;
shared abort, close, query failure, cache eviction and response-buffer ownership.

Benchmark the complete path at a shared 50,000,000 bits/s and 10 ms response
latency, modeled as RTT. Use identical flag-off/on signals, both orders,
one/all tracks, cold reads, repeat/adjacent/new-window pans, resolution changes
and coarse overviews. Record initialization separately; actual 206 body bytes,
requests, payload/directory/gap bytes, bytes inflated, cache weights, process
memory samples, storage growth and writer construction observations. A warm
cache latency alone does not establish the benefit.

Reusable tools, precise commands and measurement caveats are in
[benchmarks/README.md](benchmarks/README.md). Raw output and exact reader source
snapshots belong in ignored `benchmarks/results/`; retain them as durable
attachments before carrying claims into a commit or PR. Future runtime commits
must include a new changeset.

Acceptance: the representative 64-bin/eight-track query avoids the complete
level, inflates one 512-bin window (18,432 bytes), and fetches bounded metadata
and pages. Repeats reuse cached windows; new windows fetch only their fragments.
Sparse empty descriptors fetch no payload; actual empty streams still validate.
Both old readers and ordinary-v1 fallback must keep returning unchanged values.
