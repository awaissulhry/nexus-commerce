import { workOrderUses } from '@nexus/factory-domain/quality/lab/trace'
import type { Reader } from './store'

/**
 * Where a lot went (B-W1-34; design ts-later-fail, lt-trace-w1): the work orders that took its stock, from the issue
 * ledger (StockMove ISSUE / RETURN and their reversals; factory-domain quality/lab/trace). Read inside the blocking
 * command after the lot's stock locks (store.ts lockLotStock), so no issue lands between the trace and the block.
 * Garments, shipments and customers follow from the work orders: B-W1-43's PPE register traces them (its
 * `openRegisterEntryFor` hook is not on main yet: a later FAIL names the work orders here and in `lot.blocked`).
 */
export async function workOrdersOf(client: Reader, lotId: string) {
  const moves = await client.stockMove.findMany({
    where: { lotId, reason: { in: ['ISSUE', 'RETURN'] } },
    select: { id: true, reason: true, workOrderId: true, baseQuantity: true, reversalOfId: true, hideId: true },
    orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
  })
  const uses = workOrderUses(moves.map((move) => ({ ...move, baseQuantity: move.baseQuantity.toString() })))
  if (uses.length === 0) return []
  const orders = await client.workOrder.findMany({ where: { id: { in: uses.map((use) => use.workOrderId) } }, select: { id: true, number: true, batchNumber: true, status: true } })
  const byId = new Map(orders.map((order) => [order.id, order]))
  return uses.map((use) => {
    const order = byId.get(use.workOrderId)
    return { ...use, number: order?.number ?? null, batchNumber: order?.batchNumber ?? null, status: order?.status ?? null }
  })
}
