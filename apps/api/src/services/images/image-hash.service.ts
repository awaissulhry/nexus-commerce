/**
 * IE.1 — Hashing helpers for the product-image upload dedup gate.
 *
 * sha256Buffer(): SHA-256 hex of the raw buffer. Used to detect
 *   exact re-uploads on the same product. Computed before the
 *   Cloudinary round-trip so a hit costs zero network IO.
 *
 * hammingHex(): bit-distance between two equal-length hex strings.
 *   Applied to Cloudinary's pHash output (16 hex chars = 64 bits)
 *   to find near-duplicates — same image saved at different quality
 *   or with a small crop. ≤ 6 is the working threshold below.
 */

import { createHash } from 'crypto'

export function sha256Buffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
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
