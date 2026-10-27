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

function payloadView(payload: Uint8Array): DataView {
  if (payload.byteLength % 8 !== 0)
    corrupt('payload length is not a multiple of 8')
  return new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
}

function readValues(
  view: DataView,
  at: number,
  count: number,
  code: number,
): Float64Array {
  const values = new Float64Array(count)
  const width = WIDTHS[code]!
  for (let i = 0; i < count; i++, at += width) {
    let value: number
    switch (code) {
      case 0:
        value = view.getUint8(at)
        break
      case 1:
        value = view.getUint16(at, true)
        break
      case 2:
        value = view.getUint32(at, true)
        break
      case 3:
        value = view.getInt8(at)
        break
      case 4:
        value = view.getInt16(at, true)
        break
      case 5:
        value = view.getInt32(at, true)
        break
      case 6:
        value = view.getFloat32(at, true)
        break
      case 7:
        value = 1
        break
      case 8:
        value = view.getFloat64(at, true)
        break
      default:
        return corrupt('unsupported element code')
    }
    if (value === Infinity || value === -Infinity)
      corrupt('infinite numeric value')
    values[i] = value
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
  const view = payloadView(payload)
  if (info.kind === 1) {
    const count = tracks * tile
    requireExtent(payload, pad(count * info.width, 8))
    checkDecodedBudget(count * 8, maxDecodedBytes)
    const values = readValues(view, 0, count, info.code)
    return {
      tracks: Array.from({ length: tracks }, (_, slot) => ({
        values: values.subarray(slot * tile, (slot + 1) * tile),
      })),
      byteLength: values.byteLength,
    }
  }
  if (info.kind === 3)
    return decodeMatrix(payload, view, info, tracks, tile, maxDecodedBytes)

  requireExtent(payload, 4 + 4 * tracks)
  const total = view.getUint32(0, true)
  if (total > tracks * tile) corrupt('too many sparse entries or run changes')
  checkDecodedBudget(total * 12, maxDecodedBytes)
  const lengths = new Uint32Array(tracks)
  let offsetsEnd = 4 + 4 * tracks
  for (let slot = 0; slot < tracks; slot++) {
    const length = view.getUint32(4 + slot * 4, true)
    lengths[slot] = length
    offsetsEnd += length
  }
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
    let position = 0
    let first = true
    while (at < end) {
      let delta = 0
      let terminated = false
      for (let byteIndex = 0; byteIndex < 3; byteIndex++) {
        if (at >= end) corrupt("a varint runs past its track's bytes")
        const byte = payload[at++]!
        delta += (byte & 127) * 2 ** (7 * byteIndex)
        if (byte < 128) {
          terminated = true
          break
        }
      }
      if (!terminated) corrupt('a varint is longer than three bytes')
      if (!first && delta === 0)
        corrupt('sparse offsets or run changes do not strictly ascend')
      position += delta
      if (position >= tile || entry >= total)
        corrupt('an offset or entry count is out of bounds')
      offsets[entry++] = position
      first = false
    }
    decoded.push({
      offsets: offsets.subarray(firstEntry, entry),
      values: EMPTY_VALUES,
      ...(info.kind === 4 ? { runs: true } : {}),
    })
  }
  if (entry !== total)
    corrupt('decoded offsets do not add up to the entry count')
  const values = readValues(view, valuesAt, total, info.code)
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
  view: DataView,
  info: KindInfo,
  tracks: number,
  tile: number,
  maxDecodedBytes: number,
): DecodedChunk {
  requireExtent(payload, 8)
  const present = view.getUint32(0, true)
  if (present > tracks) corrupt('matrix has too many present tracks')
  const pointersAt = 4 + 4 * present
  const offsetsAt = 8 + 8 * present
  requireExtent(payload, offsetsAt)
  const total = view.getUint32(pointersAt + present * 4, true)
  if (total > present * tile) corrupt('matrix has too many entries')
  checkDecodedBudget(total * 12, maxDecodedBytes)
  const valuesAt = pad(offsetsAt + 2 * total, 4)
  requireExtent(payload, pad(valuesAt + total * info.width, 8))
  if (view.getUint32(pointersAt, true) !== 0)
    corrupt('matrix first pointer is not zero')
  const offsets = new Uint32Array(total)
  const decoded: DecodedTrack[] = Array.from({ length: tracks }, () => ({
    offsets: EMPTY_OFFSETS,
    values: EMPTY_VALUES,
  }))
  let previousSlot = -1
  let previousPointer = 0
  for (let i = 0; i < present; i++) {
    const slot = view.getUint32(4 + i * 4, true)
    if (slot <= previousSlot || slot >= tracks)
      corrupt('matrix slots must strictly ascend and be in range')
    const next = view.getUint32(pointersAt + (i + 1) * 4, true)
    if (next < previousPointer || next > total)
      corrupt('matrix pointers must not decrease or exceed the entry count')
    let previousOffset = -1
    for (let j = previousPointer; j < next; j++) {
      const offset = view.getUint16(offsetsAt + j * 2, true)
      if (offset <= previousOffset || offset >= tile)
        corrupt('matrix offsets must strictly ascend and be in range')
      offsets[j] = offset
      previousOffset = offset
    }
    decoded[slot] = {
      offsets: offsets.subarray(previousPointer, next),
      values: EMPTY_VALUES,
    }
    previousSlot = slot
    previousPointer = next
  }
  const values = readValues(view, valuesAt, total, info.code)
  for (let i = 0; i < present; i++) {
    const slot = view.getUint32(4 + i * 4, true)
    const first = view.getUint32(pointersAt + i * 4, true)
    const last = view.getUint32(pointersAt + (i + 1) * 4, true)
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
  const view = payloadView(payload)
  const valuesAt = pad(4 * n, 8)
  requireExtent(payload, pad(valuesAt + n * info.width, 8))
  checkDecodedBudget(n * 12, maxDecodedBytes)
  const offsets = new Uint32Array(n)
  let previous = -1
  for (let i = 0; i < n; i++) {
    const position = view.getUint32(i * 4, true)
    if (position <= previous) corrupt('block positions do not strictly ascend')
    offsets[i] = position
    previous = position
  }
  if (offsets[0] !== first || offsets[n - 1] !== last)
    corrupt('block positions do not match its index record')
  const values = readValues(view, valuesAt, n, info.code)
  return {
    tracks: [{ offsets, values }],
    byteLength: offsets.byteLength + values.byteLength,
  }
}
