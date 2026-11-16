import { ZIGZAG } from './jpeg-decode'
import type { Picture } from './picture'

/**
 * A baseline JPEG encoder for the small previews (B-TH-063): YCbCr 4:2:0, the standard quantisation tables of the JPEG
 * specification (Annex K) scaled for `quality` as the IJG library scales them, the standard Huffman tables, a JFIF header
 * and nothing else (no EXIF: the pixels are already turned the right way up, see picture.ts `orient`). An alpha channel
 * is laid on white.
 */

const LUMINANCE = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81,
  104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
]
const CHROMINANCE = [
  17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99, ...new Array<number>(32).fill(99),
]

/** The Huffman tables of Annex K.3: the code counts per length (1..16) and the symbols in code order. */
export const STANDARD_TABLES = {
  dcLuminance: {
    counts: [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0],
    symbols: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  },
  dcChrominance: {
    counts: [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0],
    symbols: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  },
  acLuminance: {
    counts: [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d],
    symbols: [
      0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1,
      0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46,
      0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84,
      0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7,
      0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9,
      0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
    ],
  },
  acChrominance: {
    counts: [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77],
    symbols: [
      0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71, 0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52,
      0xf0, 0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45,
      0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82,
      0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5,
      0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8,
      0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
    ],
  },
} as const

interface Code {
  readonly code: Int32Array
  readonly length: Int32Array
}

/** symbol → (code, length) of a canonical Huffman table. */
function codesOf(table: { readonly counts: readonly number[]; readonly symbols: readonly number[] }): Code {
  const code = new Int32Array(256)
  const length = new Int32Array(256)
  let next = 0
  let k = 0
  for (let bits = 1; bits <= 16; bits++) {
    for (let index = 0; index < table.counts[bits - 1]!; index++) {
      const symbol = table.symbols[k++]!
      code[symbol] = next++
      length[symbol] = bits
    }
    next <<= 1
  }
  return { code, length }
}

/** The IJG quality scaling of a base table (quality 1..100), in natural order. */
export function scaledTable(base: readonly number[], quality: number): Int32Array {
  const q = Math.min(100, Math.max(1, Math.round(quality)))
  const scale = q < 50 ? 5000 / q : 200 - q * 2
  return Int32Array.from(base, (value) => Math.min(255, Math.max(1, Math.floor((value * scale + 50) / 100))))
}

class BitWriter {
  private readonly bytes: number[] = []
  private buffer = 0
  private count = 0

  write(value: number, length: number): void {
    for (let bit = length - 1; bit >= 0; bit--) {
      this.buffer = (this.buffer << 1) | ((value >> bit) & 1)
      this.count += 1
      if (this.count === 8) this.flushByte()
    }
  }

  private flushByte(): void {
    this.bytes.push(this.buffer)
    if (this.buffer === 0xff) this.bytes.push(0x00)
    this.buffer = 0
    this.count = 0
  }

  /** Pads the last byte with ones (the specification's fill) and answers the entropy-coded bytes. */
  finish(): number[] {
    if (this.count > 0) this.write((1 << (8 - this.count)) - 1, 8 - this.count)
    return this.bytes
  }
}

const COS = (() => {
  const table = new Float64Array(64)
  for (let x = 0; x < 8; x++) for (let u = 0; u < 8; u++) table[x * 8 + u] = Math.cos(((2 * x + 1) * u * Math.PI) / 16) * (u === 0 ? Math.SQRT1_2 : 1)
  return table
})()

/** The forward DCT of one 8 × 8 block (samples less 128), quantised, in zigzag order. */
function transform(block: Float64Array, quant: Int32Array, out: Int32Array): void {
  const work = new Float64Array(64)
  for (let y = 0; y < 8; y++) {
    for (let u = 0; u < 8; u++) {
      let sum = 0
      for (let x = 0; x < 8; x++) sum += block[y * 8 + x]! * COS[x * 8 + u]!
      work[y * 8 + u] = sum / 2
    }
  }
  for (let u = 0; u < 8; u++) {
    for (let v = 0; v < 8; v++) {
      let sum = 0
      for (let y = 0; y < 8; y++) sum += work[y * 8 + u]! * COS[y * 8 + v]!
      const natural = v * 8 + u
      out[natural] = Math.round(sum / 2 / quant[natural]!)
    }
  }
}

const bitLength = (value: number): number => {
  let magnitude = Math.abs(value)
  let bits = 0
  while (magnitude > 0) {
    bits += 1
    magnitude >>= 1
  }
  return bits
}

/** The picture as a baseline JPEG at `quality` (default 82). */
export function encodeJpeg(picture: Picture, quality = 82): Uint8Array {
  const { width, height, channels, data } = picture
  const lumQ = scaledTable(LUMINANCE, quality)
  const chrQ = scaledTable(CHROMINANCE, quality)
  const dcL = codesOf(STANDARD_TABLES.dcLuminance)
  const acL = codesOf(STANDARD_TABLES.acLuminance)
  const dcC = codesOf(STANDARD_TABLES.dcChrominance)
  const acC = codesOf(STANDARD_TABLES.acChrominance)

  // The planes, the alpha laid on white.
  const Y = new Float64Array(width * height)
  const Cb = new Float64Array(width * height)
  const Cr = new Float64Array(width * height)
  for (let index = 0; index < width * height; index++) {
    const alpha = channels === 4 ? data[index * 4 + 3]! / 255 : 1
    const r = data[index * channels]! * alpha + 255 * (1 - alpha)
    const g = data[index * channels + 1]! * alpha + 255 * (1 - alpha)
    const b = data[index * channels + 2]! * alpha + 255 * (1 - alpha)
    Y[index] = 0.299 * r + 0.587 * g + 0.114 * b
    Cb[index] = -0.168736 * r - 0.331264 * g + 0.5 * b + 128
    Cr[index] = 0.5 * r - 0.418688 * g - 0.081312 * b + 128
  }
  const at = (plane: Float64Array, x: number, y: number): number => plane[Math.min(height - 1, y) * width + Math.min(width - 1, x)]!

  const writer = new BitWriter()
  const block = new Float64Array(64)
  const coefficients = new Int32Array(64)
  const predictions = [0, 0, 0]
  const encodeBlock = (quant: Int32Array, dc: Code, ac: Code, component: number): void => {
    transform(block, quant, coefficients)
    const diff = coefficients[0]! - predictions[component]!
    predictions[component] = coefficients[0]!
    const size = bitLength(diff)
    writer.write(dc.code[size]!, dc.length[size]!)
    if (size > 0) writer.write(diff < 0 ? diff + (1 << size) - 1 : diff, size)
    let run = 0
    for (let k = 1; k < 64; k++) {
      const value = coefficients[ZIGZAG[k]!]!
      if (value === 0) {
        run += 1
        continue
      }
      while (run > 15) {
        writer.write(ac.code[0xf0]!, ac.length[0xf0]!)
        run -= 16
      }
      const bits = bitLength(value)
      const symbol = (run << 4) | bits
      writer.write(ac.code[symbol]!, ac.length[symbol]!)
      writer.write(value < 0 ? value + (1 << bits) - 1 : value, bits)
      run = 0
    }
    if (run > 0) writer.write(ac.code[0]!, ac.length[0]!)
  }

  for (let mcuY = 0; mcuY < height; mcuY += 16) {
    for (let mcuX = 0; mcuX < width; mcuX += 16) {
      for (const [dx, dy] of [[0, 0], [8, 0], [0, 8], [8, 8]] as const) {
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) block[y * 8 + x] = at(Y, mcuX + dx + x, mcuY + dy + y) - 128
        encodeBlock(lumQ, dcL, acL, 0)
      }
      for (const [plane, component] of [[Cb, 1], [Cr, 2]] as const) {
        for (let y = 0; y < 8; y++) {
          for (let x = 0; x < 8; x++) {
            const sx = mcuX + x * 2
            const sy = mcuY + y * 2
            block[y * 8 + x] = (at(plane, sx, sy) + at(plane, sx + 1, sy) + at(plane, sx, sy + 1) + at(plane, sx + 1, sy + 1)) / 4 - 128
          }
        }
        encodeBlock(chrQ, dcC, acC, component)
      }
    }
  }
  const scan = writer.finish()

  const out: number[] = [0xff, 0xd8]
  const segment = (marker: number, body: readonly number[]): void => {
    out.push(0xff, marker, ((body.length + 2) >> 8) & 0xff, (body.length + 2) & 0xff, ...body)
  }
  segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0])
  segment(0xdb, [0x00, ...Array.from(ZIGZAG, (natural) => lumQ[natural]!), 0x01, ...Array.from(ZIGZAG, (natural) => chrQ[natural]!)])
  segment(0xc0, [8, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1])
  const huffman = (klass: number, id: number, table: { readonly counts: readonly number[]; readonly symbols: readonly number[] }) => [(klass << 4) | id, ...table.counts, ...table.symbols]
  segment(0xc4, [...huffman(0, 0, STANDARD_TABLES.dcLuminance), ...huffman(1, 0, STANDARD_TABLES.acLuminance), ...huffman(0, 1, STANDARD_TABLES.dcChrominance), ...huffman(1, 1, STANDARD_TABLES.acChrominance)])
  segment(0xda, [3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0])
  const bytes = new Uint8Array(out.length + scan.length + 2)
  bytes.set(out, 0)
  bytes.set(scan, out.length)
  bytes[bytes.length - 2] = 0xff
  bytes[bytes.length - 1] = 0xd9
  return bytes
}
