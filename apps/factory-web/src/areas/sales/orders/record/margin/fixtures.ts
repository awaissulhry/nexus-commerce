import { asSeenBy, DETAIL_1043, ROLES } from '../../../../finance/margins/demo/fixtures'
import type { OrderMargin } from '../../../../finance/margins/api'
import { marginsCanOf } from '../../../../finance/margins/model'
import type { MarginTabModel } from './model'

/**
 * Made-up margin for the design cases of the sales order's Margin tab (SCR-039, B-W2a-72): the same invented order as
 * Finance › Margins (SO-2026-1043: quoted 43.0 %, now 40.2 %). Design-only (no designScreen: the cases sit in SCR-039's
 * fixtures).
 */

export const MARGIN = { value: DETAIL_1043, problem: null }

const AS = { finance: ROLES.finance, sales: ROLES.sales, manager: ['home.view', 'orders.view', 'costing.view', 'workorders.view'] } as const

/** The tab as a person with these permissions reads it (each figure dropped without its grain, as the API drops it). */
export function marginAs(role: keyof typeof AS, part: { value: OrderMargin | null; problem: string | null } | null): MarginTabModel {
  const can = marginsCanOf(AS[role])
  return { can, part: part && part.value ? { ...part, value: asSeenBy(part.value, can) } : part }
}
