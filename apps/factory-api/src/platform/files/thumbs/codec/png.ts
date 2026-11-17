import { deflateSync, inflateSync } from 'node:zlib'
import { CodecError, type Picture } from './picture'

/**
 * A PNG decoder and encoder for the small previews (B-TH-063), on Node's own zlib: every colour type (grey, RGB, palette,
 * grey + alpha, RGBA), bit depths 1 to 16, transparency (tRNS), interlaced (Adam7) or not. The decoder answers RGBA
 * (16-bit samples keep their high byte); the encoder writes RGB, or RGBA when a pixel is not opaque, 8 bits, with the
 * usual per-row filter choice (the smallest sum of absolute differences).
 */

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
/** Pixels at most (a guard against a header that claims a giant picture). */
export const MAX_PNG_PIXELS = 60_000_000

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }
const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
] as const

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/** Undoes the row filters of one (sub-)image in place; answers the rows without their filter byte. */
function unfilter(data: Uint8Array, offset: number, width: number, height: number, bitsPerPixel: number): { readonly rows: Uint8Array; readonly rowBytes: number; readonly used: number } {
  const rowBytes = Math.ceil((width * bitsPerPixel) / 8)
  const bpp = Math.max(1, bitsPerPixel >> 3)
  const rows = new Uint8Array(rowBytes * height)
  for (let y = 0; y < height; y++) {
    const at = offset + y * (rowBytes + 1)
    if (at + rowBytes >= data.length) throw new CodecError('The PNG data is shorter than its size says.')
    const filter = data[at]!
    const line = y * rowBytes
    for (let x = 0; x < rowBytes; x++) {
      const raw = data[at + 1 + x]!
      const a = x >= bpp ? rows[line + x - bpp]! : 0
      const b = y > 0 ? rows[line - rowBytes + x]! : 0
      const c = x >= bpp && y > 0 ? rows[line - rowBytes + x - bpp]! : 0
      let value: number
      switch (filter) {
        case 0: value = raw; break
        case 1: value = raw + a; break
        case 2: value = raw + b; break
        case 3: value = raw + ((a + b) >> 1); break
        case 4: value = raw + paeth(a, b, c); break
        default: throw new CodecError('A PNG row has an unknown filter.')
      }
      rows[line + x] = value & 0xff
    }
  }
  return { rows, rowBytes, used: height * (rowBytes + 1) }
}

/** Decodes a PNG to RGBA. Throws CodecError for what it does not read. */
export function decodePng(data: Uint8Array): Picture {
  if (data.length < 8 || SIGNATURE.some((byte, index) => data[index] !== byte)) throw new CodecError('Not a PNG picture.')
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let width = 0
  let height = 0
  let depth = 0
  let colourType = 0
  let interlace = 0
  let palette: Uint8Array | null = null
  let transparency: Uint8Array | null = null
  const idat: Uint8Array[] = []
  let offset = 8
  while (offset + 8 <= data.length) {
    const length = view.getUint32(offset)
    const type = String.fromCharCode(...data.subarray(offset + 4, offset + 8))
    const body = data.subarray(offset + 8, offset + 8 + length)
    if (offset + 12 + length > data.length) throw new CodecError('A PNG chunk runs past the end of the file.')
    if (type === 'IHDR') {
      width = view.getUint32(offset + 8)
      height = view.getUint32(offset + 12)
      depth = body[8]!
      colourType = body[9]!
      interlace = body[12]!
      if (!(colourType in CHANNELS) || ![1, 2, 4, 8, 16].includes(depth)) throw new CodecError('The PNG has an unknown colour type or bit depth.')
      if (width === 0 || height === 0 || width * height > MAX_PNG_PIXELS) throw new CodecError('The picture is too large to read here.')
    } else if (type === 'PLTE') palette = body.slice()
    else if (type === 'tRNS') transparency = body.slice()
    else if (type === 'IDAT') idat.push(body)
    else if (type === 'IEND') break
    offset += 12 + length
  }
  if (width === 0 || idat.length === 0) throw new CodecError('The PNG has no picture data.')
  if (colourType === 3 && !palette) throw new CodecError('The PNG has no palette.')
  let inflated: Uint8Array
  try {
    inflated = inflateSync(Buffer.concat(idat.map((part) => Buffer.from(part.buffer, part.byteOffset, part.byteLength))))
  } catch {
    throw new CodecError('The PNG picture data is damaged.')
  }
  const channels = CHANNELS[colourType]!
  const bitsPerPixel = channels * depth
  const out = new Uint8ClampedArray(width * height * 4)
  const maxValue = (1 << depth) - 1

  const sampleAt = (rows: Uint8Array, rowBytes: number, x: number, y: number, channel: number): number => {
    if (depth === 8) return rows[y * rowBytes + x * channels + channel]!
    if (depth === 16) return rows[y * rowBytes + (x * channels + channel) * 2]!
    const bit = (x * channels + channel) * depth
    const byte = rows[y * rowBytes + (bit >> 3)]!
    return (byte >> (8 - depth - (bit & 7))) & maxValue
  }
  const sample16 = (rows: Uint8Array, rowBytes: number, x: number, y: number, channel: number): number => {
    const at = y * rowBytes + (x * channels + channel) * 2
    return (rows[at]! << 8) | rows[at + 1]!
  }
  const scale = (value: number): number => (depth >= 8 ? value : Math.round((value * 255) / maxValue))
  const key = (channel: number): number | null => {
    if (!transparency) return null
    if (colourType === 0 && transparency.length >= 2) return (transparency[0]! << 8) | transparency[1]!
    if (colourType === 2 && transparency.length >= 6) return (transparency[channel * 2]! << 8) | transparency[channel * 2 + 1]!
    return null
  }
  const raw = (rows: Uint8Array, rowBytes: number, x: number, y: number, channel: number): number => (depth === 16 ? sample16(rows, rowBytes, x, y, channel) : sampleAt(rows, rowBytes, x, y, channel))

  const place = (rows: Uint8Array, rowBytes: number, subWidth: number, subHeight: number, toX: (x: number) => number, toY: (y: number) => number): void => {
    for (let y = 0; y < subHeight; y++) {
      for (let x = 0; x < subWidth; x++) {
        const target = (toY(y) * width + toX(x)) * 4
        let r: number
        let g: number
        let b: number
        let a = 255
        switch (colourType) {
          case 0: {
            const grey = sampleAt(rows, rowBytes, x, y, 0)
            r = g = b = scale(grey)
            if (key(0) !== null && raw(rows, rowBytes, x, y, 0) === key(0)) a = 0
            break
          }
          case 2:
            r = scale(sampleAt(rows, rowBytes, x, y, 0))
            g = scale(sampleAt(rows, rowBytes, x, y, 1))
            b = scale(sampleAt(rows, rowBytes, x, y, 2))
            if (key(0) !== null && raw(rows, rowBytes, x, y, 0) === key(0) && raw(rows, rowBytes, x, y, 1) === key(1) && raw(rows, rowBytes, x, y, 2) === key(2)) a = 0
            break
          case 3: {
            const index = sampleAt(rows, rowBytes, x, y, 0)
            r = palette![index * 3] ?? 0
            g = palette![index * 3 + 1] ?? 0
            b = palette![index * 3 + 2] ?? 0
            a = transparency && index < transparency.length ? transparency[index]! : 255
            break
          }
          case 4:
            r = g = b = scale(sampleAt(rows, rowBytes, x, y, 0))
            a = scale(sampleAt(rows, rowBytes, x, y, 1))
            break
          default:
            r = scale(sampleAt(rows, rowBytes, x, y, 0))
            g = scale(sampleAt(rows, rowBytes, x, y, 1))
            b = scale(sampleAt(rows, rowBytes, x, y, 2))
            a = scale(sampleAt(rows, rowBytes, x, y, 3))
        }
        out[target] = r
        out[target + 1] = g
        out[target + 2] = b
        out[target + 3] = a
      }
    }
  }

  if (interlace === 0) {
    const { rows, rowBytes } = unfilter(inflated, 0, width, height, bitsPerPixel)
    place(rows, rowBytes, width, height, (x) => x, (y) => y)
  } else {
    let at = 0
    for (const [startX, startY, stepX, stepY] of ADAM7) {
      const subWidth = Math.ceil((width - startX) / stepX)
      const subHeight = Math.ceil((height - startY) / stepY)
      if (subWidth <= 0 || subHeight <= 0) continue
      const { rows, rowBytes, used } = unfilter(inflated, at, subWidth, subHeight, bitsPerPixel)
      place(rows, rowBytes, subWidth, subHeight, (x) => startX + x * stepX, (y) => startY + y * stepY)
      at += used
    }
  }
  return { width, height, channels: 4, data: out }
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, body.length)
  for (let index = 0; index < 4; index++) out[4 + index] = type.charCodeAt(index)
  out.set(body, 8)
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)))
  return out
}

/** The picture as an 8-bit PNG: RGB when every pixel is opaque, else RGBA. */
export function encodePng(picture: Picture): Uint8Array {
  const { width, height, channels, data } = picture
  let opaque = true
  if (channels === 4) for (let at = 3; at < data.length && opaque; at += 4) if (data[at] !== 255) opaque = false
  const outChannels = opaque ? 3 : 4
  const rowBytes = width * outChannels
  const raw = new Uint8Array(height * rowBytes)
  for (let index = 0; index < width * height; index++) for (let c = 0; c < outChannels; c++) raw[index * outChannels + c] = data[index * channels + c]!
  const filtered = new Uint8Array(height * (rowBytes + 1))
  const candidate = new Uint8Array(rowBytes)
  for (let y = 0; y < height; y++) {
    let bestScore = Infinity
    for (let filter = 0; filter <= 4; filter++) {
      let score = 0
      for (let x = 0; x < rowBytes; x++) {
        const value = raw[y * rowBytes + x]!
        const a = x >= outChannels ? raw[y * rowBytes + x - outChannels]! : 0
        const b = y > 0 ? raw[(y - 1) * rowBytes + x]! : 0
        const c = x >= outChannels && y > 0 ? raw[(y - 1) * rowBytes + x - outChannels]! : 0
        const predicted = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : paeth(a, b, c)
        const byte = (value - predicted) & 0xff
        candidate[x] = byte
        score += byte < 128 ? byte : 256 - byte
      }
      if (score < bestScore) {
        bestScore = score
        filtered[y * (rowBytes + 1)] = filter
        filtered.set(candidate, y * (rowBytes + 1) + 1)
      }
    }
  }
  const header = new Uint8Array(13)
  const view = new DataView(header.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  header[8] = 8
  header[9] = opaque ? 2 : 6
  const parts = [Uint8Array.from(SIGNATURE), chunk('IHDR', header), chunk('IDAT', deflateSync(filtered, { level: 9 })), chunk('IEND', new Uint8Array(0))]
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}
