'use client'

import { useCallback, useEffect, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'

/** The tab a record page shows (`?tab=`), one of its tabs, else the first. */
export function useRecordTab<T extends string>(tabs: readonly T[]): T {
  const params = useSearchParams()
  const asked = params?.get('tab')
  return (tabs as readonly string[]).includes(asked ?? '') ? (asked as T) : tabs[0]!
}

const WIDE = '(min-width: 1280px)'

/**
 * Owner O1: the record's thread beside any tab on a wide screen, remembered per record type on this device (a
 * per-viewer convenience: localStorage, read and written with try/catch); narrower, the same button opens Activity.
 */
export function useThreadDock(recordType: string, activityTab = 'activity') {
  const router = useRouter()
  const pathname = usePathname()
  const key = `fw.admin.dock.${recordType}`
  const [open, setOpen] = useState(false)
  useEffect(() => {
    try {
      setOpen(window.localStorage.getItem(key) === '1' && window.matchMedia(WIDE).matches)
    } catch {
      setOpen(false)
    }
  }, [key])
  const toggle = useCallback(() => {
    let wide = false
    try {
      wide = window.matchMedia(WIDE).matches
    } catch {
      wide = false
    }
    if (!wide) {
      router.push(`${pathname}?tab=${activityTab}`)
      return
    }
    setOpen((current) => {
      const next = !current
      try {
        window.localStorage.setItem(key, next ? '1' : '0')
      } catch {
        // Not kept on this device; the dock still toggles.
      }
      return next
    })
  }, [activityTab, key, pathname, router])
  return { dockOpen: open, toggleDock: toggle }
}

/** `?new=<what>` asks a list page to open a create dialog (the palette, the checklist's "Do it"). */
export function useNewParam(): string | null {
  const params = useSearchParams()
  return params?.get('new') ?? null
}
