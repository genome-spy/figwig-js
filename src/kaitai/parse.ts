import Runtime from './generated/runtime.js'
import Figwig from './generated/figwig.js'
import { check, safe, utf8 } from '../utils/binary.js'

interface RuntimeStream {
  pos: number
  readonly size: number
  seek(position: number): void
  readBytes(length: number): Uint8Array
  readU1(): number
  readU2le(): number
  readU4le(): number
  readU8le(): number
  readS1(): number
  readS2le(): number
  readS4le(): number
  readF4le(): number
  readF8le(): number
  isEof(): boolean
}
const Base = Runtime as unknown as new (view: DataView) => RuntimeStream

// Kaitai's default decoder replaces invalid UTF-8 and consumes a BOM. Figwig
// names must keep an initial U+FEFF, and malformed text must remain an error.
Runtime.bytesToStr = (bytes: Uint8Array, encoding: string) => {
  check(/^utf-?8$/i.test(encoding), 'unsupported Kaitai text encoding')
  return utf8.decode(bytes)
}

/** Bounded view over exactly the fetched bytes, with lossless u64 validation. */
export class ParseStream extends Base {
  readonly view: DataView
  constructor(readonly bytes: Uint8Array) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    super(view)
    this.view = view
  }
  get at() {
    return this.pos
  }
  set at(position: number) {
    this.seek(position)
  }
  need(length: number) {
    check(
      Number.isSafeInteger(length) &&
        length >= 0 &&
        this.pos + length <= this.bytes.length,
      'truncated or invalid binary structure',
    )
  }
  override seek(position: number) {
    check(
      Number.isSafeInteger(position) &&
        position >= 0 &&
        position <= this.bytes.length,
      'truncated or invalid binary structure',
    )
    super.seek(position)
  }
  override readBytes(length: number) {
    this.need(length)
    return super.readBytes(length)
  }
  override readU1() {
    this.need(1)
    return super.readU1()
  }
  override readU2le() {
    this.need(2)
    return super.readU2le()
  }
  override readU4le() {
    this.need(4)
    return super.readU4le()
  }
  override readS1() {
    this.need(1)
    return super.readS1()
  }
  override readS2le() {
    this.need(2)
    return super.readS2le()
  }
  override readS4le() {
    this.need(4)
    return super.readS4le()
  }
  override readF4le() {
    this.need(4)
    return super.readF4le()
  }
  override readF8le() {
    this.need(8)
    return super.readF8le()
  }
  override readU8le() {
    return this.u64()
  }
  u16() {
    return this.readU2le()
  }
  u32() {
    return this.readU4le()
  }
  u64(name = 'uint64 value') {
    this.need(8)
    const value = safe(this.view.getBigUint64(this.pos, true), name)
    this.seek(this.pos + 8)
    return value
  }
  f64() {
    return this.readF8le()
  }
  take(length: number) {
    return this.readBytes(length)
  }
}

type Constructor = new (
  stream: ParseStream,
  parent: undefined,
  root: undefined,
  ...params: number[]
) => unknown
const types = Figwig as unknown as Record<string, Constructor>

/** Instantiate a generated bounded structure. JSON and semantic checks stay in adapters. */
export function parse<T>(
  name: string,
  stream: ParseStream,
  ...params: number[]
): T {
  const Type = types[name]
  check(typeof Type === 'function', `unknown generated Kaitai type ${name}`)
  return new Type(stream, undefined, undefined, ...params) as T
}
