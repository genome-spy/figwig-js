# Development

Use Node.js 22+ and `npm ci`. Run `npm run typecheck`, `npm run lint`, `npm test`,
`npm run test:browser` (after `npx playwright install chromium`), and
`npm run build` before submitting changes. Local HTTP tests require permission
to bind a localhost port; actual browser tests require permission to launch
Chromium. There is no npm publish workflow.

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

Record remarkable observations and failed assumptions in `findings.md`.
Performance claims need measured evidence and reproducible commands in
`benchmarks/RESULTS.md`; keep large generated files out of Git. Source layout is
standalone, so the task's former `packages/figwig/benchmarks/RESULTS.md` path maps
to `benchmarks/RESULTS.md` here.

If creating the GitHub remote in a fresh checkout without one:

```sh
gh auth login
gh repo create genome-spy/figwig-js --private --source=. --remote=origin
git push -u origin main
```

An existing organization repository should be connected with `git remote add`
instead. Do not publish this package to npm as part of initial development.
