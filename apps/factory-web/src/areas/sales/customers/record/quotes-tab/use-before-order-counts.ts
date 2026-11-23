'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { BeforeOrderCountsAnswer } from '@nexus/factory-domain/sales/before-order/contracts'
import { useOfficeApi, useOfficeSession } from '../../../../../lib/session/context'
import { useLiveBus } from '../../../../../shell/live/use-live'
import { beforeOrderTouched } from '../before-order'
import { readBeforeOrderCounts } from './api'
import { COUNTS_EVENTS, COUNTS_WAIT_MS, countsMoved } from './band'

/**
 * F-CQ-302 (customer page › Quotes & incoming, 13-backend R13; 10-design §2.5) — the customer page's ONE count read, on every tab: GET
 * /sales/before-order/counts?partyId=&companyId= feeds the Quotes & incoming tab's badge (what waits on us: To answer + Accepted,
 * order waits), the tab's band and doors, and the Work tab's "Before an order" line (its four parts). Read again on a change of THIS
 * customer's quote, request or portal order (never another customer's: Q1-B10, Q2-B9), on an order change (an order made from an
 * accepted quote leaves "Accepted, order waits": the Work line's own rule), coalesced 800 ms, and when the live channel comes back.
 */
export interface PageCounts {
  /** null while it is read (or when it failed: `failed`). */
  readonly counts: BeforeOrderCountsAnswer | null
  readonly failed: boolean
  readonly onRetry: () => void
}

/** A live change after which the counts are read again (this customer's own records; every order event, as the Work line). */
export const pageCountsMoved = (change: { readonly type: string; readonly fields: Readonly<Record<string, unknown>> }, partyId: string): boolean =>
  countsMoved(change, partyId) || (!COUNTS_EVENTS.test(change.type) && beforeOrderTouched(change.type))

export function useBeforeOrderCounts(partyId: string, enabled: boolean): PageCounts {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const companyId = session.company?.id ?? null
  const [counts, setCounts] = useState<BeforeOrderCountsAnswer | null>(null)
  const [failed, setFailed] = useState(false)
  const reading = useRef<AbortController | null>(null)
  const read = useCallback(() => {
    reading.current?.abort()
    if (!enabled) return
    const controller = new AbortController()
    reading.current = controller
    readBeforeOrderCounts(api, partyId, companyId, controller.signal)
      .then((answer) => {
        if (controller.signal.aborted) return
        setCounts(answer)
        setFailed(false)
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true)
      })
  }, [api, partyId, companyId, enabled])
  useEffect(() => {
    setCounts(null)
    setFailed(false)
    read()
    return () => reading.current?.abort()
  }, [read])
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null)
  const again = useCallback(() => {
    if (pending.current) clearTimeout(pending.current)
    pending.current = setTimeout(() => {
      pending.current = null
      read()
    }, COUNTS_WAIT_MS)
  }, [read])
  useEffect(() => () => (pending.current ? clearTimeout(pending.current) : undefined), [])
  useLiveBus({ onChange: (change) => pageCountsMoved(change, partyId) && again(), onReconnect: again }, enabled)
  return { counts, failed, onRetry: read }
}
