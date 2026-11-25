'use client'

import { useEffect, type RefObject } from 'react'

/**
 * pp-fx5 (walk W-13), pp-fx7 (re-walk R2-01): a scrolling tab strip keeps the tab you are on whole in view — the order's body tabs
 * ("Files 1" sat under the › arrow) and a band's tab row ("Ship notices 2" under it: the DS reveal moved 6 of 22 px). The DS strip
 * reveals the active tab once; the strip's own width moves after (the frame settles, a count arrives), so the portal brings the
 * active tab to the strip's middle whenever the strip or a tab changes size. Sideways only (the strip's own scroll), never the page.
 * `root` holds the strip (`.nds-tabs`); `key` changes with the active tab and the tabs shown.
 */
export function useActiveTabInView(root: RefObject<HTMLElement | null>, key: string | null): void {
  useEffect(() => {
    const strip = key === null ? null : (root.current?.querySelector<HTMLElement>('.nds-tabs') ?? null)
    if (!strip) return
    const reveal = () => {
      const tab = strip.querySelector<HTMLElement>('[aria-current="page"]')
      if (!tab) return
      const box = strip.getBoundingClientRect()
      const own = tab.getBoundingClientRect()
      strip.scrollLeft += own.left + own.width / 2 - (box.left + box.width / 2)
    }
    reveal()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(reveal)
    observer.observe(strip)
    strip.querySelectorAll<HTMLElement>('[data-tab-id]').forEach((tab) => observer.observe(tab))
    return () => observer.disconnect()
  }, [root, key])
}
