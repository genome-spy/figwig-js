# Releases

Use Node.js 24 LTS and npm 11.5.1 or newer. `publish.yml` runs explicitly on a
stable `vX.Y.Z` tag with GitHub-hosted runners and npm OIDC authentication. It
checks the tag, changelog, pending notes and ancestry on `main`, then runs the
Node/Chromium tests, other checks and package build before publishing with
provenance. Pushing a tag alone does not publish.

## Initial release: 0.1.0

The version and initial changelog are already prepared. Commit and push the
release setup to `main`, wait for CI, and start from that clean checkout.

This setup bootstraps the new npm package with one local publication; npm requires
an existing package before configuring a trusted publisher. Use an npm account
with permission to publish under `@genome-spy`. See npm's
[trust prerequisites](https://github.com/npm/cli/blob/latest/docs/lib/content/commands/npm-trust.md#prerequisites).

```sh
npm ci
npx playwright install chromium
npm run release:check
npm login
npm publish --access public
git tag -a v0.1.0 -m "Release 0.1.0"
git push origin v0.1.0
```

Inspect the `npm pack --dry-run` listing printed by `release:check` before
publishing: it should contain built JS/declarations, README, changelog and license.
The local first publication has no GitHub Actions provenance. Do not run the
publishing workflow for `v0.1.0` after publishing it locally; npm versions cannot
be overwritten.

## Configure trusted publishing

Do this when ready for the next release: a new npm publisher must complete its
first successful publication within two days, otherwise recreate it.

1. In GitHub **Settings → Environments**, create `npm`. Restrict deployment tags
   to `v*`; required reviewers are optional.
2. In the npm package's **Settings → Trusted publishing**, add GitHub Actions:

   | Field                | Value                       |
   | -------------------- | --------------------------- |
   | Organization or user | `genome-spy`                |
   | Repository           | `figwig-js`                 |
   | Workflow filename    | `publish.yml`               |
   | Environment name     | `npm`                       |
   | Allowed action       | Enable direct `npm publish` |

The workflow must be present on GitHub's default branch. Field names, filename
and environment must match exactly. No `NPM_TOKEN` or `NODE_AUTH_TOKEN` secret is
needed. The repository and package must remain public for provenance. See
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) and
[npm provenance](https://docs.npmjs.com/generating-provenance-statements/).

## Changelogs and subsequent releases

For each user-visible change, run:

```sh
npm run changeset
```

Choose patch for a compatible fix, minor for a compatible addition, or major
for a breaking change, and write a concise note. Commit the generated
`.changeset/*.md` file with the implementation. Notes can accumulate across
several changes; documentation-only edits need no changeset.

When ready to release from `main`:

```sh
npm run release:version
git diff
npm run release:check
git add .changeset CHANGELOG.md package.json package-lock.json
git commit -m "Release 0.1.1"
git push origin main
```

Use the version actually produced by Changesets in the commit and tag. Review
the generated changelog and lockfile; `release:version` neither commits nor
publishes. See [Changesets versioning](https://changesets.dev/guide/versioning-and-publishing).

After CI passes for that commit, tag and run the publishing workflow:

```sh
git tag -a v0.1.1 -m "Release 0.1.1"
git push origin v0.1.1
gh workflow run publish.yml --ref v0.1.1
```

Follow the run in GitHub Actions and approve the `npm` environment if reviewers
are configured. Verify the version and provenance on npm after it succeeds.
The workflow currently publishes stable versions to `latest`; prereleases need
a separate dist-tag policy. This setup does not create GitHub releases.
