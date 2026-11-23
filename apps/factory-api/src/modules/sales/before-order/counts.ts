import type { Prisma } from '@nexus/factory-db'
import { ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, grantsFor, scopeWhere, type Actor } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { PARTIES_VIEW } from '@nexus/factory-domain/parties/permissions'
import { BEFORE_ORDER_PARTIES_MAX, type BeforeOrderCounts, type BeforeOrderCountsAnswer, type BeforeOrderCountsQuery } from '@nexus/factory-domain/sales/before-order/contracts'
import { beforeOrderGroupsOf, openQuotesOf, portalGroupCounts, quoteGroupCounts, requestGroupCounts, waitsOnUsOf, type StatusCounts } from '@nexus/factory-domain/sales/before-order/groups'
import type { InquiryStatus } from '@nexus/factory-domain/sales/inquiries/rules'
import { SALES_INQUIRIES_VIEW } from '@nexus/factory-domain/sales/inquiries/permissions'
import { ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import type { RequestStatus as PortalOrderStatus } from '@nexus/factory-domain/sales/portal-ordering/rules'
import { QUOTES_VIEW } from '@nexus/factory-domain/sales/quotes/permissions'
import type { QuoteStatus } from '@nexus/factory-domain/sales/quotes/quotes'
import { SALES_SAMPLES_VIEW } from '@nexus/factory-domain/sales/samples/permissions'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { contextOf } from '../../parties/store'
import type { Reader } from '../credit/reading'
import { openSampleRoundsWhere } from '../customer-360/glance'

/**
 * B-CQ-002 (customer page › Quotes & incoming, settle L11; 13-backend ★, §1): one customer's records before an order, counted per
 * group (factory-domain sales/before-order/groups.ts: one rule for every kind).
 *
 *   GET /sales/before-order/counts?partyId=&companyId=   office, parties.view over the customer (out of reach or unknown: "Customer
 *                                                        not found.", the drafts read's words); the answer of the helper below for
 *                                                        that one customer, and its sample rounds in progress (Overview's rule)
 *   beforeOrderCountsByParty(client, actor, partyIds)    the same numbers for up to 50 customers in 5 queries whatever their number
 *                                                        (the Customers list's page); every asked id comes back — a customer out of
 *                                                        the reader's reach (or no customer at all) with 0s, never another one's
 *
 * Each kind is counted with the reader's OWN view right of that kind and its wall (scopeWhere over the row's company and customer),
 * exactly as the list that shows those rows: quotes quotes.view (GET /sales/quotes); requests sales.inquiries.view (the inquiries'
 * baseWhere); the sent and decided portal orders orders.view AND sales.inquiries.view (C20: Incoming is the only list that shows
 * them and it asks sales.inquiries.view); the portal drafts orders.view (the drafts read). A kind the reader holds no grant of is
 * null, and a group is null when every kind it holds is: the web leaves it out, never "0". So a count always equals the rows its door
 * opens for that reader. A read: no command, no audit row, no event; counts only (no amount, no person).
 *
 * The queries (never one per customer): Q1 quotes by customer and status · Q2 the ACCEPTED quotes with an order on one of their
 * versions (WON; the rest of ACCEPTED is ORDER_WAITS, the quote's own "Order waits" rule) · Q3 requests by customer and status ·
 * Q4 portal orders by customer and status (the drafts only, without the sent kind's rights) · Q5 the ACCEPTED portal orders that
 * became an order (WON; the rest of ACCEPTED became a quote: MOVED — the database lets an accepted one name exactly one). On the
 * indexes [tenantId, partyId, status] of Quote, Inquiry and PortalOrderRequest, and SalesOrder [tenantId, quoteVersionId].
 */

const SCOPE = { company: 'companyId', party: 'partyId' } as const

/** What the reader may count: each kind's own right (a grant of it anywhere; the wall is the scope of each row). */
interface Rights {
  readonly quotes: boolean
  readonly requests: boolean
  readonly drafts: boolean
  /** The sent and decided portal orders (C20): orders.view and sales.inquiries.view. */
  readonly portal: boolean
}

function rightsOf(actor: Actor): Rights {
  const holds = (permission: Parameters<typeof grantsFor>[1]): boolean => grantsFor(actor, permission).length > 0
  const requests = holds(SALES_INQUIRIES_VIEW)
  const drafts = holds(ORDERS_VIEW)
  return { quotes: holds(QUOTES_VIEW), requests, drafts, portal: drafts && requests }
}

/** One customer's numbers as read: per status per kind, and the ACCEPTED ones with an order. */
interface Tally {
  readonly quotes: Partial<Record<QuoteStatus, number>>
  quotesWithOrder: number
  readonly requests: Partial<Record<InquiryStatus, number>>
  readonly portal: Partial<Record<PortalOrderStatus, number>>
  portalAsOrder: number
}

const emptyTally = (): Tally => ({ quotes: {}, quotesWithOrder: 0, requests: {}, portal: {}, portalAsOrder: 0 })

function countsOf(tally: Tally, rights: Rights): BeforeOrderCounts {
  const quotes = rights.quotes ? quoteGroupCounts(tally.quotes as StatusCounts<QuoteStatus>, tally.quotesWithOrder) : null
  const requests = rights.requests ? requestGroupCounts(tally.requests as StatusCounts<InquiryStatus>) : null
  const portalOrders = rights.portal ? portalGroupCounts(tally.portal as StatusCounts<PortalOrderStatus>, tally.portalAsOrder) : null
  const drafts = rights.drafts ? (tally.portal.DRAFT ?? 0) : null
  const groups = beforeOrderGroupsOf({ quotes, requests, portalOrders, drafts })
  return { groups, openQuotes: openQuotesOf(quotes), waitsOnUs: waitsOnUsOf(groups), byKind: { quotes, requests, portalOrders, drafts } }
}

/**
 * The before-order counts of each asked customer, as this reader may read them (see the file's head). At most
 * BEFORE_ORDER_PARTIES_MAX ids (else a ValidationError in words); an id that is no customer id, or a customer out of reach, gets 0s.
 */
export async function beforeOrderCountsByParty(client: Reader, actor: Actor, partyIds: readonly string[]): Promise<Map<string, BeforeOrderCounts>> {
  if (partyIds.length > BEFORE_ORDER_PARTIES_MAX) {
    throw new ValidationError(`At most ${BEFORE_ORDER_PARTIES_MAX} customers at once.`, [{ path: 'partyIds', message: `At most ${BEFORE_ORDER_PARTIES_MAX} customers.` }])
  }
  const rights = rightsOf(actor)
  const tallies = new Map<string, Tally>(partyIds.map((partyId) => [partyId, emptyTally()]))
  const ids = [...new Set(partyIds.filter((partyId) => isUuid(partyId)))]
  if (ids.length > 0) {
    const ofParty = { partyId: { in: ids } }
    const tallyOf = (partyId: string | null): Tally | undefined => (partyId === null ? undefined : tallies.get(partyId))
    if (rights.quotes) {
      const scope = scopeWhere(actor, QUOTES_VIEW, SCOPE) as Prisma.QuoteWhereInput
      // Q1
      for (const row of await client.quote.groupBy({ by: ['partyId', 'status'], where: { AND: [scope, ofParty] }, _count: { _all: true } })) {
        const tally = tallyOf(row.partyId)
        if (tally) tally.quotes[row.status as QuoteStatus] = row._count._all
      }
      // Q2: an order exists on one of its versions (even one cancelled later): WON.
      for (const row of await client.quote.groupBy({ by: ['partyId'], where: { AND: [scope, ofParty, { status: 'ACCEPTED', versions: { some: { salesOrders: { some: {} } } } }] }, _count: { _all: true } })) {
        const tally = tallyOf(row.partyId)
        if (tally) tally.quotesWithOrder = row._count._all
      }
    }
    if (rights.requests) {
      // Q3: the inquiries' own wall (a prospect's request has no customer: never one of these).
      const scope = scopeWhere(actor, SALES_INQUIRIES_VIEW, { company: 'companyId', party: { field: 'partyId', nullable: true } }) as Prisma.InquiryWhereInput
      for (const row of await client.inquiry.groupBy({ by: ['partyId', 'status'], where: { AND: [scope, ofParty] }, _count: { _all: true } })) {
        const tally = tallyOf(row.partyId)
        if (tally) tally.requests[row.status as InquiryStatus] = row._count._all
      }
    }
    if (rights.drafts) {
      const scope = scopeWhere(actor, ORDERS_VIEW, SCOPE) as Prisma.PortalOrderRequestWhereInput
      // Q4: without the sent kind's rights, the drafts only.
      for (const row of await client.portalOrderRequest.groupBy({ by: ['partyId', 'status'], where: { AND: [scope, ofParty, ...(rights.portal ? [] : [{ status: 'DRAFT' as const }])] }, _count: { _all: true } })) {
        const tally = tallyOf(row.partyId)
        if (tally) tally.portal[row.status as PortalOrderStatus] = row._count._all
      }
      if (rights.portal) {
        // Q5: accepted as an order (WON); the rest of ACCEPTED became a quote (MOVED).
        for (const row of await client.portalOrderRequest.groupBy({ by: ['partyId'], where: { AND: [scope, ofParty, { status: 'ACCEPTED', salesOrderId: { not: null } }] }, _count: { _all: true } })) {
          const tally = tallyOf(row.partyId)
          if (tally) tally.portalAsOrder = row._count._all
        }
      }
    }
  }
  return new Map(partyIds.map((partyId) => [partyId, countsOf(tallies.get(partyId) ?? emptyTally(), rights)]))
}

function officeOf(caller: CommandCaller): OfficeContext {
  const context = contextOf(caller)
  if (context.audience !== 'office') throw new ForbiddenError()
  return context
}

/** GET /sales/before-order/counts (see the file's head). */
export async function readBeforeOrderCounts(caller: CommandCaller, query: BeforeOrderCountsQuery): Promise<BeforeOrderCountsAnswer> {
  const actor = actorOf(officeOf(caller))
  const party = isUuid(query.partyId) ? await caller.withClient((client) => client.party.findUnique({ where: { id: query.partyId }, select: { id: true, companyId: true } })) : null
  // A customer out of reach is as unknown as a wrong id (the brand wall): the same words.
  if (!party || !can(actor, PARTIES_VIEW, { companyId: party.companyId, partyId: party.id })) throw new NotFoundError('Customer not found.')
  return caller.withClient(async (client) => {
    const counts = (await beforeOrderCountsByParty(client, actor, [party.id])).get(party.id)!
    // B-CQ-003: Overview's rule (the screen's company when named).
    const sampleRounds = grantsFor(actor, SALES_SAMPLES_VIEW).length > 0 ? await client.sampleRound.count({ where: openSampleRoundsWhere(actor, party.id, query.companyId ?? null) }) : null
    return { partyId: party.id, ...counts, sampleRounds, asOf: toUtcIso(serverClock.now()) }
  })
}
