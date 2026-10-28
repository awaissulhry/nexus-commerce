import { useLayoutEffect, type RefObject } from 'react'
import { horizontalOverflow, markHorizontalOverflow, overflowMarkDelay, OVERFLOW_ATTR, type HorizontalOverflow } from '../lib/horizontal-overflow'

/** Read the element's sizes and the two computed styles the rule needs. */
function measure(el: HTMLElement): HorizontalOverflow | null {
  const style = getComputedStyle(el)
  return horizontalOverflow({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
    offsetHeight: el.offsetHeight,
    clientHeight: el.clientHeight,
    borderTopWidth: parseFloat(style.borderTopWidth) || 0,
    borderBottomWidth: parseFloat(style.borderBottomWidth) || 0,
    overflowX: style.overflowX,
    scrollbarWidth: style.getPropertyValue('scrollbar-width'),
  })
}

export interface HorizontalOverflowOptions {
  /** `false` removes the mark and stops watching (a strip that is not drawn as a scroll box). Default `true`. */
  enabled?: boolean
  /**
   * Quiet time (ms) a strip must keep overflowing before it is marked, for a strip whose children rearrange
   * themselves after they render (a grid toolbar's fold). Default 0: marked before the first paint.
   */
  settleMs?: number
}

/**
 * Marks a strip that scrolls sideways with `data-overflows="overlay" | "classic"` (and, for a classic bar, its
 * height in `--nds-scrollbar-size`), so its CSS keeps the scrollbar off what the strip holds — ONLY while it
 * scrolls. A strip that fits, is not a scroll box, or hides its scrollbar carries no mark and nothing changes.
 *
 * - Writes the DOM directly and only on a change: no React state, so no re-render and no render loop. React leaves
 *   the attribute alone, as it is not one of the element's props.
 * - Follows the strip's size AND every child's (a label that grows, a tab added) — a `ResizeObserver` on the strip
 *   and its children, re-attached when children come and go (`MutationObserver`). A host's media query that turns
 *   the scroll off resizes the strip, so it is followed too.
 * - The first measurement runs before paint (layout effect); later ones on the next frame, so a mark that changes a
 *   host's height never resizes an observed element inside its own observer callback.
 * - SSR-safe: nothing runs on the server, and the mark is removed on unmount or when `enabled` turns false.
 */
export function useHorizontalOverflow(ref: RefObject<HTMLElement | null>, { enabled = true, settleMs = 0 }: HorizontalOverflowOptions = {}): void {
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !enabled) return
    let frame = 0, timer: ReturnType<typeof setTimeout> | undefined
    let changedAt = performance.now()
    const update = () => {
      frame = 0
      if (!el.isConnected) return
      const next = measure(el)
      const wait = overflowMarkDelay(el.hasAttribute(OVERFLOW_ATTR), next, performance.now() - changedAt, settleMs)
      if (wait > 0) { clearTimeout(timer); timer = setTimeout(schedule, wait); return }
      markHorizontalOverflow(el, next)
    }
    function schedule() {
      if (!frame) frame = requestAnimationFrame(update)
    }
    const changed = () => { changedAt = performance.now(); schedule() }
    // Before the first paint — except for a settling strip, whose first layout is the one that is not final yet.
    if (settleMs > 0) schedule()
    else update()
    if (typeof ResizeObserver === 'undefined') return () => { if (frame) cancelAnimationFrame(frame); clearTimeout(timer); markHorizontalOverflow(el, null) }

    const sizes = new ResizeObserver(changed)
    const watch = () => {
      sizes.disconnect()
      sizes.observe(el)
      for (const child of Array.from(el.children)) sizes.observe(child)
    }
    watch()
    const children = typeof MutationObserver === 'undefined' ? null : new MutationObserver(() => { watch(); changed() })
    children?.observe(el, { childList: true })
    return () => {
      sizes.disconnect()
      children?.disconnect()
      if (frame) cancelAnimationFrame(frame)
      clearTimeout(timer)
      markHorizontalOverflow(el, null)
    }
  }, [ref, enabled, settleMs])
}
