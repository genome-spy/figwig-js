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
- Record actionable format, writer and reader findings in `FINDINGS.md`, making
  their scope explicit. Support performance claims with measurements.
- Run checks appropriate to the change. `npm run release:check` runs the full
  verification suite and previews the npm package contents.

## Changesets

Every non-trivial commit must include its own new `.changeset/*.md` file in the
same commit. This includes features, bug fixes, performance improvements,
compatibility or runtime dependency changes, and substantial refactors. Do not
defer the changeset to a later commit.

Use `npm run changeset` and select the appropriate version bump. Write concise,
end-user-oriented entries: usually one or two sentences describing the changed
behavior or practical benefit. Omit implementation details, development history
and agent activities. Do not claim unmeasured performance improvements.

Trivial documentation or formatting edits may omit a changeset. Mechanical
release preparation consumes existing changesets and does not need an additional
entry.
