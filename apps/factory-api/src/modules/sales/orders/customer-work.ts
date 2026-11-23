import type { Prisma } from '@nexus/factory-db'
import { THREADS_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, grantsFor, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { PARTIES_VIEW } from '@nexus/factory-domain/parties/permissions'
import { PRIORITY_LEVELS, type PriorityLevel } from '@nexus/factory-domain/planning/backlog/rank'
import { ORDER_PHASES, type OrderPhase } from '@nexus/factory-domain/production-brand/stages'
import { PROMISE_STATUSES } from '@nexus/factory-domain/sales/customer-360/glance'
import { OPEN_STATUSES } from '@nexus/factory-domain/sales/orders/orders'
import { ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { waitingRowsOf } from '../../../platform/threads/waiting-list'
import { PARTY_SCOPE } from '../../parties/store'
import { usePartyWork, type PartyWork, type PartyWorkFacts } from '../../parties/work'
import { beforeOrderCountsByParty } from '../before-order/counts' // B-CL-009 (cq's one rule for "to answer" / "open quotes")
import type { BeforeOrderCounts } from '@nexus/factory-domain/sales/before-order/contracts' // B-CL-009
import { brandRequestWhere } from '../../production/brand-requests/read'
import { officeContextOf } from './access'
import { customerUrgencyWhere } from './customer-urgency'
import { limitedToSomeCustomers } from './customers'
import { depositOpenWhere, lateWhere, whereOf } from './orders'
import { phaseCountsByParty } from './production-columns'
import { asDay, dayOf, type Reader } from './store'

/**
 * B-CL-001 / B-CL-003 (customers list, 13-backend §1, §3, §4; settles T2, T3, T13): where each customer's work stands.
 *
 * ONE function for the shared facts — `partyWorkKeys` — read by the parties list (through its registered reader: the band, the
 * `work=` door and "Most urgent first") with no ids, and by GET /sales/orders/customers/work with the page's ids. Same wheres, same
 * helpers, only `partyId in` added, so a row's chips, its band group and its place in the order come from one computation.
 *
 * Every statement runs on the reader's own orders (./orders whereOf: scopeWhere over orders.view, every company — the Work tab's
 * scope), one after another on the one scoped client (never Promise.all inside withClient). Each count is the rows its door opens on
 * the customer's Work tab (`GET /sales/orders?partyId=X&<term>`):
 *
 *   phases          cw's counter phaseCountsByParty (the where passed is the wall)          door phase=<P>
 *   late            the list's one definition (lateWhere)                                   door late=true
 *   requests        the customer requests still OPEN the reader reaches (brandRequestWhere), the oldest first — its id opens the review
 *                   window (as the Work strip counts them)                                   door open=<firstId>
 *   replies         the conversations whose customer wrote last (platform/threads waitingRowsOf, its wall per row; threads.read, else
 *                   0 here and `replies` withheld on the route)                             door thread=all
 *   waitsForYes     PENDING_APPROVAL                                                         door status=PENDING_APPROVAL
 *   waitsForDeposit CONFIRMED with the deposit still open (cw's notSent.waitsForDeposit) — the band's hint inside Not sent
 *   best            its most urgent OPEN order (CONFIRMED · IN_PRODUCTION · READY · PARTLY_SHIPPED — the set the Top / High chips and
 *                   their door rows=open&priority=… count; settle T31: an order waiting for a yes never lifts a customer by its level,
 *                   it is said by "Waiting for a yes") by planning's rule order (our level, our priority number, its promise) — the
 *                   needs order's second key; the customer's own urgency is not a key (settle T3)
 *
 * A customer the reader's orders.view does not reach is never in the facts (T13: a request or a reply of a party seen only through
 * parties.view or workorders.view counts nowhere here), and one with nothing to count is absent (never a row of zeros).
 *
 * The route adds per customer, for the page only: all its orders and its last order date (the switcher's rule), the deposits open
 * in every state (the Work strip's tile), the customer's own Urgent marks per company (ranks and quota are per company), our levels
 * Top and High among the open orders, the next promise (promisesOf.next over every company: a passed promise is said only by Late),
 * and the newest order (the picture's). No amount anywhere; no person.
 *
 * B-CL-009 (settle T19): + `beforeOrder` — "to answer" (groups.TO_ANSWER) and "open quotes" (openQuotes) of the Quotes & incoming
 * lane's ONE rule (../before-order/counts beforeOrderCountsByParty, the same numbers as GET /sales/before-order/counts), asked
 * with the R0 reached ids only (it answers 0s for an id out of reach); a part the reader holds no right of is LEFT OUT, never 0.
 */

// ---- the shared facts ---------------------------------------------------------------------------------------------------

const NO_PROMISE = '9999-12-31'
type Best = NonNullable<PartyWork['best']>

/** The more urgent of two orders by planning's rule order: our level (Top first), our priority number (higher first), the promise (none last). */
function moreUrgent(kept: Best | null, next: Best): Best {
  if (!kept) return next
  if (kept.level !== next.level) return PRIORITY_LEVELS.indexOf(kept.level) <= PRIORITY_LEVELS.indexOf(next.level) ? kept : next
  if (kept.priority !== next.priority) return kept.priority > next.priority ? kept : next
  return (kept.promise ?? NO_PROMISE) <= (next.promise ?? NO_PROMISE) ? kept : next
}

/** A customer's work while the statements fill it. */
interface Filling {
  phases: Record<OrderPhase, number>
  requests: number
  replies: number
  late: number
  firstRequestId: string | null
  waitsForYes: number
  waitsForDeposit: number
  best: Best | null
}

const emptyPhases = (): Record<OrderPhase, number> => ({ NOT_SENT: 0, NOT_STARTED: 0, IN_PRODUCTION: 0, READY: 0, SHIPPED: 0, DONE: 0, CANCELLED: 0 })

/**
 * The work facts of the reader's customers (all of them, or only `partyIds`), 8 statements and the waiting read's own. The ONE body
 * of the band, the `work=` door, the needs order and the route's chips (13-backend §1).
 */
export async function partyWorkKeys(client: Reader, context: OfficeContext, today: BusinessDate, partyIds?: readonly string[]): Promise<PartyWorkFacts> {
  const actor = actorOf(context)
  const base = whereOf(context, {}, today)
  const only: Prisma.SalesOrderWhereInput = partyIds ? { partyId: { in: [...partyIds] } } : {}
  const scoped = (...terms: Prisma.SalesOrderWhereInput[]): Prisma.SalesOrderWhereInput => ({ AND: [base, ...terms, only] })
  /** A request or a reply counts only for a customer the reader's orders reach (T13). */
  const reachesOrders = (partyId: string): boolean => can(actor, ORDERS_VIEW, { partyId })
  const filled = new Map<string, Filling>()
  const of = (partyId: string): Filling => {
    const known = filled.get(partyId)
    if (known) return known
    const fresh: Filling = { phases: emptyPhases(), requests: 0, replies: 0, late: 0, firstRequestId: null, waitsForYes: 0, waitsForDeposit: 0, best: null }
    filled.set(partyId, fresh)
    return fresh
  }

  // K1–K2: the seven phases (cw S1's counter; a customer with no order is absent from its map).
  for (const [partyId, phases] of await phaseCountsByParty(client, scoped())) of(partyId).phases = { ...phases }
  // K3: late (the promise passed, not shipped yet).
  for (const row of await client.salesOrder.groupBy({ by: ['partyId'], where: scoped(lateWhere(today)), _count: { _all: true } })) of(row.partyId).late = row._count._all
  // K4: the requests to answer, the oldest first (its id is the review window's door); none reached: none.
  const reach = brandRequestWhere(actor)
  if (reach) {
    const requests = await client.orderChangeRequest.findMany({
      where: { AND: [reach, { status: 'OPEN' }, partyIds ? { partyId: { in: [...partyIds] } } : {}] },
      select: { id: true, partyId: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })
    for (const request of requests) {
      if (!reachesOrders(request.partyId)) continue
      const work = of(request.partyId)
      work.requests += 1
      work.firstRequestId ??= request.id
    }
  }
  // K5: the replies waiting on us (the threads' one waiting rule and wall; [] without threads.read).
  const waiting = await waitingRowsOf(client, context, { side: 'CUSTOMER', partyIds })
  for (const row of waiting.rows) if (reachesOrders(row.partyId)) of(row.partyId).replies += 1
  // K6: waiting for a yes.
  for (const row of await client.salesOrder.groupBy({ by: ['partyId'], where: scoped({ status: 'PENDING_APPROVAL' }), _count: { _all: true } })) of(row.partyId).waitsForYes = row._count._all
  // K7: confirmed, the deposit still open (cw's notSent.waitsForDeposit, the board's B-CW-003 where).
  for (const row of await client.salesOrder.groupBy({ by: ['partyId'], where: scoped({ status: 'CONFIRMED' }, depositOpenWhere), _count: { _all: true } })) of(row.partyId).waitsForDeposit = row._count._all
  // K8: the most urgent OPEN order (per level and number, the earliest promise; then the best of them). T31: OPEN_STATUSES, the set
  // of the Top / High chips and their door (rows=open) — an order waiting for a yes never lifts its customer by its level.
  for (const row of await client.salesOrder.groupBy({ by: ['partyId', 'priorityLevel', 'priority'], where: scoped({ status: { in: [...OPEN_STATUSES] } }), _min: { promiseDate: true } })) {
    const work = of(row.partyId)
    work.best = moreUrgent(work.best, { level: row.priorityLevel as PriorityLevel, priority: row.priority, promise: row._min.promiseDate ? dayOf(row._min.promiseDate) : null })
  }

  const byParty = new Map<string, PartyWork>()
  for (const [partyId, work] of filled) {
    byParty.set(partyId, {
      phases: work.phases,
      waiting: { requests: work.requests, replies: work.replies, late: work.late },
      firstRequestId: work.firstRequestId,
      waitsForYes: work.waitsForYes,
      waitsForDeposit: work.waitsForDeposit,
      best: work.best,
    })
  }
  return { byParty, repliesComplete: waiting.complete, limited: limitedToSomeCustomers(context) }
}

// ---- GET /sales/orders/customers/work?partyIds= -------------------------------------------------------------------------

/** The most customers one read names (a page of the list's rows). */
export const PARTY_IDS_TERM_MAX = 50

/** The customer ids of the `partyIds=` term (each once), or a 400 in words. */
export function partyIdsTermOf(text: string): string[] {
  const ids = [...new Set(text.split(',').map((value) => value.trim()).filter((value) => value !== ''))]
  if (ids.length === 0 || ids.length > PARTY_IDS_TERM_MAX || ids.some((value) => !isUuid(value))) {
    throw new ValidationError(`Name 1 to ${PARTY_IDS_TERM_MAX} customers by id, comma separated.`, [{ path: 'query/partyIds', message: `1 to ${PARTY_IDS_TERM_MAX} customer ids, comma separated.` }])
  }
  return ids
}

/** One customer's row of the route (counts and days only). */
export interface CustomerWorkRow {
  readonly partyId: string
  /** Every order of the customer the reader sees. */
  readonly orders: number
  /** The seven phases in order, 0 as 0 (they add up to `orders`). */
  readonly phases: { readonly phase: OrderPhase; readonly count: number }[]
  readonly late: number
  readonly waitsForYes: number
  /** Orders whose deposit request is still open, in every state (the Work strip's Deposit tile). */
  readonly depositOpen: number
  readonly requests: { readonly open: number; readonly firstId: string | null }
  /** null: withheld (no threads.read). */
  readonly replies: number | null
  /** The customer's own Urgent marks (production's reader), per company. */
  readonly customerUrgent: { readonly count: number; readonly byCompany: { readonly companyId: string; readonly count: number }[] }
  /** OUR levels URGENT ("Top") and HIGH among the open orders. */
  readonly priority: { readonly top: number; readonly high: number }
  readonly nextPromise: string | null
  readonly lastOrderDate: string | null
  readonly newestOrder: { readonly id: string; readonly number: string } | null
  /** B-CL-009: cq's "to answer" and "open quotes"; a part without its right is absent (never 0). */
  readonly beforeOrder: BeforeOrderPart
}

/** B-CL-009: the two before-order parts the list draws (each absent without its right). */
export interface BeforeOrderPart {
  readonly toAnswer?: number
  readonly openQuotes?: number
}

/** B-CL-009: cq's counts of one customer as the list's two parts — a null part (no right) is left out. */
export function beforeOrderPartOf(counts: BeforeOrderCounts | undefined): BeforeOrderPart {
  const toAnswer = counts?.groups.TO_ANSWER ?? null
  const openQuotes = counts?.openQuotes ?? null
  return { ...(toAnswer !== null ? { toAnswer } : {}), ...(openQuotes !== null ? { openQuotes } : {}) }
}

export interface CustomersWorkAnswer {
  readonly customers: CustomerWorkRow[]
  readonly repliesComplete: boolean
  readonly withheld: 'replies'[]
  readonly limited: boolean
  readonly asOf: string
}

/**
 * Where each asked customer's work stands (13-backend §4): R0 the customers the reader reaches by parties.view AND orders.view (an id
 * outside either is ABSENT — no zeros, no name); R1 the shared facts (partyWorkKeys); R2–R7 the page's own counts. A reached customer
 * with no order is present with zeros and no newest order. About 14 statements for up to 50 customers, never one per customer.
 */
export async function customersWork(caller: CommandCaller, query: { readonly partyIds: string }): Promise<CustomersWorkAnswer> {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  const ids = partyIdsTermOf(query.partyIds)
  const today = businessDate(serverClock.now())
  const withheld: 'replies'[] = grantsFor(actor, THREADS_READ).length === 0 ? ['replies'] : []
  const limited = limitedToSomeCustomers(context)
  return caller.withClient(async (client) => {
    // R0: the customers the reader reaches, by its parties AND its orders.
    const reached = (
      await client.party.findMany({
        where: { AND: [{ id: { in: ids } }, scopeWhere(actor, PARTIES_VIEW, PARTY_SCOPE) as Prisma.PartyWhereInput, scopeWhere(actor, ORDERS_VIEW, { party: 'id' }) as Prisma.PartyWhereInput] },
        select: { id: true },
      })
    ).map((row) => row.id)
    if (reached.length === 0) return { customers: [], repliesComplete: true, withheld, limited, asOf: toUtcIso(serverClock.now()) }
    // R1: the shared facts.
    const facts = await partyWorkKeys(client, context, today, reached)
    const base = whereOf(context, {}, today)
    const scoped = (...terms: Prisma.SalesOrderWhereInput[]): Prisma.SalesOrderWhereInput => ({ AND: [base, ...terms, { partyId: { in: reached } }] })
    // R2: deposits still open, every state.
    const deposits = new Map((await client.salesOrder.groupBy({ by: ['partyId'], where: scoped(depositOpenWhere), _count: { _all: true } })).map((row) => [row.partyId, row._count._all]))
    // R3: the customer's own Urgent marks, per company.
    const urgent = await client.salesOrder.groupBy({ by: ['partyId', 'companyId'], where: scoped(customerUrgencyWhere('URGENT')), _count: { _all: true } })
    // R4: our levels Top (URGENT) and High among the open orders.
    const levels = await client.salesOrder.groupBy({ by: ['partyId', 'priorityLevel'], where: scoped({ status: { in: [...OPEN_STATUSES] } }, { priorityLevel: { in: ['URGENT', 'HIGH'] } }), _count: { _all: true } })
    // R5: the next promise from today on, over every company (promisesOf.next).
    const promises = new Map(
      (await client.salesOrder.groupBy({ by: ['partyId'], where: scoped({ status: { in: [...PROMISE_STATUSES] } }, { promiseDate: { gte: asDay(today) } }), _min: { promiseDate: true } })).map((row) => [row.partyId, row._min.promiseDate]),
    )
    // R6: every order and the last order date (the switcher's rule).
    const all = new Map((await client.salesOrder.groupBy({ by: ['partyId'], where: scoped(), _count: { _all: true }, _max: { orderDate: true } })).map((row) => [row.partyId, row]))
    // R7: the newest order (recent first: order date, then made, then id) — the picture's.
    const newest = new Map(
      (await client.salesOrder.findMany({ where: scoped(), orderBy: [{ orderDate: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }], distinct: ['partyId'], select: { id: true, partyId: true, number: true } })).map((row) => [row.partyId, { id: row.id, number: row.number }]),
    )
    // R8 (B-CL-009): cq's before-order counts — the reached ids only (an unreached id would come back with 0s).
    const before = await beforeOrderCountsByParty(client, actor, reached)
    const reachedSet = new Set(reached)
    const customers = ids
      .filter((partyId) => reachedSet.has(partyId))
      .map((partyId): CustomerWorkRow => {
        const work = facts.byParty.get(partyId)
        const own = urgent.filter((row) => row.partyId === partyId).sort((a, b) => (a.companyId < b.companyId ? -1 : a.companyId > b.companyId ? 1 : 0))
        const level = (value: 'URGENT' | 'HIGH'): number => levels.find((row) => row.partyId === partyId && row.priorityLevel === value)?._count._all ?? 0
        const next = promises.get(partyId) ?? null
        const counted = all.get(partyId)
        return {
          partyId,
          orders: counted?._count._all ?? 0,
          phases: ORDER_PHASES.map((phase) => ({ phase, count: work?.phases[phase] ?? 0 })),
          late: work?.waiting.late ?? 0,
          waitsForYes: work?.waitsForYes ?? 0,
          depositOpen: deposits.get(partyId) ?? 0,
          requests: { open: work?.waiting.requests ?? 0, firstId: work?.firstRequestId ?? null },
          replies: withheld.length > 0 ? null : (work?.waiting.replies ?? 0),
          customerUrgent: { count: own.reduce((sum, row) => sum + row._count._all, 0), byCompany: own.map((row) => ({ companyId: row.companyId, count: row._count._all })) },
          priority: { top: level('URGENT'), high: level('HIGH') },
          nextPromise: next ? dayOf(next) : null,
          lastOrderDate: counted?._max.orderDate ? dayOf(counted._max.orderDate) : null,
          newestOrder: newest.get(partyId) ?? null,
          beforeOrder: beforeOrderPartOf(before.get(partyId)), // B-CL-009
        }
      })
    return { customers, repliesComplete: facts.repliesComplete, withheld, limited, asOf: toUtcIso(serverClock.now()) }
  })
}

// ── B-CL-001: the sales module registers its reader for the parties list, once, when the module loads (./routes imports this file;
// the worker's customers file loads it too) — as ./customer-urgency registers production's reader ──
usePartyWork({ of: (caller, client) => partyWorkKeys(client, officeContextOf(caller), businessDate(serverClock.now())) })
// ── end B-CL-001 ──
