// O.7 — Terminal-status downgrade guard for channel ingestion.
//
// Race scenario this prevents:
//   1. Operator clicks "Cancel" on /orders/:id
//      → orders.routes.ts /cancel writes Order.status='CANCELLED' locally
//      → kicks off channel-cancel pushback (env-gated, may be dryRun)
//   2. Pushback is in flight (Amazon Feeds queue, eBay
//      cancellation_request, Shopify orderCancel — all async at the
//      channel)
//   3. The next 15-min Amazon orders cron tick fires before the
//      channel processed the cancel
//      → SP-API GetOrders still returns OrderStatus='Unshipped' for
//        that AmazonOrderId
//      → amazon-orders.service maps that to PROCESSING
//      → without this guard: Order.status overwritten back to
//        PROCESSING, the operator's cancel is silently undone
//
// Same race exists for eBay (ebay-orders.service polls
// /sell/fulfillment/v1/order, sees pre-cancel status) and Shopify
// (orders/updated webhook can arrive after a local cancel because
// Shopify's webhook delivery isn't ordered with respect to the
// orderCancel mutation we just sent).
//
// The fix is conservative: when the local row is in a terminal
// state and the channel reports a non-terminal state, KEEP the
// local terminal status — the channel will catch up. Two-terminal
// transitions (e.g. CANCELLED→REFUNDED, DELIVERED→RETURNED) are
// allowed because those are legitimate channel-side state
// transitions, not stale-poll regressions.

const TERMINAL_ORDER_STATUSES = new Set([
  'CANCELLED',
  'REFUNDED',
  'RETURNED',
  'DELIVERED',
])

/**
 * Returns true when the channel-reported status would regress the
 * local row from a terminal state to a non-terminal one — i.e. when
 * the caller should preserve the existing status (and the matching
 * lifecycle timestamps: shippedAt / cancelledAt / deliveredAt) and
 * only refresh metadata.
 *
 * Returns false when:
 *   • there's no existing row (first-ever ingest of this order), or
 *   • the existing row is non-terminal (any update is fine), or
 *   • the new status is also terminal (legitimate channel-side
 *     transition, e.g. CANCELLED → REFUNDED).
 */
export function shouldPreserveTerminalStatus(
  existingStatus: string | null | undefined,
  newStatus: string,
): boolean {
  if (!existingStatus) return false
  if (!TERMINAL_ORDER_STATUSES.has(existingStatus)) return false
  if (TERMINAL_ORDER_STATUSES.has(newStatus)) return false
  return true
}

export const __test = { TERMINAL_ORDER_STATUSES }
