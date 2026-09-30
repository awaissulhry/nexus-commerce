'use client'
import { useEffect, useRef, useState } from 'react'
import type { GridApi } from '@/design-system/grid'

/**
 * Below this width the sheet pins no column. Pinned, the Product column was wider than a 390px phone, so no other cell
 * could be reached or tapped (P1, 2026-09-30). Unpinned, it scrolls away with the rest of the row.
 */
export const NARROW_SHEET_PX = 640

export function useNarrowSheet(): boolean {
  const [narrow, setNarrow] = useState(false)
  useEffect(() => {
    const query = window.matchMedia(`(max-width: ${NARROW_SHEET_PX - 1}px)`)
    const update = () => setNarrow(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return narrow
}


/**
 * Unpins the sheet's left-pinned columns on a narrow screen and pins the same ones back when it widens. Through the grid
 * API, and again whenever the grid rebuilds its columns: AG reads `pinned` from a definition only when it creates the
 * column, and the sheet re-creates its Product column after its data arrives, pinned again.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- both sheets' row types
export function useUnpinOnNarrowSheet(getGridApi: () => GridApi<any> | null | undefined, gridReady: unknown) {
  const narrow = useNarrowSheet()
  const unpinned = useRef<string[]>([])
  useEffect(() => {
    const api = getGridApi()
    if (!gridReady || !api || api.isDestroyed()) return
    if (!narrow) {
      if (unpinned.current.length) api.setColumnsPinned(unpinned.current, 'left')
      unpinned.current = []
      return
    }
    const unpin = () => {
      if (api.isDestroyed()) return
      // Every grid column: `getColumns()` leaves out the Product (auto group) and selection columns, which are the pinned ones.
      const pinned = (api.getAllGridColumns() ?? []).filter(column => column.getPinned() === 'left').map(column => column.getColId())
      if (!pinned.length) return
      unpinned.current = [...new Set([...unpinned.current, ...pinned])]
      api.setColumnsPinned(pinned, null)
    }
    unpin()
    api.addEventListener('displayedColumnsChanged', unpin)
    return () => { if (!api.isDestroyed()) api.removeEventListener('displayedColumnsChanged', unpin) }
  }, [narrow, gridReady, getGridApi])
}
