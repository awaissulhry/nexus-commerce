import { readExif } from '@nexus/factory-domain/files/thumbs/strip'
import { CodecError, type Picture } from './picture'

/**
 * A JPEG decoder for the small previews (B-TH-063), pure TypeScript, because the factory API carries no image library:
 * baseline and extended sequential (SOF0, SOF1) and progressive (SOF2) Huffman pictures, 8 bits per sample, 1, 3 or 4
 * components with any sampling factors, restart intervals. Lossless, hierarchical, arithmetic-coded and 12-bit pictures
 * are refused (CodecError): the caller then keeps the stripped copy as it is.
 *
 * It decodes at a REDUCED size when asked (`scale` 1, 2, 4 or 8 of 8): each 8 × 8 block is turned into scale × scale
 * pixels by the inverse DCT of its lowest frequencies, evaluated at the centres of the merged pixels (what libjpeg's
 * scaled decoding does; scale 1 is the block's mean). A 12-megapixel photo is read at 1/8 for a 320-pixel preview, which
 * spares the full inverse transform. The EXIF orientation (the one tag the stripped copy keeps) is returned, not applied.
 */

const ZIGZAG = (() => {
  const order: number[] = []
  for (let sum = 0; sum < 15; sum++) {
    const cells: number[] = []
    for (let row = 0; row < 8; row++) {
      const col = sum - row
      if (col >= 0 && col < 8) cells.push(row * 8 + col)
    }
    // Even diagonals run up (bottom-left to top-right), odd ones down.
    order.push(...(sum % 2 === 0 ? cells.reverse() : cells))
  }
  return Int32Array.from(order)
})()
export { ZIGZAG }

interface Huffman {
  /** For each code length 1..16: the largest code of that length (-1: none), and where its values start. */
  readonly maxCode: Int32Array
  readonly valPtr: Int32Array
  readonly minCode: Int32Array
  readonly values: Uint8Array
}

function buildHuffman(counts: Uint8Array, values: Uint8Array): Huffman {
  const maxCode = new Int32Array(18).fill(-1)
  const valPtr = new Int32Array(17)
  const minCode = new Int32Array(17)
  let code = 0
  let k = 0
  for (let length = 1; length <= 16; length++) {
    const count = counts[length - 1]!
    valPtr[length] = k
    minCode[length] = code
    code += count
    k += count
    maxCode[length] = count > 0 ? code - 1 : -1
    code <<= 1
  }
  maxCode[17] = 0x7fffffff
  if (k > values.length) throw new CodecError('A Huffman table is shorter than its counts say.')
  return { maxCode, valPtr, minCode, values }
}

interface Component {
  readonly id: number
  readonly h: number
  readonly v: number
  readonly tq: number
  blocksPerLine: number
  blocksPerColumn: number
  /** Blocks across and down as the MCU grid pads them (where the coefficients are kept). */
  paddedPerLine: number
  paddedPerColumn: number
  coefficients: Int16Array
  dc: Huffman | null
  ac: Huffman | null
  pred: number
}

interface Frame {
  readonly progressive: boolean
  readonly width: number
  readonly height: number
  readonly components: Component[]
  readonly maxH: number
  readonly maxV: number
  readonly mcusPerLine: number
  readonly mcusPerColumn: number
}

/** Pixels at most (a guard against a header that claims a giant picture). */
export const MAX_JPEG_PIXELS = 80_000_000

class BitReader {
  private bitBuffer = 0
  private bitCount = 0
  /** A marker met inside the entropy-coded data (the scan ends there). */
  marker: number | null = null

  constructor(
    private readonly data: Uint8Array,
    public offset: number,
  ) {}

  private fill(): void {
    while (this.bitCount <= 24) {
      let byte = 0
      if (this.marker === null && this.offset < this.data.length) {
        byte = this.data[this.offset]!
        if (byte === 0xff) {
          const next = this.data[this.offset + 1] ?? 0
          if (next === 0x00) {
            this.offset += 2
          } else if (next === 0xff) {
            // Fill bytes before a marker.
            this.offset += 1
            continue
          } else {
            this.marker = next
            byte = 0
          }
        } else {
          this.offset += 1
        }
      }
      this.bitBuffer = ((this.bitBuffer << 8) | byte) >>> 0
      this.bitCount += 8
    }
  }

  bit(): number {
    if (this.bitCount === 0) this.fill()
    this.bitCount -= 1
    return (this.bitBuffer >>> this.bitCount) & 1
  }

  bits(count: number): number {
    if (count === 0) return 0
    if (this.bitCount < count) this.fill()
    this.bitCount -= count
    return (this.bitBuffer >>> this.bitCount) & ((1 << count) - 1)
  }

  decode(table: Huffman): number {
    let code = this.bit()
    let length = 1
    while (code > table.maxCode[length]!) {
      code = (code << 1) | this.bit()
      length += 1
      if (length > 16) throw new CodecError('A Huffman code is not in its table.')
    }
    return table.values[table.valPtr[length]! + code - table.minCode[length]!]!
  }

  receiveExtend(size: number): number {
    if (size === 0) return 0
    if (size > 16) throw new CodecError('A coefficient is out of range.')
    const value = this.bits(size)
    return value < 1 << (size - 1) ? value - (1 << size) + 1 : value
  }

  /** Drops the buffered bits and moves past the next restart marker (RST0..RST7). */
  restart(): void {
    this.bitBuffer = 0
    this.bitCount = 0
    if (this.marker !== null && this.marker >= 0xd0 && this.marker <= 0xd7) {
      this.offset += 2
      this.marker = null
      return
    }
    // Look for the marker from where reading stopped (damaged or padded data).
    while (this.offset + 1 < this.data.length) {
      if (this.data[this.offset] === 0xff && this.data[this.offset + 1]! >= 0xd0 && this.data[this.offset + 1]! <= 0xd7) {
        this.offset += 2
        this.marker = null
        return
      }
      if (this.data[this.offset] === 0xff && this.data[this.offset + 1] !== 0 && this.data[this.offset + 1] !== 0xff) break
      this.offset += 1
    }
    this.marker = null
  }

  /** The offset of the marker that ends the scan. */
  end(): number {
    let at = this.offset
    while (at + 1 < this.data.length) {
      if (this.data[at] === 0xff) {
        const next = this.data[at + 1]!
        if (next !== 0x00 && next !== 0xff && !(next >= 0xd0 && next <= 0xd7)) return at
      }
      at += 1
    }
    return this.data.length
  }
}

interface ScanFacts {
  readonly components: Component[]
  readonly ss: number
  readonly se: number
  readonly ah: number
  readonly al: number
}

function decodeScan(data: Uint8Array, offset: number, frame: Frame, scan: ScanFacts, restartInterval: number): number {
  const reader = new BitReader(data, offset)
  const { components, ss, se, ah, al } = scan
  let eobrun = 0
  for (const component of components) component.pred = 0

  type BlockDecoder = (component: Component, at: number) => void
  const baseline: BlockDecoder = (component, at) => {
    const block = component.coefficients
    const t = reader.decode(component.dc!)
    component.pred += t === 0 ? 0 : reader.receiveExtend(t)
    block[at] = component.pred
    let k = 1
    while (k < 64) {
      const rs = reader.decode(component.ac!)
      const s = rs & 15
      const r = rs >> 4
      if (s === 0) {
        if (r < 15) break
        k += 16
        continue
      }
      k += r
      if (k > 63) break
      block[at + ZIGZAG[k]!] = reader.receiveExtend(s)
      k += 1
    }
  }
  const dcFirst: BlockDecoder = (component, at) => {
    const t = reader.decode(component.dc!)
    component.pred += t === 0 ? 0 : reader.receiveExtend(t)
    component.coefficients[at] = component.pred * (1 << al)
  }
  const dcRefine: BlockDecoder = (component, at) => {
    if (reader.bit()) component.coefficients[at] = component.coefficients[at]! | (1 << al)
  }
  const acFirst: BlockDecoder = (component, at) => {
    if (eobrun > 0) {
      eobrun -= 1
      return
    }
    const block = component.coefficients
    let k = ss
    while (k <= se) {
      const rs = reader.decode(component.ac!)
      const s = rs & 15
      const r = rs >> 4
      if (s === 0) {
        if (r < 15) {
          eobrun = (1 << r) - 1
          if (r) eobrun += reader.bits(r)
          break
        }
        k += 16
        continue
      }
      k += r
      if (k > 63) break
      block[at + ZIGZAG[k]!] = reader.receiveExtend(s) * (1 << al)
      k += 1
    }
  }
  const acRefine: BlockDecoder = (component, at) => {
    // libjpeg's decode_mcu_AC_refine, step for step.
    const block = component.coefficients
    const p1 = 1 << al
    const m1 = -1 << al
    let k = ss
    const refine = (z: number): void => {
      if (reader.bit() && (block[z]! & p1) === 0) block[z] = block[z]! + (block[z]! >= 0 ? p1 : m1)
    }
    if (eobrun === 0) {
      for (; k <= se; k++) {
        const rs = reader.decode(component.ac!)
        let r = rs >> 4
        let s = rs & 15
        if (s) {
          s = reader.bit() ? p1 : m1
        } else if (r !== 15) {
          eobrun = 1 << r
          if (r) eobrun += reader.bits(r)
          break
        }
        while (k <= se) {
          const z = at + ZIGZAG[k]!
          if (block[z] !== 0) refine(z)
          else if (--r < 0) break
          k += 1
        }
        if (s && k <= se) block[at + ZIGZAG[k]!] = s
      }
    }
    if (eobrun > 0) {
      for (; k <= se; k++) {
        const z = at + ZIGZAG[k]!
        if (block[z] !== 0) refine(z)
      }
      eobrun -= 1
    }
  }

  const decodeBlock: BlockDecoder = !frame.progressive ? baseline : ss === 0 ? (ah === 0 ? dcFirst : dcRefine) : ah === 0 ? acFirst : acRefine
  const blockAt = (component: Component, row: number, col: number): number => (row * component.paddedPerLine + col) * 64

  const single = components.length === 1
  const total = single ? components[0]!.blocksPerLine * components[0]!.blocksPerColumn : frame.mcusPerLine * frame.mcusPerColumn
  for (let mcu = 0; mcu < total; mcu++) {
    if (restartInterval > 0 && mcu > 0 && mcu % restartInterval === 0) {
      reader.restart()
      eobrun = 0
      for (const component of components) component.pred = 0
    }
    if (single) {
      const component = components[0]!
      const row = Math.floor(mcu / component.blocksPerLine)
      const col = mcu % component.blocksPerLine
      decodeBlock(component, blockAt(component, row, col))
    } else {
      const mcuRow = Math.floor(mcu / frame.mcusPerLine)
      const mcuCol = mcu % frame.mcusPerLine
      for (const component of components) {
        for (let v = 0; v < component.v; v++) {
          for (let h = 0; h < component.h; h++) decodeBlock(component, blockAt(component, mcuRow * component.v + v, mcuCol * component.h + h))
        }
      }
    }
  }
  return reader.end()
}

// ---- the scaled inverse DCT ---------------------------------------------------------------------------------------------

const COS_TABLES = new Map<number, Float64Array>()
/** cos((2m + 1) u π / (2N)) · C(u) / 2 for m, u < N (C(0) = 1/√2): one dimension of the scaled inverse transform. */
function cosTable(n: number): Float64Array {
  const found = COS_TABLES.get(n)
  if (found) return found
  const table = new Float64Array(n * n)
  for (let m = 0; m < n; m++) {
    for (let u = 0; u < n; u++) table[m * n + u] = (Math.cos(((2 * m + 1) * u * Math.PI) / (2 * n)) * (u === 0 ? Math.SQRT1_2 : 1)) / 2
  }
  COS_TABLES.set(n, table)
  return table
}

/** One component's samples at `scale`/8 of its size, from its dequantised coefficients. */
function componentPlane(component: Component, quant: Int32Array, scale: number): { readonly data: Uint8ClampedArray; readonly width: number; readonly height: number } {
  const width = component.paddedPerLine * scale
  const height = component.paddedPerColumn * scale
  const out = new Uint8ClampedArray(width * height)
  const table = cosTable(scale)
  const coefficients = new Float64Array(scale * scale)
  const work = new Float64Array(scale * scale)
  for (let row = 0; row < component.paddedPerColumn; row++) {
    for (let col = 0; col < component.paddedPerLine; col++) {
      const at = (row * component.paddedPerLine + col) * 64
      if (scale === 1) {
        out[row * width + col] = Math.round((component.coefficients[at]! * quant[0]!) / 8 + 128)
        continue
      }
      for (let v = 0; v < scale; v++) for (let u = 0; u < scale; u++) coefficients[v * scale + u] = component.coefficients[at + v * 8 + u]! * quant[v * 8 + u]!
      // Columns: work[y][u] = Σ_v table[y][v] · F[v][u]
      for (let u = 0; u < scale; u++) {
        for (let y = 0; y < scale; y++) {
          let sum = 0
          for (let v = 0; v < scale; v++) sum += table[y * scale + v]! * coefficients[v * scale + u]!
          work[y * scale + u] = sum
        }
      }
      // Rows: f[y][x] = Σ_u table[x][u] · work[y][u]
      for (let y = 0; y < scale; y++) {
        const line = (row * scale + y) * width + col * scale
        for (let x = 0; x < scale; x++) {
          let sum = 0
          for (let u = 0; u < scale; u++) sum += table[x * scale + u]! * work[y * scale + u]!
          out[line + x] = Math.round(sum + 128)
        }
      }
    }
  }
  return { data: out, width, height }
}

// ---- the picture --------------------------------------------------------------------------------------------------------

export interface DecodedJpeg extends Picture {
  /** The EXIF orientation (1..8), or 1 when the picture has none. */
  readonly orientation: number
}

/** The picture's size and the reduction that keeps it at least `minEdge` pixels on its longer side. */
export function jpegScaleFor(width: number, height: number, minEdge: number): 1 | 2 | 4 | 8 {
  const long = Math.max(width, height)
  for (const scale of [1, 2, 4] as const) if ((long * scale) / 8 >= minEdge) return scale
  return 8
}

const u16 = (data: Uint8Array, at: number): number => (data[at]! << 8) | data[at + 1]!

/**
 * Decodes a JPEG to RGB at `scale`/8 of its size (or at the reduction `minEdge` asks: the smallest that keeps the longer
 * side at least that many pixels). Throws CodecError for what it does not read.
 */
export function decodeJpeg(data: Uint8Array, options: { readonly minEdge?: number; readonly scale?: 1 | 2 | 4 | 8 } = {}): DecodedJpeg {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) throw new CodecError('Not a JPEG picture.')
  const quantTables: (Int32Array | undefined)[] = []
  const dcTables: (Huffman | undefined)[] = []
  const acTables: (Huffman | undefined)[] = []
  let frame: Frame | null = null
  let restartInterval = 0
  let adobe: number | null = null
  let jfif = false
  let orientation = 1
  let offset = 2

  while (offset < data.length) {
    if (data[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = data[offset + 1]!
    if (marker === 0xff) {
      offset += 1
      continue
    }
    offset += 2
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue
    if (marker === 0xd9) break
    if (offset + 2 > data.length) break
    const length = u16(data, offset)
    const start = offset + 2
    const segmentEnd = offset + length
    if (segmentEnd > data.length) throw new CodecError('A JPEG segment runs past the end of the file.')
    switch (marker) {
      case 0xe0:
        if (length >= 7 && String.fromCharCode(...data.subarray(start, start + 5)) === 'JFIF\0') jfif = true
        break
      case 0xe1:
        if (length >= 8 && String.fromCharCode(...data.subarray(start, start + 6)) === 'Exif\0\0') orientation = readExif(data.subarray(start + 6, segmentEnd)).orientation ?? 1
        break
      case 0xee:
        if (length >= 14 && String.fromCharCode(...data.subarray(start, start + 5)) === 'Adobe') adobe = data[start + 11]!
        break
      case 0xdb: {
        let at = start
        while (at < segmentEnd) {
          const pq = data[at]! >> 4
          const tq = data[at]! & 15
          at += 1
          const table = new Int32Array(64)
          for (let k = 0; k < 64; k++) {
            table[ZIGZAG[k]!] = pq === 0 ? data[at + k]! : u16(data, at + k * 2)
          }
          at += pq === 0 ? 64 : 128
          quantTables[tq] = table
        }
        break
      }
      case 0xc4: {
        let at = start
        while (at < segmentEnd) {
          const tc = data[at]! >> 4
          const th = data[at]! & 15
          const counts = data.subarray(at + 1, at + 17)
          const total = counts.reduce((sum, count) => sum + count, 0)
          const values = data.slice(at + 17, at + 17 + total)
          ;(tc === 0 ? dcTables : acTables)[th] = buildHuffman(counts, values)
          at += 17 + total
        }
        break
      }
      case 0xdd:
        restartInterval = u16(data, start)
        break
      case 0xc0:
      case 0xc1:
      case 0xc2: {
        if (frame) throw new CodecError('A JPEG with more than one frame is not read.')
        if (data[start] !== 8) throw new CodecError('Only 8-bit JPEG pictures are read.')
        const height = u16(data, start + 1)
        const width = u16(data, start + 3)
        const count = data[start + 5]!
        if (width === 0 || height === 0) throw new CodecError('The picture has no size (its height comes later in the file).')
        if (width * height > MAX_JPEG_PIXELS) throw new CodecError('The picture is too large to read here.')
        if (count !== 1 && count !== 3 && count !== 4) throw new CodecError('Only grey, colour and CMYK pictures are read.')
        const components: Component[] = []
        for (let index = 0; index < count; index++) {
          const at = start + 6 + index * 3
          const h = data[at + 1]! >> 4
          const v = data[at + 1]! & 15
          if (h < 1 || h > 4 || v < 1 || v > 4) throw new CodecError('A component has a sampling factor out of range.')
          components.push({ id: data[at]!, h, v, tq: data[at + 2]!, blocksPerLine: 0, blocksPerColumn: 0, paddedPerLine: 0, paddedPerColumn: 0, coefficients: new Int16Array(0), dc: null, ac: null, pred: 0 })
        }
        const maxH = Math.max(...components.map((component) => component.h))
        const maxV = Math.max(...components.map((component) => component.v))
        const mcusPerLine = Math.ceil(width / (8 * maxH))
        const mcusPerColumn = Math.ceil(height / (8 * maxV))
        for (const component of components) {
          component.blocksPerLine = Math.ceil(Math.ceil((width * component.h) / maxH) / 8)
          component.blocksPerColumn = Math.ceil(Math.ceil((height * component.v) / maxV) / 8)
          component.paddedPerLine = mcusPerLine * component.h
          component.paddedPerColumn = mcusPerColumn * component.v
          component.coefficients = new Int16Array(component.paddedPerLine * component.paddedPerColumn * 64)
        }
        frame = { progressive: marker === 0xc2, width, height, components, maxH, maxV, mcusPerLine, mcusPerColumn }
        break
      }
      case 0xda: {
        if (!frame) throw new CodecError('A JPEG scan comes before its frame.')
        const count = data[start]!
        const components: Component[] = []
        for (let index = 0; index < count; index++) {
          const at = start + 1 + index * 2
          const component = frame.components.find((entry) => entry.id === data[at])
          if (!component) throw new CodecError('A scan names a component the frame does not have.')
          const dc = dcTables[data[at + 1]! >> 4]
          const ac = acTables[data[at + 1]! & 15]
          component.dc = dc ?? null
          component.ac = ac ?? null
          components.push(component)
        }
        const at = start + 1 + count * 2
        const ss = data[at]!
        const se = data[at + 1]!
        const ah = data[at + 2]! >> 4
        const al = data[at + 2]! & 15
        const needsDc = !frame.progressive || (ss === 0 && ah === 0)
        const needsAc = !frame.progressive || ss > 0
        for (const component of components) {
          if ((needsDc && !component.dc) || (needsAc && !component.ac)) throw new CodecError('A scan uses a Huffman table that is not defined.')
        }
        offset = decodeScan(data, segmentEnd, frame, { components, ss, se, ah, al }, restartInterval)
        continue
      }
      case 0xc3:
      case 0xc5:
      case 0xc6:
      case 0xc7:
      case 0xc9:
      case 0xca:
      case 0xcb:
      case 0xcd:
      case 0xce:
      case 0xcf:
        throw new CodecError('Lossless, hierarchical and arithmetic-coded JPEG pictures are not read.')
      default:
        break
    }
    offset = segmentEnd
  }
  if (!frame) throw new CodecError('The JPEG has no frame.')

  const scale = options.scale ?? jpegScaleFor(frame.width, frame.height, options.minEdge ?? Math.max(frame.width, frame.height))
  const width = Math.ceil((frame.width * scale) / 8)
  const height = Math.ceil((frame.height * scale) / 8)
  const planes = frame.components.map((component) => {
    const quant = quantTables[component.tq]
    if (!quant) throw new CodecError('A component uses a quantisation table that is not defined.')
    return { component, ...componentPlane(component, quant, scale) }
  })
  const sampleOf = (plane: (typeof planes)[number], x: number, y: number): number => {
    const sx = Math.floor((x * plane.component.h) / frame.maxH)
    const sy = Math.floor((y * plane.component.v) / frame.maxV)
    return plane.data[sy * plane.width + sx]!
  }
  const rgb = new Uint8ClampedArray(width * height * 3)
  const count = planes.length
  const transform = adobe !== null ? adobe : count === 3 && !jfif && planes[0]!.component.id === 0x52 && planes[1]!.component.id === 0x47 && planes[2]!.component.id === 0x42 ? 0 : count === 3 ? 1 : count === 4 ? 0 : 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const out = (y * width + x) * 3
      if (count === 1) {
        const grey = sampleOf(planes[0]!, x, y)
        rgb[out] = grey
        rgb[out + 1] = grey
        rgb[out + 2] = grey
        continue
      }
      let a = sampleOf(planes[0]!, x, y)
      let b = sampleOf(planes[1]!, x, y)
      let c = sampleOf(planes[2]!, x, y)
      if ((count === 3 && transform !== 0) || (count === 4 && transform === 2)) {
        const yy = a
        const cb = b - 128
        const cr = c - 128
        a = yy + 1.402 * cr
        b = yy - 0.344136 * cb - 0.714136 * cr
        c = yy + 1.772 * cb
      }
      if (count === 4) {
        const k = sampleOf(planes[3]!, x, y)
        if (transform === 2) {
          // YCCK: the colour part decodes to 255 - the stored (Adobe-inverted) C, M, Y.
          a = 255 - Math.min(255, Math.max(0, a))
          b = 255 - Math.min(255, Math.max(0, b))
          c = 255 - Math.min(255, Math.max(0, c))
        }
        if (adobe !== null) {
          // Adobe stores CMYK inverted (255 = no ink).
          a = (a * k) / 255
          b = (b * k) / 255
          c = (c * k) / 255
        } else {
          a = ((255 - a) * (255 - k)) / 255
          b = ((255 - b) * (255 - k)) / 255
          c = ((255 - c) * (255 - k)) / 255
        }
      }
      rgb[out] = a
      rgb[out + 1] = b
      rgb[out + 2] = c
    }
  }
  return { width, height, channels: 3, data: rgb, orientation }
}
