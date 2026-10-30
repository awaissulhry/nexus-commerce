import { asMoney } from '@nexus/factory-domain/money/marked'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import { cancelImpact, type CancelFacts, type CancelImpact, type ImpactItem } from '@nexus/factory-domain/sales/orders/daily'
import { ORDERS_MANAGE } from '@nexus/factory-domain/sales/orders/permissions'
import { Dec, ZERO } from '@nexus/factory-domain/tax/decimal'
import type { CommandCaller } from '../../../core/command'
import { officeOrder } from './moves'
import { readOrderFacts, type OrderFacts, type OrderRow, type Reader } from './store'

/**
 * The cancel's impact check (B-W2a-30; SAL-211; the design's Cancel order dialog "What it leaves behind: leather already
 * cut, stock reserved, open work orders, deposit paid"): the facts read for factory-domain `cancelImpact`, from what
 * followed the order. Read before the dialog (GET …/cancel-check) and again under the order's lock in the cancel itself
 * (moves.ts cancelOrder), so the answer and the refusal always agree. Leather cut is the cut log of its work orders
 * (hides and area, reversals taken off); planning's purchase orders are the open PO lines the latest pegging of its lines
 * counts on. Never a worker's name.
 */

const OPEN_PO = ['DRAFT', 'SENT', 'CONFIRMED', 'DECLINED', 'CHANGES_PROPOSED', 'PARTLY_RECEIVED'] as const

export async function readCancelFacts(db: Reader, order: Pick<OrderRow, 'id' | 'status' | 'quoteVersionId'>, facts: OrderFacts): Promise<CancelFacts> {
  const lineIds = facts.lines.map((line) => line.id)
  const workOrderIds = facts.workOrders.map((row) => row.id)
  const cuts = workOrderIds.length > 0 ? await db.cutLog.findMany({ where: { workOrderId: { in: workOrderIds } }, select: { id: true, workOrderId: true, hideId: true, baseAreaUsed: true, reversalOfId: true } }) : []
  const reversed = new Set(cuts.flatMap((row) => (row.reversalOfId ? [row.reversalOfId] : [])))
  const standing = cuts.filter((row) => row.reversalOfId === null && !reversed.has(row.id))
  const deposits = await db.depositRequest.findMany({ where: { OR: [{ orderId: order.id }, ...(order.quoteVersionId ? [{ quoteVersionId: order.quoteVersionId }] : [])] }, select: { id: true, status: true, amount: true }, orderBy: { id: 'asc' } })
  const milestones = await db.salesOrderMilestone.findMany({ where: { orderId: order.id }, select: { id: true, kind: true, status: true, amount: true }, orderBy: { seq: 'asc' } })
  const reservations =
    lineIds.length + workOrderIds.length > 0
      ? await db.reservation.findMany({ where: { status: 'ACTIVE', OR: [...(lineIds.length > 0 ? [{ salesOrderLineId: { in: lineIds } }] : []), ...(workOrderIds.length > 0 ? [{ workOrderId: { in: workOrderIds } }] : [])] }, select: { id: true }, orderBy: { id: 'asc' } })
      : []
  const pegged = lineIds.length > 0 ? await db.requirementPegging.findMany({ where: { salesOrderLineId: { in: lineIds }, supplyKind: 'PURCHASE_ORDER', purchaseOrderLineId: { not: null } }, select: { purchaseOrderLineId: true }, distinct: ['purchaseOrderLineId'] }) : []
  const poLines = pegged.length > 0 ? await db.purchaseOrderLine.findMany({ where: { id: { in: pegged.map((row) => row.purchaseOrderLineId!) } }, select: { purchaseOrderId: true } }) : []
  const purchaseOrders = poLines.length > 0 ? await db.purchaseOrder.findMany({ where: { id: { in: [...new Set(poLines.map((row) => row.purchaseOrderId))] }, status: { in: [...OPEN_PO] } }, select: { id: true, number: true }, orderBy: { number: 'asc' } }) : []
  return {
    status: order.status,
    workOrders: facts.workOrders.map((row) => {
      const own = standing.filter((cut) => cut.workOrderId === row.id)
      const area = own.reduce((sum, cut) => sum.plus(new Dec(cut.baseAreaUsed.toString())), ZERO)
      return { id: row.id, number: row.number, status: row.status, cutHides: new Set(own.map((cut) => cut.hideId)).size, cutArea: own.length > 0 ? decimalText(area) : null }
    }),
    shipments: facts.shipments.map((row) => ({ id: row.id, number: row.number, status: row.status })),
    invoices: facts.invoices.map((row) => ({ id: row.id, number: row.number, docType: row.docType, status: row.status })),
    deposits,
    milestones,
    reservations,
    purchaseOrders: purchaseOrders.map((row) => ({ id: row.id, number: row.number })),
  }
}

const itemView = (item: ImpactItem) => ({ code: item.code, message: item.message, refs: item.refs.map((ref) => ({ type: ref.type, id: ref.id, number: ref.number })), amount: asMoney('price', item.amount) })

/** The impact as the API answers it (amounts marked price). */
export const impactView = (impact: CancelImpact) => ({
  cancellable: impact.cancellable,
  blocks: impact.blocks.map(itemView),
  touches: impact.touches.map(itemView),
  leavesBehind: impact.leavesBehind.map(itemView),
})

/**
 * orders.manage: what cancelling the order would stop at, change and leave behind, in words (the design's Cancel order
 * dialog), with the leather cut per work order. Reads only.
 */
export async function cancelCheck(caller: CommandCaller, orderId: string) {
  const order = await officeOrder(caller, orderId, ORDERS_MANAGE)
  return caller.withClient(async (client) => {
    const facts = await readOrderFacts(client, order)
    const cancelFacts = await readCancelFacts(client, order, facts)
    return {
      orderId: order.id,
      number: order.number,
      status: order.status,
      version: order.version,
      impact: impactView(cancelImpact(cancelFacts)),
      leatherCut: cancelFacts.workOrders.filter((row) => row.cutHides > 0).map((row) => ({ workOrderId: row.id, number: row.number, hides: row.cutHides, area: row.cutArea })),
    }
  })
}
