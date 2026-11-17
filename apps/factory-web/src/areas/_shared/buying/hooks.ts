'use client'

import { useCallback, useEffect, useRef } from 'react'
import { useLiveBus } from '../../../shell/live/use-live'
import type { LiveChange } from '../../../record-panels/model'

export type LiveState = 'connecting' | 'live' | 'offline'

/**
 * The live stream (`GET /live` through this app's `/api`) with its state in words (connecting, live, offline; the
 * browser's EventSource reconnects by itself, and after a break the page reads everything again). A message is a hint:
 * the page reads the part again, it never takes data from the message.
 */
export function useLive(onChange: (change: LiveChange) => void, onReconnect: () => void, enabled = true): LiveState {
  // B-W2b-05: the tab's ONE live connection (shell/live/bus.ts), shared with the bell and every other screen.
  return useLiveBus({ onChange, onReconnect }, enabled)
}

/** Calls `run` at most once per `ms` while changes keep coming (a burst of live events: one read). */
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

/** Keys of a page (one handler, removed on unmount): never while typing, in a dialog, a menu or a listbox. */
export function usePageKeys(onKey: (event: KeyboardEvent) => void): void {
  const latest = useRef(onKey)
  latest.current = onKey
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], [role="listbox"]') || target.isContentEditable)) return
      latest.current(event)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])
}
