import type { Prisma } from '@nexus/factory-db'
import { grantsFor } from '@nexus/factory-domain/core/permissions'
import { ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { OPEN_STATUSES } from '@nexus/factory-domain/sales/orders/orders'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { officeContextOf } from './access'
import { lateWhere, whereOf } from './orders'

/**
 * The Customer switcher's numbers (B-TH-019; threads plan TH-1a, picture 24; features SHEET.switcher-F01, -F04; wall test
 * T30): GET /sales/orders/customers lists the customers that have orders the reader may see — the same filter as the list
 * (scopeWhere over orders.view: the companies AND the customers its grants reach, so a person limited to customer A
 * (RoleAssignment.partyIds) never reads customer B's name nor any count of it) — most recent order first, with each
 * customer's open orders (not shipped yet: CONFIRMED, IN_PRODUCTION, READY, PARTLY_SHIPPED) and late orders (the one
 * definition: the promise passed and the order not shipped yet, the list's `late=true` and the board's Late tile).
 *
 * `q` finds a customer by name or code (case-insensitive); `companyId` narrows to one company (the list's own term). The
 * total says how many customers match, so the picker can say "type to find" beyond the first `limit`. Counts are read now
 * (`asOf`); the board (GET /sales/orders/board) takes the same customer term, `partyId`.
 */

export interface CustomersQuery {
  readonly q?: string | undefined
  readonly companyId?: string | undefined
  readonly limit: number
}

/** Party ids a search matches at most (a search wider than this should be narrowed). */
const SEARCH_CAP = 2000

export async function orderCustomers(caller: CommandCaller, query: CustomersQuery) {
  const context = officeContextOf(caller)
  const today: BusinessDate = businessDate(serverClock.now())
  return caller.withClient(async (client) => {
    const matching = query.q
      ? (
          await client.party.findMany({
            where: { OR: [{ legalName: { contains: query.q, mode: 'insensitive' } }, { code: { contains: query.q, mode: 'insensitive' } }] },
            select: { id: true },
            take: SEARCH_CAP,
          })
        ).map((party) => party.id)
      : null
    const base: Prisma.SalesOrderWhereInput = { AND: [whereOf(context, { companyId: query.companyId }, today), matching ? { partyId: { in: matching } } : {}] }
    const all = await client.salesOrder.groupBy({ by: ['partyId'], where: base, _count: { _all: true }, _max: { orderDate: true, createdAt: true } })
    const open = await client.salesOrder.groupBy({ by: ['partyId'], where: { AND: [base, { status: { in: [...OPEN_STATUSES] } }] }, _count: { _all: true } })
    const late = await client.salesOrder.groupBy({ by: ['partyId'], where: { AND: [base, lateWhere(today)] }, _count: { _all: true } })
    const parties = all.length > 0 ? await client.party.findMany({ where: { id: { in: all.map((row) => row.partyId) } }, select: { id: true, code: true, legalName: true, status: true } }) : []
    const partyOf = new Map(parties.map((party) => [party.id, party]))
    const openOf = new Map(open.map((row) => [row.partyId, row._count._all]))
    const lateOf = new Map(late.map((row) => [row.partyId, row._count._all]))
    const time = (value: Date | null | undefined): number => value?.getTime() ?? 0
    const customers = all
      .flatMap((row) => {
        const party = partyOf.get(row.partyId)
        return party
          ? [
              {
                id: party.id,
                code: party.code,
                name: party.legalName,
                archived: party.status === 'ARCHIVED',
                orders: row._count._all,
                open: openOf.get(row.partyId) ?? 0,
                late: lateOf.get(row.partyId) ?? 0,
                lastOrderDate: row._max.orderDate ? row._max.orderDate.toISOString().slice(0, 10) : null,
                ordered: time(row._max.orderDate),
                created: time(row._max.createdAt),
              },
            ]
          : []
      })
      // Recent first: the latest order date, then the latest order made, then the name.
      .sort((a, b) => b.ordered - a.ordered || b.created - a.created || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    return {
      customers: customers.slice(0, query.limit).map((row) => ({ id: row.id, code: row.code, name: row.name, archived: row.archived, orders: row.orders, open: row.open, late: row.late, lastOrderDate: row.lastOrderDate })),
      total: customers.length,
      // B-TH-226: limited when every grant of orders.view names its customers (RoleAssignment.partyIds): the switcher reads
      // "All my customers (n)", and a fixed label for one. Says nothing of the customers outside (no name, no count).
      limited: limitedToSomeCustomers(context),
      asOf: toUtcIso(serverClock.now()),
    }
  })
}

// ── B-TH-226 ──
/** The reader's orders.view reaches only some customers: every grant that holds it names its parties. */
// B-TH-058: exported for the overall view's "Your customers" (./summary).
export function limitedToSomeCustomers(context: ReturnType<typeof officeContextOf>): boolean {
  const grants = grantsFor(actorOf(context), ORDERS_VIEW)
  return grants.length > 0 && grants.every((grant) => grant.parties !== 'all')
}
// ── end B-TH-226 ──
