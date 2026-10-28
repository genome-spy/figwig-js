import { readFileSync } from 'node:fs'
import { BlobFile } from 'generic-filehandle2'
import { expect, test } from 'vitest'
import { FigWig, FigWigError } from '../src/index.js'
import { decodeChunk } from '../src/decoding/chunk.js'
import { parseFixed } from '../src/format/header.js'
import { crc32 } from '../src/utils/binary.js'

test('malformed payloads use the public corruption error type', () => {
  // A dense uint8 tile requires 16 values, but this payload has only eight.
  expect(() => decodeChunk(new Uint8Array(8), 1, 1, 16)).toThrow(FigWigError)
})

test('invalid metadata JSON uses the public corruption error type and preserves its cause', async () => {
  const bytes = new Uint8Array(
    readFileSync(new URL('./fixtures/zlib.fw', import.meta.url)),
  )
  const fixed = parseFixed(bytes)
  bytes.fill(32, fixed.metadata, fixed.metadata + fixed.metadataLength)
  bytes[fixed.metadata] = 0x7b // An unterminated JSON object, followed by spaces.
  const view = new DataView(bytes.buffer)
  view.setUint32(
    28,
    crc32(bytes.subarray(fixed.chroms, fixed.index + fixed.nGroups * 8)),
    true,
  )
  view.setUint32(104, 0, true)
  view.setUint32(104, crc32(bytes.subarray(0, 128)), true)
  const reader = new FigWig({ filehandle: new BlobFile(new Blob([bytes])) })
  try {
    const error: unknown = await reader
      .getHeader()
      .catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(FigWigError)
    expect(error).toMatchObject({
      message: 'Figwig: invalid JSON metadata',
      cause: expect.any(SyntaxError),
    })
  } finally {
    await reader.close()
  }
})

test.each(['zlib', 'tracks_zlib'])(
  '%s invalid UTF-8 chromosome names use the public corruption error type and preserve their cause',
  async (name) => {
    const bytes = new Uint8Array(
      readFileSync(new URL(`./fixtures/${name}.fw`, import.meta.url)),
    )
    const fixed = parseFixed(bytes),
      view = new DataView(bytes.buffer)
    // Corrupt the first name, then repair CRCs so decoding reaches the bad UTF-8.
    bytes[fixed.chroms + 2] = 0xff
    view.setUint32(
      28,
      crc32(bytes.subarray(fixed.chroms, fixed.index + fixed.nGroups * 8)),
      true,
    )
    view.setUint32(104, 0, true)
    view.setUint32(104, crc32(bytes.subarray(0, 128)), true)
    const reader = new FigWig({ filehandle: new BlobFile(new Blob([bytes])) })
    try {
      const error: unknown = await reader
        .getHeader()
        .catch((cause: unknown) => cause)
      expect(error).toBeInstanceOf(FigWigError)
      expect(error).toMatchObject({
        message: 'Figwig: invalid UTF-8 chromosome name',
        cause: expect.any(TypeError),
      })
    } finally {
      await reader.close()
    }
  },
)
