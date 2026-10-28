import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { parseGroup } from '../src/format/group.js'
import { parseFixed, parseTables } from '../src/format/header.js'

test('rejects oversized run metadata before reading run records', () => {
  const fixture = new Uint8Array(
    readFileSync(new URL('./fixtures/zlib.fw', import.meta.url)),
  )
  const fixed = parseFixed(fixture)
  const state = parseTables(
    fixed,
    fixture.subarray(fixed.chroms, fixed.index + fixed.nGroups * 8),
  )
  const bytes = new Uint8Array(48)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, 1, true)
  // If the parser starts reading this run before checking its allocation
  // budget, the unsafe tile number throws a different validation error.
  view.setBigUint64(8, 2n ** 53n, true)
  expect(() => parseGroup(bytes, 0, state, 111)).toThrow(
    /parsed group index allocation exceeds maxInflatedBytes/,
  )
  expect(() => parseGroup(bytes, 0, state, 112)).toThrow(/MAX_SAFE_INTEGER/)
})
