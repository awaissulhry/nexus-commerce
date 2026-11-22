import { parseDecimal } from '../../tax/decimal'

/**
 * B-OM-021 (order money tab; lead L2, L4; design order-money-2026-11-22 13-backend §5): an order's margin set by hand, pure.
 *
 *   hand cost lines  ADDED only: a cost the ledger does not know (a freight estimate before the carrier's charge, a commission,
 *                    bank charges, another), each above 0 in the order's currency with a reason; counted in the margin now and
 *                    so far, beside the computed cost ("computed … · with hand lines …"); removed with a reason, never edited or
 *                    deleted (factory-db OrderCostLine, its guard). Replacing a computed part and a rate for one order are LATER.
 *   the target       the order's own margin target in percent of its value (SalesOrder.targetMarginPct, the margin grain): the
 *                    flag is judged on it, else on the floor of the Sales settings (apps/factory-api costing/margins/floor.ts).
 *
 * A margin is never typed: it stays derived from the value and the costs.
 */

export interface Words {
  readonly en: string
  readonly it: string
}

export const ORDER_COST_LINE_KINDS = ['FREIGHT_ESTIMATE', 'COMMISSION', 'BANK_CHARGES', 'OTHER'] as const
export type OrderCostLineKind = (typeof ORDER_COST_LINE_KINDS)[number]

/** The audit actions (13-backend §8). */
export const ORDER_COST_LINE_ACTION = 'costing.orderCostLine'
export const ORDER_COST_LINE_REMOVED_ACTION = 'costing.orderCostLineRemoved'
export const MARGIN_TARGET_ACTION = 'orders.marginTarget'

export const HAND_MARGIN_REFUSALS = ['CLOSED', 'REMOVED_ALREADY', 'TARGET_RANGE'] as const
export type HandMarginRefusal = (typeof HAND_MARGIN_REFUSALS)[number]

/** The refusals in words (409 `handMargin/<CODE>`, TARGET_RANGE 400; Italian "tu"). */
export const HAND_MARGIN_WORDS: Readonly<Record<HandMarginRefusal, Words>> = Object.freeze({
  CLOSED: { en: 'A closed or cancelled order keeps its costs and its target as they were.', it: "Un ordine chiuso o annullato tiene costi e obiettivo com'erano." },
  REMOVED_ALREADY: { en: 'This cost line is removed already.', it: 'Questa riga di costo è già stata tolta.' },
  TARGET_RANGE: { en: 'A target margin is a percent above 0 and below 100, with at most 4 decimals.', it: 'Un margine obiettivo è una percentuale sopra 0 e sotto 100, con al massimo 4 decimali.' },
})

/** The sum of the lines still counted (not removed), in minor units. */
export function handCostOf(lines: readonly { readonly amount: number; readonly removedAt: Date | string | null }[]): number {
  return lines.reduce((sum, line) => (line.removedAt === null ? sum + line.amount : sum), 0)
}

/** A target as typed ("38", "38.5"): its canonical text, or null when it is not a percent above 0 and below 100 (≤ 4 decimals). */
export function targetPctOf(text: string): string | null {
  const value = parseDecimal(text.trim())
  if (value === null || value.lte(0) || value.gte(100) || value.decimalPlaces() > 4) return null
  return value.toFixed()
}
