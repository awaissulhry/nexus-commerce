'use client'

/**
 * PES.4 — the drawer's open state and its width.
 *
 * ## The open state is NOT owned here any more
 *
 * This hook used to write `?rec=` / `?cell=` itself. PES.1's frame now publishes `useStudioRecord()`
 * (`_studio/contracts.tsx`), which owns those two keys, and PES.2's master sheet already calls
 * `record.open(rowId)` on row double-click. Keeping a second writer for the same two keys would be
 * the ruling-#27 duplication in its most dangerous form: two components patching one query string.
 * The frame's own header warns about exactly that — a merged filter bar once dropped a live
 * `?status=all` because two writers disagreed about which keys they owned.
 *
 * So this delegates, and the frame's version wins on the one point where they differed. Mine
 * pushed on closed→open and replaced afterwards; theirs pushes every open and counts them, so
 * `close()` steps BACK off the stack instead of pushing an entry that Back would walk straight
 * into again. Theirs is the better answer — it also handles arriving with `?rec=` already set from
 * a shared link, where there is no entry of ours to pop.
 *
 * ## What IS owned here: the width
 *
 * Nobody else owns it, and it is deliberately not in the URL. It is a per-operator preference, not
 * part of what a shared link means — sending someone a record should not resize their workspace.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { emitPrefsChanged, onPrefsChanged } from '@/design-system/patterns/prefs-bus'
import { useStudioRecord } from '../contracts'

const WIDTH_KEY = 'pes.drawer.width'
const DEFAULT_WIDTH = 520
export const MIN_WIDTH = 380
/** §5.3. Past this the panel stops being a panel and starts being the page. */
export const MAX_WIDTH = 720

export interface RecordDrawerState {
  recordId: string | null
  cellKey: string | null
  open: (recordId: string, cellKey?: string) => void
  close: () => void
  width: number
  setWidth: (px: number) => void
}

function clamp(px: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(px)))
}

/** The width, on its own — for a host that takes its open state straight from `useStudioRecord()`. */
export function useDrawerWidth(): { width: number; setWidth: (px: number) => void } {
  // Starts at the default on BOTH server and first client render, then adopts the stored value in
  // an effect. Reading localStorage during render would make the server's HTML and the client's
  // first paint disagree, which React resolves by throwing the markup away.
  const [width, setWidthState] = useState(DEFAULT_WIDTH)

  useEffect(() => {
    const read = () => {
      try {
        const raw = window.localStorage.getItem(WIDTH_KEY)
        if (raw) setWidthState(clamp(Number(raw)))
      } catch {
        /* private mode, blocked storage — the default is a perfectly good answer */
      }
    }
    read()
    // A preference changed elsewhere in THIS tab (another surface, a reset) should land without a
    // reload; localStorage fires no event in the tab that wrote it.
    return onPrefsChanged((key) => {
      if (key === WIDTH_KEY) read()
    })
  }, [])

  const setWidth = useCallback((px: number) => {
    const next = clamp(px)
    setWidthState(next)
    try {
      window.localStorage.setItem(WIDTH_KEY, String(next))
      emitPrefsChanged(WIDTH_KEY)
    } catch {
      /* the drag still works; only the memory of it is lost */
    }
  }, [])

  return useMemo(() => ({ width, setWidth }), [width, setWidth])
}

/** Open state (the frame's) + width (this lane's), for hosts that want one object. */
export function useRecordDrawer(): RecordDrawerState {
  const record = useStudioRecord()
  const { width, setWidth } = useDrawerWidth()
  return useMemo(
    () => ({
      recordId: record.rowId,
      cellKey: record.colKey,
      open: record.open,
      close: record.close,
      width,
      setWidth,
    }),
    [record.rowId, record.colKey, record.open, record.close, width, setWidth],
  )
}
