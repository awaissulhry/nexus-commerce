'use client'

import { useEffect, useRef, useState } from 'react'
import { beforeOrderCountsAnswer, type BeforeOrderCountsAnswer } from '@nexus/factory-domain/sales/before-order/contracts'
import type { ApiClient } from '../../../../lib/api/client'
import { useOfficeApi } from '../../../../lib/session/context'
import { useLiveBus } from '../../../../shell/live/use-live'
import { useCoalesced } from '../../orders/hooks'
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

/** The line's four counts for one customer — the ONE read the page makes for it. */
export async function readBeforeOrder(api: ApiClient, partyId: string, signal?: AbortSignal): Promise<BeforeOrderCounts> {
  return beforeOrderOf(await api.get('/sales/before-order/counts', { query: { partyId }, schema: beforeOrderCountsAnswer, signal }))
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

/**
 * A live change after which the line is read again: one of its own records (a portal draft, a request, a portal order, a quote), and
 * every event the band's other reads already listen to (an order made from an accepted quote leaves "accepted, order waits").
 */
export const beforeOrderTouched = (type: string): boolean =>
  type.startsWith('portal_order_request.') || type.startsWith('inquiry.') || type.startsWith('quote.') || sourcesTouched(type).length > 0

/**
 * The line's counts for the customer's Work tab: read only while the tab is shown (`enabled`), again on a live change (coalesced,
 * 800 ms, as the band's other reads) and when the live channel comes back. A failed read: no line.
 */
export function useBeforeOrder(partyId: string, enabled: boolean): BeforeOrderCounts {
  const api = useOfficeApi()
  const [counts, setCounts] = useState<BeforeOrderCounts>(NO_BEFORE_ORDER)
  const turn = useRef(0)
  const read = useRef<() => void>(() => undefined)
  read.current = () => {
    if (!enabled) return
    const mine = ++turn.current
    readBeforeOrder(api, partyId).then(
      (value) => mine === turn.current && setCounts(value),
      () => mine === turn.current && setCounts(NO_BEFORE_ORDER),
    )
  }
  useEffect(() => {
    if (!enabled) {
      turn.current += 1
      setCounts(NO_BEFORE_ORDER)
      return
    }
    read.current()
  }, [api, partyId, enabled])
  const again = useCoalesced(() => read.current(), 800)
  useLiveBus({ onChange: (change) => beforeOrderTouched(change.type) && again(), onReconnect: again }, enabled)
  return counts
}
