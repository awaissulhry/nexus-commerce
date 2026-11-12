import type { Uom } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { THREADS_POST } from '@nexus/factory-domain/auth/permissions/catalogue'
import { INVENTORY_STOCK_VIEW } from '@nexus/factory-domain/inventory/permissions'
import type { GoodsReceiptStatus } from '@nexus/factory-domain/inventory/receipts/rules'
import { demandKey, proposeServes, reportHeld, type DemandFacts, type DemandKind, type LotFree, type ReportHeld, type ServeHeld, type ServeWhy } from '@nexus/factory-domain/inventory/reception-report/rules'
import { INVENTORY_RESERVE } from '@nexus/factory-domain/inventory/reservations/permissions'
import { isOpenOrder, isOpenWorkOrder, OPEN_WORK_ORDER_STATUSES } from '@nexus/factory-domain/inventory/reservations/rules'
import { Dec, ZERO, type Decimal } from '@nexus/factory-domain/tax/decimal'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { officeContextOf } from '../ledger/access'
import { readAtWorkOrder } from '../issue/store'
import { byId, dec, ids, readColours, RECEIPT_COLUMNS, RECEIPT_LINE_COLUMNS, type Reader, type ReceiptRow } from '../receipts/store'
import { readKeyFacts } from '../reservations/store'

/**
 * The reception report (B-W2b-300; SCM-119; design warehouse.receipts pop:rc-reception "which work orders and orders these goods
 * serve; allocate in one step"), read: per line of a POSTED receipt against a purchase order, the lots it brought and what of
 * each is free now (on hand, not held, not reserved), and the demands it serves —
 *
 *   PEGGED   the site's latest finished planning run pegged the receipt's order line to them (RequirementPegging, supply
 *            PURCHASE_ORDER: a work order, or an order line not yet made into one);
 *   NEEDS    the other open work orders of the site that plan the material and colour and still need some (an order made by
 *            hand has no pegging), earliest due first;
 *
 * each with what it still needs (a work order: its planned material less what is at it and what is reserved for it; an order
 * line: its pegged quantity less what is reserved for it), what of this receipt is reserved for it already, and what to reserve
 * now (factory-domain reception-report proposeServes). Office only, inventory.stock.view over the receipt's site; never a price
 * or a customer's name (the order's number and line only).
 */

const DEMANDS_PER_LINE = 50
const day = (value: Date | null): string | null => (value === null ? null : businessDate(value, 'UTC'))
const q = (value: Decimal): string => value.toFixed(4)

export async function visibleReceipt(caller: CommandCaller, receiptId: string): Promise<{ context: OfficeContext; receipt: ReceiptRow }> {
  const context = officeContextOf(caller)
  const receipt = isUuid(receiptId) ? await caller.withClient((client) => client.goodsReceipt.findUnique({ where: { id: receiptId }, select: RECEIPT_COLUMNS })) : null
  if (!receipt || !can(actorOf(context), INVENTORY_STOCK_VIEW, { companyId: receipt.companyId, siteId: receipt.siteId })) throw new NotFoundError('Goods receipt not found.')
  return { context, receipt }
}

export interface ServeView {
  readonly key: string
  readonly kind: DemandKind
  readonly why: ServeWhy
  readonly workOrder: { readonly id: string; readonly number: string; readonly status: string; readonly dueDate: string | null } | null
  readonly orderLine: { readonly id: string; readonly number: string; readonly seq: number; readonly status: string } | null
  readonly needDate: string | null
  readonly pegged: string | null
  readonly open: string
  readonly reservedHere: string
  readonly proposed: string
  readonly lots: { readonly lotId: string | null; readonly quantity: string }[]
  readonly held: ServeHeld | null
}

export interface LineReport {
  readonly receiptLineId: string
  readonly seq: number
  readonly purchaseOrderLineId: string | null
  readonly item: { readonly id: string; readonly code: string; readonly name: string; readonly baseUom: Uom; readonly tracking: 'NONE' | 'LOT' | 'HIDE' }
  readonly colour: { readonly id: string; readonly code: string; readonly name: string } | null
  readonly received: string
  readonly lots: { readonly id: string | null; readonly code: string | null; readonly qualityStatus: string | null; readonly free: string; readonly held: boolean }[]
  readonly serves: ServeView[]
  readonly left: string
}

export interface ReceptionReport {
  readonly receipt: { readonly id: string; readonly number: string; readonly status: GoodsReceiptStatus; readonly companyId: string; readonly siteId: string; readonly purchaseOrder: { readonly id: string; readonly number: string; readonly partyId: string } | null }
  readonly held: ReportHeld | null
  readonly run: { readonly id: string; readonly finishedAt: string | null } | null
  readonly buyer: { readonly id: string; readonly name: string } | null
  readonly lines: LineReport[]
  readonly proposals: number
}

/** The report of one receipt, read in `db` (a plain read, or inside the reserve's command under its locks). */
export async function readReport(db: Reader, receipt: ReceiptRow): Promise<ReceptionReport> {
  const order = receipt.purchaseOrderId ? await db.purchaseOrder.findUnique({ where: { id: receipt.purchaseOrderId }, select: { id: true, number: true, partyId: true, createdById: true } }) : null
  const held = reportHeld(receipt)
  const buyerRow = order?.createdById ? await db.user.findUnique({ where: { id: order.createdById }, select: { id: true, displayName: true, status: true } }) : null
  const head = {
    receipt: { id: receipt.id, number: receipt.number, status: receipt.status, companyId: receipt.companyId, siteId: receipt.siteId, purchaseOrder: order ? { id: order.id, number: order.number, partyId: order.partyId } : null },
    held,
    buyer: buyerRow && buyerRow.status === 'ACTIVE' ? { id: buyerRow.id, name: buyerRow.displayName } : null,
  }
  if (held) return { ...head, run: null, lines: [], proposals: 0 }

  const lines = await db.goodsReceiptLine.findMany({ where: { receiptId: receipt.id }, select: RECEIPT_LINE_COLUMNS, orderBy: { seq: 'asc' } })
  const items = byId(await db.item.findMany({ where: { id: { in: ids(lines.map((line) => line.itemId)) } }, select: { id: true, code: true, name: true, baseUom: true, tracking: true } }))
  const colours = await readColours(db, lines.map((line) => line.itemColourId))
  const lots = await db.lot.findMany({ where: { receiptLineId: { in: lines.map((line) => line.id) } }, orderBy: [{ code: 'asc' }, { id: 'asc' }], select: { id: true, code: true, receiptLineId: true, qualityStatus: true } })
  const run = await db.planningRun.findFirst({ where: { siteId: receipt.siteId, status: 'DONE' }, orderBy: [{ finishedAt: 'desc' }, { id: 'desc' }], select: { id: true, finishedAt: true } })
  const orderLineIds = lines.flatMap((line) => (line.purchaseOrderLineId ? [line.purchaseOrderLineId] : []))
  const pegging = run && orderLineIds.length > 0
    ? await db.requirementPegging.findMany({
        where: { runId: run.id, supplyKind: 'PURCHASE_ORDER', purchaseOrderLineId: { in: orderLineIds }, demandKind: { in: ['WORK_ORDER', 'ORDER_LINE'] } },
        orderBy: [{ demandDate: 'asc' }, { seq: 'asc' }, { id: 'asc' }],
        take: 2000,
        select: { purchaseOrderLineId: true, demandKind: true, workOrderId: true, salesOrderLineId: true, demandDate: true, quantity: true },
      })
    : []

  const out: LineReport[] = []
  let proposals = 0
  for (const line of lines) {
    const item = items.get(line.itemId)!
    const colour = line.itemColourId ? colours.get(line.itemColourId) : undefined
    const key = { siteId: receipt.siteId, itemId: line.itemId, itemColourId: line.itemColourId }
    const facts = await readKeyFacts(db, key, { withOrders: false })
    const mine = lots.filter((lot) => lot.receiptLineId === line.id)
    // Each lot's free quantity: its stock not held, less what is reserved of it (by lot or by one of its hides).
    const lotFree: (LotFree & { code: string | null; qualityStatus: string | null })[] =
      mine.length === 0
        ? [untrackedFree(facts, dec(line.baseQuantity))]
        : mine.map((lot) => {
            const parts = facts.stock.filter((part) => part.lotId === lot.id)
            const hides = new Set(parts.flatMap((part) => (part.hideId ? [part.hideId] : [])))
            const free = parts.filter((part) => !part.held).reduce((sum, part) => sum.plus(new Dec(part.onHand)), ZERO)
            const reserved = facts.rows.filter((row) => row.lotId === lot.id || (row.hideId !== null && hides.has(row.hideId))).reduce((sum, row) => sum.plus(dec(row.quantity).minus(dec(row.issuedQuantity))), ZERO)
            const onHand = parts.reduce((sum, part) => sum.plus(new Dec(part.onHand)), ZERO)
            return { lotId: lot.id, code: lot.code, qualityStatus: lot.qualityStatus, free: q(Dec.max(ZERO, free.minus(reserved))), held: onHand.gt(0) && parts.every((part) => part.held) }
          })
    const mineIds = new Set(mine.map((lot) => lot.id))
    const reservedHereOf = (demand: { workOrderId: string | null; salesOrderLineId: string | null }) =>
      facts.rows
        .filter((row) => (row.lotId !== null && mineIds.has(row.lotId)) || (mine.length === 0 && row.lotId === null && row.hideId === null))
        .filter((row) => (demand.workOrderId ? row.workOrderId === demand.workOrderId : row.salesOrderLineId === demand.salesOrderLineId))
        .reduce((sum, row) => sum.plus(dec(row.quantity).minus(dec(row.issuedQuantity))), ZERO)
    const reservedFor = (demand: { workOrderId: string | null; salesOrderLineId: string | null }) =>
      facts.rows.filter((row) => (demand.workOrderId ? row.workOrderId === demand.workOrderId : row.salesOrderLineId === demand.salesOrderLineId)).reduce((sum, row) => sum.plus(dec(row.quantity).minus(dec(row.issuedQuantity))), ZERO)

    // The demands: what the plan pegged to this order line, then the other open work orders that need the material.
    const pegged = new Map<string, { kind: DemandKind; workOrderId: string | null; salesOrderLineId: string | null; needDate: string | null; quantity: Decimal }>()
    for (const row of pegging.filter((entry) => entry.purchaseOrderLineId === line.purchaseOrderLineId)) {
      const kind = row.demandKind === 'WORK_ORDER' && row.workOrderId ? 'WORK_ORDER' : 'ORDER_LINE'
      const id = kind === 'WORK_ORDER' ? row.workOrderId : row.salesOrderLineId
      if (!id) continue
      const k = demandKey(kind, id)
      const entry = pegged.get(k) ?? { kind, workOrderId: kind === 'WORK_ORDER' ? id : null, salesOrderLineId: kind === 'ORDER_LINE' ? id : null, needDate: day(row.demandDate), quantity: ZERO }
      entry.quantity = entry.quantity.plus(dec(row.quantity))
      pegged.set(k, entry)
    }
    const planning = await db.workOrderMaterial.findMany({ where: { siteId: receipt.siteId, itemId: line.itemId, itemColourId: line.itemColourId, workOrder: { status: { in: [...OPEN_WORK_ORDER_STATUSES] } } }, select: { workOrderId: true, baseQuantity: true } })
    const required = new Map<string, Decimal>()
    for (const row of planning) required.set(row.workOrderId, (required.get(row.workOrderId) ?? ZERO).plus(dec(row.baseQuantity)))
    const workOrderIds = [...new Set([...required.keys(), ...[...pegged.values()].flatMap((entry) => (entry.workOrderId ? [entry.workOrderId] : []))])]
    const workOrders = byId(workOrderIds.length === 0 ? [] : await db.workOrder.findMany({ where: { id: { in: workOrderIds } }, select: { id: true, number: true, status: true, dueDate: true } }))
    const orderLineRows = byId(await db.salesOrderLine.findMany({ where: { id: { in: ids([...pegged.values()].map((entry) => entry.salesOrderLineId)) } }, select: { id: true, seq: true, orderId: true, promiseDate: true, requestedDate: true } }))
    const salesOrders = byId(orderLineRows.size === 0 ? [] : await db.salesOrder.findMany({ where: { id: { in: [...new Set([...orderLineRows.values()].map((row) => row.orderId))] } }, select: { id: true, number: true, status: true } }))

    const demandFacts: DemandFacts[] = []
    const views = new Map<string, Omit<ServeView, 'proposed' | 'lots' | 'held'>>()
    const openOfWorkOrder = async (workOrderId: string): Promise<Decimal> => {
      const at = (await readAtWorkOrder(db, receipt.siteId, workOrderId, { itemId: line.itemId, itemColourId: line.itemColourId })).reduce((sum, row) => sum.plus(new Dec(row.quantity)), ZERO)
      return Dec.max(ZERO, (required.get(workOrderId) ?? ZERO).minus(at).minus(reservedFor({ workOrderId, salesOrderLineId: null })))
    }
    const add = (facts: DemandFacts, view: Omit<ServeView, 'proposed' | 'lots' | 'held'>) => {
      demandFacts.push(facts)
      views.set(facts.key, view)
    }
    for (const [k, entry] of pegged) {
      if (entry.workOrderId) {
        const workOrder = workOrders.get(entry.workOrderId)
        if (!workOrder) continue
        const open = await openOfWorkOrder(workOrder.id)
        const facts: DemandFacts = { key: k, why: 'PEGGED', needDate: entry.needDate, pegged: q(entry.quantity), open: q(open), openDemand: isOpenWorkOrder(workOrder.status) }
        add(facts, { key: k, kind: 'WORK_ORDER', why: 'PEGGED', workOrder: { id: workOrder.id, number: workOrder.number, status: workOrder.status, dueDate: day(workOrder.dueDate) }, orderLine: null, needDate: entry.needDate, pegged: q(entry.quantity), open: q(open), reservedHere: q(reservedHereOf(entry)) })
      } else {
        const row = orderLineRows.get(entry.salesOrderLineId!)
        const order = row ? salesOrders.get(row.orderId) : undefined
        if (!row || !order) continue
        const open = Dec.max(ZERO, entry.quantity.minus(reservedFor(entry)))
        const facts: DemandFacts = { key: k, why: 'PEGGED', needDate: entry.needDate ?? day(row.promiseDate ?? row.requestedDate), pegged: q(entry.quantity), open: q(open), openDemand: isOpenOrder(order.status) }
        add(facts, { key: k, kind: 'ORDER_LINE', why: 'PEGGED', workOrder: null, orderLine: { id: row.id, number: order.number, seq: row.seq, status: order.status }, needDate: facts.needDate, pegged: q(entry.quantity), open: q(open), reservedHere: q(reservedHereOf(entry)) })
      }
    }
    const needing = [...required.keys()]
      .filter((id) => !pegged.has(demandKey('WORK_ORDER', id)) && workOrders.has(id))
      .sort((a, b) => (day(workOrders.get(a)!.dueDate) ?? '9999-12-31').localeCompare(day(workOrders.get(b)!.dueDate) ?? '9999-12-31') || workOrders.get(a)!.number.localeCompare(workOrders.get(b)!.number))
    for (const id of needing) {
      if (demandFacts.length >= DEMANDS_PER_LINE) break
      const workOrder = workOrders.get(id)!
      const open = await openOfWorkOrder(id)
      // A work order that needs nothing more stays listed when this receipt holds some for it (reserved here).
      const here = reservedHereOf({ workOrderId: id, salesOrderLineId: null })
      if (open.lte(0) && here.lte(0)) continue
      const k = demandKey('WORK_ORDER', id)
      add({ key: k, why: 'NEEDS', needDate: day(workOrder.dueDate), pegged: null, open: q(open), openDemand: true }, { key: k, kind: 'WORK_ORDER', why: 'NEEDS', workOrder: { id, number: workOrder.number, status: workOrder.status, dueDate: day(workOrder.dueDate) }, orderLine: null, needDate: day(workOrder.dueDate), pegged: null, open: q(open), reservedHere: q(here) })
    }

    const { plans, left } = proposeServes(demandFacts, lotFree)
    proposals += plans.filter((plan) => new Dec(plan.proposed).gt(0)).length
    out.push({
      receiptLineId: line.id,
      seq: line.seq,
      purchaseOrderLineId: line.purchaseOrderLineId,
      item: { id: item.id, code: item.code, name: item.name, baseUom: item.baseUom, tracking: item.tracking as 'NONE' | 'LOT' | 'HIDE' },
      colour: colour ? { id: colour.id, code: colour.code, name: colour.name } : null,
      received: q(dec(line.baseQuantity)),
      lots: lotFree.map((lot) => ({ id: lot.lotId, code: lot.code, qualityStatus: lot.qualityStatus, free: lot.free, held: lot.held })),
      serves: plans.map((plan) => ({ ...views.get(plan.key)!, proposed: plan.proposed, lots: [...plan.lots], held: plan.held })),
      left,
    })
  }
  return { ...head, run: run ? { id: run.id, finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null } : null, lines: out, proposals }
}

/** An untracked line: what of the material and colour is free now, at most what the line brought (reserved by material). */
function untrackedFree(facts: Awaited<ReturnType<typeof readKeyFacts>>, received: Decimal): LotFree & { code: null; qualityStatus: null } {
  const free = facts.stock.filter((part) => part.lotId === null && !part.held).reduce((sum, part) => sum.plus(new Dec(part.onHand)), ZERO)
  const reserved = facts.rows.filter((row) => row.lotId === null && row.hideId === null).reduce((sum, row) => sum.plus(dec(row.quantity).minus(dec(row.issuedQuantity))), ZERO)
  return { lotId: null, code: null, qualityStatus: null, free: q(Dec.min(received, Dec.max(ZERO, free.minus(reserved)))), held: false }
}

/** What the person may do with the report. */
export function reportCan(context: OfficeContext, report: ReceptionReport) {
  const actor = actorOf(context)
  const at = { companyId: report.receipt.companyId, siteId: report.receipt.siteId }
  const order = report.receipt.purchaseOrder
  return {
    reserve: report.held === null && report.proposals > 0 && can(actor, INVENTORY_RESERVE, at),
    send: report.held === null && order !== null && can(actor, THREADS_POST, { ...at, partyId: order.partyId }),
  }
}

/** GET /inventory/receipts/:receiptId/reception-report */
export async function receptionReport(caller: CommandCaller, receiptId: string) {
  const { context, receipt } = await visibleReceipt(caller, receiptId)
  const report = await caller.withClient((client) => readReport(client, receipt))
  return { ...report, can: reportCan(context, report) }
}
