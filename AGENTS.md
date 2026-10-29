# Agent guidance

Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup, architecture and verification,
and [RELEASING.md](RELEASING.md) for versioning and publishing.

## Implementation

- Keep changes small and simple. Follow the existing GMOD-style API and avoid
  unnecessary abstractions.
- Browser use is primary. Keep runtime code independent of Node built-ins and
  GenomeSpy itself; preserve native typed-array values and missing-value semantics.
- Preserve integrity checks, allocation limits, cancellation and cache ownership.
  Follow the pinned fixture/oracle process when changing binary parsing.
- Run checks appropriate to the change. `npm run release:check` runs the full
  verification suite and previews the npm package contents.

## Documentation and evidence

- Update existing documentation in place when public behavior, setup or a durable
  maintenance constraint changes. Add a standalone document only when it has a
  clear ongoing audience that existing documentation cannot serve.
- Do not create task reports, implementation diaries or completed-work summaries,
  or append routine investigations to findings. Keep `FINDINGS.md` focused on
  unresolved format/writer proposals and the constraints needed to assess them.
- Put concise performance rationale, measured results, verification and limitations
  in the commit message body when committing directly to `main`, or in the PR
  description when using a PR. Concise user-facing performance notes may also go
  in the changeset; avoid repeating the same detail across these. Support claims
  with reproducible measurements, including revisions, commands, environment and
  dataset identity, or a reference to that evidence.
- Write generated benchmark output to ignored `benchmarks/results/`. Retain raw
  evidence needed by maintained claims through pinned history or durable
  attachments referenced from the commit or PR. Preserve reusable benchmark
  tooling and independent correctness fixtures.

## Changesets

Every commit that changes the published package's API, behavior, performance,
compatibility or runtime dependencies must include its own new `.changeset/*.md`
file in the same commit. Do not defer the changeset to a later commit.

Use `npm run changeset` and select the appropriate version bump. Write concise,
end-user-oriented entries: usually one or two sentences describing the changed
behavior or practical benefit. Omit implementation details, development history
and agent activities. Do not claim unmeasured performance improvements.

Documentation, tests, benchmark tooling, CI, formatting and internal refactors
with no user-visible package change do not require a changeset. Mechanical
release preparation consumes existing changesets and does not need an additional
entry.
