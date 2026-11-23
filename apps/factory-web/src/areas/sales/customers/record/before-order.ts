'use client'

import { useEffect, useRef, useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { useOfficeApi } from '../../../../lib/session/context'
import { useLiveBus } from '../../../../shell/live/use-live'
import { useCoalesced } from '../../orders/hooks'
import { listIncoming } from '../../inquiries/api'
import type { QuoteRow } from '../../../parties/_shared/api'
import { OPEN_QUOTES, type Loaded } from '../../../parties/_shared/model'
import { listCustomerDrafts } from './drafts/api'
import { draftsTouched } from './drafts/model'

/**
 * F-CW-101 (lead settle S27, agreed with the Quotes & incoming lane; 10-design §2) — the band's "Before an order" line: what the
 * customer has BEFORE an order exists. Never added into the order counts (a draft, a request and a quote are not orders).
 *
 *   EN  Before an order: N drafts · N to answer · N open quotes (· N accepted, order waits — only when > 0)
 *   IT  Prima dell'ordine: N bozze · N da rispondere · N preventivi aperti (· N accettati, l'ordine aspetta)
 *
 * ONE place for the rule and its reads, so the source is switched HERE and nowhere else. The page calls `readBeforeOrder` only (through
 * the small hook below); every count is `number | null` — null: the reader has no right for that part, or it could not be counted
 * honestly (a failed or capped read): the part is LEFT OUT, never "0". A part that is 0 is left out too; all parts out: no line.
 *
 * The interim rule (until the Quotes & incoming lane's endpoint is on main):
 *   drafts         the customer's portal drafts (the drafts list's rows, GET /sales/order-requests?status=DRAFT) — orders.view
 *   to answer      requests (Inquiry) NEW or ASSIGNED — sales.inquiries.view — PLUS portal orders SENT — orders.view AND
 *                  sales.inquiries.view (the Incoming list is the only place that shows those rows: without it the number would open
 *                  nothing). Read from Incoming's open rows of this customer (GET /sales/incoming?tile=OPEN&partyId=); more than one
 *                  page: not counted (never a wrong number). NOT the tile "Waiting on us".
 *   open quotes    the record's own quotes read, states DRAFT / PENDING_APPROVAL / APPROVED / SENT — quotes.view
 *   order waits    not counted here (only the final source knows an accepted quote whose order waits)
 *
 * THE FINAL SOURCE (the Quotes & incoming lane's server PR; not on main yet — never called before it is): GET
 * /sales/before-order/counts?partyId= → { groups: { WRITING, TO_ANSWER, …, ORDER_WAITS, … }, openQuotes, … }, each count int | null
 * (null: no right for that kind). The line then maps drafts = groups.WRITING · to answer = groups.TO_ANSWER · open quotes = openQuotes ·
 * accepted, order waits = groups.ORDER_WAITS — a change inside `readBeforeOrder`, nothing else moves.
 */

/** The four parts of the line (null: left out — no right, or not counted). */
export interface BeforeOrderCounts {
  readonly drafts: number | null
  readonly toAnswer: number | null
  readonly openQuotes: number | null
  readonly orderWaits: number | null
}

/** What the reader may read of the line's parts (each part reads its OWN right). */
export interface BeforeOrderCan {
  /** orders.view over the customer: its drafts; with `inquiries`, its portal orders sent. */
  readonly orders: boolean
  /** sales.inquiries.view: its requests, and the Incoming list that shows the portal orders sent. */
  readonly inquiries: boolean
  /** quotes.view: its open quotes. */
  readonly quotes: boolean
}

export const NO_BEFORE_ORDER: BeforeOrderCounts = Object.freeze({ drafts: null, toAnswer: null, openQuotes: null, orderWaits: null })

/** The record's open quotes (the Overview tile's own rule: OPEN_QUOTES); null while read, when more exist than were read, or failed. */
export function openQuotesOf(quotes: Loaded<QuoteRow>): number | null {
  if (!quotes.items || quotes.more) return null
  return quotes.items.filter((quote) => OPEN_QUOTES.has(quote.status)).length
}

/**
 * "To answer" from Incoming's open rows of the customer: its requests NEW or ASSIGNED, and — only for a reader of orders too — its
 * portal orders SENT. A change request is never counted here (it is the strip's "Requests to answer": a request on an ORDER).
 */
export function toAnswerOf(rows: ReadonlyArray<{ readonly kind: string; readonly state: string }>, can: Pick<BeforeOrderCan, 'orders'>): number {
  return rows.filter((row) => (row.kind === 'REQUEST' ? row.state === 'NEW' || row.state === 'ASSIGNED' : row.kind === 'CATALOGUE_ORDER' ? can.orders && row.state === 'SENT' : false)).length
}

/**
 * The line's four counts for one customer — the ONE function the page calls. Each part with its own right; a part whose read fails
 * is left out (null), the others stand.
 */
export async function readBeforeOrder(api: ApiClient, partyId: string, can: BeforeOrderCan, quotes: Loaded<QuoteRow>, signal?: AbortSignal): Promise<BeforeOrderCounts> {
  const [drafts, toAnswer] = await Promise.all([
    can.orders ? listCustomerDrafts(api, partyId, signal).then((rows) => rows.length, () => null) : Promise.resolve(null),
    can.inquiries
      ? listIncoming(api, { tile: 'OPEN', partyId }, { signal }).then(
          // More than one page of open rows: the count would be short — left out rather than wrong.
          (page) => (page.next === null ? toAnswerOf(page.rows, can) : null),
          () => null,
        )
      : Promise.resolve(null),
  ])
  return { drafts, toAnswer, openQuotes: can.quotes ? openQuotesOf(quotes) : null, orderWaits: null }
}

// ---- the line as the band draws it ----

export type BeforePart = keyof BeforeOrderCounts

/** Where each part leads: the Work tab's own Drafts view, or the Quotes & incoming tab at its group (the final addresses). */
export const BEFORE_GROUPS: Readonly<Record<Exclude<BeforePart, 'drafts'>, string>> = Object.freeze({ toAnswer: 'TO_ANSWER', openQuotes: 'OPEN_QUOTES', orderWaits: 'ORDER_WAITS' })

/** The Quotes & incoming tab at one of its groups (`?tab=quotes&group=<GROUP>`). */
export const quotesGroupDoor = (recordHref: string, group: string): string => `${recordHref}?tab=quotes&group=${group}`

export interface BeforeLinePart {
  readonly part: BeforePart
  readonly count: number
  /** A real link (Quotes & incoming); null: the Drafts view of this tab (the band's own pick). */
  readonly href: string | null
}

/** The parts the line shows, in their order: a part left out (null) and a part that is 0 are not there; none: no line at all. */
export function beforeLineOf(counts: BeforeOrderCounts, recordHref: string): BeforeLinePart[] {
  const order: readonly BeforePart[] = ['drafts', 'toAnswer', 'openQuotes', 'orderWaits']
  return order.flatMap((part) => {
    const count = counts[part]
    if (count === null || count <= 0) return []
    return [{ part, count, href: part === 'drafts' ? null : quotesGroupDoor(recordHref, BEFORE_GROUPS[part]) }]
  })
}

/** A live change that may move the line: a portal draft, a request or a portal order (the quotes follow the record's own read). */
export const beforeOrderTouched = (type: string): boolean => draftsTouched(type) || type.startsWith('inquiry.') || type.startsWith('portal_order_request.')

/**
 * The line's counts for the customer's Work tab: read only while the tab is shown (`enabled`), again when the record's quotes are
 * read and on a live change (coalesced, 800 ms). Nothing is read for a reader with none of the rights.
 */
export function useBeforeOrder(partyId: string, enabled: boolean, can: BeforeOrderCan, quotes: Loaded<QuoteRow>): BeforeOrderCounts {
  const api = useOfficeApi()
  const [counts, setCounts] = useState<BeforeOrderCounts>(NO_BEFORE_ORDER)
  const turn = useRef(0)
  const latest = useRef(quotes)
  latest.current = quotes
  const on = enabled && (can.orders || can.inquiries || can.quotes)
  // The quotes read as a word: the line is counted again when it arrives or changes (never on every render).
  const quotesKey = quotes.items ? `${quotes.items.length}:${quotes.more ? 'more' : 'all'}:${openQuotesOf(quotes) ?? '-'}` : 'reading'
  const read = useRef<() => void>(() => undefined)
  read.current = () => {
    if (!on) return
    const mine = ++turn.current
    readBeforeOrder(api, partyId, can, latest.current).then(
      (value) => mine === turn.current && setCounts(value),
      () => mine === turn.current && setCounts(NO_BEFORE_ORDER),
    )
  }
  useEffect(() => {
    if (!on) {
      turn.current += 1
      setCounts(NO_BEFORE_ORDER)
      return
    }
    read.current()
  }, [api, partyId, on, can.orders, can.inquiries, can.quotes, quotesKey])
  const again = useCoalesced(() => read.current(), 800)
  useLiveBus({ onChange: (change) => beforeOrderTouched(change.type) && again(), onReconnect: again }, on)
  return counts
}
