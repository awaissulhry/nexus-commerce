/**
 * Incident #39 — ONE deterministic value-order authority for eBay variations.
 *
 * The owner's rule: variation value order must never drift — a no-change push
 * emits byte-identical order every time, and every consumer (Inventory group
 * push, Trading creation, the family-axes resolver that powers the images
 * drawer and pre-publish review) agrees on the SAME order.
 *
 * Precedence:
 *   1. The operator's stored order (the value-order modal's _axisSortOrder) —
 *      always wins, verbatim.
 *   2. Size-dimension axes: canonical garment ranking (XXS → 5XL, numerics in
 *      numeric order) — buyers see sizes in wearing order, not alphabetical.
 *   3. Everything else: locale-stable alphabetical (deterministic regardless
 *      of row/DB iteration order).
 * Unknown values sort after known ones, alphabetically, so a novel size never
 * scrambles the rest.
 */

import { axisSynonymKey } from './ebay-theme-axes.js'

const SIZE_RANK: Record<string, number> = {
  '4XS': -4, '3XS': -3, 'XXXS': -3, '2XS': -2, 'XXS': -2, 'XS': -1,
  S: 0, M: 1, L: 2, XL: 3, XXL: 4, '2XL': 4, XXXL: 5, '3XL': 5,
  '4XL': 6, '5XL': 7, '6XL': 8, '7XL': 9, '8XL': 10,
}

/** The synonym-dimension key for the size axis (taglia/size/…). */
const SIZE_DIM = axisSynonymKey('taglia')

function sizeRank(value: string): number | null {
  const v = value.trim().toUpperCase()
  if (v in SIZE_RANK) return SIZE_RANK[v]
  // Numeric sizes (46, 48, 50…) rank numerically after the letter scale.
  const num = Number(v.replace(',', '.'))
  if (Number.isFinite(num) && v !== '') return 100 + num
  return null
}

/**
 * Order an axis's values deterministically.
 * @param axisName    the axis (any spelling — synonym-resolved internally)
 * @param values      the values to order (deduped by trimmed identity)
 * @param storedOrder the operator's saved order for this axis, if any
 */
export function orderAxisValues(axisName: string, values: string[], storedOrder?: string[]): string[] {
  const seen = new Set<string>()
  const uniq: string[] = []
  for (const v of values) {
    const t = String(v ?? '').trim()
    if (!t || seen.has(t.toLowerCase())) continue
    seen.add(t.toLowerCase())
    uniq.push(t)
  }

  if (storedOrder?.length) {
    const rank = new Map(storedOrder.map((v, i) => [String(v).trim().toLowerCase(), i]))
    return [...uniq].sort((a, b) => {
      const ra = rank.get(a.toLowerCase())
      const rb = rank.get(b.toLowerCase())
      if (ra != null && rb != null) return ra - rb
      if (ra != null) return -1
      if (rb != null) return 1
      return a.localeCompare(b, 'it')
    })
  }

  if (axisSynonymKey(axisName) === SIZE_DIM) {
    return [...uniq].sort((a, b) => {
      const ra = sizeRank(a)
      const rb = sizeRank(b)
      if (ra != null && rb != null) return ra - rb
      if (ra != null) return -1
      if (rb != null) return 1
      return a.localeCompare(b, 'it')
    })
  }

  return [...uniq].sort((a, b) => a.localeCompare(b, 'it'))
}
