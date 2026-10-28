# Release notes

Every non-trivial commit must include its own new changeset file in the same
commit. Run `npm run changeset`, choose a bump, and write a concise,
end-user-oriented note describing the changed behavior or practical benefit.
Omit implementation details and development history. See [AGENTS.md](../AGENTS.md)
for the policy and limited exceptions.

Run `npm run release:version` when preparing a release. It consumes these notes,
updates the version and `CHANGELOG.md`, and synchronizes `package-lock.json`.
Review and commit the result before tagging. See [RELEASING.md](../RELEASING.md)
for publishing instructions.
