// @ts-nocheck
// Generated portable ESM bundle of kaitai-struct 0.11.0; do not edit.
// Copyright 2012-2016 Ilmari Heikkinen; 2016-2025 Kaitai Project.
// Apache-2.0; see LICENSES/kaitai-runtime.txt.
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var __commonJS = (cb, mod) => function __require2() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// unused-node-hooks:iconv-lite
var require_iconv_lite = __commonJS({
  "unused-node-hooks:iconv-lite"() {
    throw new Error("Kaitai optional Node hooks are unavailable; use Figwig bounded decoding");
  }
});

// unused-node-hooks:zlib
var require_zlib = __commonJS({
  "unused-node-hooks:zlib"() {
    throw new Error("Kaitai optional Node hooks are unavailable; use Figwig bounded decoding");
  }
});

// node_modules/kaitai-struct/KaitaiStream.js
var require_KaitaiStream = __commonJS({
  "node_modules/kaitai-struct/KaitaiStream.js"(exports, module) {
    (function(global, factory) {
      typeof exports === "object" && typeof module !== "undefined" ? module.exports = factory() : typeof define === "function" && define.amd ? define(factory) : (global = typeof globalThis !== "undefined" ? globalThis : global || self, global.KaitaiStream = factory());
    })(exports, (function() {
      "use strict";
      var extendStatics = function(d, b) {
        extendStatics = Object.setPrototypeOf || { __proto__: [] } instanceof Array && function(d2, b2) {
          d2.__proto__ = b2;
        } || function(d2, b2) {
          for (var p in b2) if (Object.prototype.hasOwnProperty.call(b2, p)) d2[p] = b2[p];
        };
        return extendStatics(d, b);
      };
      function __extends(d, b) {
        if (typeof b !== "function" && b !== null)
          throw new TypeError("Class extends value " + String(b) + " is not a constructor or null");
        extendStatics(d, b);
        function __() {
          this.constructor = d;
        }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
      }
      typeof SuppressedError === "function" ? SuppressedError : function(error, suppressed, message) {
        var e = new Error(message);
        return e.name = "SuppressedError", e.error = error, e.suppressed = suppressed, e;
      };
      var KaitaiStream = (
        /** @class */
        (function() {
          function KaitaiStream2(arrayBuffer, byteOffset) {
            this._byteLength = 0;
            this._byteOffset = 0;
            this.bits = 0;
            this.bitsLeft = 0;
            this._byteOffset = byteOffset || 0;
            if (arrayBuffer instanceof ArrayBuffer) {
              this.buffer = arrayBuffer;
            } else if (typeof arrayBuffer == "object") {
              this.dataView = arrayBuffer;
              if (byteOffset) {
                this._byteOffset += byteOffset;
              }
            } else {
              this.buffer = new ArrayBuffer(arrayBuffer || 1);
            }
            this.pos = 0;
            this.alignToByte();
          }
          Object.defineProperty(KaitaiStream2.prototype, "buffer", {
            /**
             * Gets the backing ArrayBuffer of the KaitaiStream object.
             *
             * @returns The backing ArrayBuffer.
             */
            get: function() {
              this._trimAlloc();
              return this._buffer;
            },
            /**
             * Sets the backing ArrayBuffer of the KaitaiStream object and updates the
             * DataView to point to the new buffer.
             */
            set: function(v) {
              this._buffer = v;
              this._dataView = new DataView(this._buffer, this._byteOffset);
              this._byteLength = this._buffer.byteLength;
            },
            enumerable: false,
            configurable: true
          });
          Object.defineProperty(KaitaiStream2.prototype, "byteOffset", {
            /**
             * Gets the byteOffset of the KaitaiStream object.
             *
             * @returns The byteOffset.
             */
            get: function() {
              return this._byteOffset;
            },
            /**
             * Sets the byteOffset of the KaitaiStream object and updates the DataView to
             * point to the new byteOffset.
             */
            set: function(v) {
              this._byteOffset = v;
              this._dataView = new DataView(this._buffer, this._byteOffset);
              this._byteLength = this._buffer.byteLength;
            },
            enumerable: false,
            configurable: true
          });
          Object.defineProperty(KaitaiStream2.prototype, "dataView", {
            /**
             * Gets the backing DataView of the KaitaiStream object.
             *
             * @returns The backing DataView.
             */
            get: function() {
              return this._dataView;
            },
            /**
             * Sets the backing DataView of the KaitaiStream object and updates the buffer
             * and byteOffset to point to the DataView values.
             */
            set: function(v) {
              this._byteOffset = v.byteOffset;
              this._buffer = v.buffer;
              this._dataView = new DataView(this._buffer, this._byteOffset);
              this._byteLength = this._byteOffset + v.byteLength;
            },
            enumerable: false,
            configurable: true
          });
          KaitaiStream2.prototype._trimAlloc = function() {
            if (this._byteLength === this._buffer.byteLength) {
              return;
            }
            var buf = new ArrayBuffer(this._byteLength);
            var dst = new Uint8Array(buf);
            var src = new Uint8Array(this._buffer, 0, dst.length);
            dst.set(src);
            this.buffer = buf;
          };
          KaitaiStream2.prototype.isEof = function() {
            return this.pos >= this.size && this.bitsLeft === 0;
          };
          KaitaiStream2.prototype.seek = function(pos) {
            var npos = Math.max(0, Math.min(this.size, pos));
            this.pos = isNaN(npos) || !isFinite(npos) ? 0 : npos;
          };
          Object.defineProperty(KaitaiStream2.prototype, "size", {
            /**
             * Returns the byte length of the KaitaiStream object.
             *
             * @returns The byte length.
             */
            get: function() {
              return this._byteLength - this._byteOffset;
            },
            enumerable: false,
            configurable: true
          });
          KaitaiStream2.prototype.readS1 = function() {
            this.ensureBytesLeft(1);
            var v = this._dataView.getInt8(this.pos);
            this.pos += 1;
            return v;
          };
          KaitaiStream2.prototype.readS2be = function() {
            this.ensureBytesLeft(2);
            var v = this._dataView.getInt16(this.pos);
            this.pos += 2;
            return v;
          };
          KaitaiStream2.prototype.readS4be = function() {
            this.ensureBytesLeft(4);
            var v = this._dataView.getInt32(this.pos);
            this.pos += 4;
            return v;
          };
          KaitaiStream2.prototype.readS8be = function() {
            this.ensureBytesLeft(8);
            var v1 = this.readU4be();
            var v2 = this.readU4be();
            if ((v1 & 2147483648) !== 0) {
              return -(4294967296 * (v1 ^ 4294967295) + (v2 ^ 4294967295)) - 1;
            } else {
              return 4294967296 * v1 + v2;
            }
          };
          KaitaiStream2.prototype.readS2le = function() {
            this.ensureBytesLeft(2);
            var v = this._dataView.getInt16(this.pos, true);
            this.pos += 2;
            return v;
          };
          KaitaiStream2.prototype.readS4le = function() {
            this.ensureBytesLeft(4);
            var v = this._dataView.getInt32(this.pos, true);
            this.pos += 4;
            return v;
          };
          KaitaiStream2.prototype.readS8le = function() {
            this.ensureBytesLeft(8);
            var v1 = this.readU4le();
            var v2 = this.readU4le();
            if ((v2 & 2147483648) !== 0) {
              return -(4294967296 * (v2 ^ 4294967295) + (v1 ^ 4294967295)) - 1;
            } else {
              return 4294967296 * v2 + v1;
            }
          };
          KaitaiStream2.prototype.readU1 = function() {
            this.ensureBytesLeft(1);
            var v = this._dataView.getUint8(this.pos);
            this.pos += 1;
            return v;
          };
          KaitaiStream2.prototype.readU2be = function() {
            this.ensureBytesLeft(2);
            var v = this._dataView.getUint16(this.pos);
            this.pos += 2;
            return v;
          };
          KaitaiStream2.prototype.readU4be = function() {
            this.ensureBytesLeft(4);
            var v = this._dataView.getUint32(this.pos);
            this.pos += 4;
            return v;
          };
          KaitaiStream2.prototype.readU8be = function() {
            this.ensureBytesLeft(8);
            var v1 = this.readU4be();
            var v2 = this.readU4be();
            return 4294967296 * v1 + v2;
          };
          KaitaiStream2.prototype.readU2le = function() {
            this.ensureBytesLeft(2);
            var v = this._dataView.getUint16(this.pos, true);
            this.pos += 2;
            return v;
          };
          KaitaiStream2.prototype.readU4le = function() {
            this.ensureBytesLeft(4);
            var v = this._dataView.getUint32(this.pos, true);
            this.pos += 4;
            return v;
          };
          KaitaiStream2.prototype.readU8le = function() {
            this.ensureBytesLeft(8);
            var v1 = this.readU4le();
            var v2 = this.readU4le();
            return 4294967296 * v2 + v1;
          };
          KaitaiStream2.prototype.readF4be = function() {
            this.ensureBytesLeft(4);
            var v = this._dataView.getFloat32(this.pos);
            this.pos += 4;
            return v;
          };
          KaitaiStream2.prototype.readF8be = function() {
            this.ensureBytesLeft(8);
            var v = this._dataView.getFloat64(this.pos);
            this.pos += 8;
            return v;
          };
          KaitaiStream2.prototype.readF4le = function() {
            this.ensureBytesLeft(4);
            var v = this._dataView.getFloat32(this.pos, true);
            this.pos += 4;
            return v;
          };
          KaitaiStream2.prototype.readF8le = function() {
            this.ensureBytesLeft(8);
            var v = this._dataView.getFloat64(this.pos, true);
            this.pos += 8;
            return v;
          };
          KaitaiStream2.prototype.alignToByte = function() {
            this.bitsLeft = 0;
            this.bits = 0;
          };
          KaitaiStream2.prototype.readBitsIntBe = function(n) {
            if (n > 32) {
              throw new RangeError("readBitsIntBe: the maximum supported bit length is 32 (tried to read " + n + " bits)");
            }
            var res = 0;
            var bitsNeeded = n - this.bitsLeft;
            this.bitsLeft = -bitsNeeded & 7;
            if (bitsNeeded > 0) {
              var bytesNeeded = (bitsNeeded - 1 >> 3) + 1;
              var buf = this.readBytes(bytesNeeded);
              for (var i = 0; i < bytesNeeded; i++) {
                res = res << 8 | buf[i];
              }
              var newBits = res;
              res = res >>> this.bitsLeft | this.bits << bitsNeeded;
              this.bits = newBits;
            } else {
              res = this.bits >>> -bitsNeeded;
            }
            var mask = (1 << this.bitsLeft) - 1;
            this.bits &= mask;
            return res >>> 0;
          };
          KaitaiStream2.prototype.readBitsInt = function(n) {
            return this.readBitsIntBe(n);
          };
          KaitaiStream2.prototype.readBitsIntLe = function(n) {
            if (n > 32) {
              throw new RangeError("readBitsIntLe: the maximum supported bit length is 32 (tried to read " + n + " bits)");
            }
            var res = 0;
            var bitsNeeded = n - this.bitsLeft;
            if (bitsNeeded > 0) {
              var bytesNeeded = (bitsNeeded - 1 >> 3) + 1;
              var buf = this.readBytes(bytesNeeded);
              for (var i = 0; i < bytesNeeded; i++) {
                res |= buf[i] << i * 8;
              }
              var newBits = bitsNeeded < 32 ? res >>> bitsNeeded : 0;
              res = res << this.bitsLeft | this.bits;
              this.bits = newBits;
            } else {
              res = this.bits;
              this.bits >>>= n;
            }
            this.bitsLeft = -bitsNeeded & 7;
            if (n < 32) {
              var mask = (1 << n) - 1;
              res &= mask;
            } else {
              res >>>= 0;
            }
            return res;
          };
          KaitaiStream2.prototype.readBytes = function(len) {
            return this.mapUint8Array(len);
          };
          KaitaiStream2.prototype.readBytesFull = function() {
            return this.mapUint8Array(this.size - this.pos);
          };
          KaitaiStream2.prototype.readBytesTerm = function(terminator, include, consume, eosError) {
            var blen = this.size - this.pos;
            var u8 = new Uint8Array(this._buffer, this._byteOffset + this.pos);
            var i;
            for (i = 0; i < blen && u8[i] !== terminator; i++)
              ;
            if (i === blen) {
              if (eosError) {
                throw new Error("End of stream reached, but no terminator " + terminator + " found");
              } else {
                return this.mapUint8Array(i);
              }
            } else {
              var arr = void 0;
              if (include) {
                arr = this.mapUint8Array(i + 1);
              } else {
                arr = this.mapUint8Array(i);
              }
              if (consume) {
                this.pos += 1;
              }
              return arr;
            }
          };
          KaitaiStream2.prototype.readBytesTermMulti = function(terminator, include, consume, eosError) {
            var unitSize = terminator.length;
            var data = new Uint8Array(this._buffer, this._byteOffset + this.pos, this.size - this.pos);
            var res = KaitaiStream2.bytesTerminateMulti(data, terminator, true);
            this.pos += res.length;
            var termFound = res.length !== 0 && res.length % unitSize === 0 && KaitaiStream2.byteArrayCompare(new Uint8Array(res.buffer, res.length - unitSize), terminator) === 0;
            if (termFound) {
              if (!include) {
                res = new Uint8Array(res.buffer, res.byteOffset, res.length - unitSize);
              }
              if (!consume) {
                this.pos -= unitSize;
              }
            } else if (eosError) {
              throw new Error("End of stream reached, but no terminator " + terminator + " found");
            }
            return res;
          };
          KaitaiStream2.prototype.ensureFixedContents = function(expected) {
            var actual = this.readBytes(expected.length);
            if (actual.length !== expected.length) {
              throw new KaitaiStream2.UnexpectedDataError(expected, actual);
            }
            var actLen = actual.length;
            for (var i = 0; i < actLen; i++) {
              if (actual[i] !== expected[i]) {
                throw new KaitaiStream2.UnexpectedDataError(expected, actual);
              }
            }
            return actual;
          };
          KaitaiStream2.bytesStripRight = function(data, padByte) {
            var newLen = data.length;
            while (data[newLen - 1] === padByte) {
              newLen--;
            }
            return data.slice(0, newLen);
          };
          KaitaiStream2.bytesTerminate = function(data, term, include) {
            var newLen = 0;
            var maxLen = data.length;
            while (newLen < maxLen && data[newLen] !== term) {
              newLen++;
            }
            if (include && newLen < maxLen)
              newLen++;
            return data.slice(0, newLen);
          };
          KaitaiStream2.bytesTerminateMulti = function(data, term, include) {
            var unitSize = term.length;
            if (unitSize === 0) {
              return new Uint8Array();
            }
            var len = data.length;
            var iTerm = 0;
            for (var iData = 0; iData < len; ) {
              if (data[iData] !== term[iTerm]) {
                iData += unitSize - iTerm;
                iTerm = 0;
                continue;
              }
              iData++;
              iTerm++;
              if (iTerm === unitSize) {
                return data.slice(0, iData - (include ? 0 : unitSize));
              }
            }
            return data.slice();
          };
          KaitaiStream2.bytesToStr = function(arr, encoding) {
            if (encoding == null || encoding.toLowerCase() === "ascii") {
              return KaitaiStream2.createStringFromArray(arr);
            } else {
              if (typeof TextDecoder === "function") {
                return new TextDecoder(encoding).decode(arr);
              } else {
                switch (encoding.toLowerCase()) {
                  case "utf8":
                  case "utf-8":
                  case "ucs2":
                  case "ucs-2":
                  case "utf16le":
                  case "utf-16le":
                    return Buffer.from(arr).toString(encoding);
                  default:
                    if (typeof KaitaiStream2.iconvlite === "undefined")
                      KaitaiStream2.iconvlite = require_iconv_lite();
                    return KaitaiStream2.iconvlite.decode(arr, encoding);
                }
              }
            }
          };
          KaitaiStream2.processXorOne = function(data, key) {
            var r = new Uint8Array(data.length);
            var dl = data.length;
            for (var i = 0; i < dl; i++)
              r[i] = data[i] ^ key;
            return r;
          };
          KaitaiStream2.processXorMany = function(data, key) {
            var dl = data.length;
            var r = new Uint8Array(dl);
            var kl = key.length;
            var ki = 0;
            for (var i = 0; i < dl; i++) {
              r[i] = data[i] ^ key[ki];
              ki++;
              if (ki >= kl)
                ki = 0;
            }
            return r;
          };
          KaitaiStream2.processRotateLeft = function(data, amount, groupSize) {
            if (groupSize !== 1)
              throw new RangeError("unable to rotate group of " + groupSize + " bytes yet");
            var mask = groupSize * 8 - 1;
            var antiAmount = -amount & mask;
            var r = new Uint8Array(data.length);
            for (var i = 0; i < data.length; i++)
              r[i] = data[i] << amount & 255 | data[i] >> antiAmount;
            return r;
          };
          KaitaiStream2.processZlib = function(buf) {
            if (typeof __require !== "undefined") {
              if (typeof KaitaiStream2.zlib === "undefined")
                KaitaiStream2.zlib = require_zlib();
              var r = KaitaiStream2.zlib.inflateSync(Buffer.from(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)));
              return new Uint8Array(r.buffer, r.byteOffset, r.length);
            } else {
              if (typeof KaitaiStream2.zlib === "undefined" && typeof KaitaiStream2.depUrls.zlib !== "undefined") {
                importScripts(KaitaiStream2.depUrls.zlib);
                KaitaiStream2.zlib = pako;
              }
              return KaitaiStream2.zlib.inflate(buf);
            }
          };
          KaitaiStream2.mod = function(a, b) {
            if (b <= 0)
              throw new RangeError("mod divisor <= 0");
            var r = a % b;
            if (r < 0)
              r += b;
            return r;
          };
          KaitaiStream2.arrayMin = function(arr) {
            var min = arr[0];
            var x;
            for (var i = 1, n = arr.length; i < n; ++i) {
              x = arr[i];
              if (x < min)
                min = x;
            }
            return min;
          };
          KaitaiStream2.arrayMax = function(arr) {
            var max = arr[0];
            var x;
            for (var i = 1, n = arr.length; i < n; ++i) {
              x = arr[i];
              if (x > max)
                max = x;
            }
            return max;
          };
          KaitaiStream2.byteArrayCompare = function(a, b) {
            if (a === b)
              return 0;
            var al = a.length;
            var bl = b.length;
            var minLen = al < bl ? al : bl;
            for (var i = 0; i < minLen; i++) {
              var cmp = a[i] - b[i];
              if (cmp !== 0)
                return cmp;
            }
            if (al === bl) {
              return 0;
            } else {
              return al - bl;
            }
          };
          KaitaiStream2.prototype.ensureBytesLeft = function(length) {
            if (this.pos + length > this.size) {
              throw new KaitaiStream2.EOFError(length, this.size - this.pos);
            }
          };
          KaitaiStream2.prototype.mapUint8Array = function(length) {
            length |= 0;
            this.ensureBytesLeft(length);
            var arr = new Uint8Array(this._buffer, this.byteOffset + this.pos, length);
            this.pos += length;
            return arr;
          };
          KaitaiStream2.createStringFromArray = function(array) {
            var chunk_size = 32768;
            var chunks = [];
            for (var i = 0; i < array.length; i += chunk_size) {
              var chunk = array.subarray(i, i + chunk_size);
              chunks.push(String.fromCharCode.apply(null, chunk));
            }
            return chunks.join("");
          };
          KaitaiStream2.depUrls = {
            // processZlib uses this and expected a link to a copy of pako.
            // specifically the pako_inflate.min.js script at:
            // https://raw.githubusercontent.com/nodeca/pako/master/dist/pako_inflate.min.js
            zlib: void 0
          };
          KaitaiStream2.endianness = new Int8Array(new Int16Array([1]).buffer)[0] > 0;
          KaitaiStream2.EOFError = /** @class */
          (function(_super) {
            __extends(EOFError, _super);
            function EOFError(bytesReq, bytesAvail) {
              var _this = _super.call(this, "requested " + bytesReq + " bytes, but only " + bytesAvail + " bytes available") || this;
              _this.name = "EOFError";
              Object.setPrototypeOf(_this, KaitaiStream2.EOFError.prototype);
              _this.bytesReq = bytesReq;
              _this.bytesAvail = bytesAvail;
              return _this;
            }
            return EOFError;
          })(Error);
          KaitaiStream2.UnexpectedDataError = /** @class */
          (function(_super) {
            __extends(UnexpectedDataError, _super);
            function UnexpectedDataError(expected, actual) {
              var _this = _super.call(this, "expected [" + expected + "], but got [" + actual + "]") || this;
              _this.name = "UnexpectedDataError";
              Object.setPrototypeOf(_this, KaitaiStream2.UnexpectedDataError.prototype);
              _this.expected = expected;
              _this.actual = actual;
              return _this;
            }
            return UnexpectedDataError;
          })(Error);
          KaitaiStream2.UndecidedEndiannessError = /** @class */
          (function(_super) {
            __extends(UndecidedEndiannessError, _super);
            function UndecidedEndiannessError() {
              var _this = _super.call(this) || this;
              _this.name = "UndecidedEndiannessError";
              Object.setPrototypeOf(_this, KaitaiStream2.UndecidedEndiannessError.prototype);
              return _this;
            }
            return UndecidedEndiannessError;
          })(Error);
          KaitaiStream2.ValidationNotEqualError = /** @class */
          (function(_super) {
            __extends(ValidationNotEqualError, _super);
            function ValidationNotEqualError(expected, actual) {
              var _this = _super.call(this, "not equal, expected [" + expected + "], but got [" + actual + "]") || this;
              _this.name = "ValidationNotEqualError";
              Object.setPrototypeOf(_this, KaitaiStream2.ValidationNotEqualError.prototype);
              _this.expected = expected;
              _this.actual = actual;
              return _this;
            }
            return ValidationNotEqualError;
          })(Error);
          KaitaiStream2.ValidationLessThanError = /** @class */
          (function(_super) {
            __extends(ValidationLessThanError, _super);
            function ValidationLessThanError(min, actual) {
              var _this = _super.call(this, "not in range, min [" + min + "], but got [" + actual + "]") || this;
              _this.name = "ValidationLessThanError";
              Object.setPrototypeOf(_this, KaitaiStream2.ValidationLessThanError.prototype);
              _this.min = min;
              _this.actual = actual;
              return _this;
            }
            return ValidationLessThanError;
          })(Error);
          KaitaiStream2.ValidationGreaterThanError = /** @class */
          (function(_super) {
            __extends(ValidationGreaterThanError, _super);
            function ValidationGreaterThanError(max, actual) {
              var _this = _super.call(this, "not in range, max [" + max + "], but got [" + actual + "]") || this;
              _this.name = "ValidationGreaterThanError";
              Object.setPrototypeOf(_this, KaitaiStream2.ValidationGreaterThanError.prototype);
              _this.max = max;
              _this.actual = actual;
              return _this;
            }
            return ValidationGreaterThanError;
          })(Error);
          KaitaiStream2.ValidationNotAnyOfError = /** @class */
          (function(_super) {
            __extends(ValidationNotAnyOfError, _super);
            function ValidationNotAnyOfError(actual) {
              var _this = _super.call(this, "not any of the list, got [" + actual + "]") || this;
              _this.name = "ValidationNotAnyOfError";
              Object.setPrototypeOf(_this, KaitaiStream2.ValidationNotAnyOfError.prototype);
              _this.actual = actual;
              return _this;
            }
            return ValidationNotAnyOfError;
          })(Error);
          KaitaiStream2.ValidationNotInEnumError = /** @class */
          (function(_super) {
            __extends(ValidationNotInEnumError, _super);
            function ValidationNotInEnumError(actual) {
              var _this = _super.call(this, "not in the enum, got [" + actual + "]") || this;
              _this.name = "ValidationNotInEnumError";
              Object.setPrototypeOf(_this, KaitaiStream2.ValidationNotInEnumError.prototype);
              _this.actual = actual;
              return _this;
            }
            return ValidationNotInEnumError;
          })(Error);
          KaitaiStream2.ValidationExprError = /** @class */
          (function(_super) {
            __extends(ValidationExprError, _super);
            function ValidationExprError(actual) {
              var _this = _super.call(this, "not matching the expression, got [" + actual + "]") || this;
              _this.name = "ValidationExprError";
              Object.setPrototypeOf(_this, KaitaiStream2.ValidationExprError.prototype);
              _this.actual = actual;
              return _this;
            }
            return ValidationExprError;
          })(Error);
          return KaitaiStream2;
        })()
      );
      return KaitaiStream;
    }));
  }
});

// kaitai-runtime-entry.js
var import_KaitaiStream = __toESM(require_KaitaiStream());
var kaitai_runtime_entry_default = import_KaitaiStream.default;
export {
  kaitai_runtime_entry_default as default
};
