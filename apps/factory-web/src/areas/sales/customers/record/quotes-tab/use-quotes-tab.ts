'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useOfficeSession } from '../../../../../lib/session/context'
import { companyPrefix } from '../../../../../lib/session/session'
import { doorAddress, doorOf, DOORS, tabRightsOf, termsOfDoor, toggledDoor, type Door, type TabFacts } from './band'
import type { PageCounts } from './use-before-order-counts' // F-CQ-302: the page's one count read

/**
 * F-CQ-101 / F-CQ-104 (customer page › Quotes & incoming, 13-backend §11 rows 1–2): the tab's container — the counts (F-CQ-302: the
 * page's one read, handed in: the badge, this band and the Work line read the same answer), the
 * door the address opens (`?tab=quotes&group=<G>`: each door is a real link; the same door again, or ✕, writes ONE replace without
 * it), the lists' terms under it, and the tab's own room (a ResizeObserver on its root: each list lays out by that room, never by
 * the window). The customer's one name is the page's (P0-B9). F-CQ-205: the drafts' door is this tab's own section.
 */
/** The tab's state as its parts read it (band.ts TabFacts: the live tab's, or a design case's). */
export type QuotesTab = TabFacts

export function useQuotesTab(partyId: string, page: PageCounts): { tab: QuotesTab; rootRef: RefObject<HTMLDivElement | null>; onCloseDoor: () => void; onDoor: (door: Door) => void; onRetry: () => void } {
  const session = useOfficeSession()
  const router = useRouter()
  const params = useSearchParams()
  const prefix = companyPrefix(session.company?.code ?? '')
  const rights = useMemo(() => tabRightsOf(session.permissions), [session.permissions])
  const base = `${prefix}/sales/customers/${encodeURIComponent(partyId)}`
  const door = doorOf(params)
  const terms = useMemo(() => termsOfDoor(door), [door])

  // ---- F-CQ-302: the counts are the page's ONE read (use-before-order-counts.ts: the badge, the band, the Work line) ----
  const { counts, failed, onRetry } = page

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
    // F-CQ-205: every door is this tab's own — WRITING too (the drafts section "Customer is writing" is here now).
    return Object.fromEntries(DOORS.map((each) => [each, doorAddress(base, current, toggledDoor(door, each))])) as Record<Door, string>
  }, [base, query, door])
  const everything = useMemo(() => doorAddress(base, new URLSearchParams(query), null), [base, query])
  // F-CQ-B: a door is a button now (the band's filter tile): ONE replace to its address (the open door's: everything again), the
  // scroll kept — the same one write ✕ makes.
  const go = useCallback((href: string) => router.replace(href, { scroll: false }), [router])
  const onCloseDoor = useCallback(() => go(everything), [go, everything])
  const onDoor = useCallback((each: Door) => go(hrefs[each]), [go, hrefs])

  return { tab: { counts, failed, door, terms, rights, room, hrefs, everything, prefix }, rootRef, onCloseDoor, onDoor, onRetry }
}
