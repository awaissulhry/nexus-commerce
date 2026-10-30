'use client'

import { useCallback, useEffect, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'

/**
 * The shipping screens' hooks. The live stream, the coalesced re-read and the CSV download are the order screens' (one
 * Office view: the same `/live` stream and the same file download); the thread dock is the shipment's own (remembered
 * per record type on this device).
 */
export { downloadText, useCoalesced, useLive, type LiveState } from '../../sales/orders/hooks'

const WIDE = '(min-width: 1280px)'
const DOCK_KEY = 'fw.warehouse.dock.Shipment'

/**
 * Owner O1: the shipment's thread beside any tab on a wide screen (1280 px and wider, ⌘J), remembered on this device (a
 * per-viewer convenience: localStorage, read and written with try/catch); narrower, the same button opens Activity.
 */
export function useThreadDock() {
  const router = useRouter()
  const pathname = usePathname()
  const [open, setOpen] = useState(false)
  useEffect(() => {
    try {
      setOpen(window.localStorage.getItem(DOCK_KEY) === '1' && window.matchMedia(WIDE).matches)
    } catch {
      setOpen(false)
    }
  }, [])
  const toggle = useCallback(() => {
    let wide = false
    try {
      wide = window.matchMedia(WIDE).matches
    } catch {
      wide = false
    }
    if (!wide) {
      router.push(`${pathname}?tab=activity`)
      return
    }
    setOpen((current) => {
      const next = !current
      try {
        window.localStorage.setItem(DOCK_KEY, next ? '1' : '0')
      } catch {
        // Not kept on this device; the dock still toggles.
      }
      return next
    })
  }, [pathname, router])
  return { dockOpen: open, toggleDock: toggle }
}
