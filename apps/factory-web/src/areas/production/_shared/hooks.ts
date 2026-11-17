'use client'

import { useCallback, useEffect, useRef } from 'react'
import { useLiveBus } from '../../../shell/live/use-live'
import type { LiveChange } from '../../../record-panels/model'

export type LiveState = 'connecting' | 'live' | 'offline'

/**
 * The live stream (`GET /live` through this app's `/api`): workorder.* and production.* events of the work orders this
 * person may see, with the stream's state in words (connecting, live, offline; the browser's EventSource reconnects by
 * itself, and after a break the page reads everything again). A message is a hint: the page reads the part again.
 */
export function useLive(onChange: (change: LiveChange) => void, onReconnect: () => void, enabled = true): LiveState {
  // B-W2b-05: the tab's ONE live connection (shell/live/bus.ts), shared with the bell and every other screen.
  return useLiveBus({ onChange, onReconnect }, enabled)
}

// B-TH-265: the work order's own dock hook (useThreadDock) went: the record frame docks its thread (areas/_shared/record-frame).

/** The byte-order mark spreadsheet programs need to read a UTF-8 CSV as UTF-8. */
const BOM = String.fromCharCode(0xfeff)

/** Downloads text as a file (Export N (CSV)): a Blob link, clicked once. */
export function downloadText(name: string, text: string, type = 'text/csv;charset=utf-8'): void {
  const url = URL.createObjectURL(new Blob([`${BOM}${text}`], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Calls `run` at most once per `ms` while changes keep coming (live events: one read, not one per scan). */
export function useCoalesced(run: () => void, ms = 600): () => void {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latest = useRef(run)
  latest.current = run
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )
  return useCallback(() => {
    if (timer.current) return
    timer.current = setTimeout(() => {
      timer.current = null
      latest.current()
    }, ms)
  }, [ms])
}
