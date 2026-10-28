import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'

const script = fileURLToPath(
  new URL('../scripts/release-notes.mjs', import.meta.url),
)
let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'figwig-release-notes-'))
  writeFileSync(join(directory, 'package.json'), '{"version":"0.2.0"}')
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))

function run(changelog: string, version?: string) {
  writeFileSync(join(directory, 'CHANGELOG.md'), changelog)
  return spawnSync(process.execPath, [script, ...(version ? [version] : [])], {
    cwd: directory,
    encoding: 'utf8',
  })
}

const changelog = `# Package

## 0.2.0

### Minor Changes

- New queries.
  More detail.

## 0.1.0-beta.1

- Prerelease notes.

## 0.1.0

### Patch Changes

- Initial release.
`

test('defaults to the package version and preserves its subheadings', () => {
  const result = run(changelog)
  expect(result.status).toBe(0)
  expect(result.stdout).toBe(
    '### Minor Changes\n\n- New queries.\n  More detail.\n',
  )
})

test('selects an older explicit version without matching its prerelease prefix', () => {
  rmSync(join(directory, 'package.json'))
  const result = run(changelog, '0.1.0')
  expect(result.status).toBe(0)
  expect(result.stdout).toBe('### Patch Changes\n\n- Initial release.\n')
})

test('accepts CRLF changelogs', () => {
  const result = run(changelog.replaceAll('\n', '\r\n'))
  expect(result.status).toBe(0)
  expect(result.stdout).toBe(
    '### Minor Changes\n\n- New queries.\n  More detail.\n',
  )
})

test.each([
  { name: 'missing', contents: '## 0.1.0\n\nOld release.\n' },
  { name: 'empty', contents: '## 0.2.0\n\n## 0.1.0\n\nOld release.\n' },
  {
    name: 'duplicate',
    contents: '## 0.2.0\n\nFirst.\n\n## 0.2.0\n\nSecond.\n',
  },
])('rejects $name release notes before writing output', ({ contents }) => {
  const result = run(contents)
  expect(result.status).not.toBe(0)
  expect(result.stdout).toBe('')
  expect(result.stderr).toMatch(/changelog entry for 0\.2\.0/i)
})
