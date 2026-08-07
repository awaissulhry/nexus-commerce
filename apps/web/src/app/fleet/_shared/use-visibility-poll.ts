'use client'

/**
 * NAF.SB shared decision #1 (docs/2026-08-07-naf-sb-session-locks.md §5,
 * SETTLED 2026-08-07): real-time on every fleet page is visibility-gated
 * polling — refetch on an ~10s cadence while the tab is visible, pause when
 * hidden, catch up the moment the tab becomes visible again, and surface an
 * "as of" stamp so the operator knows how fresh the screen is. No SSE, no new
 * infrastructure.
 *
 * Extracted early by the Workflows stream (the locks doc allows whoever needs
 * it sooner to extract it and record that); Workers re-points at it in W.6.
 *
 * Contract: `load` owns its own error state and THROWS on failure — the hook
 * swallows the throw and keeps the previous stamp, so `asOf` is always the
 * time of the last SUCCESSFUL read, never the last attempt.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

export function useVisibilityPoll(
  load: () => Promise<void>,
  intervalMs = 10_000,
): { asOf: Date | null; refresh: () => void } {
  const loadRef = useRef(load)
  loadRef.current = load
  const inFlight = useRef(false)
  const [asOf, setAsOf] = useState<Date | null>(null)

  const tick = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    try {
      await loadRef.current()
      setAsOf(new Date())
    } catch {
      /* the consumer surfaced its own error; the stamp stays honest */
    } finally {
      inFlight.current = false
    }
  }, [])

  useEffect(() => {
    void tick()
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') void tick()
    }, intervalMs)
    const onVisible = () => {
      if (document.visibilityState === 'visible') void tick()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [tick, intervalMs])

  return { asOf, refresh: () => void tick() }
}
