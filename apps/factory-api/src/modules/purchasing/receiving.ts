import { ForbiddenError } from '@nexus/factory-domain/core/errors'
import type { PurchaseOrderStatus } from '@nexus/factory-domain/purchasing/orders'
import type { CommandTools, CommandTx } from '../../core/command'

/**
 * The purchase order's side of receiving goods (B-W1-30 → B-W1-32): the lock a goods receipt and the order's cancel
 * share, and the order's progress (PARTLY_RECEIVED, RECEIVED, or back to CONFIRMED / SENT after a reversal). Called
 * INSIDE the receipt's command (modules/inventory/receipts). Lock order everywhere: the order's row (a version bump),
 * then this advisory lock; the receipt's own row (a reversal) comes before both.
 *
 * Why both: an office receipt bumps the order's version, so a cancel decided on the order as it was read fails on its
 * version (and a receipt after a cancel reads CANCELLED). A floor device (B-W1-33) cannot lock or update the order (its
 * role only reads it), so the advisory lock is what keeps a floor receipt and a cancel apart: the cancel takes it after
 * its version bump and refuses while a receipt names the order.
 */

/** The advisory lock a receipt against the order and the order's cancel share (held to the end of the transaction). */
export async function lockOrderReceiving(tx: CommandTx, tenantId: string, orderId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.purchase-order-receiving', ${tenantId}::uuid, ${orderId}::uuid), 0))`
}

/** The order as a receipt needs it, read under its row lock. */
export interface OrderForReceipt {
  readonly id: string
  readonly companyId: string
  readonly siteId: string
  readonly partyId: string
  readonly number: string
  readonly status: PurchaseOrderStatus
  readonly currency: string
  readonly confirmed: boolean
  /** After the bump. */
  readonly version: number
}

/**
 * Inside a receipt's command (office or system): bumps the order's version (its row is locked to the commit, so a
 * cancel or send decided on the version it read fails), then takes the receiving lock. Null when the order is not there.
 */
export async function lockOrderForReceipt(tools: Pick<CommandTools, 'tx' | 'context' | 'now'>, orderId: string): Promise<OrderForReceipt | null> {
  const [row] = await tools.tx.$queryRaw<{ id: string; companyId: string; siteId: string; partyId: string; number: string; status: PurchaseOrderStatus; currency: string; confirmed: boolean; version: number }[]>`
    UPDATE "PurchaseOrder" SET "version" = "version" + 1, "updatedAt" = ${tools.now}
     WHERE "id" = ${orderId}::uuid
     RETURNING "id"::text AS "id", "companyId"::text AS "companyId", "siteId"::text AS "siteId", "partyId"::text AS "partyId", "number",
               "status"::text AS "status", "currency", ("confirmedAt" IS NOT NULL) AS "confirmed", "version"`
  if (!row) return null
  if (!('tenantId' in tools.context)) throw new ForbiddenError()
  await lockOrderReceiving(tools.tx, tools.context.tenantId, orderId)
  return row
}

/**
 * Inside the same command, after the receipt (or its reversal) is written: the order's new state, audited on the order
 * when it moved. The caller decided it (factory-domain inventory/receipts orderStatusAfter).
 */
export async function setOrderReceiptProgress(tools: CommandTools, order: OrderForReceipt, to: PurchaseOrderStatus, receipt: { readonly id: string; readonly number: string; readonly reversed: boolean }): Promise<void> {
  if (to === order.status) return
  await tools.tx.purchaseOrder.update({ where: { id: order.id }, data: { status: to }, select: { id: true } })
  tools.audit({
    action: receipt.reversed ? 'purchasing.receiptReversed' : 'purchasing.received',
    recordType: 'PurchaseOrder',
    recordId: order.id,
    companyId: order.companyId,
    siteId: order.siteId,
    before: { status: order.status },
    after: { status: to, receiptId: receipt.id, receiptNumber: receipt.number },
  })
}

/**
 * Under the receiving lock, in the order's cancel: why goods at the dock stop it (an OPEN or POSTED receipt names the
 * order: a floor receipt that never moved the order's state included), or null.
 */
export async function receiptStopsCancel(tx: CommandTx, orderId: string): Promise<string | null> {
  const receipts = await tx.goodsReceipt.findMany({ where: { purchaseOrderId: orderId, status: { in: ['OPEN', 'POSTED'] } }, select: { number: true }, orderBy: { number: 'asc' }, take: 3 })
  if (receipts.length === 0) return null
  return `Goods were received against this order (${receipts.map((receipt) => receipt.number).join(', ')}): it is closed, never cancelled. Reverse a wrong receipt first.`
}
