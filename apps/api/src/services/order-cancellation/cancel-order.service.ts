/**
 * MCP full control 07 O10 — an operator's order cancel (O.48 / O.50), moved out of routes/orders.routes.ts so the
 * Orders page and Claude's `cancel-order` cancel one way. The code is the route's own (its route tests,
 * routes/orders-cancel.vitest.test.ts, pass before and after the move), plus two refusals: a RETURNED or REFUNDED
 * order, and an order Amazon ships (FBA, MCF; fail closed).
 *
 * In order: the order is read; refused when cancelled already, too far (shipped, partly shipped, delivered, returned,
 * refunded), Amazon-fulfilled, or an Amazon market with no known id; then a compare-and-swap on its status (a channel
 * sync or a second cancel in between wins, and nothing runs); the cascade (void parcels, restore stock); and the
 * channel's own cancel — a dry run unless NEXUS_ENABLE_{AMAZON,EBAY,SHOPIFY}_ORDER_CANCEL is on. A channel cancel
 * refunds the buyer. It runs in the caller's business.
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { resolveConnection } from '../connection-resolver.service.js'
import { amazonFulfilledRefusal } from '../fulfillment/amazon-fulfilled-order.js'
import { AnswerReply, answered, type RouteAnswer, type RouteLog } from '../../lib/route-answer.js'

/** Whether each channel's cancel is live or a dry run, from the switches channel-cancel.ts reads. */
export function channelCancelMode(channel: string): string {
  const live = (name: string) => process.env[name] === 'true'
  if (channel === 'AMAZON') return live('NEXUS_ENABLE_AMAZON_ORDER_CANCEL') ? 'live: Amazon cancels it and refunds the buyer' : 'dry run: Amazon is not told (NEXUS_ENABLE_AMAZON_ORDER_CANCEL off)'
  if (channel === 'EBAY') return live('NEXUS_ENABLE_EBAY_ORDER_CANCEL') ? 'live: eBay cancels it and refunds the buyer' : 'dry run: eBay is not told (NEXUS_ENABLE_EBAY_ORDER_CANCEL off)'
  if (channel === 'SHOPIFY') return live('NEXUS_ENABLE_SHOPIFY_ORDER_CANCEL') ? 'live: Shopify cancels it and refunds the buyer' : 'dry run: Shopify is not told (NEXUS_ENABLE_SHOPIFY_ORDER_CANCEL off)'
  return `Nexus only: ${channel} orders have no channel cancel`
}

/** POST /api/orders/:id/cancel — the answer the route gives. */
export async function cancelOrder(id: string, reasonText: string | undefined, log: RouteLog): Promise<RouteAnswer> {
  const reply = new AnswerReply()
  const reason = reasonText?.trim() || 'Cancelled by operator'
  return answered(await (async () => {

  const existing = await prisma.order.findUnique({
    where: { id },
    select: { id: true, status: true, channel: true, channelOrderId: true, marketplace: true, fulfillmentMethod: true },
  })
  if (!existing) return reply.status(404).send({ error: 'Order not found' })
  if (existing.status === 'CANCELLED') {
    return reply.status(400).send({
      error: 'Order is already cancelled.',
      code: 'ALREADY_CANCELLED',
    })
  }
  // 07 O1 — PARTIALLY_SHIPPED too: part of the order has already left the shelf.
  if (['SHIPPED', 'DELIVERED', 'PARTIALLY_SHIPPED'].includes(existing.status as string)) {
    return reply.status(400).send({
      error: `Cannot cancel a ${existing.status} order. File a return instead.`,
      code: 'ORDER_TOO_FAR',
    })
  }
  // 07 O10 — a RETURNED or REFUNDED order is past selling: cancelling it would restore stock a second time and tell
  // the channel to cancel a sale it already closed.
  if (['RETURNED', 'REFUNDED'].includes(existing.status as string)) {
    return reply.status(400).send({
      error: `Cannot cancel a ${existing.status} order: it is already past the sale.`,
      code: 'ORDER_TOO_FAR',
    })
  }
  // 07 O10 — an order Amazon ships (FBA, or a live Multi-Channel Fulfilment request; fail closed) is Amazon's to
  // cancel: Nexus would restore stock Amazon holds and call a cancel Amazon does not take for it.
  const amazonShips = await amazonFulfilledRefusal(prisma, existing)
  if (amazonShips) {
    return reply.status(400).send({
      error: 'Amazon ships this order (FBA or Multi-Channel Fulfilment): cancel it in Seller Central or on its MCF request. Nothing was cancelled.',
      code: amazonShips.code,
    })
  }

  // 07 O1 — the Amazon marketplace id comes from the order's own market. The old six-market map sent every
  // other market (NL, BE, SE, PL, IE, …) with the Italian id. A market with no known id is refused here,
  // before anything changes, rather than told to Amazon under another market.
  let amazonMarketplaceId: string | null = null
  if (existing.channel === 'AMAZON' && existing.channelOrderId) {
    const { amazonMarketplaceIdFor } = await import('../reviews/amazon-solicitations.service.js')
    amazonMarketplaceId = amazonMarketplaceIdFor(existing.marketplace)
    if (!amazonMarketplaceId) {
      return reply.status(400).send({
        error: `Nexus does not know the Amazon marketplace id of market "${existing.marketplace ?? 'none'}". Nothing was cancelled: cancel this order in Seller Central.`,
        code: 'UNKNOWN_AMAZON_MARKETPLACE',
      })
    }
  }

  // 07 O1 — compare-and-swap: the order is cancelled only if it still has the status read above. A channel
  // sync (or a second cancel) that moved it in between wins, and nothing here runs.
  const swapped = await prisma.order.updateMany({
    where: { id, status: existing.status },
    data: { status: 'CANCELLED', cancelledAt: new Date() },
  })
  if (swapped.count !== 1) {
    return reply.status(409).send({
      error: 'The order changed while it was being cancelled (a channel update or another cancel). Nothing was cancelled: reload it and try again.',
      code: 'ORDER_CHANGED',
    })
  }
  const updated = await prisma.order.findUnique({ where: { id } })

  // Cascade: void shipments + restore stock + audit + SSE.
  const { handleOrderCancelled } = await import(
    '../order-cancellation/index.js'
  )
  const cleanup = await handleOrderCancelled(id)

  // O.50: channel-side pushback — tell the marketplace we
  // cancelled. dryRun-default per channel; real path gated by
  // NEXUS_ENABLE_*_ORDER_CANCEL flags. Best-effort: a channel
  // failure doesn't roll back the local cancellation (operator
  // already chose to cancel; we just couldn't notify upstream
  // automatically).
  let channelAck: import('../order-cancellation/channel-cancel.js').ChannelCancelResult | null = null
  if (existing.channel !== 'MANUAL' && existing.channelOrderId) {
    const channelCancel = await import(
      '../order-cancellation/channel-cancel.js'
    )
    try {
      if (existing.channel === 'AMAZON' && amazonMarketplaceId) {
        channelAck = await channelCancel.cancelOnAmazon(
          existing.channelOrderId,
          reason,
          [amazonMarketplaceId],
        )
      } else if (existing.channel === 'EBAY') {
        // 🔴 This read was BROKEN from 2026-05-07 to 2026-08-19. It filtered
        // on `channel`, which is not a column on ChannelConnection — the
        // column is `channelType` — and the `(prisma as any)` cast hid it
        // from the type checker. Prisma rejects an unknown argument rather
        // than ignoring it, so every eBay cancellation threw
        // PrismaClientValidationError here. Proven against the production
        // database, 2026-08-19; see docs/2026-08-19-map-multi-account-profiles.md §7.3.
        //
        // MAP.3 — resolved from the ORDER, which is the account that actually
        // owns it, so this is correct for two accounts as well as one.
        let conn: { id: string } | null = null
        try {
          conn = await resolveConnection({ orderId: id })
        } catch (err) {
          log.warn(
            { err, orderId: id },
            'eBay cancel: could not resolve the order\'s account',
          )
        }
        if (conn?.id) {
          channelAck = await channelCancel.cancelOnEbay(
            existing.channelOrderId,
            reason,
            conn.id,
            id,
          )
        } else {
          channelAck = {
            ok: false,
            channel: 'EBAY',
            channelOrderId: existing.channelOrderId,
            ackRef: null,
            dryRun: false,
            error: 'No active eBay connection',
          }
        }
      } else if (existing.channel === 'SHOPIFY') {
        channelAck = await channelCancel.cancelOnShopify(
          existing.channelOrderId,
          reason,
          id,
        )
      }
    } catch (err: any) {
      logger.warn('orders/:id/cancel channel pushback failed', {
        orderId: id,
        channel: existing.channel,
        error: err?.message,
      })
    }
  }

  // Operator-initiated audit row distinct from the auto-cancel
  // path (auto-cancel-from-order). Lets the audit-log surface
  // distinguish operator vs channel-driven cancellations.
  const { auditLogService } = await import('../audit-log.service.js')
  void auditLogService.write({
    entityType: 'Order',
    entityId: id,
    action: 'manual-cancel',
    before: { status: existing.status },
    after: { status: 'CANCELLED' },
    metadata: { reason, channel: existing.channel, ...cleanup, channelAck },
  })

  return {
    order: updated,
    cleanup,
    // O.50: channelPushbackPending is now true only when the
    // channel call failed OR the channel is MANUAL OR the
    // channel push was dryRun (operator hasn't enabled real
    // mode yet). Honest: operator only sees the "cancel on
    // marketplace too" reminder when there's actually
    // marketplace work left.
    channelPushbackPending:
      channelAck === null
      || channelAck.dryRun
      || !channelAck.ok,
    channelAck,
    channel: existing.channel,
    channelOrderId: existing.channelOrderId,
  }
  })())
}
