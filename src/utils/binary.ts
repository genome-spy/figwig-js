export class FigWigError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`Figwig: ${message}`, options)
    this.name = 'FigWigError'
  }
}
export function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new FigWigError(message)
}
export function safe(value: bigint, name: string): number {
  check(
    value <= BigInt(Number.MAX_SAFE_INTEGER),
    `${name} exceeds Number.MAX_SAFE_INTEGER`,
  )
  return Number(value)
}
export class Cursor {
  readonly view: DataView
  at = 0
  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }
  need(n: number) {
    check(
      Number.isSafeInteger(n) && n >= 0 && this.at + n <= this.bytes.length,
      'truncated or invalid binary structure',
    )
  }
  u16() {
    this.need(2)
    const v = this.view.getUint16(this.at, true)
    this.at += 2
    return v
  }
  u32() {
    this.need(4)
    const v = this.view.getUint32(this.at, true)
    this.at += 4
    return v
  }
  u64(name = 'uint64 value') {
    this.need(8)
    const v = safe(this.view.getBigUint64(this.at, true), name)
    this.at += 8
    return v
  }
  f64() {
    this.need(8)
    const v = this.view.getFloat64(this.at, true)
    this.at += 8
    return v
  }
  take(n: number) {
    this.need(n)
    const b = this.bytes.subarray(this.at, this.at + n)
    this.at += n
    return b
  }
}
const crcTable = Uint32Array.from({ length: 256 }, (_, i) => {
  let c = i
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const b of bytes) c = crcTable[(c ^ b) & 255] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
export function crc(bytes: Uint8Array, expected: number, what: string) {
  check(crc32(bytes) === expected, `${what} CRC-32 mismatch`)
}
export function lowerBound(array: ArrayLike<number>, value: number): number {
  let lo = 0,
    hi = array.length
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2)
    if (array[mid] < value) lo = mid + 1
    else hi = mid
  }
  return lo
}
export function aborted(signal?: AbortSignal) {
  signal?.throwIfAborted()
}
// Names are arbitrary UTF8 strings: preserve a literal initial U+FEFF rather
// than consuming it as a text-file BOM. JSON.parse remains strict about BOMs.
export const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
