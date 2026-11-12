import type { Prisma } from '@nexus/factory-db'
import { Decimal } from 'decimal.js'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { confirmedLaterByOf, expectedDayOf, expediteReasonsOf, lateByOf, nextDeliveryOf, type ExpediteReason, type LineDeliveryFacts } from '@nexus/factory-domain/purchasing/expediting/worklist'
import { daysLate } from '@nexus/factory-domain/purchasing/orders/delivery'
import { PURCHASING_VIEW } from '@nexus/factory-domain/purchasing/permissions'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { expectedLinesOf } from '../orders'
import { dayOf, officeContextOf, quantityText, type Reader } from '../store'

/**
 * The reads under the expediting worklist, the demand of each line and the chase (B-W2b-305; SCM-064, SCM-068; the rules:
 * factory-domain purchasing/expediting/worklist.ts): the open lines still waiting for goods (W2a's expected lines:
 * received with the line's own tolerance), each expected on its next delivery not yet covered (B-W2b-296's schedule) else
 * its own day, its reasons, and what it blocks — the demand the latest finished plan of its site pegs on it (planning's
 * RequirementPegging, supply PURCHASE_ORDER): work orders with their due day, customer order lines with their order's
 * promise, each late by the days the line is expected after the day it is needed. Numbers, days and states: no price, no
 * customer name.
 */

export interface Blocked {
  readonly kind: string
  readonly workOrder: { readonly id: string; readonly number: string; readonly status: string; readonly dueDate: string | null } | null
  readonly salesOrder: { readonly id: string; readonly number: string; readonly promiseDate: string | null } | null
  readonly size: string | null
  readonly demandDate: string
  /** The base quantity of the line pegged to it. */
  readonly quantity: string
  /** Days the line puts it late (0: in time). */
  readonly lateBy: number
}

/** The demand the latest finished plan of each line's site pegs on these lines, with how late the line puts it. */
export async function blocksOf(db: Reader, lines: readonly { readonly id: string; readonly siteId: string; readonly expectedDate: string }[]) {
  const runs = new Map<string, { id: string; finishedAt: Date | null } | null>()
  for (const siteId of new Set(lines.map((line) => line.siteId))) {
    runs.set(siteId, await db.planningRun.findFirst({ where: { siteId, status: 'DONE' }, orderBy: [{ finishedAt: 'desc' }, { id: 'desc' }], select: { id: true, finishedAt: true } }))
  }
  const runIds = [...runs.values()].flatMap((run) => (run ? [run.id] : []))
  const blocks = new Map<string, Blocked[]>()
  if (runIds.length === 0 || lines.length === 0) return { runs, blocks }
  const rows = await db.requirementPegging.findMany({
    where: { runId: { in: runIds }, supplyKind: 'PURCHASE_ORDER', purchaseOrderLineId: { in: lines.map((line) => line.id) } },
    orderBy: [{ demandDate: 'asc' }, { seq: 'asc' }, { id: 'asc' }],
    take: 5000,
    select: { siteId: true, runId: true, purchaseOrderLineId: true, demandKind: true, workOrderId: true, salesOrderLineId: true, size: true, demandDate: true, quantity: true },
  })
  const workOrderIds = [...new Set(rows.flatMap((row) => (row.workOrderId ? [row.workOrderId] : [])))]
  const workOrders = new Map((workOrderIds.length === 0 ? [] : await db.workOrder.findMany({ where: { id: { in: workOrderIds } }, select: { id: true, number: true, status: true, dueDate: true } })).map((row) => [row.id, row]))
  const orderLineIds = [...new Set(rows.flatMap((row) => (row.salesOrderLineId ? [row.salesOrderLineId] : [])))]
  const orderLines = orderLineIds.length === 0 ? [] : await db.salesOrderLine.findMany({ where: { id: { in: orderLineIds } }, select: { id: true, orderId: true } })
  const salesOrders = new Map((orderLines.length === 0 ? [] : await db.salesOrder.findMany({ where: { id: { in: [...new Set(orderLines.map((row) => row.orderId))] } }, select: { id: true, number: true, promiseDate: true } })).map((row) => [row.id, row]))
  const orderOf = new Map(orderLines.map((row) => [row.id, salesOrders.get(row.orderId) ?? null]))
  const expected = new Map(lines.map((line) => [line.id, line]))
  for (const row of rows) {
    const line = expected.get(row.purchaseOrderLineId!)
    // Only the latest finished run of the line's own site.
    if (!line || runs.get(line.siteId)?.id !== row.runId) continue
    const workOrder = row.workOrderId ? workOrders.get(row.workOrderId) : undefined
    const salesOrder = row.salesOrderLineId ? orderOf.get(row.salesOrderLineId) : null
    const demandDate = dayOf(row.demandDate)!
    const entry: Blocked = {
      kind: row.demandKind,
      workOrder: workOrder ? { id: workOrder.id, number: workOrder.number, status: workOrder.status, dueDate: dayOf(workOrder.dueDate) } : null,
      salesOrder: salesOrder ? { id: salesOrder.id, number: salesOrder.number, promiseDate: dayOf(salesOrder.promiseDate) } : null,
      size: row.size,
      demandDate,
      quantity: quantityText(row.quantity),
      lateBy: lateByOf(line.expectedDate, demandDate),
    }
    blocks.set(line.id, [...(blocks.get(line.id) ?? []), entry])
  }
  return { runs, blocks }
}

/** What a line blocks, counted: customer orders and work orders it puts late, and the earliest promise among those orders. */
export function atRiskOf(blocks: readonly Blocked[]) {
  const late = blocks.filter((entry) => entry.lateBy > 0)
  const salesOrders = new Map(late.flatMap((entry) => (entry.salesOrder ? [[entry.salesOrder.id, entry] as const] : [])))
  const workOrders = new Set(late.flatMap((entry) => (entry.workOrder ? [entry.workOrder.id] : [])))
  const promises = [...salesOrders.values()].map((entry) => entry.salesOrder?.promiseDate ?? entry.demandDate).sort()
  return { salesOrders: salesOrders.size, workOrders: workOrders.size, earliestPromise: promises[0] ?? null }
}

/** The worklist's filter over the orders the caller reaches (scopeWhere: company, site, supplier). */
export function orderFiltersOf(caller: CommandCaller, query: { readonly companyId?: string | undefined; readonly siteId?: string | undefined; readonly partyId?: string | undefined; readonly purchaseOrderId?: string | undefined }): Prisma.PurchaseOrderWhereInput[] {
  const context = officeContextOf(caller)
  const scope = scopeWhere(actorOf(context), PURCHASING_VIEW, { company: 'companyId', site: 'siteId', party: 'partyId' }) as Prisma.PurchaseOrderWhereInput
  return [scope, query.companyId ? { companyId: query.companyId } : {}, query.siteId ? { siteId: query.siteId } : {}, query.partyId ? { partyId: query.partyId } : {}, query.purchaseOrderId ? { id: query.purchaseOrderId } : {}]
}

export interface WorkLine {
  readonly lineId: string
  readonly purchaseOrderId: string
  readonly seq: number
  readonly itemId: string
  readonly itemColourId: string | null
  readonly uom: string
  readonly needDate: string
  readonly confirmedDate: string | null
  readonly expectedDate: string
  readonly nextDelivery: { readonly seq: number; readonly needDate: string; readonly confirmedDate: string | null } | null
  readonly outstandingBase: string
  readonly daysLate: number
  readonly confirmedLaterBy: number
  readonly reasons: ExpediteReason[]
  readonly order: { readonly number: string; readonly status: string; readonly revision: number; readonly companyId: string; readonly siteId: string; readonly partyId: string; readonly confirmBy: Date | null; readonly version: number }
}

/**
 * The open lines of the orders these filters find, each with its expected day, its reasons and its order (`complete`: all
 * lines were read; W2a reads at most 5000).
 */
export async function workLinesOf(db: Reader, filters: readonly Prisma.PurchaseOrderWhereInput[], today: string, now: Date): Promise<{ lines: WorkLine[]; complete: boolean }> {
  const expected = await expectedLinesOf(db as Prisma.TransactionClient, filters, today)
  const ids = expected.lines.map((line) => line.lineId)
  const deliveries = ids.length === 0 ? [] : await db.purchaseOrderLineDelivery.findMany({ where: { purchaseOrderLineId: { in: ids } }, orderBy: [{ seq: 'asc' }, { id: 'asc' }], select: { purchaseOrderLineId: true, seq: true, baseQuantity: true, needDate: true, confirmedDate: true } })
  const byLine = new Map<string, LineDeliveryFacts[]>()
  for (const row of deliveries) byLine.set(row.purchaseOrderLineId, [...(byLine.get(row.purchaseOrderLineId) ?? []), { seq: row.seq, baseQuantity: row.baseQuantity.toFixed(4), needDate: dayOf(row.needDate)!, confirmedDate: dayOf(row.confirmedDate) }])
  const orderIds = [...new Set(expected.lines.map((line) => line.purchaseOrderId))]
  const orders = new Map((orderIds.length === 0 ? [] : await db.purchaseOrder.findMany({ where: { id: { in: orderIds } }, select: { id: true, number: true, status: true, revision: true, companyId: true, siteId: true, partyId: true, confirmBy: true, version: true } })).map((row) => [row.id, row]))
  const lines = expected.lines.map((line): WorkLine => {
    const order = orders.get(line.purchaseOrderId)!
    const schedule = byLine.get(line.lineId) ?? []
    const next = nextDeliveryOf(schedule, line.receivedBase)
    const expectedDate = expectedDayOf(line, next)
    const facts = { orderStatus: order.status, needDate: line.needDate, confirmedDate: line.confirmedDate, expectedDate, deliveries: schedule, confirmBy: order.confirmBy, today, now }
    return {
      lineId: line.lineId,
      purchaseOrderId: line.purchaseOrderId,
      seq: line.seq,
      itemId: line.itemId,
      itemColourId: line.itemColourId,
      uom: line.uom,
      needDate: line.needDate,
      confirmedDate: line.confirmedDate,
      expectedDate,
      nextDelivery: next ? { seq: next.seq, needDate: next.needDate, confirmedDate: next.confirmedDate } : null,
      outstandingBase: new Decimal(line.outstandingBase).toFixed(4),
      daysLate: daysLate(expectedDate, today),
      confirmedLaterBy: confirmedLaterByOf(facts),
      reasons: expediteReasonsOf(facts),
      order,
    }
  })
  return { lines, complete: expected.complete }
}

/** Material and colour names of some lines, and the suppliers' names. */
export async function namesOf(db: Reader, lines: readonly { readonly itemId: string; readonly itemColourId: string | null }[], partyIds: readonly string[]) {
  const items = new Map((lines.length === 0 ? [] : await db.item.findMany({ where: { id: { in: [...new Set(lines.map((line) => line.itemId))] } }, select: { id: true, code: true, name: true, baseUom: true } })).map((row) => [row.id, row]))
  const colourIds = [...new Set(lines.flatMap((line) => (line.itemColourId ? [line.itemColourId] : [])))]
  const colours = new Map((colourIds.length === 0 ? [] : await db.itemColour.findMany({ where: { id: { in: colourIds } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
  const parties = new Map((partyIds.length === 0 ? [] : await db.party.findMany({ where: { id: { in: [...new Set(partyIds)] } }, select: { id: true, legalName: true } })).map((row) => [row.id, row.legalName]))
  return { items, colours, parties }
}
