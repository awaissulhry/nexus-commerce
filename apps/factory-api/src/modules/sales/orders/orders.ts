import type { Prisma } from '@nexus/factory-db'
import { ConflictError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { BOARD_LANES, daysLate, OPEN_STATUSES, SALES_ORDER_STATUSES, type SalesOrderStatus } from '@nexus/factory-domain/sales/orders/orders'
import { ORDERS_MANAGE, ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { assertMay, officeContextOf } from './access'
import { makeOrderInCommand } from './make'
import { officeOrder, recordAfter } from './moves'
import { asDay, dayOf, dayOrNull, LEFT } from './store'
import type { OrderView } from './views'

/**
 * The office's sales orders (B-W1-25; SAL-200, SAL-204, SAL-206, SAL-214; A2 SCR-038 "Orders", SCR-039 "Order record"):
 * the list with its filters, the board's counts by state and the tiles (in W1 the board is these counts and saved rows:
 * the design's board view is W2a), the record, and the order of an accepted version made by the office when the
 * acceptance could not make it (no SALES_ORDER series then). The moves are ./moves.
 */

const todayNow = (): BusinessDate => businessDate(serverClock.now())

export async function getOrder(caller: CommandCaller, orderId: string): Promise<{ order: OrderView }> {
  const order = await officeOrder(caller, orderId)
  return { order: await recordAfter(caller, order.id) }
}

// ---- the list, the board, the tiles ------------------------------------------------------------------------------------

export interface ListFilters {
  readonly status?: SalesOrderStatus | undefined
  /** Only orders not shipped yet (CONFIRMED, IN_PRODUCTION, READY, PARTLY_SHIPPED). */
  readonly open?: 'true' | 'false' | undefined
  readonly companyId?: string | undefined
  readonly partyId?: string | undefined
  /** The promise passed and the order is not shipped yet. */
  readonly late?: 'true' | 'false' | undefined
  /** The order needs a deposit and a request of it is still OPEN. */
  readonly deposit?: 'OPEN' | undefined
  readonly promiseFrom?: BusinessDate | undefined
  readonly promiseTo?: BusinessDate | undefined
  /** Number or customer reference, case-insensitive. */
  readonly q?: string | undefined
}

export interface ListQuery extends ListFilters {
  readonly cursor?: string | undefined
  readonly limit: number
}

const lateWhere = (today: BusinessDate): Prisma.SalesOrderWhereInput => ({ status: { in: [...OPEN_STATUSES] }, promiseDate: { lt: asDay(today) } })
const depositOpenWhere: Prisma.SalesOrderWhereInput = { depositRequired: true, depositRequests: { some: { status: 'OPEN' } } }

function whereOf(context: OfficeContext, filters: ListFilters, today: BusinessDate): Prisma.SalesOrderWhereInput {
  return {
    AND: [
      scopeWhere(actorOf(context), ORDERS_VIEW, { company: 'companyId', party: 'partyId' }) as Prisma.SalesOrderWhereInput,
      filters.status ? { status: filters.status } : {},
      filters.open === 'true' ? { status: { in: [...OPEN_STATUSES] } } : {},
      filters.companyId ? { companyId: filters.companyId } : {},
      filters.partyId ? { partyId: filters.partyId } : {},
      filters.late === 'true' ? lateWhere(today) : {},
      filters.deposit === 'OPEN' ? depositOpenWhere : {},
      filters.promiseFrom ? { promiseDate: { gte: asDay(filters.promiseFrom) } } : {},
      filters.promiseTo ? { promiseDate: { lte: asDay(filters.promiseTo) } } : {},
      filters.q ? { OR: [{ number: { contains: filters.q, mode: 'insensitive' } }, { customerRef: { contains: filters.q, mode: 'insensitive' } }] } : {},
    ],
  }
}

type DepositState = 'NOT_NEEDED' | 'MISSING' | 'OPEN' | 'PAID' | 'WAIVED'

/** The orders the caller may see (its companies and parties), newest first, with SCR-038's columns. */
export async function listOrders(caller: CommandCaller, query: ListQuery) {
  const context = officeContextOf(caller)
  const today = todayNow()
  const where: Prisma.SalesOrderWhereInput = { AND: [whereOf(context, query, today), query.cursor ? { id: { lt: query.cursor } } : {}] }
  return caller.withClient(async (client) => {
    const rows = await client.salesOrder.findMany({
      where,
      orderBy: { id: 'desc' },
      take: query.limit + 1,
      select: { id: true, number: true, companyId: true, partyId: true, customerRef: true, status: true, orderDate: true, requestedDate: true, promiseDate: true, currency: true, netAmount: true, grossAmount: true, depositRequired: true, quoteVersionId: true, version: true, updatedAt: true },
    })
    const page = rows.slice(0, query.limit)
    const ids = page.map((row) => row.id)
    const lines = ids.length > 0 ? await client.salesOrderLine.groupBy({ by: ['orderId'], where: { orderId: { in: ids } }, _sum: { quantity: true }, _count: { _all: true } }) : []
    const deposits = ids.length > 0 ? await client.depositRequest.findMany({ where: { orderId: { in: ids } }, select: { orderId: true, status: true, dueDate: true }, orderBy: { dueDate: 'asc' } }) : []
    const shipments = ids.length > 0 ? await client.shipment.findMany({ where: { salesOrderId: { in: ids }, status: { in: [...LEFT] } }, select: { id: true, salesOrderId: true } }) : []
    const shipped = shipments.length > 0 ? await client.shipmentLine.groupBy({ by: ['shipmentId'], where: { shipmentId: { in: shipments.map((row) => row.id) } }, _sum: { quantity: true } }) : []
    const versionIds = page.flatMap((row) => (row.quoteVersionId ? [row.quoteVersionId] : []))
    const versions = versionIds.length > 0 ? await client.quoteVersion.findMany({ where: { id: { in: versionIds } }, select: { id: true, quoteId: true, revision: true } }) : []
    const quotes = versions.length > 0 ? await client.quote.findMany({ where: { id: { in: [...new Set(versions.map((row) => row.quoteId))] } }, select: { id: true, number: true } }) : []
    const parties = new Map((await client.party.findMany({ where: { id: { in: [...new Set(page.map((row) => row.partyId))] } }, select: { id: true, legalName: true } })).map((row) => [row.id, row.legalName]))
    const shippedOf = new Map<string, number>()
    for (const row of shipped) {
      const orderId = shipments.find((shipment) => shipment.id === row.shipmentId)!.salesOrderId
      shippedOf.set(orderId, (shippedOf.get(orderId) ?? 0) + (row._sum.quantity ?? 0))
    }
    return {
      orders: page.map((row) => {
        const own = deposits.filter((deposit) => deposit.orderId === row.id && deposit.status !== 'CANCELLED')
        const open = own.find((deposit) => deposit.status === 'OPEN')
        const state: DepositState = !row.depositRequired ? 'NOT_NEEDED' : open ? 'OPEN' : own.some((deposit) => deposit.status === 'PAID') ? 'PAID' : own.some((deposit) => deposit.status === 'WAIVED') ? 'WAIVED' : 'MISSING'
        const version = versions.find((entry) => entry.id === row.quoteVersionId)
        const quote = version ? quotes.find((entry) => entry.id === version.quoteId) : undefined
        const count = lines.find((entry) => entry.orderId === row.id)
        const promiseDate = dayOrNull(row.promiseDate)
        return {
          id: row.id,
          number: row.number,
          companyId: row.companyId,
          partyId: row.partyId,
          partyName: parties.get(row.partyId) ?? '',
          customerRef: row.customerRef,
          status: row.status,
          deposit: { state, dueDate: open ? dayOf(open.dueDate) : null },
          lineCount: count?._count._all ?? 0,
          units: count?._sum.quantity ?? 0,
          shippedUnits: shippedOf.get(row.id) ?? 0,
          orderDate: dayOf(row.orderDate),
          requestedDate: dayOrNull(row.requestedDate),
          promiseDate,
          daysLate: daysLate(row.status, promiseDate, today),
          currency: row.currency,
          netAmount: asMoney('price', row.netAmount),
          grossAmount: asMoney('price', row.grossAmount),
          quote: quote && version ? { id: quote.id, number: quote.number, versionId: version.id, revision: version.revision } : null,
          version: row.version,
          updatedAt: toUtcIso(row.updatedAt),
        }
      }),
      nextCursor: rows.length > query.limit ? page[page.length - 1]!.id : null,
    }
  })
}

/** The tiles (the design's saved-filter tiles): each count is the list's total under its filter. */
const TILES = ['late', 'waitingForDeposit', 'inProduction', 'readyToShip'] as const

/**
 * The board (SAL-214; W1: the state counts as tiles and lanes, the drag-free board view is W2a): the count of every
 * state under the list's filters (scope, company, party, promise range, search), the board's lanes, and the tiles with
 * the filter each stands for.
 */
export async function orderBoard(caller: CommandCaller, filters: Pick<ListFilters, 'companyId' | 'partyId' | 'promiseFrom' | 'promiseTo' | 'q'>) {
  const context = officeContextOf(caller)
  const today = todayNow()
  const base = whereOf(context, filters, today)
  return caller.withClient(async (client) => {
    const grouped = await client.salesOrder.groupBy({ by: ['status'], where: base, _count: { _all: true } })
    const countOf = (status: SalesOrderStatus) => grouped.find((row) => row.status === status)?._count._all ?? 0
    const late = await client.salesOrder.count({ where: { AND: [base, lateWhere(today)] } })
    const deposit = await client.salesOrder.count({ where: { AND: [base, depositOpenWhere] } })
    const counts: Record<(typeof TILES)[number], { count: number; filter: Record<string, string> }> = {
      late: { count: late, filter: { late: 'true' } },
      waitingForDeposit: { count: deposit, filter: { deposit: 'OPEN' } },
      inProduction: { count: countOf('IN_PRODUCTION'), filter: { status: 'IN_PRODUCTION' } },
      readyToShip: { count: countOf('READY'), filter: { status: 'READY' } },
    }
    return {
      byStatus: SALES_ORDER_STATUSES.map((status) => ({ status, count: countOf(status) })),
      lanes: [...BOARD_LANES],
      tiles: TILES.map((key) => ({ key, ...counts[key] })),
      asOf: toUtcIso(serverClock.now()),
    }
  })
}

// ---- the order of an accepted version, by the office ------------------------------------------------------------------

/**
 * orders.manage: the order of an accepted quote version, when the acceptance could not make it (its company had no
 * active SALES_ORDER series then): 201 with the new order, 200 with the one that exists. The version's row is locked
 * first, as the acceptance's own step does, so the two never make two orders.
 */
export async function makeOrder(caller: CommandCaller, body: { readonly quoteVersionId: string }, idempotencyKey?: string): Promise<{ created: boolean; order: OrderView }> {
  const context = officeContextOf(caller)
  const scope = isUuid(body.quoteVersionId)
    ? await caller.withClient(async (client) => {
        const version = await client.quoteVersion.findUnique({ where: { id: body.quoteVersionId }, select: { quoteId: true } })
        return version ? client.quote.findUnique({ where: { id: version.quoteId }, select: { companyId: true, partyId: true } }) : null
      })
    : null
  assertMay(context, ORDERS_MANAGE, scope, 'Quote version')
  const { result } = await command(caller, { name: 'orders.make', idempotencyKey, input: body }, async (tools) => {
    const locked = await tools.tx.$queryRaw<{ id: string }[]>`SELECT id FROM "QuoteVersion" WHERE id = ${body.quoteVersionId}::uuid FOR UPDATE`
    if (locked.length === 0) throw new NotFoundError('Quote version not found.')
    const made = await makeOrderInCommand(tools, body.quoteVersionId)
    if (!made.order) throw new ConflictError('The company has no active SALES_ORDER number series: an administrator adds one under Numbering, then the order can be made.')
    if (!made.created) tools.audit({ action: 'orders.make', recordType: 'SalesOrder', recordId: made.order.id, companyId: scope!.companyId, after: { existing: true, linkedDepositRequestIds: made.linkedDepositRequestIds } })
    return { created: made.created, orderId: made.order.id }
  })
  return { created: result.created, order: await recordAfter(caller, result.orderId) }
}
