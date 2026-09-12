'use client'

/**
 * PES.1 — which tier the merged chips+tabs row is in (v2 spec §3.4).
 *
 * Chosen on the CONTAINER's width, not the viewport's: the rail is a fixed 66px and the slide-over
 * does not change it (§5), so the container is a pure function of viewport — but measuring the
 * container is what stays true if either of those ever changes.
 *
 *   A  ≥ 1300  one row, every tab labelled
 *   B  1000–1299  one row, non-active tabs icon-only
 *   C  < 1000  two rows — below 1000 no single row is both complete and legible
 */

import { useEffect, useRef, useState, type MutableRefObject } from 'react'

export type RowTier = 'A' | 'B' | 'C'

export function tierFor(width: number): RowTier {
  if (width >= 1300) return 'A'
  if (width >= 1000) return 'B'
  return 'C'
}

export function useContainerTier<T extends HTMLElement>(): [MutableRefObject<T | null>, RowTier] {
  const ref = useRef<T | null>(null)
  // Start at A rather than C: on the server and the first paint the width is unknown, and briefly
  // rendering the widest layout is far less jarring than briefly rendering the two-row fallback.
  const [tier, setTier] = useState<RowTier>('A')

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const read = () => {
      const next = tierFor(el.getBoundingClientRect().width)
      // Only re-render on an actual tier CHANGE — a resize fires continuously, and this value feeds
      // the row's whole render.
      setTier((prev) => (prev === next ? prev : next))
    }
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return [ref, tier]
}
