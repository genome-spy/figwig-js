# Development

Use Node.js 24 LTS and `npm ci`. Run `npm run format:check`, `npm run typecheck`, `npm run lint`, `npm test`,
`npm run test:browser` (after `npx playwright install chromium`), and
`npm run build` before submitting changes. Local HTTP tests require permission
to bind a localhost port; actual browser tests require permission to launch
Chromium. `npm run release:check` runs all of these checks and previews the npm
package contents. See [RELEASING.md](RELEASING.md) for changelogs and publishing.

Run `npm run format` to format maintained TypeScript, JavaScript, JSON, Markdown,
and workflow files with Prettier. Generated fixtures, oracle data, benchmark
measurements/reports, vendored upstream files, and the original `PROMPT.md` are
excluded in `.prettierignore` so regeneration and source attribution stay intact.

The authoritative source and fixture oracle are pinned in
[`test/fixtures/README.md`](test/fixtures/README.md). Change expected results
only through `scripts/generate-fixtures.py`, which independently checks Python's
reader against the specification reader. Add corrupt-file tests when changing
binary validation, and test both storage orders. Respect the frozen v1 format.

Architecture:

- `src/format/`: validated metadata, directory, runs/blocks, and summaries.
- `src/decoding/`: sparse-preserving, little-endian payload decoding.
- `src/utils/`: binary primitives, strict bounded zlib, and abortable coalesced I/O.
- `src/figwig.ts`: public API, shared query planning, caching, and aggregation.
- `test/`: Python-backed conformance, malformed inputs, HTTP, and Chromium tests.
- `benchmarks/`: deterministic writer, local network simulation, runner, evidence.

Keep runtime independent of Node built-ins and GenomeSpy packages. Preserve
declared track dtypes and distinguish NaNs from implicit zeros. Do not infer
valid-base counts or exact sums from rounded Figwig summaries.

Record actionable observations and design constraints in `FINDINGS.md`,
distinguishing reader/writer improvements from proposed format extensions.
Performance claims need measured evidence and reproducible commands in
`benchmarks/RESULTS.md`; keep large generated files out of Git. Source layout is
standalone, so the task's former `packages/figwig/benchmarks/RESULTS.md` path maps
to `benchmarks/RESULTS.md` here.

Add a changeset for user-visible changes with `npm run changeset`. Keep the note
focused on behavior that matters to package consumers.
