import type { Header, DType, Track, Chromosome, Statistics } from '../types.js'
import { check, crc, Cursor, utf8 } from '../utils/binary.js'

export interface FixedHeader {
  flags: number
  tile: number
  codec: 0 | 1
  level: number
  nChroms: number
  nTracks: number
  nGroups: number
  tablesCrc: number
  chroms: number
  tracks: number
  index: number
  metadata: number
  metadataLength: number
  length: number
  optional: number
}
export interface MetadataState {
  header: Header
  fixed: FixedHeader
  directory: number[]
  members: Track[][]
  nTiles: number
}
export const dtypeWidths: Record<DType, number> = {
  uint8: 1,
  uint16: 2,
  uint32: 4,
  int8: 1,
  int16: 2,
  int32: 4,
  float32: 4,
  float64: 8,
}
export function parseFixed(bytes: Uint8Array): FixedHeader {
  const c = new Cursor(bytes)
  c.need(128)
  check(c.u32() === 0x57474946, 'bad magic; expected FIGW')
  const headerBytes = Uint8Array.from(bytes.subarray(0, 128)),
    view = new DataView(headerBytes.buffer)
  const checksum = view.getUint32(104, true)
  view.setUint32(104, 0, true)
  crc(headerBytes, checksum, 'header')
  check(c.u16() === 1, 'unsupported format version')
  const flags = c.u16(),
    tile = c.u32(),
    codec = c.u16(),
    level = c.u16()
  const nChroms = c.u32(),
    nTracks = c.u32(),
    nGroups = c.u32(),
    tablesCrc = c.u32()
  const chroms = c.u64('chromosome table offset'),
    tracks = c.u64('statistics offset'),
    index = c.u64('index offset')
  const data = c.u64('data offset'),
    metadata = c.u64('metadata offset'),
    metadataLength = c.u64('metadata length')
  c.u64('reserved zoom offset')
  const length = c.u64('file length'),
    required = c.u32(),
    optional = c.u32()
  check(required === 0, 'unsupported required feature bits')
  check(!(flags & ~1), 'unsupported header flags')
  check(
    tile >= 16 && tile <= 65536 && !(tile & (tile - 1)),
    'invalid tile size',
  )
  check(codec === 0 || codec === 1, 'unsupported compression codec')
  check(data === 128 && length >= 128, 'invalid data offset or file length')
  check(
    128 <= chroms &&
      chroms <= tracks &&
      tracks <= metadata &&
      metadata <= index &&
      index <= length,
    'table offsets outside file or out of order',
  )
  check(
    nChroms > 0 && nTracks > 0 && nGroups > 0 && index + nGroups * 8 <= length,
    'invalid counts or truncated directory',
  )
  check(
    !(flags & 1) || nGroups === nTracks,
    'track order requires one group per track',
  )
  check(
    tracks + 32 * nTracks <= metadata && metadata + metadataLength <= index,
    'statistics or metadata extend into next table',
  )
  return {
    flags,
    tile,
    codec,
    level,
    nChroms,
    nTracks,
    nGroups,
    tablesCrc,
    chroms,
    tracks,
    index,
    metadata,
    metadataLength,
    length,
    optional,
  }
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function freeze<T>(value: T): T {
  const pending: unknown[] = [value]
  while (pending.length) {
    const item = pending.pop()
    if (item && typeof item === 'object' && !Object.isFrozen(item)) {
      Object.freeze(item)
      for (const nested of Object.values(item)) pending.push(nested)
    }
  }
  return value
}
export function parseTables(f: FixedHeader, bytes: Uint8Array): MetadataState {
  crc(bytes, f.tablesCrc, 'tables')
  const c = new Cursor(bytes),
    chromosomes: Chromosome[] = [],
    names = new Set<string>()
  let nTiles = 0
  check(
    f.nChroms <= Math.floor((f.tracks - f.chroms) / 11),
    'chromosome count exceeds table bounds',
  )
  for (let id = 0; id < f.nChroms; id++) {
    const size = c.u16()
    check(c.at + size + 8 <= f.tracks - f.chroms, 'truncated chromosome table')
    const name = utf8.decode(c.take(size)),
      length = c.u64('chromosome length')
    check(
      name.length > 0 && !names.has(name) && length > 0 && length <= 0xffffffff,
      'invalid or duplicate chromosome',
    )
    names.add(name)
    const tileCount = Math.ceil(length / f.tile)
    chromosomes.push({ id, name, length, tileOffset: nTiles, tileCount })
    nTiles += tileCount
  }
  check(c.at === f.tracks - f.chroms, 'chromosome table extent mismatch')
  check(nTiles <= 2 ** 26, 'genome exceeds 2**26 tiles')
  const statistics: Statistics[] = []
  for (let i = 0; i < f.nTracks; i++)
    statistics.push({
      sum: c.f64(),
      nonzero: c.u64('nonzero base count'),
      min: c.f64(),
      max: c.f64(),
    })
  c.at = f.metadata - f.chroms
  let metadata: unknown
  try {
    metadata = JSON.parse(utf8.decode(c.take(f.metadataLength)))
  } catch (cause) {
    throw new Error('Figwig: invalid JSON metadata', { cause })
  }
  check(
    object(metadata) &&
      object(metadata.attributes) &&
      Array.isArray(metadata.tracks) &&
      metadata.tracks.length === f.nTracks,
    'invalid metadata or track count',
  )
  check(
    metadata.genome === undefined ||
      metadata.genome === null ||
      typeof metadata.genome === 'string',
    'invalid genome identifier',
  )
  const members: Track[][] = Array.from({ length: f.nGroups }, () => [])
  const trackNames = new Set<string>()
  const tracks: Track[] = metadata.tracks.map(
    (record: unknown, index: number) => {
      check(
        object(record) &&
          typeof record.name === 'string' &&
          record.name.length > 0 &&
          !trackNames.has(record.name),
        'invalid or duplicate track name',
      )
      check(
        typeof record.dtype === 'string' &&
          Object.hasOwn(dtypeWidths, record.dtype),
        'invalid track dtype',
      )
      check(
        typeof record.group === 'number' &&
          Number.isInteger(record.group) &&
          record.group >= 0 &&
          record.group < f.nGroups,
        'invalid track group',
      )
      trackNames.add(record.name)
      const track = {
        index,
        name: record.name,
        dtype: record.dtype as DType,
        group: record.group,
        metadata: record,
        statistics: statistics[index],
      }
      members[track.group].push(track)
      return track
    },
  )
  check(
    members.every(
      (m) =>
        m.length > 0 &&
        m.length <= 2 ** 29 / f.tile &&
        (!(f.flags & 1) || m.length === 1),
    ),
    'empty or oversized track group',
  )
  c.at = f.index - f.chroms
  const directory: number[] = []
  for (let i = 0; i < f.nGroups; i++) {
    const offset = c.u64('group index offset')
    check(
      offset >= f.index + 8 * f.nGroups &&
        offset < f.length &&
        (i === 0 || offset > directory[i - 1]),
      'invalid group directory offsets',
    )
    directory.push(offset)
  }
  check(
    directory[0] === f.index + 8 * f.nGroups,
    'index records must follow directory',
  )
  const header: Header = freeze({
    version: 1,
    order: f.flags & 1 ? 'tracks' : 'positions',
    tileSize: f.tile,
    codec: f.codec,
    compressionLevel: f.level,
    genome: (metadata.genome as string | null) ?? null,
    attributes: (metadata.attributes ?? {}) as Record<string, unknown>,
    metadata,
    chromosomes,
    tracks,
    statistics,
    groupCount: f.nGroups,
    length: f.length,
  })
  return { header, fixed: f, directory, members, nTiles }
}
