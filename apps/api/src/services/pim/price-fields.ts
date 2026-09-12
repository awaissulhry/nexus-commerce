/**
 * price-fields.ts — WHICH cells may carry a formula. Owner, 2026-09-05, on sheet-chrome row 20:
 * "I might feel the need, or at least it would be nice to have the ability to price by percentage of
 * master because the fees vary channel by channel." So a formula is a PRICING tool — a channel price
 * as `$basePrice * 1.08` — and every other attribute lost formulas with the presets menu.
 *
 * A LEAF: imports nothing, so the sheet's `formulaWritable` (studio-sheet.service) and the formula
 * writer's gate (cell-formula.service `setCellFormula`) ask the SAME question of the SAME key —
 * producer and consumer in one place. Keyed on the sheet KEY, with or without the `attr_` prefix,
 * because the writer receives the routed name and the sheet the column key, and both must agree.
 *
 * Group is NOT consulted on purpose: Amazon's "Offer" group holds `supplemental_condition_information`
 * and its kin, which are not prices (measured on Amazon·IT, 2026-09-05).
 */
const PRICE_ROOT = /^purchasable_offer(?:\[\d+\])?$/
const PRICE_WORD = /(^|[._\-\[])prices?([._\-\[]|$)/
const PRICE_KEYS = new Set(['purchasable_offer', 'baseprice', 'costprice', 'saleprice', 'compareatprice', 'msrp', 'rrp'])

export function isPriceFieldKey(rawKey: string | null | undefined): boolean {
  if (!rawKey) return false
  const key = String(rawKey).replace(/^attr_/, '').trim().toLowerCase()
  if (!key) return false
  if (PRICE_KEYS.has(key)) return true
  const leaf = key.split(/__|\./).at(-1)!.replace(/\[\d+\]$/, '')
  if (/price$/.test(leaf)) return true
  if (['value', 'value_with_tax', 'value_without_tax', 'amount'].includes(leaf) && PRICE_WORD.test(key)) return true
  return PRICE_ROOT.test(key)
}
