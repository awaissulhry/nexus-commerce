import { createHash } from 'node:crypto'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { expectedBaseOf, orderStatusAfter } from '@nexus/factory-domain/inventory/receipts/rules'
import type { PurchaseOrderStatus } from '@nexus/factory-domain/purchasing/orders'
import { ZERO } from '@nexus/factory-domain/tax/decimal'
import { command, type CommandCaller } from '../../../core/command'
import type { FloorContext } from '../../../core/context'
import { asTenantSystem } from '../../production/bundles/codes'
import { lockOrderForReceipt, setOrderReceiptProgress } from '../../purchasing/receiving'
import { readOrderLines } from '../receipts/store'

/**
 * The order's move after a FLOOR receipt (B-W1-33; receipts notes gap 1). The floor's role reads the order but may not
 * lock or change it, so right after the floor's receipt command commits, ONE command in the tenant's system context
 * (production/bundles/codes.ts asTenantSystem: the worker's office role, row-level security forced) bumps the order's
 * version (its row locked to the commit: an office cancel, send or edit decided on the version it read fails), takes the
 * receiving lock, and moves the order from what ALL its posted receipts brought (factory-domain orderStatusAfter:
 * PARTLY_RECEIVED while a line is open, RECEIVED when none is), audited `purchasing.received` on the order, naming the
 * receipt. Lock order as every receipt: the row, then the lock.
 *
 * It recomputes from the ledger of receipts each time, so it is right whatever ran in between (two tablets receiving the
 * same order: each move reads both). Its Idempotency-Key is derived from the floor request's: a resend of that request
 * (its receipt answered from the stored answer) runs it again only when it never committed, which also mends an order
 * left behind by a failure between the two commits.
 */
export async function moveOrderAfterFloorReceipt(
  caller: CommandCaller,
  context: FloorContext,
  receipt: { readonly id: string; readonly number: string; readonly purchaseOrderId: string },
  floorKey: string,
): Promise<{ status: PurchaseOrderStatus; version: number }> {
  const { result } = await command(
    asTenantSystem(caller, context),
    { name: 'purchasing.receiptProgress', idempotencyKey: progressKeyOf(floorKey), input: { receiptId: receipt.id, purchaseOrderId: receipt.purchaseOrderId } },
    async (tools) => {
      const order = await lockOrderForReceipt(tools, receipt.purchaseOrderId)
      if (!order) throw new NotFoundError('Purchase order not found.')
      const after = await readOrderLines(tools.tx, order.id)
      const to = orderStatusAfter(
        { status: order.status, confirmed: order.confirmed },
        after.lines.map((line) => ({
          expected: expectedBaseOf({ quantity: line.quantity.toString(), baseQuantity: line.baseQuantity.toString(), confirmedQuantity: line.confirmedQuantity?.toString() ?? null }),
          received: after.received.get(line.id) ?? ZERO,
          tolerancePct: line.areaTolerancePct?.toString() ?? null,
        })),
      )
      await setOrderReceiptProgress(tools, order, to, { id: receipt.id, number: receipt.number, reversed: false })
      return { status: to, version: order.version }
    },
  )
  return result
}

/** The follow-up's key, one per floor request key (keys are at most 128 characters: a digest of it). */
export function progressKeyOf(floorKey: string): string {
  return `receipt-order.${createHash('sha256').update(floorKey).digest('hex').slice(0, 48)}`
}
