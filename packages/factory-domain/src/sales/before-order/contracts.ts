import { z } from 'zod'
import { id, input, instant, output } from '../../core/contracts'

/**
 * B-CQ-002 (customer page › Quotes & incoming, settle L11; 13-backend ★(1), §1): GET /sales/before-order/counts — one customer's
 * records before an order, counted per group (./groups.ts), shared by the API and the web. The Work tab's line, the tab's band and
 * badge, Overview's "Open quotes" and the Customers list read these numbers (the list through the per-party helper
 * beforeOrderCountsByParty, apps/factory-api modules/sales/before-order/counts.ts).
 *
 *   a number  the rows of that group the reader may open, under each kind's OWN view right and wall (0: none in reach)
 *   null      the reader holds no right of any kind the part needs: the part is LEFT OUT, never shown as 0
 *
 * Counts only: no amount, no person, no row. office only (parties.view over the customer; each kind its own right inside). The
 * customer never reads it.
 */

/** The most customers one call of the per-party helper counts (the Customers list's page asks at most this many). */
export const BEFORE_ORDER_PARTIES_MAX = 50

export const beforeOrderCountsQuery = input({
  /** The customer (out of reach or unknown: "Customer not found."). */
  partyId: z.uuid({ error: 'Name the customer.' }),
  /** The screen's company: the sample rounds of the customer with it (Overview's number). Without: of every company. */
  companyId: id().optional(),
})
export type BeforeOrderCountsQuery = z.output<typeof beforeOrderCountsQuery>

/** A count the reader may read (an int ≥ 0), or null: no right of the kinds it holds. */
const maybe = () => z.number().int().min(0).nullable()
const count = () => z.number().int().min(0)

/** The nine groups, in BEFORE_ORDER_GROUPS order (./groups.ts). */
export const beforeOrderGroupCounts = output({
  WRITING: maybe(),
  TO_ANSWER: maybe(),
  PREPARING: maybe(),
  APPROVAL: maybe(),
  WAITING_CUSTOMER: maybe(),
  ORDER_WAITS: maybe(),
  WON: maybe(),
  MOVED: maybe(),
  LOST: maybe(),
})

/** Each kind's groups (null: the reader holds no right of that kind). */
export const beforeOrderKindCounts = output({
  /** quotes.view */
  quotes: output({ PREPARING: count(), APPROVAL: count(), WAITING_CUSTOMER: count(), ORDER_WAITS: count(), WON: count(), LOST: count() }).nullable(),
  /** sales.inquiries.view */
  requests: output({ TO_ANSWER: count(), WAITING_CUSTOMER: count(), WON: count(), MOVED: count(), LOST: count() }).nullable(),
  /** The sent and decided portal orders: orders.view AND sales.inquiries.view (Incoming's right: the only list that shows them). */
  portalOrders: output({ TO_ANSWER: count(), WON: count(), MOVED: count(), LOST: count() }).nullable(),
  /** The customer's portal drafts (= groups.WRITING): orders.view. */
  drafts: maybe(),
})

/** One customer's counts (the per-party helper's answer for each customer). */
export const beforeOrderCounts = output({
  groups: beforeOrderGroupCounts,
  /** The open quotes (DRAFT, PENDING_APPROVAL, APPROVED, SENT: OPEN_QUOTES). */
  openQuotes: maybe(),
  /** What waits on us: TO_ANSWER + ORDER_WAITS (the tab badge). */
  waitsOnUs: maybe(),
  byKind: beforeOrderKindCounts,
})
export type BeforeOrderCounts = z.output<typeof beforeOrderCounts>

/** The answer of GET /sales/before-order/counts. */
export const beforeOrderCountsAnswer = beforeOrderCounts.extend({
  partyId: id(),
  /** The customer's sample rounds in progress, Overview's rule (sales.samples.view; with the screen's company when asked). */
  sampleRounds: maybe(),
  asOf: instant(),
})
export type BeforeOrderCountsAnswer = z.output<typeof beforeOrderCountsAnswer>
