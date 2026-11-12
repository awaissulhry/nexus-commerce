import type { Prisma } from '@nexus/factory-db'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { asMoney } from '@nexus/factory-domain/money/marked'
import type { PurchaseOrderStatus } from '@nexus/factory-domain/purchasing/orders'
import { PURCHASING_VIEW } from '@nexus/factory-domain/purchasing/permissions'
import { SAMPLE_ORDER_KIND } from '@nexus/factory-domain/purchasing/sample-orders/rules'
import type { SampleKind, SampleStage } from '@nexus/factory-domain/sales/samples/rules'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { dayOf, officeContextOf, type Reader } from '../store'

/**
 * GET /purchasing/sample-orders (purchasing.view; design purchasing.sourcing sec "Sample and development orders", SCR-222): the
 * purchase orders of kind SAMPLE the caller reaches (can() over the company, delivery site and supplier, as W1's list), newest
 * first, each with its supplier, the development project (style and sample round), what it buys (the first materials, the line
 * count), its status and its value (a cost: dropped without the cost grain). OPEN leaves out the cancelled, closed and fully
 * received ones. A row opens W1's PO record (`/purchasing/orders/<id>`), which says it is a sample order.
 */

const CLOSED: readonly PurchaseOrderStatus[] = ['CANCELLED', 'CLOSED', 'RECEIVED']
/** The materials a row names (the rest is its line count). */
const ITEMS_SHOWN = 3

export interface ListSampleOrdersQuery {
  readonly companyId?: string | undefined
  readonly rows: 'OPEN' | 'ALL'
  readonly status?: PurchaseOrderStatus | undefined
  readonly styleId?: string | undefined
  readonly q?: string | undefined
  readonly cursor?: string | undefined
  readonly limit: number
}

const ROW_SELECT = {
  id: true,
  number: true,
  companyId: true,
  siteId: true,
  partyId: true,
  status: true,
  revision: true,
  currency: true,
  orderDate: true,
  requestedDate: true,
  netAmount: true,
  sentAt: true,
  updatedAt: true,
  version: true,
  party: { select: { legalName: true } },
  developmentStyle: { select: { id: true, code: true, name: true } },
  sampleRound: { select: { id: true, number: true, kind: true, roundNo: true, stage: true } },
} as const satisfies Prisma.PurchaseOrderSelect
type Row = Prisma.PurchaseOrderGetPayload<{ select: typeof ROW_SELECT }>

/** One row of the list, read in this scope (also the answer of New sample order). */
export async function sampleRowsOf(db: Reader, rows: readonly Row[]) {
  const ids = rows.map((row) => row.id)
  const lines =
    ids.length === 0
      ? []
      : await db.purchaseOrderLine.findMany({
          where: { purchaseOrderId: { in: ids }, cancelledAt: null },
          orderBy: [{ purchaseOrderId: 'asc' }, { seq: 'asc' }],
          select: { purchaseOrderId: true, description: true, item: { select: { code: true, name: true, kind: true } } },
        })
  return rows.map((row) => {
    const own = lines.filter((line) => line.purchaseOrderId === row.id)
    return {
      id: row.id,
      number: row.number,
      companyId: row.companyId,
      siteId: row.siteId,
      partyId: row.partyId,
      supplierName: row.party.legalName,
      status: row.status,
      revision: row.revision,
      currency: row.currency,
      orderDate: dayOf(row.orderDate)!,
      requestedDate: dayOf(row.requestedDate),
      style: row.developmentStyle,
      round: row.sampleRound ? { ...row.sampleRound, kind: row.sampleRound.kind as SampleKind, stage: row.sampleRound.stage as SampleStage } : null,
      items: own.slice(0, ITEMS_SHOWN).map((line) => ({ code: line.item.code, name: line.item.name, kind: line.item.kind, description: line.description })),
      lineCount: own.length,
      netAmount: asMoney('cost', row.netAmount),
      sentAt: row.sentAt === null ? null : toUtcIso(row.sentAt),
      updatedAt: toUtcIso(row.updatedAt),
      version: row.version,
    }
  })
}

/** The row of one sample order (the create's answer), in this scope. */
export async function sampleRowOf(db: Reader, orderId: string) {
  const row = await db.purchaseOrder.findUniqueOrThrow({ where: { id: orderId }, select: ROW_SELECT })
  return (await sampleRowsOf(db, [row]))[0]!
}

export async function listSampleOrders(caller: CommandCaller, query: ListSampleOrdersQuery) {
  const context = officeContextOf(caller)
  const scope = scopeWhere(actorOf(context), PURCHASING_VIEW, { company: 'companyId', site: 'siteId', party: 'partyId' }) as Prisma.PurchaseOrderWhereInput
  const q = query.q
  const where: Prisma.PurchaseOrderWhereInput = {
    AND: [
      scope,
      { kind: SAMPLE_ORDER_KIND },
      query.companyId ? { companyId: query.companyId } : {},
      query.status ? { status: query.status } : query.rows === 'OPEN' ? { status: { notIn: [...CLOSED] } } : {},
      query.styleId ? { developmentStyleId: query.styleId } : {},
      q
        ? {
            OR: [
              { number: { contains: q, mode: 'insensitive' } },
              { party: { legalName: { contains: q, mode: 'insensitive' } } },
              { developmentStyle: { code: { contains: q, mode: 'insensitive' } } },
              { developmentStyle: { name: { contains: q, mode: 'insensitive' } } },
            ],
          }
        : {},
      query.cursor ? { id: { lt: query.cursor } } : {},
    ],
  }
  const readAt = toUtcIso(serverClock.now())
  return caller.withClient(async (client) => {
    const rows = await client.purchaseOrder.findMany({ where, orderBy: { id: 'desc' }, take: query.limit + 1, select: ROW_SELECT })
    const page = rows.slice(0, query.limit)
    return { orders: await sampleRowsOf(client, page), nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null, readAt }
  })
}
