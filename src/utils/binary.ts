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
