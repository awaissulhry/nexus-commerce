import { valuationKey } from '@nexus/factory-domain/inventory/ledger/valuation'
import { unitCostPerBase } from '@nexus/factory-domain/inventory/receipts/rules'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import { defineHandler, type EventHandler } from '../../../platform/outbox/dispatch'
import { stockContextOf } from './access'
import { LEDGER_SELECT, valueMovesInCommand } from './post-moves'

/**
 * The floor's moves get their value afterwards (plan A1 §2.6: the floor never sees or writes a cost; factory-db
 * StockValuation is office only). On `inventory.moved` with `valued: false` and `changesValue: true` (a floor receipt,
 * issue, return), the worker values the move as the event's tenant's system caller, through command() (audited, the
 * event as its cause), with the same basis as an office move: a RECEIPT move at its purchase order line's price per base
 * unit (receipts' unitCostPerBase, when the order's currency is the material's), else the lot's cost, else the item's
 * standard cost. Once:
 * the valuation's key is `move:<moveId>` and the command's Idempotency-Key is the move's, so a repeated event or a
 * retried job finds it valued and writes nothing. A move with no cost basis stays unvalued (the stock overview and the
 * ledger check say so).
 *
 * Listed in background.ts HANDLERS for the worker: floorMoveValuationHandler().
 */
export function floorMoveValuationHandler(): EventHandler {
  return defineHandler({
    name: 'inventory.valueFloorMoves',
    events: ['inventory.moved'],
    async handle(event, { caller }) {
      const payload = event.payload as { moveId: string; valued: boolean; changesValue: boolean }
      if (payload.valued || !payload.changesValue) return
      await valueMove(caller, payload.moveId, event.eventId)
    },
  })
}

/** Values one move that has no value yet (system callers only). Answers whether it is valued now. */
export async function valueMove(caller: CommandCaller, moveId: string, causationId?: string): Promise<boolean> {
  const context = stockContextOf(caller)
  if (context.audience !== 'system') throw new Error('valueMove runs as the system (the worker)')
  const before = await caller.withClient(async (client) => ({
    move: await client.stockMove.findUnique({ where: { id: moveId }, select: LEDGER_SELECT }),
    valued: (await client.stockValuation.findUnique({ where: { tenantId_idempotencyKey: { tenantId: context.tenantId, idempotencyKey: valuationKey(moveId) } }, select: { id: true } })) !== null,
  }))
  if (!before.move) return false
  if (before.valued) return true
  const { result } = await command(
    caller,
    { name: 'inventory.valueMove', idempotencyKey: `inventory-value:${moveId}`, input: { moveId }, ...(causationId ? { causationId } : {}) },
    async (tools) => {
      const move = before.move!
      // A floor receipt's move is valued as the office's: at its order line's price per base unit (B-W1-33).
      const cost = await receiptCostOf(tools.tx, move)
      const valued = await valueMovesInCommand(tools, [{ ...move, baseQuantity: move.baseQuantity.toString() }], [{ cost }])
      if (!valued.has(move.id)) {
        // Nothing gives it a cost: recorded, so the attempt is audited and a repeat answers from the receipt.
        tools.audit({ action: 'inventory.value', recordType: 'StockMove', recordId: move.id, companyId: move.companyId, siteId: move.siteId, after: { valued: false }, reason: 'No cost basis: the lot has no value and the item no standard cost.' })
      }
      return { valued: valued.has(move.id) }
    },
  )
  return result.valued
}

/**
 * The cost an office receipt would have given this move: a RECEIPT (not a reversal) of a receipt line against a purchase
 * order line, in the material's currency, at the order line's price per base unit. Null otherwise (the lot's or the
 * standard cost then).
 */
async function receiptCostOf(tx: CommandTx, move: { readonly reason: string; readonly receiptLineId: string | null; readonly reversalOfId: string | null; readonly itemId: string }) {
  if (move.reason !== 'RECEIPT' || move.receiptLineId === null || move.reversalOfId !== null) return null
  const line = await tx.goodsReceiptLine.findUnique({ where: { id: move.receiptLineId }, select: { purchaseOrderLineId: true } })
  if (!line?.purchaseOrderLineId) return null
  const orderLine = await tx.purchaseOrderLine.findUnique({ where: { id: line.purchaseOrderLineId }, select: { unitPrice: true, quantity: true, baseQuantity: true, purchaseOrderId: true } })
  if (!orderLine || !orderLine.baseQuantity.greaterThan(0)) return null
  const order = await tx.purchaseOrder.findUnique({ where: { id: orderLine.purchaseOrderId }, select: { currency: true } })
  const item = await tx.item.findUnique({ where: { id: move.itemId }, select: { currency: true } })
  if (!order || !item || order.currency !== item.currency) return null
  return { method: 'PURCHASE_PRICE' as const, unitCost: unitCostPerBase({ unitPrice: orderLine.unitPrice.toString(), quantity: orderLine.quantity.toString(), baseQuantity: orderLine.baseQuantity.toString() }) }
}
