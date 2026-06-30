/**
 * Phase 3 — decide what to do with an active OPEN_ORDER reservation whose
 * order has moved on. Conservative: only auto-act on unambiguous cases.
 *
 *   CANCELLED            -> release  (never shipped; free the hold)
 *   SHIPPED | DELIVERED  -> consume  (unit left; decrement quantity)
 *   REFUNDED | RETURNED  -> alert    (ambiguous; surface, don't auto-act)
 *   non-terminal & stale -> alert    (legitimately may still await fulfillment)
 *   otherwise            -> skip     (fresh, active — hold is correct)
 */
export type ReconcileAction = 'release' | 'consume' | 'alert' | 'skip'

const NON_TERMINAL = new Set([
  'PENDING',
  'PROCESSING',
  'PARTIALLY_SHIPPED',
  'ON_HOLD',
  'AWAITING_PAYMENT',
])

export function classifyOpenOrderReconciliation(
  orderStatus: string,
  ageMs: number,
  staleMs: number,
): ReconcileAction {
  if (orderStatus === 'CANCELLED') return 'release'
  if (orderStatus === 'SHIPPED' || orderStatus === 'DELIVERED') return 'consume'
  if (orderStatus === 'REFUNDED' || orderStatus === 'RETURNED') return 'alert'
  if (NON_TERMINAL.has(orderStatus)) return ageMs > staleMs ? 'alert' : 'skip'
  return 'skip'
}
