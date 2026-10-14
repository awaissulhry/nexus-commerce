/**
 * Garment size order (2026-10-15) — the order sizes are shown in where the family sets none (a free-text size axis has
 * no dictionary order and no saved order, so its values arrive in first-seen order: A–Z by SKU). The letter scale from
 * the smallest (… XXS, XS, S, M, L, XL, XXL = 2XL, 3XL = XXXL, 4XL …), then numeric sizes ascending (44, 46 … 60), then
 * every other value in the order it was first seen. PURE. Used by the sheet's garment measurements editor and the
 * Shopify colour products panel; an order the family sets always wins over it.
 */

/** The letter scale, smallest first; the names on one step are the same size. */
const LETTER_SIZES: ReadonlyArray<readonly string[]> = [
  ['5XS', 'XXXXXS'], ['4XS', 'XXXXS'], ['3XS', 'XXXS'], ['2XS', 'XXS'], ['XS'], ['S'], ['M'], ['L'], ['XL'],
  ['2XL', 'XXL'], ['3XL', 'XXXL'], ['4XL', 'XXXXL'], ['5XL', 'XXXXXL'], ['6XL'], ['7XL'], ['8XL'],
]
const LETTER_RANK = new Map(LETTER_SIZES.flatMap((names, rank) => names.map((name) => [name, rank] as const)))
const NUMBER = /^\d+(?:[.,]\d+)?$/

/** A size's place on the garment scale (letters first, then numbers), or `null`: not a size the scale knows. */
export function garmentSizeRank(value: string): number | null {
  const text = value.trim().toUpperCase().replace(/\s+/g, '')
  const letter = LETTER_RANK.get(text)
  if (letter !== undefined) return letter
  return NUMBER.test(text) ? LETTER_SIZES.length + Number(text.replace(',', '.')) : null
}

/**
 * Two sizes — or two lists of option values ("M / Long"), compared position by position. Known sizes come first, in
 * scale order; two values the scale does not know compare equal, so a stable sort keeps them in first-seen order.
 */
export function compareGarmentSizes(a: string | readonly string[], b: string | readonly string[]): number {
  const left = typeof a === 'string' ? [a] : a, right = typeof b === 'string' ? [b] : b
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i] ?? '', y = right[i] ?? ''
    if (x === y) continue
    const rx = garmentSizeRank(x), ry = garmentSizeRank(y)
    if (rx === null && ry === null) return 0
    if (rx === null) return 1
    if (ry === null) return -1
    if (rx !== ry) return rx - ry
  }
  return 0
}

/** The items in garment size order, as a new array; `key` reads an item's size (or its option values). */
export function sortGarmentSizes<T>(items: readonly T[], key: (item: T) => string | readonly string[]): T[] {
  return [...items].sort((a, b) => compareGarmentSizes(key(a), key(b)))
}
