# Release notes

Run `npm run changeset` to add release notes, following the
[changeset policy](../AGENTS.md#changesets).

Run `npm run release:version` when preparing a release. It consumes these notes,
updates the version and `CHANGELOG.md`, and synchronizes `package-lock.json`.
Review and commit the result before tagging. See [RELEASING.md](../RELEASING.md)
for publishing instructions.
