# Release notes

Run `npm run changeset` for changes that affect package users. Choose a bump and
write a short note explaining the resulting behavior. Commit the generated
Markdown file with the change. Documentation-only changes do not need a note.

Run `npm run release:version` when preparing a release. It consumes these notes,
updates the version and `CHANGELOG.md`, and synchronizes `package-lock.json`.
Review and commit the result before tagging. See [RELEASING.md](../RELEASING.md)
for publishing instructions.
