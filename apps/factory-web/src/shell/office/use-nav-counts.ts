'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { z } from 'zod'
import type { AreaNav, AreaNavItem } from '@nexus/ui/patterns/shell/index'
import { browserApi } from '../../lib/api/browser'
import type { ApiClient } from '../../lib/api/client'
import { useLiveChanges } from '../../record-panels/live'

/**
 * F-SA-210 (sales page plan N1, pick P1; 12-lists-board §1.1, §1.3): the sub-sidebar's counts — today one, Sales › Incoming's
 * "N waiting on us" (GET /sales/incoming/waiting-count, B-SA-010: the rows whose next move is ours, under the reader's own walls,
 * so a person limited to some customers counts only theirs). Built like the bell (use-bell.ts): ONE light read when the shell
 * mounts, only for a person who reaches Incoming (sales.inquiries.view), then again when the live stream says a request, a
 * catalogue order or a change request moved, after a reconnect; a burst of changes is one read. An unknown count (reading,
 * failed, offline, or a reader who lists no kind) has no key, so the row shows no badge — never a guessed 0; the design system
 * draws a badge only above 0. Office shell only: never in the portal.
 */

/** The Incoming row's badge key (areas/sales/nav.ts). */
export const INCOMING_WAITING = 'sales.incoming.waiting'

/** The permission that reaches Incoming (its row's own). */
const INCOMING_VIEW = 'sales.inquiries.view'

/** The events that move the count (each names its customer: party-limited people get them too). */
export const NAV_COUNT_EVENTS: readonly string[] = Object.freeze([
  'inquiry.received',
  'inquiry.changed',
  'inquiry.closed',
  'portal_order_request.sent',
  'portal_order_request.accepted',
  'portal_order_request.refused',
  'portal_order_request.withdrawn',
  'order_change_request.asked',
  'order_change_request.withdrawn',
  'order_change_request.answered',
  'order_change_request.countered',
  'order_change_request.counter_answered',
])

/** A burst of changes is one read. */
const SETTLE_MS = 500

const waitingSchema = z.object({ count: z.number().nullable(), asOf: z.string() })
export type WaitingCount = z.infer<typeof waitingSchema>

export function fetchWaitingCount(api: ApiClient, signal?: AbortSignal): Promise<WaitingCount> {
  return api.get('/sales/incoming/waiting-count', { schema: waitingSchema, signal })
}

/** The shell asks for the count only for a person who reaches Incoming. */
export const navCountsWanted = (permissions: readonly string[]): boolean => permissions.includes(INCOMING_VIEW)

/** The counts by badge key from the answer: none known (null answer or null count) → no key. */
export function navCountsOf(answer: Pick<WaitingCount, 'count'> | null): Readonly<Record<string, number>> {
  return answer && typeof answer.count === 'number' && answer.count >= 0 ? { [INCOMING_WAITING]: answer.count } : {}
}

/**
 * The navigation with each counted row's screen-reader name in words ("Incoming, 3 waiting on us"), set only when its count is
 * known (factory code: the design system draws the badge from `counts`, its row takes an `ariaLabel`). `words` says the words.
 */
export function withNavCountWords(nav: AreaNav, counts: Readonly<Record<string, number>>, words: (badge: string, count: number) => string): AreaNav {
  if (Object.keys(counts).length === 0) return nav
  const row = (item: AreaNavItem): AreaNavItem => {
    const count = item.badge ? counts[item.badge] : undefined
    const named = count === undefined ? item : { ...item, ariaLabel: words(item.badge!, count) }
    return named.children ? { ...named, children: named.children.map(row) } : named
  }
  return { ...nav, areas: nav.areas.map((area) => (area.sections ? { ...area, sections: area.sections.map((section) => ({ ...section, items: section.items.map(row) })) } : area)) }
}

/** The shell's counts (see the file's head). */
export function useNavCounts(company: string, permissions: readonly string[]): Readonly<Record<string, number>> {
  const enabled = navCountsWanted(permissions)
  const api = useMemo(() => browserApi({ company }), [company])
  const [counts, setCounts] = useState<Readonly<Record<string, number>>>({})
  const seq = useRef(0)
  const read = useCallback(async () => {
    const mine = ++seq.current
    try {
      const answer = await fetchWaitingCount(api)
      if (mine === seq.current) setCounts(navCountsOf(answer))
    } catch {
      // Unknown: no badge (never a guessed 0).
      if (mine === seq.current) setCounts({})
    }
  }, [api])

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const soon = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      void read()
    }, SETTLE_MS)
  }, [read])
  useEffect(() => () => (timer.current ? clearTimeout(timer.current) : undefined), [])

  useEffect(() => {
    if (enabled) void read()
    else setCounts({})
  }, [enabled, read])
  useLiveChanges({ onChange: (change) => NAV_COUNT_EVENTS.includes(change.type) && soon(), onReconnect: soon }, enabled)
  // Offline: the count may be old — no badge until the stream is back (the reconnect reads it again).
  useEffect(() => {
    if (!enabled) return
    const offline = () => setCounts({})
    window.addEventListener('offline', offline)
    return () => window.removeEventListener('offline', offline)
  }, [enabled])

  return enabled ? counts : {}
}
