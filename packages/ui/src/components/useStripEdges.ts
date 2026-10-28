import { useEffect, type RefObject } from 'react'
import { stripEdges } from './tabsScroll'

/**
 * The overflow marker's state (polish round 2, audit M6): marks `frame` with `data-more-start` / `data-more-end` while
 * the strip `list` has tabs beyond that edge, which the CSS turns into a fade and an arrow (`components.css`,
 * `.nds-tabs-scroller`). Follows the strip's scroll and the size of the strip and every tab; `key` re-attaches when the
 * tabs change. Direct DOM writes, only on a change and at most once a frame: no React state, no re-render while
 * scrolling. Rules: `tabsScroll.ts` (tested).
 */
export function useStripEdges(list: RefObject<HTMLElement | null>, frame: RefObject<HTMLElement | null>, enabled: boolean, key: string): void {
  useEffect(() => {
    const strip = list.current, host = frame.current
    if (!enabled || !strip || !host) return
    let pending = 0
    const mark = () => {
      pending = 0
      const edges = stripEdges(strip)
      for (const [attr, on] of [['data-more-start', edges.start], ['data-more-end', edges.end]] as const) {
        if (on !== host.hasAttribute(attr)) host.toggleAttribute(attr, on)
      }
    }
    const schedule = () => { if (!pending) pending = requestAnimationFrame(mark) }
    mark()
    strip.addEventListener('scroll', schedule, { passive: true })
    const sizes = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule)
    sizes?.observe(strip)
    strip.querySelectorAll<HTMLElement>('[data-tab-id]').forEach((tab) => sizes?.observe(tab))
    return () => {
      strip.removeEventListener('scroll', schedule)
      sizes?.disconnect()
      if (pending) cancelAnimationFrame(pending)
    }
  }, [list, frame, enabled, key])
}
