import { Decimal } from 'decimal.js'
import { expectedBaseOf } from '@nexus/factory-domain/inventory/receipts/rules'
import { outstandingBase, type EndLineFacts } from '@nexus/factory-domain/purchasing/orders/changes'
import { dayOf, quantityText, type Reader } from '../store'

/**
 * What a cancel or a close short of a purchase order (or of some of its lines) reaches (B-W2a-52; SCM-059 "releasing
 * pegged demand"; design purchasing.orders pop "Cancel PO-0093?": "Reach: 3 lines; expected stock released; WO-0221 and
 * WO-0225 lose their supply (listed)"): per line what came and what is still expected (the material's base unit), the
 * plan lines it bought (they are open again after: planning's hook), and the demand the site's latest plan pegs on it
 * (planning.prisma RequirementPegging of the latest DONE run: work orders, sales order lines, safety stock, reorder
 * rules), which loses that supply. Numbers and dates only: no price, no customer name.
 */

const ZERO = new Decimal(0)

export interface LineFacts extends EndLineFacts {
  readonly itemId: string
  readonly baseUom: string
  readonly orderedBase: string
}

/** The order's lines as the end rules read them: received (posted receipts), at the dock (open receipts), sent before. */
export async function endLineFactsOf(db: Reader, order: { readonly id: string; readonly revision: number }): Promise<LineFacts[]> {
  const lines = await db.purchaseOrderLine.findMany({
    where: { purchaseOrderId: order.id },
    orderBy: { seq: 'asc' },
    select: { id: true, seq: true, itemId: true, supplierArticleCode: true, quantity: true, baseQuantity: true, confirmedQuantity: true, areaTolerancePct: true, cancelledAt: true, closedShortAt: true },
  })
  const ids = lines.map((line) => line.id)
  const items = new Map((ids.length === 0 ? [] : await db.item.findMany({ where: { id: { in: [...new Set(lines.map((line) => line.itemId))] } }, select: { id: true, code: true, name: true, baseUom: true } })).map((item) => [item.id, item]))
  const posted = ids.length === 0 ? [] : await db.goodsReceiptLine.groupBy({ by: ['purchaseOrderLineId'], where: { purchaseOrderLineId: { in: ids }, receipt: { status: 'POSTED' } }, _sum: { baseQuantity: true } })
  const received = new Map(posted.map((row) => [row.purchaseOrderLineId!, new Decimal(row._sum.baseQuantity?.toString() ?? '0')]))
  const docked = ids.length === 0 ? [] : await db.goodsReceiptLine.findMany({ where: { purchaseOrderLineId: { in: ids }, receipt: { status: 'OPEN' } }, select: { purchaseOrderLineId: true } })
  const atDock = new Set(docked.map((row) => row.purchaseOrderLineId!))
  const previous = order.revision > 1 ? await db.purchaseOrderRevision.findFirst({ where: { purchaseOrderId: order.id, revision: order.revision - 1 }, select: { after: true } }) : null
  const sentIds = previous ? new Set(((previous.after as { lines?: { id: string }[] }).lines ?? []).map((line) => line.id)) : null
  return lines.map((line) => {
    const item = items.get(line.itemId)
    return {
      id: line.id,
      seq: line.seq,
      label: `Line ${line.seq} (${line.supplierArticleCode ?? item?.code ?? ''} ${item?.name ?? ''})`.replace(/\s+\)/, ')'),
      itemId: line.itemId,
      baseUom: item?.baseUom ?? '',
      cancelled: line.cancelledAt !== null,
      closedShort: line.closedShortAt !== null,
      orderedBase: quantityText(line.baseQuantity),
      expectedBase: quantityText(expectedBaseOf({ quantity: line.quantity.toString(), baseQuantity: line.baseQuantity.toString(), confirmedQuantity: line.confirmedQuantity?.toString() ?? null })),
      receivedBase: (received.get(line.id) ?? ZERO).toFixed(4),
      tolerancePct: line.areaTolerancePct?.toString() ?? null,
      atDock: atDock.has(line.id),
      // Without the previous revision's row (an order sent before revisions were kept), a draft of revision 2+ trusts the line.
      sentBefore: sentIds === null ? order.revision > 1 : sentIds.has(line.id),
    }
  })
}

/** The demand the site's latest plan pegs on these lines, and the plan lines they buy. */
export async function peggedOn(db: Reader, siteId: string, lineIds: readonly string[]) {
  if (lineIds.length === 0) return { runId: null, pegged: new Map<string, PeggedDemand[]>(), planLines: new Map<string, string[]>() }
  const run = await db.planningRun.findFirst({ where: { siteId, status: 'DONE' }, orderBy: [{ finishedAt: 'desc' }, { id: 'desc' }], select: { id: true } })
  const planRows = await db.materialRequirement.findMany({ where: { purchaseOrderLineId: { in: [...lineIds] }, decision: 'ORDERED', run: { status: 'DONE' } }, select: { id: true, purchaseOrderLineId: true }, orderBy: { id: 'asc' } })
  const planLines = new Map<string, string[]>()
  for (const row of planRows) planLines.set(row.purchaseOrderLineId!, [...(planLines.get(row.purchaseOrderLineId!) ?? []), row.id])
  const pegged = new Map<string, PeggedDemand[]>()
  if (!run) return { runId: null, pegged, planLines }
  const rows = await db.requirementPegging.findMany({
    where: { runId: run.id, purchaseOrderLineId: { in: [...lineIds] } },
    orderBy: [{ demandDate: 'asc' }, { seq: 'asc' }],
    take: 500,
    select: { purchaseOrderLineId: true, demandKind: true, workOrderId: true, salesOrderLineId: true, size: true, demandDate: true, quantity: true },
  })
  const workOrders = new Map((await db.workOrder.findMany({ where: { id: { in: [...new Set(rows.flatMap((row) => (row.workOrderId ? [row.workOrderId] : [])))] } }, select: { id: true, number: true } })).map((row) => [row.id, row.number]))
  const orderLines = await db.salesOrderLine.findMany({ where: { id: { in: [...new Set(rows.flatMap((row) => (row.salesOrderLineId ? [row.salesOrderLineId] : [])))] } }, select: { id: true, orderId: true } })
  const salesOrders = new Map((await db.salesOrder.findMany({ where: { id: { in: [...new Set(orderLines.map((row) => row.orderId))] } }, select: { id: true, number: true } })).map((row) => [row.id, row.number]))
  const orderOf = new Map(orderLines.map((row) => [row.id, { id: row.orderId, number: salesOrders.get(row.orderId) ?? null }]))
  for (const row of rows) {
    const salesOrder = row.salesOrderLineId ? (orderOf.get(row.salesOrderLineId) ?? null) : null
    const entry: PeggedDemand = {
      kind: row.demandKind,
      workOrder: row.workOrderId ? { id: row.workOrderId, number: workOrders.get(row.workOrderId) ?? null } : null,
      salesOrder: salesOrder ? { id: salesOrder.id, number: salesOrder.number } : null,
      size: row.size,
      demandDate: dayOf(row.demandDate)!,
      quantity: quantityText(row.quantity),
    }
    pegged.set(row.purchaseOrderLineId!, [...(pegged.get(row.purchaseOrderLineId!) ?? []), entry])
  }
  return { runId: run.id, pegged, planLines }
}

export interface PeggedDemand {
  readonly kind: string
  readonly workOrder: { readonly id: string; readonly number: string | null } | null
  readonly salesOrder: { readonly id: string; readonly number: string | null } | null
  readonly size: string | null
  readonly demandDate: string
  readonly quantity: string
}

/** The reach of these lines: what came, what is still expected, the plan lines they buy, the demand pegged on them. */
export async function reachOf(db: Reader, order: { readonly siteId: string }, lines: readonly LineFacts[]) {
  const { runId, pegged, planLines } = await peggedOn(db, order.siteId, lines.map((line) => line.id))
  const rows = lines.map((line) => ({
    lineId: line.id,
    seq: line.seq,
    label: line.label,
    baseUom: line.baseUom,
    orderedBase: line.orderedBase,
    receivedBase: line.receivedBase,
    outstandingBase: outstandingBase(line),
    planLineIds: planLines.get(line.id) ?? [],
    pegged: pegged.get(line.id) ?? [],
  }))
  const workOrders = [...new Map(rows.flatMap((row) => row.pegged.flatMap((entry) => (entry.workOrder ? [[entry.workOrder.id, entry.workOrder] as const] : [])))).values()]
  const salesOrders = [...new Map(rows.flatMap((row) => row.pegged.flatMap((entry) => (entry.salesOrder ? [[entry.salesOrder.id, entry.salesOrder] as const] : [])))).values()]
  return { runId, lines: rows, workOrders, salesOrders }
}

export type Reach = Awaited<ReturnType<typeof reachOf>>
