/**
 * The overflow marker of a scrolling tab strip (`Tabs overflow="scroll"`), as pure rules — `apps/web` vitest is
 * node-only, so they are tested here and `Tabs.tsx` only applies them (bid page polish round 2, audit M6: at 1440 the
 * Rules & Automation strip hid "Keyword Tracker" behind an overlay scrollbar with no sign that it was there).
 *
 *  - Each edge with more tabs beyond it is marked: the labels fade out there and an arrow scrolls that way.
 *  - An arrow scrolls by most of the visible strip, so one tab that was cut is still in view after the move.
 *  - A tab that takes the focus, or the tab you are on, is brought wholly into view clear of the fade, so a label is
 *    never left cut under it; at the strip's own ends there is nothing to clear.
 *  - The arrows are for a pointer: a keyboard moves between tabs with Tab / ←→ / Home / End, and the strip follows the
 *    focus. They take no focus and are hidden from a screen reader, which hears every tab anyway.
 */

/** How far the fade reaches into the strip at a marked edge (px: clear under the 28px arrow, then fading in over 28);
 *  a revealed tab stays clear of it. Matches `.nds-tabs-scroller` in components.css. */
export const TAB_FADE = 56

export interface StripBox { scrollLeft: number; clientWidth: number; scrollWidth: number }

/** Which edges have more tabs beyond them. A pixel of rounding is not "more". */
export function stripEdges({ scrollLeft, clientWidth, scrollWidth }: StripBox): { start: boolean; end: boolean } {
  const max = Math.max(0, scrollWidth - clientWidth)
  return { start: scrollLeft > 1, end: max - scrollLeft > 1 }
}

/** One arrow press: most of the visible strip, at least one tab's worth. */
export function stripStep(clientWidth: number): number {
  return Math.max(80, Math.round(clientWidth * 0.8))
}

/**
 * The scroll change that shows a tab wholly, clear of the fade on an edge that has more beyond it. `strip` and `tab`
 * are their boxes' left/right on screen; 0 when the tab is already clear. A tab wider than the room shows its start.
 */
export function revealDelta(
  strip: { left: number; right: number },
  tab: { left: number; right: number },
  box: StripBox,
  fade = TAB_FADE,
): number {
  const max = Math.max(0, box.scrollWidth - box.clientWidth)
  const clamp = (d: number) => Math.max(-box.scrollLeft, Math.min(max - box.scrollLeft, d))
  const solve = (fadeStart: boolean, fadeEnd: boolean) => {
    const leftRoom = strip.left + (fadeStart ? fade : 0)
    const rightRoom = strip.right - (fadeEnd ? fade : 0)
    if (tab.left < leftRoom) return tab.left - leftRoom
    if (tab.right > rightRoom) return Math.min(tab.right - rightRoom, tab.left - leftRoom)
    return 0
  }
  // A fade sits only on an edge that still has more AFTER the move: try with both, then again with the fades of the
  // ends that move reaches dropped (at the strip's own ends there is nothing to clear). Never past the ends.
  const first = clamp(solve(max > 0, max > 0))
  const after = box.scrollLeft + first
  return clamp(solve(after > 1, max - after > 1))
}
