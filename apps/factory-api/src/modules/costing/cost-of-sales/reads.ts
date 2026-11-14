import type { Prisma } from '@nexus/factory-db'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate, businessDayRange, businessDayStart, toUtcIso } from '@nexus/factory-domain/core/time'
import type { CogsAnswer, CogsEntryView, CogsQuery } from '@nexus/factory-domain/costing/cost-of-sales/contracts'
import { perUnit } from '@nexus/factory-domain/costing/cost-of-sales/rules'
import { COSTING_VIEW } from '@nexus/factory-domain/costing/permissions'
import { asMoney } from '@nexus/factory-domain/money/marked'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { contextOf } from '../../product/materials/store'
import { unique, type Reader } from '../actual/store'
import { waitsOf } from '../ppv/settings'

/**
 * The cost of goods sold (B-W2b-407; FIN-043; design finance.accounting "cost of goods sold and variances"), office reads
 * with costing.view over the entry's company and customer (scopeWhere), newest first, a page at a time; the totals per
 * currency cover every page of the query. Every amount is money.cost.
 */

const SCOPE = { company: 'companyId', party: 'partyId' } as const
const PAGE = 100

export const ENTRY_COLUMNS = {
  id: true,
  companyId: true,
  partyId: true,
  siteId: true,
  shipmentLineId: true,
  stockMoveId: true,
  quantity: true,
  materialAmount: true,
  labourAmount: true,
  subcontractAmount: true,
  overheadAmount: true,
  amount: true,
  currency: true,
  postedAt: true,
  reversalOfId: true,
  reason: true,
} as const satisfies Prisma.CostOfSalesEntrySelect
export type EntryRow = Prisma.CostOfSalesEntryGetPayload<{ select: typeof ENTRY_COLUMNS }>

/** The entries as the screens show them: the customer, the shipment and its line (size, work order), the reversal. */
export async function cogsViews(db: Reader, rows: readonly EntryRow[]): Promise<CogsEntryView[]> {
  if (rows.length === 0) return []
  const parties = new Map((await db.party.findMany({ where: { id: { in: unique(rows.map((row) => row.partyId)) } }, select: { id: true, legalName: true, tradeName: true } })).map((row) => [row.id, row.tradeName ?? row.legalName]))
  const lines = new Map((await db.shipmentLine.findMany({ where: { id: { in: unique(rows.map((row) => row.shipmentLineId)) } }, select: { id: true, shipmentId: true, size: true, salesOrderLineId: true, workOrderId: true } })).map((row) => [row.id, row]))
  const shipments = new Map((await db.shipment.findMany({ where: { id: { in: unique([...lines.values()].map((row) => row.shipmentId)) } }, select: { id: true, number: true } })).map((row) => [row.id, row.number]))
  const workOrders = new Map((await db.workOrder.findMany({ where: { id: { in: unique([...lines.values()].map((row) => row.workOrderId)) } }, select: { id: true, number: true } })).map((row) => [row.id, row.number]))
  const reversals = new Map((await db.costOfSalesEntry.findMany({ where: { reversalOfId: { in: rows.map((row) => row.id) } }, select: { id: true, reversalOfId: true, postedAt: true, reason: true } })).map((row) => [row.reversalOfId!, row]))
  return rows.map((row) => {
    const line = lines.get(row.shipmentLineId ?? '')
    const reversedBy = reversals.get(row.id)
    const quantity = row.quantity.toFixed(4)
    return {
      id: row.id,
      companyId: row.companyId,
      customer: { id: row.partyId, name: parties.get(row.partyId) ?? '' },
      shipment: { id: line?.shipmentId ?? '', number: shipments.get(line?.shipmentId ?? '') ?? '' },
      line: { id: row.shipmentLineId ?? '', size: line?.size ?? '', salesOrderLineId: line?.salesOrderLineId ?? '', workOrder: { id: line?.workOrderId ?? '', number: workOrders.get(line?.workOrderId ?? '') ?? '' } },
      stockMoveId: row.stockMoveId,
      postedAt: toUtcIso(row.postedAt),
      day: businessDate(row.postedAt),
      quantity,
      materialAmount: asMoney('cost', row.materialAmount),
      labourAmount: asMoney('cost', row.labourAmount),
      subcontractAmount: asMoney('cost', row.subcontractAmount),
      overheadAmount: asMoney('cost', row.overheadAmount),
      amount: asMoney('cost', row.amount),
      unitCost: asMoney('cost', perUnit(row.amount, quantity, row.currency)),
      currency: row.currency,
      reversalOfId: row.reversalOfId,
      reversedBy: reversedBy ? { id: reversedBy.id, postedAt: toUtcIso(reversedBy.postedAt), reason: reversedBy.reason } : null,
      reason: row.reason,
    }
  })
}

/** GET /costing/cost-of-sales */
export async function cogsList(caller: CommandCaller, query: CogsQuery): Promise<CogsAnswer> {
  const actor = actorOf(contextOf(caller))
  const limit = query.limit ?? PAGE
  return caller.withClient(async (db) => {
    const lineIds = query.shipmentId ? (await db.shipmentLine.findMany({ where: { shipmentId: query.shipmentId }, select: { id: true } })).map((row) => row.id) : null
    const base: Prisma.CostOfSalesEntryWhereInput[] = [
      scopeWhere(actor, COSTING_VIEW, SCOPE) as Prisma.CostOfSalesEntryWhereInput,
      query.companyId ? { companyId: query.companyId } : {},
      query.partyId ? { partyId: query.partyId } : {},
      query.from ? { postedAt: { gte: businessDayStart(query.from) } } : {},
      query.to ? { postedAt: { lt: businessDayRange(query.to).end } } : {},
      lineIds ? { shipmentLineId: { in: lineIds } } : {},
    ]
    const rows = await db.costOfSalesEntry.findMany({ where: { AND: [...base, query.cursor ? { id: { lt: query.cursor } } : {}] }, select: ENTRY_COLUMNS, orderBy: { id: 'desc' }, take: limit + 1 })
    const page = rows.slice(0, limit)
    const sums = await db.costOfSalesEntry.groupBy({
      by: ['currency'],
      where: { AND: base },
      _sum: { materialAmount: true, labourAmount: true, subcontractAmount: true, overheadAmount: true, amount: true },
      _count: { _all: true },
      orderBy: { currency: 'asc' },
    })
    return {
      entries: await cogsViews(db, page),
      nextCursor: rows.length > limit ? page.at(-1)!.id : null,
      totals: sums.map((row) => ({
        currency: row.currency,
        materialAmount: asMoney('cost', row._sum.materialAmount ?? 0),
        labourAmount: asMoney('cost', row._sum.labourAmount ?? 0),
        subcontractAmount: asMoney('cost', row._sum.subcontractAmount ?? 0),
        overheadAmount: asMoney('cost', row._sum.overheadAmount ?? 0),
        amount: asMoney('cost', row._sum.amount ?? 0),
        entries: row._count._all,
      })),
      waits: await waitsOf(db, query.companyId),
      empty: 'No cost of goods sold in this period: no shipment that left has its cost posted yet.',
    }
  })
}
