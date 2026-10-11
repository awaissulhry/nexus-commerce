'use client'

/**
 * useNarrow — true on a phone-width screen (Keyword Harvest DS lane H4, 2026-10-10). ONE breakpoint for the pages and
 * their sheets.
 *
 * The pages had four private `usePhone` copies at `max-width: 639px` (control-room CampaignsTab, Bid BidsView and
 * RulesView, the approvals grid), while the DS `DetailModal` turns into a full-screen sheet at `breakpoint.sm` = 760px
 * (`tokens/breakpoints.ts`, `.nds-modal.detail` in `components.css`). Between 640 and 760 px a page showed its desktop
 * table while its modal was already a sheet. This hook uses the sheet's breakpoint, so a page that asks "narrow?" and
 * the modal it opens agree. The four copies stay until their pages move here.
 *
 * Server and first client render: false (the desktop layout), then the real answer — the same as the copies did.
 */
import { useSyncExternalStore } from 'react'
import { mediaQuery } from '../tokens/breakpoints'

/** `(max-width: 760px)` — the DetailModal's sheet breakpoint. */
export const NARROW_QUERY = mediaQuery.belowSm

function subscribe(onChange: () => void): () => void {
  const query = window.matchMedia(NARROW_QUERY)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}
const isNarrow = () => window.matchMedia(NARROW_QUERY).matches
const onServer = () => false

export function useNarrow(): boolean {
  return useSyncExternalStore(subscribe, isNarrow, onServer)
}
