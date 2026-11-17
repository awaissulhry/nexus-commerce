/**
 * The pixels the small-preview codecs pass around (B-TH-063): 8 bits per sample, rows top to bottom, RGB or RGBA.
 */
export interface Picture {
  readonly width: number
  readonly height: number
  readonly channels: 3 | 4
  readonly data: Uint8ClampedArray
}

/** A picture this codec does not read (an unusual kind of file, or a damaged one): the caller keeps the copy as it is. */
export class CodecError extends Error {
  override name = 'CodecError'
}

/**
 * The picture turned as its EXIF orientation says (1..8: 2 mirrored, 3 upside down, 4 flipped, 5 mirrored and turned, 6
 * turned right, 7 mirrored and turned, 8 turned left), so a copy without EXIF shows the right way up.
 */
export function orient(picture: Picture, orientation: number): Picture {
  if (orientation < 2 || orientation > 8) return picture
  const { width: w, height: h, channels, data } = picture
  const swap = orientation >= 5
  const width = swap ? h : w
  const height = swap ? w : h
  const out = new Uint8ClampedArray(width * height * channels)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sx: number
      let sy: number
      switch (orientation) {
        case 2: sx = w - 1 - x; sy = y; break
        case 3: sx = w - 1 - x; sy = h - 1 - y; break
        case 4: sx = x; sy = h - 1 - y; break
        case 5: sx = y; sy = x; break
        case 6: sx = y; sy = h - 1 - x; break
        case 7: sx = w - 1 - y; sy = h - 1 - x; break
        default: sx = w - 1 - y; sy = x; break
      }
      const from = (sy * w + sx) * channels
      const to = (y * width + x) * channels
      for (let c = 0; c < channels; c++) out[to + c] = data[from + c]!
    }
  }
  return { width, height, channels, data: out }
}

/** The weights of the source pixels that cover each target pixel, when `from` pixels shrink to `to` (area average). */
function coverage(from: number, to: number): { readonly start: Int32Array; readonly weights: Float32Array[] } {
  const ratio = from / to
  const start = new Int32Array(to)
  const weights: Float32Array[] = []
  for (let index = 0; index < to; index++) {
    const left = index * ratio
    const right = Math.min(from, (index + 1) * ratio)
    const first = Math.floor(left)
    const last = Math.min(from - 1, Math.ceil(right) - 1)
    const row = new Float32Array(last - first + 1)
    for (let source = first; source <= last; source++) row[source - first] = (Math.min(right, source + 1) - Math.max(left, source)) / (right - left)
    start[index] = first
    weights.push(row)
  }
  return { start, weights }
}

/**
 * The picture shrunk so its longer side is at most `edge` pixels (never enlarged), each target pixel the area average of
 * the source pixels it covers (no ringing, no lost thin lines). The aspect ratio is kept; each side at least 1 pixel.
 */
export function shrink(picture: Picture, edge: number): Picture {
  const { width, height, channels, data } = picture
  const long = Math.max(width, height)
  if (long <= edge) return picture
  const targetWidth = Math.max(1, Math.round((width * edge) / long))
  const targetHeight = Math.max(1, Math.round((height * edge) / long))
  // With transparency, the colours are weighed by their alpha (premultiplied), so a clear pixel lends no colour.
  const source = Float32Array.from(data)
  if (channels === 4) {
    for (let at = 0; at < source.length; at += 4) {
      const alpha = source[at + 3]! / 255
      source[at] = source[at]! * alpha
      source[at + 1] = source[at + 1]! * alpha
      source[at + 2] = source[at + 2]! * alpha
    }
  }
  // Rows first (width → targetWidth), then columns.
  const across = coverage(width, targetWidth)
  const wide = new Float32Array(targetWidth * height * channels)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < targetWidth; x++) {
      const first = across.start[x]!
      const weights = across.weights[x]!
      for (let c = 0; c < channels; c++) {
        let sum = 0
        for (let k = 0; k < weights.length; k++) sum += weights[k]! * source[(y * width + first + k) * channels + c]!
        wide[(y * targetWidth + x) * channels + c] = sum
      }
    }
  }
  const down = coverage(height, targetHeight)
  const out = new Uint8ClampedArray(targetWidth * targetHeight * channels)
  for (let y = 0; y < targetHeight; y++) {
    const first = down.start[y]!
    const weights = down.weights[y]!
    for (let x = 0; x < targetWidth; x++) {
      const at = (y * targetWidth + x) * channels
      const sums = [0, 0, 0, 0]
      for (let c = 0; c < channels; c++) {
        let sum = 0
        for (let k = 0; k < weights.length; k++) sum += weights[k]! * wide[((first + k) * targetWidth + x) * channels + c]!
        sums[c] = sum
      }
      const alpha = channels === 4 ? sums[3]! / 255 : 1
      for (let c = 0; c < channels; c++) out[at + c] = c < 3 && channels === 4 ? (alpha > 0 ? sums[c]! / alpha : 0) : sums[c]!
    }
  }
  return { width: targetWidth, height: targetHeight, channels, data: out }
}
