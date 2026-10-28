import { readFileSync } from 'node:fs'
import process from 'node:process'

const version =
  process.argv[2] ?? JSON.parse(readFileSync('package.json', 'utf8')).version
const entries = readFileSync('CHANGELOG.md', 'utf8')
  .replaceAll('\r\n', '\n')
  .split(/^## /m)
  .filter((entry) => entry.startsWith(`${version}\n`))
if (entries.length !== 1)
  throw new Error(
    `Expected one changelog entry for ${version}, found ${entries.length}`,
  )
const notes = entries[0].slice(version.length).trim()
if (!notes) throw new Error(`Changelog entry for ${version} is empty`)
process.stdout.write(`${notes}\n`)
