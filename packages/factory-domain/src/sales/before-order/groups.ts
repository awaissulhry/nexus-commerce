import type { BusinessDate } from '../../core/time'
import type { IncomingTile } from '../incoming/rules'
import type { InquiryStatus } from '../inquiries/rules'
import type { RequestStatus as PortalOrderStatus } from '../portal-ordering/rules'
import { addDays, type QuoteStatus } from '../quotes/quotes'

/**
 * B-CQ-001 (customer page › Quotes & incoming, settle L11; 13-backend §2): everything BEFORE an order of one customer, in ONE rule —
 * pure, no words (the words are the web's). Four kinds of record live before an order: the customer's portal DRAFT, the SENT portal
 * order, the request (Inquiry) and the quote. Every state of every kind falls in exactly one of nine groups, in life order:
 *
 *   group             waits on   quote                              request                     portal order
 *   WRITING           customer   —                                  —                           DRAFT
 *   TO_ANSWER         us         —                                  NEW, ASSIGNED               SENT
 *   PREPARING         us         DRAFT, APPROVED                    —                           —
 *   APPROVAL          approver   PENDING_APPROVAL                   —                           —
 *   WAITING_CUSTOMER  customer   SENT                               NEED_INFO                   —
 *   ORDER_WAITS       us         ACCEPTED, no order on any version  —                           —
 *   WON               —          ACCEPTED with an order (even one   ORDERED                     ACCEPTED as an order
 *                                cancelled later)
 *   MOVED             —          —                                  QUOTED                      ACCEPTED as a quote
 *   LOST              —          DECLINED, EXPIRED, CANCELLED       DECLINED (every reason,     REFUSED, WITHDRAWN
 *                                                                   "Not an order" too), LOST,
 *                                                                   WITHDRAWN
 *
 * The server builds every where of the counts (GET /sales/before-order/counts), of the quotes list's `group` term and of Incoming's
 * TO_ANSWER / ENDED tiles from the sets below — it never writes a status list of its own. A count of a group therefore always equals
 * the rows its door opens. A draft is counted only in WRITING: never in "waits on us", never in Incoming (B-CP-071, B-CQ-033).
 * The customer never reads a group, a count or the urgency order (office only).
 */

export const BEFORE_ORDER_GROUPS = ['WRITING', 'TO_ANSWER', 'PREPARING', 'APPROVAL', 'WAITING_CUSTOMER', 'ORDER_WAITS', 'WON', 'MOVED', 'LOST'] as const
export type BeforeOrderGroup = (typeof BEFORE_ORDER_GROUPS)[number]

/** The live groups (the band's first line, in life order) and the closed ones (apart and quiet). */
export const LIVE_GROUPS = ['WRITING', 'TO_ANSWER', 'PREPARING', 'APPROVAL', 'WAITING_CUSTOMER', 'ORDER_WAITS'] as const satisfies readonly BeforeOrderGroup[]
export const CLOSED_GROUPS = ['WON', 'MOVED', 'LOST'] as const satisfies readonly BeforeOrderGroup[]

/** Who the group waits on (null: a closed group waits on nobody). Never a person or a role name (C4). */
export type GroupWaitsOn = 'CUSTOMER' | 'US' | 'APPROVER'
export const GROUP_WAITS_ON: Readonly<Record<BeforeOrderGroup, GroupWaitsOn | null>> = Object.freeze({
  WRITING: 'CUSTOMER',
  TO_ANSWER: 'US',
  PREPARING: 'US',
  APPROVAL: 'APPROVER',
  WAITING_CUSTOMER: 'CUSTOMER',
  ORDER_WAITS: 'US',
  WON: null,
  MOVED: null,
  LOST: null,
})

// ---- per kind: the groups each kind can be in, and the statuses of each ------------------------------------------------------

export const QUOTE_GROUPS = ['PREPARING', 'APPROVAL', 'WAITING_CUSTOMER', 'ORDER_WAITS', 'WON', 'LOST'] as const satisfies readonly BeforeOrderGroup[]
export type QuoteGroup = (typeof QUOTE_GROUPS)[number]
export const REQUEST_GROUPS = ['TO_ANSWER', 'WAITING_CUSTOMER', 'WON', 'MOVED', 'LOST'] as const satisfies readonly BeforeOrderGroup[]
export type RequestGroup = (typeof REQUEST_GROUPS)[number]
/** A portal order's groups: its DRAFT in WRITING, the sent ones in the other four. */
export const PORTAL_GROUPS = ['WRITING', 'TO_ANSWER', 'WON', 'MOVED', 'LOST'] as const satisfies readonly BeforeOrderGroup[]
export type PortalGroup = (typeof PORTAL_GROUPS)[number]
/** The groups of a SENT (or decided) portal order: what Incoming lists (a draft never is). */
export const PORTAL_SENT_GROUPS = ['TO_ANSWER', 'WON', 'MOVED', 'LOST'] as const satisfies readonly PortalGroup[]
export type PortalSentGroup = (typeof PORTAL_SENT_GROUPS)[number]

/**
 * The quote statuses of each quote group. ORDER_WAITS and WON share ACCEPTED: an order made from any version of the quote (even one
 * cancelled later) makes it WON, none ORDER_WAITS (the rule of the quote's "Order waits", modules/sales/quotes/views quoteSourcesOf).
 */
export const QUOTE_GROUP_STATUSES: Readonly<Record<QuoteGroup, readonly QuoteStatus[]>> = Object.freeze({
  PREPARING: ['DRAFT', 'APPROVED'],
  APPROVAL: ['PENDING_APPROVAL'],
  WAITING_CUSTOMER: ['SENT'],
  ORDER_WAITS: ['ACCEPTED'],
  WON: ['ACCEPTED'],
  LOST: ['DECLINED', 'EXPIRED', 'CANCELLED'],
})

export const REQUEST_GROUP_STATUSES: Readonly<Record<RequestGroup, readonly InquiryStatus[]>> = Object.freeze({
  TO_ANSWER: ['NEW', 'ASSIGNED'],
  WAITING_CUSTOMER: ['NEED_INFO'],
  WON: ['ORDERED'],
  MOVED: ['QUOTED'],
  LOST: ['DECLINED', 'LOST', 'WITHDRAWN'],
})

/**
 * The portal order statuses of each group. WON and MOVED share ACCEPTED: the database lets an ACCEPTED request name exactly one of
 * its order or its quote (…_customer_page_guards), so WON = ACCEPTED with an order and MOVED = the rest of ACCEPTED.
 */
export const PORTAL_GROUP_STATUSES: Readonly<Record<PortalGroup, readonly PortalOrderStatus[]>> = Object.freeze({
  WRITING: ['DRAFT'],
  TO_ANSWER: ['SENT'],
  WON: ['ACCEPTED'],
  MOVED: ['ACCEPTED'],
  LOST: ['REFUSED', 'WITHDRAWN'],
})

/**
 * B-CQ-051 (threads: a closed record waits on nobody on the customer side): a quote in a final state (its closed groups: accepted,
 * declined, expired, cancelled) and a decided portal order (accepted, refused, withdrawn).
 */
export const QUOTE_FINAL_STATUSES: readonly QuoteStatus[] = Object.freeze([...QUOTE_GROUP_STATUSES.WON, ...QUOTE_GROUP_STATUSES.LOST])
export const PORTAL_DECIDED_STATUSES: readonly PortalOrderStatus[] = Object.freeze([...PORTAL_GROUP_STATUSES.WON, ...PORTAL_GROUP_STATUSES.LOST])

export function groupOfQuote(status: QuoteStatus, orderMade: boolean): QuoteGroup {
  switch (status) {
    case 'DRAFT':
    case 'APPROVED':
      return 'PREPARING'
    case 'PENDING_APPROVAL':
      return 'APPROVAL'
    case 'SENT':
      return 'WAITING_CUSTOMER'
    case 'ACCEPTED':
      return orderMade ? 'WON' : 'ORDER_WAITS'
    case 'DECLINED':
    case 'EXPIRED':
    case 'CANCELLED':
      return 'LOST'
  }
}

export function groupOfRequest(status: InquiryStatus): RequestGroup {
  switch (status) {
    case 'NEW':
    case 'ASSIGNED':
      return 'TO_ANSWER'
    case 'NEED_INFO':
      return 'WAITING_CUSTOMER'
    case 'ORDERED':
      return 'WON'
    case 'QUOTED':
      return 'MOVED'
    case 'DECLINED':
    case 'LOST':
    case 'WITHDRAWN':
      return 'LOST'
  }
}

/** What an ACCEPTED portal order became (null for any other status). */
export type PortalOrderBecame = 'ORDER' | 'QUOTE' | null

export function groupOfPortalOrder(status: PortalOrderStatus, became: PortalOrderBecame): PortalGroup {
  switch (status) {
    case 'DRAFT':
      return 'WRITING'
    case 'SENT':
      return 'TO_ANSWER'
    case 'ACCEPTED':
      return became === 'ORDER' ? 'WON' : 'MOVED'
    case 'REFUSED':
    case 'WITHDRAWN':
      return 'LOST'
  }
}

// ---- the quotes list's terms (B-CQ-010, B-CQ-011) -----------------------------------------------------------------------------

/** The open quotes: the Work line's "open quotes", Overview's tile (= factory-web parties model OPEN_QUOTES; W3 imports it). */
export const OPEN_QUOTES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT'] as const satisfies readonly QuoteStatus[]

/**
 * The quotes list's `group` term: a quote group, the set OPEN_QUOTES, or LIVE (the tab's default for quotes: groups 3–6, the open
 * quotes and the accepted ones whose order waits; not a door). A door group no quote is in (WRITING, TO_ANSWER, MOVED) is no value.
 */
export const QUOTE_GROUP_TERMS = ['PREPARING', 'APPROVAL', 'WAITING_CUSTOMER', 'ORDER_WAITS', 'WON', 'LOST', 'OPEN_QUOTES', 'LIVE'] as const
export type QuoteGroupTerm = (typeof QUOTE_GROUP_TERMS)[number]

/** The quote groups each term holds. */
export const QUOTE_TERM_GROUPS: Readonly<Record<QuoteGroupTerm, readonly QuoteGroup[]>> = Object.freeze({
  PREPARING: ['PREPARING'],
  APPROVAL: ['APPROVAL'],
  WAITING_CUSTOMER: ['WAITING_CUSTOMER'],
  ORDER_WAITS: ['ORDER_WAITS'],
  WON: ['WON'],
  LOST: ['LOST'],
  OPEN_QUOTES: ['PREPARING', 'APPROVAL', 'WAITING_CUSTOMER'],
  LIVE: ['PREPARING', 'APPROVAL', 'WAITING_CUSTOMER', 'ORDER_WAITS'],
})

/** The quotes list's `sort` term: newest first (today's `id desc`, the default) or most urgent first. */
export const QUOTE_SORTS = ['newest', 'urgent'] as const
export type QuoteSort = (typeof QUOTE_SORTS)[number]

/** The most quotes one `sort=urgent` read orders (above it: refused in words; a customer's tab never reaches it). */
export const QUOTE_URGENT_MAX = 2000

/** On Sales › Incoming the before-order groups open these EXISTING tiles (+ the two new ones, B-CQ-020); the others fold. */
export const INCOMING_TILE_OF = Object.freeze({ TO_ANSWER: 'TO_ANSWER', WAITING_CUSTOMER: 'WAITING_CUSTOMER', WON: 'ORDERED', MOVED: 'QUOTED', LOST: 'ENDED' } as const satisfies Partial<Record<BeforeOrderGroup, IncomingTile>>)

/** A sent quote "ends soon" when its offer stands at most this many days more (= factory-web quotes model; the web reads it). */
export const ENDS_SOON_DAYS = 7

// ---- counting: the groups from each kind's numbers (B-CQ-002) ----------------------------------------------------------------

/** Each status's number of rows (a status not named: 0). */
export type StatusCounts<Status extends string> = Readonly<Partial<Record<Status, number>>>

const sumOf = <Status extends string>(counts: StatusCounts<Status>, statuses: readonly Status[]): number => statuses.reduce((total, status) => total + (counts[status] ?? 0), 0)

/** A customer's quotes per group, from their numbers per status and how many ACCEPTED ones have an order. */
export function quoteGroupCounts(byStatus: StatusCounts<QuoteStatus>, acceptedWithOrder: number): Record<QuoteGroup, number> {
  const accepted = byStatus.ACCEPTED ?? 0
  return {
    PREPARING: sumOf(byStatus, QUOTE_GROUP_STATUSES.PREPARING),
    APPROVAL: sumOf(byStatus, QUOTE_GROUP_STATUSES.APPROVAL),
    WAITING_CUSTOMER: sumOf(byStatus, QUOTE_GROUP_STATUSES.WAITING_CUSTOMER),
    ORDER_WAITS: Math.max(0, accepted - acceptedWithOrder),
    WON: Math.min(accepted, acceptedWithOrder),
    LOST: sumOf(byStatus, QUOTE_GROUP_STATUSES.LOST),
  }
}

/** A customer's requests per group, from their numbers per status. */
export function requestGroupCounts(byStatus: StatusCounts<InquiryStatus>): Record<RequestGroup, number> {
  return {
    TO_ANSWER: sumOf(byStatus, REQUEST_GROUP_STATUSES.TO_ANSWER),
    WAITING_CUSTOMER: sumOf(byStatus, REQUEST_GROUP_STATUSES.WAITING_CUSTOMER),
    WON: sumOf(byStatus, REQUEST_GROUP_STATUSES.WON),
    MOVED: sumOf(byStatus, REQUEST_GROUP_STATUSES.MOVED),
    LOST: sumOf(byStatus, REQUEST_GROUP_STATUSES.LOST),
  }
}

/** A customer's SENT (or decided) portal orders per group, from their numbers per status and how many ACCEPTED ones became an order. */
export function portalGroupCounts(byStatus: StatusCounts<PortalOrderStatus>, acceptedAsOrder: number): Record<PortalSentGroup, number> {
  const accepted = byStatus.ACCEPTED ?? 0
  return {
    TO_ANSWER: sumOf(byStatus, PORTAL_GROUP_STATUSES.TO_ANSWER),
    WON: Math.min(accepted, acceptedAsOrder),
    MOVED: Math.max(0, accepted - acceptedAsOrder),
    LOST: sumOf(byStatus, PORTAL_GROUP_STATUSES.LOST),
  }
}

/** Each kind's groups as one reader may read them: null for a kind the reader holds no right of. */
export interface KindGroupCounts {
  readonly quotes: Readonly<Record<QuoteGroup, number>> | null
  readonly requests: Readonly<Record<RequestGroup, number>> | null
  readonly portalOrders: Readonly<Record<PortalSentGroup, number>> | null
  readonly drafts: number | null
}

/** The sum of the parts a reader may read; null only when every part is null (never a guessed 0). */
const total = (...parts: readonly (number | null | undefined)[]): number | null => (parts.every((part) => part === null || part === undefined) ? null : parts.reduce<number>((sum, part) => sum + (part ?? 0), 0))

/**
 * The nine groups from each kind's numbers: a group is null when every kind it holds is gated out for the reader, else the sum over
 * the kinds the reader may read — so a count always equals the rows its door opens for that reader.
 */
export function beforeOrderGroupsOf(kinds: KindGroupCounts): Record<BeforeOrderGroup, number | null> {
  const { quotes, requests, portalOrders, drafts } = kinds
  return {
    WRITING: drafts,
    TO_ANSWER: total(requests?.TO_ANSWER, portalOrders?.TO_ANSWER),
    PREPARING: total(quotes?.PREPARING),
    APPROVAL: total(quotes?.APPROVAL),
    WAITING_CUSTOMER: total(quotes?.WAITING_CUSTOMER, requests?.WAITING_CUSTOMER),
    ORDER_WAITS: total(quotes?.ORDER_WAITS),
    WON: total(quotes?.WON, requests?.WON, portalOrders?.WON),
    MOVED: total(requests?.MOVED, portalOrders?.MOVED),
    LOST: total(quotes?.LOST, requests?.LOST, portalOrders?.LOST),
  }
}

/** The open quotes (OPEN_QUOTES) of a reader's quote groups: PREPARING + APPROVAL + WAITING_CUSTOMER; null without quotes. */
export function openQuotesOf(quotes: Readonly<Record<QuoteGroup, number>> | null): number | null {
  return quotes === null ? null : QUOTE_TERM_GROUPS.OPEN_QUOTES.reduce((sum, group) => sum + quotes[group], 0)
}

/** What waits on us (the tab badge): TO_ANSWER + ORDER_WAITS; null only when both are null. */
export function waitsOnUsOf(groups: Readonly<Record<BeforeOrderGroup, number | null>>): number | null {
  return total(groups.TO_ANSWER, groups.ORDER_WAITS)
}

// ---- urgency (B-CQ-011, B-CQ-022) -----------------------------------------------------------------------------------------------

/** The facts of one quote its place in "Most urgent first" is read from (instants ISO with zone, days YYYY-MM-DD). */
export interface QuoteUrgencyFacts {
  readonly id: string
  readonly status: QuoteStatus
  /** An order exists on one of its versions (even one cancelled later). */
  readonly orderMade: boolean
  /** The newest approval round of its current version (null: none asked). */
  readonly approval: { readonly status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'WITHDRAWN'; readonly createdAt: string } | null
  /** The current version's offer stands until (null: no day). */
  readonly validUntil: BusinessDate | null
  /** When the current version was sent. */
  readonly sentAt: string | null
  /** When the current version reached its final status (the acceptance). */
  readonly closedAt: string | null
  readonly updatedAt: string
}

const LAST = Number.MAX_SAFE_INTEGER
const msOf = (instant: string | null): number => (instant === null ? LAST : Date.parse(instant))
const dayMsOf = (day: BusinessDate | null): number => (day === null ? LAST : Date.parse(`${day}T00:00:00.000Z`))

/**
 * A quote's place, first match wins (research §4; inside a tier the oldest wait first, ties by id):
 *   1 accepted, its order waits (by the acceptance, oldest first)
 *   2 waiting for approval (by the newest round's ask, oldest first)
 *   3 our move: APPROVED, then a DRAFT whose newest round was REJECTED, then any other DRAFT (by the last change, oldest first)
 *   4 sent and ending within ENDS_SOON_DAYS — one already past and not yet expired by the morning job too (by its last day)
 *   5 any other sent (by when it was sent, oldest first)
 *   6 closed (the last change, newest first)
 */
export function quoteUrgencyKey(facts: QuoteUrgencyFacts, today: BusinessDate): readonly (number | string)[] {
  const changed = msOf(facts.updatedAt)
  switch (groupOfQuote(facts.status, facts.orderMade)) {
    case 'ORDER_WAITS':
      return [1, 0, msOf(facts.closedAt ?? facts.updatedAt)]
    case 'APPROVAL':
      return [2, 0, msOf(facts.approval?.createdAt ?? facts.updatedAt)]
    case 'PREPARING':
      return [3, facts.status === 'APPROVED' ? 0 : facts.approval?.status === 'REJECTED' ? 1 : 2, changed]
    case 'WAITING_CUSTOMER':
      if (facts.validUntil !== null && facts.validUntil <= addDays(today, ENDS_SOON_DAYS)) return [4, 0, dayMsOf(facts.validUntil)]
      return [5, 0, msOf(facts.sentAt ?? facts.updatedAt)]
    case 'WON':
    case 'LOST':
      return [6, 0, -changed]
  }
}

/** The facts of one Incoming row its place is read from (the row's own `open`, `waiting`, `wantedDate`, `receivedAt`). */
export interface IncomingUrgencyFacts {
  readonly id: string
  /** Still waits for the office or the customer (the OPEN tile). */
  readonly open: boolean
  /** Waits on us (not on the customer). */
  readonly waitsOnUs: boolean
  readonly overdue: boolean
  readonly workingMinutes: number | null
  readonly wantedDate: BusinessDate | null
  readonly receivedAt: string
}

/**
 * An Incoming row's place (the web ranks ONE page with it, C7): 1 waits on us and overdue · 2 waits on us · 3 waits for the
 * customer · 4 closed (newest first). Inside 1–3: the longest wait first, then the earliest wanted day (none last), then the oldest
 * arrival. Unread never reorders (it is the reader's own).
 */
export function incomingUrgencyKey(facts: IncomingUrgencyFacts): readonly (number | string)[] {
  const arrived = msOf(facts.receivedAt)
  if (!facts.open) return [4, 0, 0, -arrived]
  const tier = facts.waitsOnUs ? (facts.overdue ? 1 : 2) : 3
  return [tier, facts.workingMinutes === null ? LAST : -facts.workingMinutes, dayMsOf(facts.wantedDate), arrived]
}

/** A comparator from a key (element by element, numbers before strings), ties by id ascending. */
export function byUrgency<Row extends { readonly id: string }>(key: (row: Row) => readonly (number | string)[]): (a: Row, b: Row) => number {
  return (a, b) => {
    const left = key(a)
    const right = key(b)
    for (let index = 0; index < Math.max(left.length, right.length); index++) {
      const x = left[index]
      const y = right[index]
      if (x === y) continue
      if (x === undefined) return -1
      if (y === undefined) return 1
      if (typeof x === 'number' && typeof y === 'number') return x < y ? -1 : 1
      if (typeof x === 'number') return -1
      if (typeof y === 'number') return 1
      return x < y ? -1 : 1
    }
    return a.id === b.id ? 0 : a.id < b.id ? -1 : 1
  }
}
