'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { browserApi } from '../../lib/api/browser'
import { useLiveChanges } from '../../record-panels/live'
import { fetchCounts } from '../../areas/home/notifications/api'
import { LIVE_EVENTS, NOTIFICATIONS_CHANGED, type BellState } from '../../areas/home/notifications/model'

/** A burst of changes (several notifications of one event, a bulk mark) is one read. */
const SETTLE_MS = 500

/**
 * The top bar's bell (design shell.frame top-bar: "W1 bell counts approvals only; W2a adds mentions, assignments and
 * alerts"): the person's unread notifications still to look at, by ONE light read (GET /notifications/counts) when the
 * shell mounts — never on every page — then again only when the live stream says a notification was made
 * (`notification.created`), after a reconnect, and when the notifications page changed some (`factory:notifications-
 * changed`). Only for a person who reaches Home (home.view); else null (no bell).
 */
export function useBell(company: string, enabled: boolean): BellState | null {
  const api = useMemo(() => browserApi({ company }), [company])
  const [bell, setBell] = useState<BellState>({ status: 'loading' })
  const seq = useRef(0)
  const read = useCallback(async () => {
    const mine = ++seq.current
    try {
      const counts = await fetchCounts(api)
      if (mine === seq.current) setBell({ status: 'ready', unread: counts.unread, complete: counts.complete })
    } catch {
      // An unknown count shows no badge, never 0 (the bell's words say it is not available).
      if (mine === seq.current) setBell({ status: 'error' })
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
  }, [enabled, read])
  useLiveChanges({ onChange: (change) => LIVE_EVENTS.includes(change.type) && soon(), onReconnect: soon }, enabled)
  useEffect(() => {
    if (!enabled) return
    window.addEventListener(NOTIFICATIONS_CHANGED, soon)
    return () => window.removeEventListener(NOTIFICATIONS_CHANGED, soon)
  }, [enabled, soon])

  return enabled ? bell : null
}
