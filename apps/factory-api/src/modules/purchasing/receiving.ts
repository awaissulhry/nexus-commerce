import { ForbiddenError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import type { PurchaseOrderStatus } from '@nexus/factory-domain/purchasing/orders'
import { receiptToleranceOf, toleranceFor, type ReceiptTolerance, type ToleranceRule } from '@nexus/factory-domain/purchasing/po-depth/tolerances'
import type { CommandTools, CommandTx } from '../../core/command'
import { closeConfirmTasks } from './portal-orders/tasks'

/**
 * The purchase order's side of receiving goods (B-W1-30 → B-W1-32): the lock a goods receipt and the order's cancel
 * share, and the order's progress (PARTLY_RECEIVED, RECEIVED, or back to CONFIRMED / SENT after a reversal). Called
 * INSIDE the receipt's command (modules/inventory/receipts). Lock order everywhere: the order's row (a version bump),
 * then this advisory lock; the receipt's own row (a reversal) comes before both.
 *
 * Why both: an office receipt bumps the order's version, so a cancel decided on the order as it was read fails on its
 * version (and a receipt after a cancel reads CANCELLED). A floor device (B-W1-33) cannot lock or update the order (its
 * role only reads it), so the advisory lock is what keeps a floor receipt and a cancel apart: the cancel takes it after
 * its version bump and refuses while a receipt names the order. The floor's receipt then moves the order in the
 * tenant's system context, in a command of its own right after (modules/inventory/receiving/progress.ts).
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
 * Inside a FLOOR receipt's command (B-W1-33): the order's receiving lock first, then the order read under it with the
 * columns the floor's role may read (it may not lock or change the order's row). A cancel takes the same lock after its
 * version bump and refuses while a receipt names the order, so the two never both commit: a cancel that went first is
 * read here as CANCELLED. The version is the one the order has now (not bumped: the follow-up system command bumps it).
 * Null when the order is not there or not of the device's site (row-level security).
 */
export async function readOrderForFloorReceipt(tools: Pick<CommandTools, 'tx' | 'context'>, orderId: string): Promise<OrderForReceipt | null> {
  if (tools.context.audience !== 'floor') throw new ForbiddenError()
  if (!isUuid(orderId)) return null
  await lockOrderReceiving(tools.tx, tools.context.tenantId, orderId)
  const row = await tools.tx.purchaseOrder.findUnique({
    where: { id: orderId },
    select: { id: true, companyId: true, siteId: true, partyId: true, number: true, status: true, currency: true, confirmedAt: true, version: true },
  })
  if (!row) return null
  return { id: row.id, companyId: row.companyId, siteId: row.siteId, partyId: row.partyId, number: row.number, status: row.status, currency: row.currency, confirmed: row.confirmedAt !== null, version: row.version }
}

/**
 * Inside the same command, after the receipt (or its reversal) is written: the order's new state, audited on the order
 * when it moved. The caller decided it (factory-domain inventory/receipts orderStatusAfter).
 */
export async function setOrderReceiptProgress(tools: CommandTools, order: OrderForReceipt, to: PurchaseOrderStatus, receipt: { readonly id: string; readonly number: string; readonly reversed: boolean }): Promise<void> {
  if (to === order.status) return
  await tools.tx.purchaseOrder.update({ where: { id: order.id }, data: { status: to }, select: { id: true } })
  // B-W2b-174: goods came while the order still waited for the supplier's answer: nothing is left to confirm.
  if (order.status === 'SENT') await closeConfirmTasks(tools, order.id, 'CANCELLED')
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

/**
 * B-W2b-296 (SCM-061): the tolerance each order line is received with, read under the receipt's lock in the caller's
 * session (office, floor or system: each may read the tolerances): the line's own (a leather line's area tolerance, both
 * ways, W1's rule beyond it), else the most specific ACTIVE delivery tolerance of the order's company, supplier and the
 * line's material or kind (factory-domain purchasing/po-depth/tolerances), else none (exactly as ordered). The receipt's
 * difference, its refusal beyond the tolerance over and the order's state after it (received within the tolerance under)
 * all read this one answer.
 */
export async function receiptTolerancesOf(tx: Pick<CommandTx, 'item' | 'deliveryTolerance'>, order: Pick<OrderForReceipt, 'companyId' | 'partyId'>, lines: readonly { readonly id: string; readonly itemId: string; readonly areaTolerancePct: { toString(): string } | null }[]): Promise<Map<string, ReceiptTolerance>> {
  const itemIds = [...new Set(lines.map((line) => line.itemId))]
  const items = itemIds.length === 0 ? [] : await tx.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, kind: true } })
  const kinds = new Map(items.map((item) => [item.id, item.kind as string]))
  const rows = await tx.deliveryTolerance.findMany({
    where: { status: 'ACTIVE', OR: [{ companyId: null }, { companyId: order.companyId }], AND: [{ OR: [{ supplierId: null }, { supplierId: order.partyId }] }] },
    select: { id: true, companyId: true, supplierId: true, itemId: true, itemKind: true, overPct: true, underPct: true, whenBeyond: true, status: true },
  })
  const rules: ToleranceRule[] = rows.map((row) => ({ ...row, itemKind: row.itemKind as string | null, overPct: row.overPct.toString(), underPct: row.underPct.toString() }))
  return new Map(
    lines.map((line) => [
      line.id,
      receiptToleranceOf(
        { areaTolerancePct: line.areaTolerancePct === null ? null : line.areaTolerancePct.toString() },
        toleranceFor(rules, { companyId: order.companyId, supplierId: order.partyId, itemId: line.itemId, itemKind: kinds.get(line.itemId) ?? '' }),
      ),
    ]),
  )
}

/** A line's tolerance as factory-domain inventory/receipts lineDifference and orderStatusAfter take it. */
export const differenceTolerance = (tolerance: ReceiptTolerance | undefined, areaTolerancePct: { toString(): string } | null): { tolerancePct: string | null; underPct: string | null } =>
  tolerance ? { tolerancePct: tolerance.overPct, underPct: tolerance.underPct } : { tolerancePct: areaTolerancePct?.toString() ?? null, underPct: null }
