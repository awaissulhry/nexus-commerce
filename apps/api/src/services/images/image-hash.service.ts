/**
 * IE.1 + IE.2 — Hashing helpers for the product-image upload dedup
 * gate and the legacy-row backfill.
 *
 * sha256Buffer(): SHA-256 hex of the raw buffer. Used to detect
 *   exact re-uploads on the same product. Computed before the
 *   Cloudinary round-trip so a hit costs zero network IO.
 *
 * aHashBuffer(): 64-bit average-hash via sharp, encoded as 16 hex
 *   chars. Resize to 8×8 grayscale, threshold each pixel against the
 *   mean, pack bits in row-major order. Detects near-duplicates that
 *   SHA-256 misses (same image at different resolution / quality).
 *   Industry-standard pHash variant; cheap (~5 ms per image) and
 *   deterministic. Runs locally so it works uniformly on Cloudinary
 *   uploads and Amazon-synced URLs that have no Cloudinary asset.
 *
 * hammingHex(): bit-distance between two equal-length hex strings.
 *   Applied to aHash outputs to find near-duplicates — same image
 *   saved at different quality or resolution. ≤ 6 is the working
 *   threshold below.
 */

import { createHash } from 'crypto'
import sharp from 'sharp'

export function sha256Buffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

/**
 * Compute an average-hash perceptual fingerprint of `buf`.
 *
 * Returns 16 lowercase hex chars (64 bits, row-major MSB-first).
 * Two images with Hamming distance ≤ NEAR_DUP_HAMMING_THRESHOLD
 * after this hash are visually near-identical — typically the
 * same shot at different resolutions or JPEG quality.
 *
 * Throws if `buf` is not a decodable raster image; callers handle
 * the error and skip pHash for that row (contentHash still records).
 */
export async function aHashBuffer(buf: Buffer): Promise<string> {
  // 8×8 grayscale = 64 single-byte pixels. fit: 'fill' guarantees
  // the exact target dimensions regardless of source aspect — pHash
  // is shape-independent, only intensity distribution matters.
  const pixels = await sharp(buf)
    .resize(8, 8, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer()
  if (pixels.length !== 64) {
    throw new Error(`aHash: expected 64 pixels, got ${pixels.length}`)
  }
  let sum = 0
  for (let i = 0; i < 64; i++) sum += pixels[i]
  const mean = sum / 64
  // Pack 64 bits MSB-first into 16 nibbles. Bit i = pixel[i] > mean.
  // MSB-first so the hex string reads left-to-right in the same
  // order as the pixel scan, which makes debug dumps tractable.
  let hex = ''
  for (let nibble = 0; nibble < 16; nibble++) {
    let v = 0
    for (let bit = 0; bit < 4; bit++) {
      const pi = nibble * 4 + bit
      if (pixels[pi] > mean) v |= 1 << (3 - bit)
    }
    hex += v.toString(16)
  }
  return hex
}

export function hammingHex(a: string, b: string): number {
  if (a.length !== b.length) {
    // Length mismatch = different hash families. Surface as "very
    // far" rather than throwing — the dedup check is best-effort.
    return Math.max(a.length, b.length) * 4
  }
  let distance = 0
  for (let i = 0; i < a.length; i++) {
    const xa = parseInt(a[i], 16)
    const xb = parseInt(b[i], 16)
    if (Number.isNaN(xa) || Number.isNaN(xb)) return a.length * 4
    let xor = xa ^ xb
    while (xor) {
      distance += xor & 1
      xor >>>= 1
    }
  }
  return distance
}

/**
 * Empirical threshold for "same image, slightly different file".
 *   0      → byte-identical (would have been caught by SHA-256)
 *   1–4    → re-saved at different JPEG quality, near-identical
 *   5–6    → minor crop / scale / colour-correction
 *   7–10   → similar subject, different shot
 *   > 10   → unrelated
 * 6 catches the "same photographer re-export" case operators hit
 * without flagging two different colour-variant shots.
 */
export const NEAR_DUP_HAMMING_THRESHOLD = 6
