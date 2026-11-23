'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import type { BeforeOrderCountsAnswer } from '@nexus/factory-domain/sales/before-order/contracts'
import { useOfficeApi, useOfficeSession } from '../../../../../lib/session/context'
import { companyPrefix } from '../../../../../lib/session/session'
import { useLiveBus } from '../../../../../shell/live/use-live'
import { draftsAddress } from '../drafts/model'
import { readBeforeOrderCounts } from './api'
import { COUNTS_WAIT_MS, countsMoved, doorAddress, doorOf, DOORS, tabRightsOf, termsOfDoor, toggledDoor, type Door, type DoorTerms, type TabRights } from './band'

/**
 * F-CQ-101 / F-CQ-104 (customer page › Quotes & incoming, 13-backend §11 rows 1–2): the tab's container — the counts (one read while
 * this tab is shown; again on a quote, request or portal order change, coalesced 800 ms; everything again after a reconnect), the
 * door the address opens (`?tab=quotes&group=<G>`: each door is a real link; the same door again, or ✕, writes ONE replace without
 * it), the lists' terms under it, and the tab's own room (a ResizeObserver on its root: each list lays out by that room, never by
 * the window). The customer's one name is the page's (P0-B9). The drafts' door is Work › "Drafts of <customer>" until the drafts
 * section moves here (W2 / W3).
 */
export interface QuotesTab {
  readonly counts: BeforeOrderCountsAnswer | null
  /** The counts could not be read (the band says so; the lists still draw). */
  readonly failed: boolean
  readonly door: Door | null
  readonly terms: DoorTerms
  readonly rights: TabRights
  /** The tab's own room in px (null until measured). */
  readonly room: number | null
  /** Each door's address (the open door's: everything again). */
  readonly hrefs: Readonly<Record<Door, string>>
  /** The address without a door (✕, "Show everything"). */
  readonly everything: string
  /** The page's company prefix (`/w/<code>`). */
  readonly prefix: string
}

export function useQuotesTab(partyId: string): { tab: QuotesTab; rootRef: RefObject<HTMLDivElement | null>; onCloseDoor: () => void; onRetry: () => void } {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const params = useSearchParams()
  const prefix = companyPrefix(session.company?.code ?? '')
  const companyId = session.company?.id ?? null
  const rights = useMemo(() => tabRightsOf(session.permissions), [session.permissions])
  const base = `${prefix}/sales/customers/${encodeURIComponent(partyId)}`
  const door = doorOf(params)
  const terms = useMemo(() => termsOfDoor(door), [door])

  // ---- the counts: one read, live, coalesced ----
  const [counts, setCounts] = useState<BeforeOrderCountsAnswer | null>(null)
  const [failed, setFailed] = useState(false)
  const reading = useRef<AbortController | null>(null)
  const read = useCallback(() => {
    reading.current?.abort()
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
  }, [api, partyId, companyId])
  useEffect(() => {
    setCounts(null)
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
  useLiveBus({ onChange: (change) => countsMoved(change, partyId) && again(), onReconnect: again })

  // ---- the tab's own room (F-CQ-104): the lists' column sets follow it, never the window ----
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [room, setRoom] = useState<number | null>(null)
  useEffect(() => {
    const root = rootRef.current
    if (!root || typeof ResizeObserver === 'undefined') return
    const measure = (width: number) => setRoom((now) => (now === Math.round(width) ? now : Math.round(width)))
    measure(root.getBoundingClientRect().width)
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) measure(entry.contentRect.width)
    })
    observer.observe(root)
    return () => observer.disconnect()
  }, [])

  // ---- the doors: real links (the open one, pressed again: everything); W1's drafts door is Work's "Drafts of <customer>" ----
  const query = params?.toString() ?? ''
  const hrefs = useMemo(() => {
    const current = new URLSearchParams(query)
    const out = Object.fromEntries(DOORS.map((each) => [each, doorAddress(base, current, toggledDoor(door, each))])) as Record<Door, string>
    out.WRITING = draftsAddress(base, partyId, current)
    return out
  }, [base, query, door, partyId])
  const everything = useMemo(() => doorAddress(base, new URLSearchParams(query), null), [base, query])
  const onCloseDoor = useCallback(() => router.replace(everything, { scroll: false }), [router, everything])

  return { tab: { counts, failed, door, terms, rights, room, hrefs, everything, prefix }, rootRef, onCloseDoor, onRetry: read }
}
