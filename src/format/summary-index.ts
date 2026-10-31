import type { MetadataState } from './header.js'
import type { SummaryDescriptor } from './group.js'
import type { Summary } from '../types.js'
import { check, crc, Cursor } from '../utils/binary.js'
import { inflateRestart } from '../utils/inflate.js'

export const restartKey = 'org.figwig.summary-restarts'
export const restartPageEntries = 102
export const restartPageBytes = 4096
export interface RestartRoot {
  offset: number
  directory: number
  firstData: number
  end: number
}
export interface RestartLocator {
  offset: number
  count: number
  checksum: number
}
export interface RestartLevel extends SummaryDescriptor {
  index: number
  windowBins: number
}
export interface RestartGroup {
  levels: RestartLevel[]
  cacheBytes: number
}
export interface RestartFragment {
  offset: number
  size: number
  checksum: number
  rawChecksum: number
}
export interface RestartWindow {
  n: number
  firstRow: number
  ids: RestartFragment
  sums: RestartFragment
}
export interface RestartPage {
  windows: RestartWindow[]
  cacheBytes: number
}

function checkedCrc(bytes: Uint8Array, at: number, what: string) {
  const copy = Uint8Array.from(bytes),
    view = new DataView(copy.buffer),
    expected = view.getUint32(at, true)
  view.setUint32(at, 0, true)
  crc(copy, expected, what)
}
export function restartBounds(root: RestartRoot, offset: number, size: number) {
  check(
    Number.isSafeInteger(offset) &&
      Number.isSafeInteger(size) &&
      size >= 0 &&
      offset >= root.firstData &&
      offset <= root.end - size,
    'summary restart directory extent outside data region',
  )
}
export function restartLocatorOffset(state: MetadataState): number | undefined {
  if (!(state.fixed.optional & 2)) return
  const value = state.header.metadata[restartKey]
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const locator = value as Record<string, unknown>
  if (locator.version !== 2) return
  check(
    locator.length === 256 &&
      Number.isSafeInteger(locator.offset) &&
      (locator.offset as number) >= 128 &&
      (locator.offset as number) <= state.fixed.chroms - 256,
    'invalid summary restart locator',
  )
  return locator.offset as number
}
export function parseRestartRoot(
  bytes: Uint8Array,
  offset: number,
  state: MetadataState,
): RestartRoot | undefined {
  check(bytes.length === 256, 'invalid summary restart root length')
  const c = new Cursor(bytes)
  check(
    c.u32() === 0x53525746 && c.u32() === 0x00314d55,
    'invalid summary restart root magic',
  )
  check(c.u16() === 2 && c.u16() === 256, 'unsupported summary restart root')
  checkedCrc(bytes, 12, 'summary restart root')
  check(
    bytes.subarray(36, 64).every((v) => v === 0) &&
      bytes.subarray(192).every((v) => v === 0),
    'nonzero summary restart reserved fields',
  )
  // Check the binding before interpreting a stale root against new group counts.
  if (!state.fixed.bytes.every((v, i) => v === bytes[64 + i])) return
  c.at = 16
  const directory = c.u64('summary restart directory'),
    groups = c.u32(),
    entries = c.u32(),
    target = c.u32(),
    firstData = directory + 32 * groups
  check(
    directory === offset + 256 &&
      groups === state.fixed.nGroups &&
      entries === restartPageEntries &&
      target === 32768 &&
      firstData <= state.fixed.chroms &&
      state.fixed.chroms - offset <= 16 * 1024 ** 2,
    'invalid summary restart root dimensions',
  )
  return { offset, directory, firstData, end: state.fixed.chroms }
}
export function parseRestartLocator(
  bytes: Uint8Array,
  group: number,
  root: RestartRoot,
  state: MetadataState,
): RestartLocator {
  check(bytes.length === 32, 'invalid summary restart group locator length')
  checkedCrc(bytes, 24, 'summary restart group locator')
  const c = new Cursor(bytes),
    offset = c.u64('summary restart levels'),
    count = c.u32(),
    checksum = c.u32(),
    id = c.u32(),
    tracks = c.u32()
  c.u32()
  check(
    id === group &&
      tracks === state.members[group].length &&
      count >= 1 &&
      count <= 13 &&
      (count === 1 || !!(state.fixed.optional & 1)) &&
      c.u32() === 0,
    'invalid summary restart group locator',
  )
  restartBounds(root, offset, count * 32)
  return { offset, count, checksum }
}
export function restartIndexSize(windows: number) {
  const pages = Math.ceil(windows / restartPageEntries)
  return (
    (pages - 1) * restartPageBytes +
    16 +
    (windows - (pages - 1) * restartPageEntries) * 40
  )
}
export function parseRestartGroup(
  bytes: Uint8Array,
  locator: RestartLocator,
  root: RestartRoot,
  group: number,
  state: MetadataState,
): RestartGroup {
  check(bytes.length === locator.count * 32, 'truncated summary restart levels')
  crc(bytes, locator.checksum, 'summary restart levels')
  const c = new Cursor(bytes),
    levels: RestartLevel[] = [],
    start = state.directory[group],
    end = state.directory[group + 1] ?? state.fixed.length,
    tracks = state.members[group].length
  for (let level = 0; level < locator.count; level++) {
    const offset = c.u64('summary restart source'),
      index = c.u64('summary restart index'),
      n = c.u32(),
      size = c.u32(),
      checksum = c.u32(),
      windowBins = c.u32(),
      factor = 4 ** level,
      binCount = state.header.chromosomes.reduce(
        (sum, chr) => sum + Math.ceil(chr.tileCount / factor),
        0,
      )
    check(
      offset >= start + (level ? 16 : 12) &&
        offset <= end - size &&
        n <= binCount &&
        (size > 0 || n === 0) &&
        (level === 0 || size > 0) &&
        (size !== 0 || checksum === 0),
      'invalid summary restart source extent or count',
    )
    check(
      windowBins === 0
        ? index === 0
        : windowBins <= 2048 &&
            !(windowBins & (windowBins - 1)) &&
            windowBins * (4 + (level ? 8 : 4) * tracks) <= 32768 &&
            size > 0 &&
            n > 0 &&
            index > 0,
      'invalid summary restart window dimensions',
    )
    if (windowBins)
      restartBounds(
        root,
        index,
        restartIndexSize(Math.ceil(binCount / windowBins)),
      )
    levels.push({
      factor,
      offset,
      index,
      n,
      size,
      checksum,
      windowBins,
      binCount,
    })
  }
  return { levels, cacheBytes: bytes.length + levels.length * 96 + 64 }
}
export function parseRestartPage(
  bytes: Uint8Array,
  page: number,
  ref: RestartLevel,
  tracks: number,
  maxInflated: number,
): RestartPage {
  const first = page * restartPageEntries,
    count = Math.min(
      restartPageEntries,
      Math.ceil(ref.binCount / ref.windowBins) - first,
    )
  check(
    bytes.length === 16 + count * 40 &&
      count > 0 &&
      bytes.length + count * 160 <= maxInflated,
    'summary restart page allocation exceeds bounds or maxInflatedBytes',
  )
  checkedCrc(bytes, 12, 'summary restart page')
  const c = new Cursor(bytes)
  check(
    c.u32() === 0x50525746 && c.u32() === first && c.u32() === count,
    'invalid summary restart page header',
  )
  c.u32()
  const windows: RestartWindow[] = [],
    width = (ref.factor === 1 ? 4 : 8) * tracks
  let previous: RestartWindow | undefined
  let firstSum = Infinity
  for (let i = 0; i < count; i++) {
    const n = c.u32(),
      firstRow = c.u32()
    const fragment = (raw: number): RestartFragment => {
      const offset = c.u32(),
        size = c.u32(),
        checksum = c.u32(),
        rawChecksum = c.u32()
      check(
        n
          ? size > 0 &&
              size <= 2 * raw + 64 &&
              offset >= 2 &&
              offset <= ref.size - 4 - size
          : offset === 0 && size === 0 && checksum === 0 && rawChecksum === 0,
        'invalid summary restart fragment extent',
      )
      return { offset, size, checksum, rawChecksum }
    }
    check(
      n <=
        Math.min(ref.windowBins, ref.binCount - (first + i) * ref.windowBins) &&
        firstRow <= ref.n - n &&
        (n > 0 || firstRow === 0),
      'invalid summary restart window count or row',
    )
    const ids = fragment(n * 4),
      sums = fragment(n * width)
    check(
      !n || ids.offset + ids.size <= sums.offset,
      'overlapping summary restart fragments',
    )
    if (n) {
      check(
        !previous ||
          (firstRow === previous.firstRow + previous.n &&
            ids.offset >= previous.ids.offset + previous.ids.size &&
            sums.offset >= previous.sums.offset + previous.sums.size),
        'summary restart rows or fragments overlap or are out of order',
      )
      if (!previous) firstSum = sums.offset
      previous = { n, firstRow, ids, sums }
    }
    windows.push({ n, firstRow, ids, sums })
  }
  // The legacy stream has all IDs before all sums, including other windows.
  check(
    !previous || previous.ids.offset + previous.ids.size <= firstSum,
    'overlapping summary restart page fragments',
  )
  return { windows, cacheBytes: bytes.length + count * 160 + 64 }
}
export function validateRestartSource(bytes: Uint8Array, ref: RestartLevel) {
  const c = new Cursor(bytes)
  if (ref.factor !== 1)
    check(c.u32() === ref.factor, 'summary restart source factor mismatch')
  check(
    c.u32() === ref.n && c.u32() === ref.size && c.u32() === ref.checksum,
    'summary restart source header mismatch',
  )
  if (ref.size) {
    const cmf = bytes[c.at],
      flg = bytes[c.at + 1]
    check(
      (cmf & 15) === 8 &&
        (ref.windowBins ? cmf >>> 4 === 7 : cmf >>> 4 <= 7) &&
        ((cmf << 8) + flg) % 31 === 0 &&
        !(flg & 32),
      'invalid summary restart zlib wrapper',
    )
  }
}
export function parseRestartSummary(
  idsBytes: Uint8Array,
  sumsBytes: Uint8Array,
  window: RestartWindow,
  windowId: number,
  ref: RestartLevel,
  group: number,
  state: MetadataState,
  maxInflated: number,
): Summary {
  const tracks = state.members[group],
    wide = ref.factor !== 1,
    idRaw = window.n * 4,
    sumRaw = window.n * tracks.length * (wide ? 8 : 4)
  check(
    2 * (idRaw + sumRaw) <= maxInflated,
    'parsed summary restart allocation exceeds maxInflatedBytes',
  )
  crc(idsBytes, window.ids.checksum, 'summary restart IDs')
  crc(sumsBytes, window.sums.checksum, 'summary restart sums')
  const ids = inflateRestart(idsBytes, idRaw, maxInflated),
    sums = inflateRestart(sumsBytes, sumRaw, maxInflated)
  crc(ids, window.ids.rawChecksum, 'summary restart decoded IDs')
  crc(sums, window.sums.rawChecksum, 'summary restart decoded sums')
  const bins = new Uint32Array(window.n),
    values = wide
      ? new Float64Array(window.n * tracks.length)
      : new Float32Array(window.n * tracks.length),
    idView = new DataView(ids.buffer, ids.byteOffset, ids.byteLength),
    sumView = new DataView(sums.buffer, sums.byteOffset, sums.byteLength),
    first = windowId * ref.windowBins,
    end = Math.min(first + ref.windowBins, ref.binCount)
  for (let i = 0; i < bins.length; i++) {
    bins[i] = idView.getUint32(4 * i, true)
    check(
      bins[i] >= first && bins[i] < end && (!i || bins[i] > bins[i - 1]),
      'summary restart IDs out of order or window',
    )
  }
  for (let i = 0; i < values.length; i++)
    values[i] = wide
      ? sumView.getFloat64(8 * i, true)
      : sumView.getFloat32(4 * i, true)
  return {
    factor: ref.factor,
    binSize: ref.factor * state.fixed.tile,
    bins,
    sums: values,
    tracks,
    available: true,
  }
}
