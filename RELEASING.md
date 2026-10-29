# Releases

Use Node.js 24 LTS and npm 11.5.1 or newer. `publish.yml` runs explicitly on a
stable `vX.Y.Z` tag with GitHub-hosted runners and npm OIDC authentication. It
checks the tag, changelog, pending notes and ancestry on `main`, then runs the
Node/Chromium tests, other checks and package build before publishing with
provenance. A separate job then creates a GitHub Release from the matching
`CHANGELOG.md` entry. Pushing a tag alone does not publish.

## Configure trusted publishing

When configuring or replacing a trusted publisher, complete its first successful
publication within two days; otherwise recreate it.

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

## Changelogs and releases

For each user-visible change, run:

```sh
npm run changeset
```

Choose patch for a compatible fix, minor for a compatible addition, or major
for a breaking change. Follow the [changeset policy](AGENTS.md#changesets);
notes accumulate until versioning.

When ready to release from `main`:

```sh
npm run release:version
git diff
npm run release:check
git add .changeset CHANGELOG.md package.json package-lock.json
git commit -m "Release 0.2.3"
git push origin main
```

Inspect the package listing printed by `release:check`; it should contain built
JS/declarations, README, changelog and license. Use the version actually produced
by Changesets in the commit and tag. Review the generated changelog and lockfile;
`release:version` neither commits nor
publishes. See [Changesets versioning](https://changesets.dev/guide/versioning-and-publishing).

After CI passes for that commit, tag and run the publishing workflow:

```sh
git tag -a v0.2.3 -m "Release 0.2.3"
git push origin v0.2.3
gh workflow run publish.yml --ref v0.2.3
```

Follow the run in GitHub Actions and approve the `npm` environment if reviewers
are configured. Verify the version and provenance on npm and the corresponding
GitHub Release after it succeeds.
The workflow currently publishes stable versions to `latest`; prereleases need
a separate dist-tag policy.

If npm succeeds but the GitHub Release job fails, use
[Re-run failed jobs](https://docs.github.com/en/rest/actions/workflow-runs#re-run-failed-jobs-from-a-workflow-run) or
`gh run rerun RUN_ID --failed`. This retries the failed job without republishing
npm. Do not start a new workflow run or rerun all jobs for an already published
version. Existing published GitHub Releases are left unchanged; an existing draft
must be published or removed before retrying.
