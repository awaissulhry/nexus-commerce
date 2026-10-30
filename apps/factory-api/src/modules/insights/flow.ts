import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { ScopeFilter, Viewer } from '@nexus/factory-domain/insights/attention'
import {
  invoiceStageOf,
  LENS_RULES,
  lensesFor,
  lotStageOf,
  orderStageOf,
  purchaseOrderStageOf,
  RECENT_LOT_DAYS,
  stagesOf,
  workOrderStageOf,
  type FlowLens,
  type FlowRow,
} from '@nexus/factory-domain/insights/flow'
import { INVOICES_VIEW } from '@nexus/factory-domain/invoicing/permissions'
import { daysLate as workOrderDaysLate } from '@nexus/factory-domain/production/work-orders/machine'
import { WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import { PURCHASING_VIEW } from '@nexus/factory-domain/purchasing/permissions'
import { QUALITY_LOTS_VIEW } from '@nexus/factory-domain/quality/lab/permissions'
import { daysLate as orderDaysLate } from '@nexus/factory-domain/sales/orders/orders'
import { ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import type { CommandCaller } from '../../core/command'
import { ORDER_DEPOSIT_ONLY } from '../sales/deposits/deposits'
import { dayOrNull } from './sources/common'
import { scopeFilterOf, viewerOf } from './viewer'

/**
 * GET /home/flow (B-W1-52; SCR-031 W1 "Overview" on Today; design home.today `flow`): per lens the person can see
 * (factory-domain insights/flow lensesFor), its records by stage with how many are late and how old the oldest is.
 * Counts only. The company filter applies to every lens; the site filter to the lenses whose records have a site (work
 * orders, purchase orders, lots) and, for orders and invoices (no site), to the site's company. Read only.
 */

/** The most rows one lens reads (an answer says when it was reached). */
const FLOW_LIMIT = 5000

const OPEN_PO = ['DRAFT', 'SENT', 'CHANGES_PROPOSED', 'CONFIRMED', 'PARTLY_RECEIVED'] as const

/** The company (and site, where the record has one) filter of a lens's query. */
function filterWhere(filter: ScopeFilter, hasSite: boolean): Record<string, unknown> {
  const companyId = filter.site?.companyId ?? filter.companyId
  return {
    ...(companyId ? { companyId } : {}),
    ...(hasSite && filter.site ? { siteId: filter.site.id } : {}),
  }
}

interface LensRows {
  readonly rows: FlowRow[]
  readonly complete: boolean
}

type Reader = (db: FactoryClient, viewer: Viewer, filter: ScopeFilter) => Promise<LensRows>

const orders: Reader = async (db, viewer, filter) => {
  const where: Prisma.SalesOrderWhereInput = {
    AND: [scopeWhere(viewer.actor, ORDERS_VIEW, { company: 'companyId', party: 'partyId' }) as Prisma.SalesOrderWhereInput, filterWhere(filter, false), { status: { in: ['CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED', 'SHIPPED'] } }],
  }
  const found = await db.salesOrder.findMany({ where, take: FLOW_LIMIT + 1, select: { id: true, status: true, promiseDate: true, createdAt: true } })
  // The orders list's own deposit filter (deposit=OPEN): a deposit is needed and a request of it is still OPEN (the
  // deposit's own: a before-shipping step's request is the balance, B-W2a-F2).
  const waiting = new Set(
    (await db.salesOrder.findMany({ where: { AND: [where, { status: 'CONFIRMED' }, { depositRequired: true, depositRequests: { some: { status: 'OPEN', ...ORDER_DEPOSIT_ONLY } } }] }, select: { id: true } })).map((row) => row.id),
  )
  const rows = found.slice(0, FLOW_LIMIT).map((row) => ({
    stage: orderStageOf(row.status, waiting.has(row.id)),
    late: (orderDaysLate(row.status, dayOrNull(row.promiseDate), viewer.today) ?? 0) > 0,
    since: row.createdAt,
  }))
  return { rows, complete: found.length <= FLOW_LIMIT }
}

const workOrders: Reader = async (db, viewer, filter) => {
  const found = await db.workOrder.findMany({
    where: { AND: [scopeWhere(viewer.actor, WORKORDERS_VIEW, { company: 'companyId', site: 'siteId' }) as Prisma.WorkOrderWhereInput, filterWhere(filter, true), { status: { in: ['DRAFT', 'RELEASED', 'IN_PROGRESS', 'COMPLETED'] } }] },
    take: FLOW_LIMIT + 1,
    select: { status: true, dueDate: true, createdAt: true },
  })
  const rows = found.slice(0, FLOW_LIMIT).map((row) => ({ stage: workOrderStageOf(row.status), late: (workOrderDaysLate(row.status, dayOrNull(row.dueDate), viewer.today) ?? 0) > 0, since: row.createdAt }))
  return { rows, complete: found.length <= FLOW_LIMIT }
}

const purchaseOrders: Reader = async (db, viewer, filter) => {
  const found = await db.purchaseOrder.findMany({
    where: {
      AND: [
        scopeWhere(viewer.actor, PURCHASING_VIEW, { company: 'companyId', site: 'siteId', party: 'partyId' }) as Prisma.PurchaseOrderWhereInput,
        filterWhere(filter, true),
        { status: { in: [...OPEN_PO, 'RECEIVED'] } },
      ],
    },
    take: FLOW_LIMIT + 1,
    select: { status: true, requestedDate: true, createdAt: true },
  })
  const rows = found.slice(0, FLOW_LIMIT).map((row) => {
    const requested = dayOrNull(row.requestedDate)
    return { stage: purchaseOrderStageOf(row.status), late: requested !== null && requested < viewer.today && (OPEN_PO as readonly string[]).includes(row.status), since: row.createdAt }
  })
  return { rows, complete: found.length <= FLOW_LIMIT }
}

const invoices: Reader = async (db, viewer, filter) => {
  const found = await db.invoice.findMany({
    where: {
      AND: [
        scopeWhere(viewer.actor, INVOICES_VIEW, { company: 'companyId', party: 'buyerPartyId' }) as Prisma.InvoiceWhereInput,
        filterWhere(filter, false),
        { status: { in: ['DRAFT', 'ISSUED', 'ERROR', 'REJECTED', 'SENT', 'DELIVERED', 'NOT_DELIVERABLE'] } },
      ],
    },
    take: FLOW_LIMIT + 1,
    select: { id: true, status: true, docType: true, grossTotal: true, createdAt: true },
  })
  const delivered = found.filter((row) => row.status === 'DELIVERED' || row.status === 'NOT_DELIVERABLE').map((row) => row.id)
  const allocated = delivered.length > 0 ? await db.paymentAllocation.groupBy({ by: ['invoiceId'], where: { invoiceId: { in: delivered } }, _sum: { amount: true } }) : []
  const paidOf = new Map(allocated.map((row) => [row.invoiceId, row._sum.amount ?? 0]))
  const rows = found.slice(0, FLOW_LIMIT).map((row) => ({
    // A deposit invoice (TD02) bills money already received (the invoicing module's own rule).
    stage: invoiceStageOf(row.status, row.docType === 'TD02' || (paidOf.get(row.id) ?? 0) >= row.grossTotal),
    late: false,
    since: row.createdAt,
  }))
  return { rows, complete: found.length <= FLOW_LIMIT }
}

const lots: Reader = async (db, viewer, filter) => {
  const recent = new Date(viewer.now.getTime() - RECENT_LOT_DAYS * 86_400_000)
  const found = await db.lot.findMany({
    where: {
      AND: [
        scopeWhere(viewer.actor, QUALITY_LOTS_VIEW, { company: 'companyId', site: 'siteId' }) as Prisma.LotWhereInput,
        filterWhere(filter, true),
        { OR: [{ qualityStatus: { in: ['QUARANTINE', 'BLOCKED'] } }, { qualityStatus: { in: ['RELEASED', 'REJECTED'] }, qualityDecidedAt: { gte: recent } }] },
      ],
    },
    take: FLOW_LIMIT + 1,
    select: { qualityStatus: true, receivedAt: true, createdAt: true },
  })
  const rows = found.slice(0, FLOW_LIMIT).map((row) => ({ stage: lotStageOf(row.qualityStatus), late: false, since: row.receivedAt ?? row.createdAt }))
  return { rows, complete: found.length <= FLOW_LIMIT }
}

const READERS: Readonly<Record<FlowLens, Reader>> = Object.freeze({ ORDERS: orders, WORK_ORDERS: workOrders, PURCHASE_ORDERS: purchaseOrders, INVOICES: invoices, LOTS: lots })

export async function flow(caller: CommandCaller, query: { readonly companyId?: string | undefined; readonly siteId?: string | undefined }) {
  const viewer = viewerOf(caller)
  const filter = await scopeFilterOf(caller, query)
  const lenses = lensesFor(viewer.actor)
  const answer = await caller.withClient(async (db) => {
    const out = []
    for (const lens of lenses) {
      const { rows, complete } = await READERS[lens](db, viewer, filter)
      const rule = LENS_RULES[lens]
      out.push({ lens, label: rule.label, list: rule.list, stages: stagesOf(lens, rows, viewer.now), complete, live: { events: [...rule.live] } })
    }
    return out
  })
  return { asOf: toUtcIso(viewer.now), today: viewer.today, lenses: answer }
}
