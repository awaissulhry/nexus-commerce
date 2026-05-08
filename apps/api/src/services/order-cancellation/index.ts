/**
 * O.45 — Order cancellation cascade.
 *
 * When a channel reports an order as CANCELLED (via the ingest cron or
 * a webhook), the system today did nothing about associated shipments:
 * a label could be printed, the parcel sitting at Sendcloud, with the
 * customer expecting a refund + the operator unaware. This service
 * runs the cleanup chain:
 *
 *   1. Find active (non-CANCELLED, non-DELIVERED) shipments for the
 *      order.
 *   2. For each:
 *      - If it has a Sendcloud parcel id, void via the Sendcloud API
 *        (best-effort — Sendcloud refuses post-pickup, which is fine;
 *        we record the failure but proceed).
 *      - Transition Shipment.status to CANCELLED + cancelledAt = now.
 *      - Append AuditLog row.
 *      - Publish 'shipment.deleted' SSE event so open browsers
 *        refresh.
 *
 * Idempotent — running it twice on the same order is a no-op the
 * second time. Safe to call from ingest cron paths that re-process
 * the same order.
 *
 * Skips DELIVERED + already-CANCELLED shipments. If a shipment is
 * already SHIPPED / IN_TRANSIT, we still cancel-on-our-side (so the
 * UI reflects reality) but we DON'T attempt to void at Sendcloud
 * since the carrier has it.
 */

import prisma from '../../db.js'

export interface CancellationCleanupResult {
  orderId: string
  shipmentsScanned: number
  shipmentsCancelled: number
  parcelsVoided: number
  parcelsVoidFailed: number
  itemsRestocked: number
  // S.2 — reservations released for orders that used the
  // reserve-then-consume pattern (Amazon FBM today; Shopify in S.2.5).
  reservationsReleased: number
  errors: Array<{ shipmentId?: string; itemId?: string; error: string }>
}

const TERMINAL_STATUSES = ['CANCELLED', 'DELIVERED', 'RETURNED'] as const
const POST_PICKUP_STATUSES = ['SHIPPED', 'IN_TRANSIT'] as const

export async function handleOrderCancelled(
  orderId: string,
): Promise<CancellationCleanupResult> {
  const result: CancellationCleanupResult = {
    orderId,
    shipmentsScanned: 0,
    shipmentsCancelled: 0,
    parcelsVoided: 0,
    parcelsVoidFailed: 0,
    itemsRestocked: 0,
    reservationsReleased: 0,
    errors: [],
  }

  const shipments = await prisma.shipment.findMany({
    where: { orderId },
    select: {
      id: true,
      status: true,
      sendcloudParcelId: true,
      trackingNumber: true,
      heldReason: true,
    },
  })
  result.shipmentsScanned = shipments.length

  // Defer the heavy imports so callers that pass in non-cancelled
  // orders (defensive) don't pay for the modules.
  const [
    { publishOutboundEvent },
    { auditLogService },
    sendcloud,
    { applyStockMovement },
    { releaseOpenOrder },
  ] = await Promise.all([
    import('../outbound-events.service.js'),
    import('../audit-log.service.js'),
    import('../sendcloud/index.js'),
    import('../stock-movement.service.js'),
    import('../stock-level.service.js'),
  ])

  // S.2: Stock restoration. Two patterns coexist depending on how the
  // channel ingestion path handles stock:
  //   - reserve-then-consume (Amazon FBM today; Shopify in S.2.5):
  //     ingestion called reserveOpenOrder. Cancellation releases the
  //     reservation — frees `available` without touching `quantity`.
  //   - decrement-at-creation (eBay today): ingestion called
  //     applyStockMovement(-qty, ORDER_PLACED). Cancellation restores
  //     via applyStockMovement(+qty, ORDER_CANCELLED).
  //
  // We try the reservation path first. If no open reservations exist
  // for this order, we fall through to the legacy restore path.
  // Idempotent on both branches: release/consume are no-ops on
  // already-settled reservations; the legacy branch checks for an
  // existing ORDER_CANCELLED movement before emitting.
  try {
    const released = await releaseOpenOrder({
      orderId,
      actor: 'system:order-cancellation',
      reason: 'order cancelled by channel',
    })
    result.reservationsReleased = released
  } catch (err: any) {
    result.errors.push({
      itemId: 'reservation-release',
      error: `Reservation release: ${err?.message ?? String(err)}`,
    })
  }

  // Legacy restore path runs only when no reservations were released.
  // If even one reservation existed, the order used reserve-then-consume
  // and applyStockMovement(+qty, ORDER_CANCELLED) would over-restore.
  if (result.reservationsReleased === 0) {
    const orderItems = await prisma.orderItem.findMany({
      where: { orderId },
      select: { id: true, productId: true, sku: true, quantity: true },
    })
    for (const it of orderItems) {
      if (!it.productId || it.quantity <= 0) continue
      try {
        const alreadyRestocked = await prisma.stockMovement.findFirst({
          where: {
            orderId,
            productId: it.productId,
            reason: 'ORDER_CANCELLED',
          },
          select: { id: true },
        })
        if (alreadyRestocked) continue
        await applyStockMovement({
          productId: it.productId,
          change: it.quantity,
          reason: 'ORDER_CANCELLED',
          referenceType: 'Order',
          referenceId: orderId,
          orderId,
          notes: `Auto-restock: order ${orderId} cancelled by channel`,
          actor: 'system',
        })
        result.itemsRestocked++
      } catch (err: any) {
        result.errors.push({
          itemId: it.id,
          error: `Restock ${it.sku} ×${it.quantity}: ${err?.message ?? String(err)}`,
        })
      }
    }
  }

  if (shipments.length === 0) return result

  for (const s of shipments) {
    if (TERMINAL_STATUSES.includes(s.status as any)) continue

    // Try to void at Sendcloud only when the parcel exists AND the
    // carrier hasn't picked it up yet. Post-pickup voids waste an API
    // call + Sendcloud rejects them anyway.
    const shouldAttemptVoid =
      s.sendcloudParcelId !== null
      && !POST_PICKUP_STATUSES.includes(s.status as any)

    if (shouldAttemptVoid && s.sendcloudParcelId) {
      try {
        const creds = await sendcloud.resolveCredentials()
        const voidRes = await sendcloud.voidParcel(creds, Number(s.sendcloudParcelId))
        if (voidRes.ok) result.parcelsVoided++
        else {
          result.parcelsVoidFailed++
          result.errors.push({
            shipmentId: s.id,
            error: `Sendcloud void: ${(voidRes as { ok: false; reason: string }).reason}`,
          })
        }
      } catch (err: any) {
        result.parcelsVoidFailed++
        result.errors.push({
          shipmentId: s.id,
          error: err?.message ?? String(err),
        })
      }
    }

    // Transition our side regardless — the order IS cancelled per
    // the channel; the shipment row should reflect that even when
    // Sendcloud refuses the void (operator can manually intervene
    // via the existing void-label endpoint if needed).
    try {
      await prisma.shipment.update({
        where: { id: s.id },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          version: { increment: 1 },
        },
      })
      result.shipmentsCancelled++

      void auditLogService.write({
        entityType: 'Shipment',
        entityId: s.id,
        action: 'auto-cancel-from-order',
        before: { status: s.status, sendcloudParcelId: s.sendcloudParcelId },
        after: { status: 'CANCELLED' },
        metadata: { reason: 'Order cancelled by channel', orderId },
      })

      publishOutboundEvent({
        type: 'shipment.deleted',
        shipmentId: s.id,
        ts: Date.now(),
      })
    } catch (err: any) {
      result.errors.push({
        shipmentId: s.id,
        error: err?.message ?? String(err),
      })
    }
  }

  return result
}

export const __test = { TERMINAL_STATUSES, POST_PICKUP_STATUSES }
