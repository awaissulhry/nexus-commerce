'use client'

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'

/**
 * B-TH-213 — the record band slot (threads plan PL1; 10-web-notes §2 #5: a band slot in the shell, no packages/ui change). A record
 * page draws its band — back, number and customer, one status pill, its step, the Thread button, ⋯ — IN the shell's area band row
 * (the WorkspaceSubheader's dense DetailHeader), so the shell adds no band of its own above the record's: about 60 px won back for the
 * thread. The page claims the row while it is on screen (the shell stops drawing the page's crumbs there) and draws into the slot's
 * element through a portal, so its words and handlers stay its own. Where the shell has no band row (an area without pages, a window,
 * the print view, a design case without the shell) there is no slot: the page draws its band itself.
 */
export interface BandSlot {
  /** The element of the shell's band row the record band is drawn into, or null: the page draws its band in its own column. */
  readonly element: HTMLElement | null
  /** The shell's own parts of the band that stay beside the record's: the tab's live state and Print. */
  readonly status?: ReactNode
  readonly actions?: ReactNode
  /** Claims the band row for a record band (the crumbs give way); returns the release. A no-op where the shell has no band row. */
  readonly claim: () => () => void
}

const NO_SLOT: BandSlot = { element: null, claim: () => () => undefined }

export const BandSlotContext = createContext<BandSlot>(NO_SLOT)

/** The band slot of the shell around the page (NO_SLOT outside the office shell). */
export function useBandSlot(): BandSlot {
  return useContext(BandSlotContext)
}

/**
 * The shell's side: how many record bands claim the row, and the slot element once the shell draws it. `available` is false where
 * the shell draws no band row: claims then change nothing and the element stays null.
 */
export function useBandSlotHost(available: boolean, parts: { status?: ReactNode; actions?: ReactNode }) {
  const [claims, setClaims] = useState(0)
  const [element, setElement] = useState<HTMLElement | null>(null)
  const claim = useCallback(() => {
    setClaims((count) => count + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      setClaims((count) => Math.max(0, count - 1))
    }
  }, [])
  const claimed = available && claims > 0
  const value = useMemo<BandSlot>(
    () => (available ? { element: claimed ? element : null, status: parts.status, actions: parts.actions, claim } : NO_SLOT),
    [available, claimed, element, parts.status, parts.actions, claim],
  )
  return { claimed, ref: setElement, value }
}
