import { parse, ParseStream } from '../kaitai/parse.js'

/** A decoded track keeps sparse entries sparse. Offsets are relative to a tile,
 * or absolute chromosome positions for a track-order block. */
export interface DecodedTrack {
  offsets?: Uint32Array
  values: Float64Array
  runs?: boolean
}

export interface DecodedChunk {
  tracks: DecodedTrack[]
  /** Retained typed-array bytes (views sharing a buffer are counted once). */
  byteLength: number
}

export interface KindInfo {
  kind: number
  code: number
  width: number
  stored: boolean
}

const WIDTHS = [1, 2, 4, 1, 2, 4, 4, 0, 8] as const
const PARSE_WINDOW = 4096
const EMPTY_OFFSETS = new Uint32Array(0)
const EMPTY_VALUES = new Float64Array(0)

function corrupt(message: string): never {
  throw new Error(`Corrupt Figwig chunk: ${message}`)
}

/** Validate a live tile's kind byte, or a track-order block's kind byte. */
export function validateKind(
  kindByte: number,
  block = false,
  codec?: number,
): KindInfo {
  if (!Number.isInteger(kindByte) || kindByte < 0 || kindByte > 255) {
    corrupt('kind byte is outside 0..255')
  }
  const kind = kindByte & 7
  const code = (kindByte >>> 3) & 15
  const stored = (kindByte & 128) !== 0
  if (kind < 1 || kind > 4 || code > 8)
    corrupt('unsupported kind or element code')
  if (block) {
    if (kind !== 1 || stored)
      corrupt('a block must have kind 1 without a stored bit')
  } else if ((kind === 1 || kind === 4) && code === 7) {
    corrupt('dense and runs chunks cannot use implicit-one elements')
  }
  if (codec === 0 && stored) corrupt('the stored bit is forbidden with codec 0')
  return { kind, code, width: WIDTHS[code]!, stored }
}

function pad(n: number, alignment: number): number {
  return Math.ceil(n / alignment) * alignment
}

function requireExtent(payload: Uint8Array, end: number): void {
  if (!Number.isSafeInteger(end) || end < 0 || end > payload.byteLength) {
    corrupt('payload is truncated or its element count is invalid')
  }
}

function payloadStream(payload: Uint8Array): ParseStream {
  if (payload.byteLength % 8 !== 0)
    corrupt('payload length is not a multiple of 8')
  return new ParseStream(payload)
}

interface ParsedValues {
  values: number[]
}

function readValues(stream: ParseStream, count: number, code: number) {
  const values = new Float64Array(count)
  if (code === 7) return values.fill(1)
  // Kaitai emits number[] for repeated primitives. Keep only a bounded
  // staging window live instead of another array proportional to the payload.
  for (let first = 0; first < count; first += PARSE_WINDOW) {
    const parsed = parse<ParsedValues>(
      'ElementValues',
      stream,
      code,
      Math.min(PARSE_WINDOW, count - first),
    )
    for (let i = 0; i < parsed.values.length; i++) {
      const value = parsed.values[i]
      if (value === Infinity || value === -Infinity)
        corrupt('infinite numeric value')
      values[first + i] = value
    }
  }
  return values
}

function readIntegers(stream: ParseStream, count: number, width: 16 | 32) {
  const values = new Uint32Array(count)
  for (let first = 0; first < count; first += PARSE_WINDOW) {
    const parsed = parse<ParsedValues>(
      width === 16 ? 'U16Array' : 'U32Array',
      stream,
      Math.min(PARSE_WINDOW, count - first),
    )
    values.set(parsed.values, first)
  }
  return values
}

function checkDimensions(tracks: number, tile: number): void {
  if (
    !Number.isSafeInteger(tracks) ||
    tracks < 1 ||
    !Number.isInteger(tile) ||
    tile < 16 ||
    tile > 65_536 ||
    (tile & (tile - 1)) !== 0 ||
    tracks * tile > 2 ** 29
  ) {
    corrupt('invalid track count or tile size')
  }
}

function checkDecodedBudget(bytes: number, maxDecodedBytes: number): void {
  if (
    !Number.isSafeInteger(maxDecodedBytes) ||
    maxDecodedBytes < 0 ||
    bytes > maxDecodedBytes
  ) {
    corrupt('decoded allocation exceeds maxDecodedBytes')
  }
}

/** Decode one fully inflated position-order payload. No dense expansion of
 * sparse/matrix/runs chunks takes place. All numeric storage types fit exactly
 * in binary64; the query layer converts each track to its declared dtype. */
export function decodeChunk(
  payload: Uint8Array,
  kindByte: number,
  tracks: number,
  tile: number,
  maxDecodedBytes = 256 * 1024 * 1024,
): DecodedChunk {
  const info = validateKind(kindByte)
  checkDimensions(tracks, tile)
  const stream = payloadStream(payload)
  if (info.kind === 1) {
    const count = tracks * tile
    requireExtent(payload, pad(count * info.width, 8))
    checkDecodedBudget(count * 8, maxDecodedBytes)
    const values = readValues(stream, count, info.code)
    return {
      tracks: Array.from({ length: tracks }, (_, slot) => ({
        values: values.subarray(slot * tile, (slot + 1) * tile),
      })),
      byteLength: values.byteLength,
    }
  }
  if (info.kind === 3)
    return decodeMatrix(payload, stream, info, tracks, tile, maxDecodedBytes)

  requireExtent(payload, 4 + 4 * tracks)
  const total = parse<ParsedValues>('U32Array', stream, 1).values[0]
  if (total > tracks * tile) corrupt('too many sparse entries or run changes')
  checkDecodedBudget(total * 12, maxDecodedBytes)
  // Lengths are temporary workspace, separately bounded before allocating.
  checkDecodedBudget(tracks * 4, maxDecodedBytes)
  const lengths = readIntegers(stream, tracks, 32)
  let offsetsEnd = 4 + 4 * tracks
  for (const length of lengths) offsetsEnd += length
  // Every offset needs between one and three varint bytes. Check this before
  // allocating from the claimed count, including the zero-width one encoding.
  const offsetBytes = offsetsEnd - 4 - 4 * tracks
  if (offsetBytes < total || offsetBytes > 3 * total)
    corrupt('offset byte lengths do not match the entry count')
  const valuesAt = pad(offsetsEnd, 4)
  requireExtent(payload, pad(valuesAt + total * info.width, 8))
  const offsets = new Uint32Array(total)
  const decoded: DecodedTrack[] = []
  let entry = 0
  let at = 4 + 4 * tracks
  // Validate offsets before allocating/reading numeric values.
  for (let slot = 0; slot < tracks; slot++) {
    const firstEntry = entry
    const end = at + lengths[slot]!
    // Parse one varint at a time rather than retaining Kaitai's object graph
    // for the entire sparse chunk. The adapted schema caps groups at three.
    const offsetsStream = new ParseStream(payload.subarray(at, end))
    let position = 0
    let first = true
    while (offsetsStream.pos < lengths[slot]!) {
      let varint: { groups: { hasNext: boolean }[]; value: number }
      try {
        varint = parse('Varint', offsetsStream)
      } catch {
        corrupt("a varint runs past its track's bytes")
      }
      if (varint.groups[varint.groups.length - 1].hasNext)
        corrupt('a varint is longer than three bytes')
      const delta = varint.value
      if (!first && delta === 0)
        corrupt('sparse offsets or run changes do not strictly ascend')
      position += delta
      if (position >= tile || entry >= total)
        corrupt('an offset or entry count is out of bounds')
      offsets[entry++] = position
      first = false
    }
    at = end
    decoded.push({
      offsets: offsets.subarray(firstEntry, entry),
      values: EMPTY_VALUES,
      ...(info.kind === 4 ? { runs: true } : {}),
    })
  }
  if (entry !== total)
    corrupt('decoded offsets do not add up to the entry count')
  stream.at = valuesAt
  const values = readValues(stream, total, info.code)
  let valueAt = 0
  for (const track of decoded) {
    const count = track.offsets!.length
    track.values = values.subarray(valueAt, valueAt + count)
    valueAt += count
  }
  return { tracks: decoded, byteLength: offsets.byteLength + values.byteLength }
}

function decodeMatrix(
  payload: Uint8Array,
  stream: ParseStream,
  info: KindInfo,
  tracks: number,
  tile: number,
  maxDecodedBytes: number,
): DecodedChunk {
  requireExtent(payload, 8)
  const present = parse<ParsedValues>('U32Array', stream, 1).values[0]
  if (present > tracks) corrupt('matrix has too many present tracks')
  const offsetsAt = 8 + 8 * present
  requireExtent(payload, offsetsAt)
  // Slots and pointers are bounded workspace. The extra initial pointer is a
  // single scalar; an empty matrix still fits a zero decoded-value budget.
  checkDecodedBudget(present * 8, maxDecodedBytes)
  const slots = readIntegers(stream, present, 32)
  const pointers = readIntegers(stream, present + 1, 32)
  const total = pointers[present]
  if (total > present * tile) corrupt('matrix has too many entries')
  checkDecodedBudget(total * 12, maxDecodedBytes)
  const valuesAt = pad(offsetsAt + 2 * total, 4)
  requireExtent(payload, pad(valuesAt + total * info.width, 8))
  if (pointers[0] !== 0) corrupt('matrix first pointer is not zero')
  const offsets = readIntegers(stream, total, 16)
  const decoded: DecodedTrack[] = Array.from({ length: tracks }, () => ({
    offsets: EMPTY_OFFSETS,
    values: EMPTY_VALUES,
  }))
  let previousSlot = -1
  let previousPointer = 0
  for (let i = 0; i < present; i++) {
    const slot = slots[i]
    if (slot <= previousSlot || slot >= tracks)
      corrupt('matrix slots must strictly ascend and be in range')
    const next = pointers[i + 1]
    if (next < previousPointer || next > total)
      corrupt('matrix pointers must not decrease or exceed the entry count')
    let previousOffset = -1
    for (let j = previousPointer; j < next; j++) {
      const offset = offsets[j]
      if (offset <= previousOffset || offset >= tile)
        corrupt('matrix offsets must strictly ascend and be in range')
      previousOffset = offset
    }
    decoded[slot] = {
      offsets: offsets.subarray(previousPointer, next),
      values: EMPTY_VALUES,
    }
    previousSlot = slot
    previousPointer = next
  }
  stream.at = valuesAt
  const values = readValues(stream, total, info.code)
  for (let i = 0; i < present; i++) {
    const slot = slots[i]
    const first = pointers[i]
    const last = pointers[i + 1]
    decoded[slot]!.values = values.subarray(first, last)
  }
  return { tracks: decoded, byteLength: offsets.byteLength + values.byteLength }
}

/** Decode one fully inflated track-order block. */
export function decodeBlock(
  payload: Uint8Array,
  kindByte: number,
  n: number,
  first: number,
  last: number,
  maxDecodedBytes = 256 * 1024 * 1024,
): DecodedChunk {
  const info = validateKind(kindByte, true)
  if (
    !Number.isInteger(n) ||
    n < 1 ||
    n > 65_536 ||
    !Number.isInteger(first) ||
    first < 0 ||
    first > 0xffff_ffff ||
    !Number.isInteger(last) ||
    last < first ||
    last > 0xffff_ffff
  ) {
    corrupt('invalid block entry count or position bounds')
  }
  const stream = payloadStream(payload)
  const valuesAt = pad(4 * n, 8)
  requireExtent(payload, pad(valuesAt + n * info.width, 8))
  checkDecodedBudget(n * 12, maxDecodedBytes)
  const offsets = readIntegers(stream, n, 32)
  let previous = -1
  for (let i = 0; i < n; i++) {
    const position = offsets[i]
    if (position <= previous) corrupt('block positions do not strictly ascend')
    previous = position
  }
  if (offsets[0] !== first || offsets[n - 1] !== last)
    corrupt('block positions do not match its index record')
  stream.at = valuesAt
  const values = readValues(stream, n, info.code)
  return {
    tracks: [{ offsets, values }],
    byteLength: offsets.byteLength + values.byteLength,
  }
}
