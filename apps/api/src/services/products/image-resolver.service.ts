/**
 * F5 — derive a SKU + image-slot from a photographer's filename.
 *
 * Real-world inputs (Xavia photo dump, Spring 2026):
 *   XV-G-RACE-PRO-BLK-M.jpg                → SKU: XV-G-RACE-PRO-BLK-M
 *   XV-G-RACE-PRO-BLK-M-1.jpg              → SKU + position 1 (MAIN)
 *   XV-G-RACE-PRO-BLK-M-2.jpg              → SKU + position 2 (ALT)
 *   XV-G-RACE-PRO-BLK-M-MAIN.jpg           → SKU + type=MAIN
 *   XV-G-RACE-PRO-BLK-M-LIFESTYLE-1.jpg    → SKU + type=LIFESTYLE + pos 1
 *   IMG_1234.jpg                           → no match → `ok:false`
 *
 * Algorithm: peel up to two trailing `-<token>` segments and check the
 * remaining stem against the known-SKU set. A token can be:
 *   - a positive integer            → image position
 *   - one of TYPE_TOKENS (case-insensitive) → image slot
 *   - anything else                 → not a recognised suffix; the
 *                                     stem is tried as-is and we don't
 *                                     peel further.
 *
 * Type → ProductImage.type mapping:
 *   MAIN | HERO              → MAIN
 *   LIFESTYLE | LIFE | SCENE → LIFESTYLE
 *   anything else            → ALT  (BACK, SIDE, DETAIL, ALT, …)
 *
 * No type marker, no position → defaults to ALT. Position 1 with no
 * marker → MAIN, since the convention "*-1" is the hero shot.
 *
 * Resolution returns `null` when the filename can't be matched. The
 * caller surfaces this in the UI so the user sees which photos got
 * skipped (typo? wrong product? rename and retry).
 */

const TYPE_TOKENS = new Set([
  'MAIN',
  'HERO',
  'ALT',
  'BACK',
  'SIDE',
  'FRONT',
  'DETAIL',
  'CLOSE',
  'CLOSEUP',
  'LIFESTYLE',
  'LIFE',
  'SCENE',
])

export type ImageSlot = 'MAIN' | 'ALT' | 'LIFESTYLE'

export interface ImageFilenameResolution {
  sku: string
  type: ImageSlot
  /**
   * 1-indexed position within the product when present. Used as a
   * sort hint by the UI; the DB doesn't enforce ordering since
   * ProductImage has no `position` column today.
   */
  position: number | null
  /** Original filename stem with extension stripped, for the UI label. */
  stem: string
}

interface PeeledToken {
  type?: ImageSlot
  position?: number
}

function stemOf(filename: string): string {
  const i = filename.lastIndexOf('.')
  return i > 0 ? filename.substring(0, i) : filename
}

function classifyTypeToken(token: string): ImageSlot {
  const upper = token.toUpperCase()
  if (upper === 'MAIN' || upper === 'HERO') return 'MAIN'
  if (upper === 'LIFESTYLE' || upper === 'LIFE' || upper === 'SCENE') {
    return 'LIFESTYLE'
  }
  return 'ALT'
}

function peelToken(stem: string): { remaining: string; token: PeeledToken } | null {
  const dash = stem.lastIndexOf('-')
  if (dash <= 0) return null
  const suffix = stem.substring(dash + 1)
  if (suffix.length === 0) return null
  if (/^\d+$/.test(suffix)) {
    return {
      remaining: stem.substring(0, dash),
      token: { position: parseInt(suffix, 10) },
    }
  }
  if (TYPE_TOKENS.has(suffix.toUpperCase())) {
    return {
      remaining: stem.substring(0, dash),
      token: { type: classifyTypeToken(suffix) },
    }
  }
  return null
}

/**
 * Resolve a filename against the known-SKU set. Returns the matched
 * SKU + slot, or `null` if no peeling produced a known SKU.
 */
export function resolveImageFilename(
  filename: string,
  knownSkus: Set<string>,
): ImageFilenameResolution | null {
  const stem = stemOf(filename)
  if (knownSkus.has(stem)) {
    return { sku: stem, type: 'ALT', position: null, stem }
  }
  // Peel one suffix.
  const first = peelToken(stem)
  if (!first) return null
  if (knownSkus.has(first.remaining)) {
    return resolveWithTokens(first.remaining, [first.token], stem)
  }
  // Peel a second suffix (e.g. SKU-MAIN-2 or SKU-2-MAIN).
  const second = peelToken(first.remaining)
  if (!second) return null
  if (knownSkus.has(second.remaining)) {
    return resolveWithTokens(second.remaining, [second.token, first.token], stem)
  }
  return null
}

function resolveWithTokens(
  sku: string,
  tokens: PeeledToken[],
  stem: string,
): ImageFilenameResolution {
  let type: ImageSlot | undefined
  let position: number | null = null
  for (const t of tokens) {
    if (t.type) type = t.type
    if (t.position != null) position = t.position
  }
  if (!type) {
    // No explicit type → infer from position. Position 1 is the hero
    // shot by long-standing convention; everything else is ALT.
    type = position === 1 ? 'MAIN' : 'ALT'
  }
  return { sku, type, position, stem }
}

/**
 * Resolve a batch of filenames. Convenience wrapper used by the
 * /api/products/images/resolve endpoint — pre-fetches SKUs once and
 * maps every filename through the resolver. Returns parallel arrays
 * so the caller can render `filenames[i] → resolutions[i]`.
 */
export function resolveImageBatch(
  filenames: string[],
  knownSkus: Set<string>,
): Array<{ filename: string; resolution: ImageFilenameResolution | null }> {
  return filenames.map((filename) => ({
    filename,
    resolution: resolveImageFilename(filename, knownSkus),
  }))
}
