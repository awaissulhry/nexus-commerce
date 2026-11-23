'use client'

import { beforeOrderCountsAnswer, type BeforeOrderCountsAnswer } from '@nexus/factory-domain/sales/before-order/contracts'
import type { ApiClient } from '../../../../lib/api/client'
import { sourcesTouched } from './use-customer-work'

/**
 * F-CW-101 (lead settles S27, S27b, agreed with the Quotes & incoming lane; 10-design §2) — the band's "Before an order" line: what
 * the customer has BEFORE an order exists. Never added into the order counts (a draft, a request and a quote are not orders).
 *
 *   EN  Before an order: N drafts · N to answer · N open quotes (· N accepted, order waits — only when > 0)
 *   IT  Prima dell'ordine: N bozze · N da rispondere · N preventivi aperti (· N accettati, l'ordine aspetta)
 *
 * ONE read, no rule of our own (S27b): GET /sales/before-order/counts?partyId= (office, parties.view over the customer; each kind
 * under its OWN view right and wall on the API), parsed with the shared contract `beforeOrderCountsAnswer`. The line maps
 *
 *   drafts                 groups.WRITING        the customer's portal drafts
 *   to answer              groups.TO_ANSWER      requests and portal orders that wait for our answer
 *   open quotes            openQuotes            the quotes not yet decided
 *   accepted, order waits  groups.ORDER_WAITS    an accepted quote whose order is not there yet
 *
 * Every count is `number | null` — null: the reader holds no right for that part: it is LEFT OUT, never "0". A part that is 0 is left
 * out too; all parts out: no line. A read that fails (or an API without the route) gives no line: quiet, never an error band.
 */

/** The four parts of the line (null: left out — no right for it, or the read failed). */
export interface BeforeOrderCounts {
  readonly drafts: number | null
  readonly toAnswer: number | null
  readonly openQuotes: number | null
  readonly orderWaits: number | null
}

export const NO_BEFORE_ORDER: BeforeOrderCounts = Object.freeze({ drafts: null, toAnswer: null, openQuotes: null, orderWaits: null })

/** The line's four parts from the API's answer (the mapping above; a null stays null). */
export function beforeOrderOf(answer: Pick<BeforeOrderCountsAnswer, 'groups' | 'openQuotes'>): BeforeOrderCounts {
  return { drafts: answer.groups.WRITING, toAnswer: answer.groups.TO_ANSWER, openQuotes: answer.openQuotes, orderWaits: answer.groups.ORDER_WAITS }
}

// ---- F-CQ-306 (cq fx3, walk W2-1; settle C3): every part of the line is a door to Quotes & incoming — a reader who cannot open that tab
// (neither quotes.view nor sales.inquiries.view: Warehouse) sees no line at all (its "1 draft" door landed back on Work; Warehouse no
// longer sees portal drafts on the customer page).
export const beforeOrderFor = (answer: Pick<BeforeOrderCountsAnswer, 'groups' | 'openQuotes'> | null, opensQuotesTab: boolean): BeforeOrderCounts => (answer && opensQuotesTab ? beforeOrderOf(answer) : NO_BEFORE_ORDER)
// ---- end F-CQ-306

/** The line's four counts for one customer — the ONE read the page makes for it. */
export async function readBeforeOrder(api: ApiClient, partyId: string, signal?: AbortSignal): Promise<BeforeOrderCounts> {
  return beforeOrderOf(await api.get('/sales/before-order/counts', { query: { partyId }, schema: beforeOrderCountsAnswer, signal }))
}

// ---- the line as the band draws it ----

export type BeforePart = keyof BeforeOrderCounts

/** Where each part leads: the Quotes & incoming tab at its group (the final addresses; F-CQ-303: the drafts at WRITING, below). */
export const BEFORE_GROUPS: Readonly<Record<Exclude<BeforePart, 'drafts'>, string>> = Object.freeze({ toAnswer: 'TO_ANSWER', openQuotes: 'OPEN_QUOTES', orderWaits: 'ORDER_WAITS' })

/** The Quotes & incoming tab at one of its groups (`?tab=quotes&group=<GROUP>`). */
export const quotesGroupDoor = (recordHref: string, group: string): string => `${recordHref}?tab=quotes&group=${group}`

export interface BeforeLinePart {
  readonly part: BeforePart
  readonly count: number
  /** A real link (Quotes & incoming at its group). F-CQ-303: the drafts too ("Customer is writing" there); null is no longer given. */
  readonly href: string | null
}

/** The parts the line shows, in their order: a part left out (null) and a part that is 0 are not there; none: no line at all. */
export function beforeLineOf(counts: BeforeOrderCounts, recordHref: string): BeforeLinePart[] {
  const order: readonly BeforePart[] = ['drafts', 'toAnswer', 'openQuotes', 'orderWaits']
  return order.flatMap((part) => {
    const count = counts[part]
    if (count === null || count <= 0) return []
    // ---- F-CQ-303 (13-backend R14): the drafts left the Work tab — their part opens Quotes & incoming at WRITING ("Customer is writing").
    return [{ part, count, href: quotesGroupDoor(recordHref, part === 'drafts' ? 'WRITING' : BEFORE_GROUPS[part]) }]
    // ---- end F-CQ-303
  })
}

/**
 * A live change after which the line is read again: one of its own records (a portal draft, a request, a portal order, a quote), and
 * every event the band's other reads already listen to (an order made from an accepted quote leaves "accepted, order waits").
 */
export const beforeOrderTouched = (type: string): boolean =>
  type.startsWith('portal_order_request.') || type.startsWith('inquiry.') || type.startsWith('quote.') || sourcesTouched(type).length > 0

// ---- F-CQ-302 (customer page › Quotes & incoming, 13-backend R13): the line's own read (only while the Work tab was shown) went into
// the page's ONE count read, on every tab (quotes-tab/use-before-order-counts.ts — the Quotes & incoming badge, its band and this
// line read the same answer); the page maps it with beforeOrderOf. The live rule stays this module's beforeOrderTouched.
// ---- end F-CQ-302
