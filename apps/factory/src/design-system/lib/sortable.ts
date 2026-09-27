/**
 * Sortable drag — the geometry behind a drag that FEELS like one (Owner, 2026-09-28, on the media pickers: "the ui and
 * ux of drag and drop has to be improved").
 *
 * The old reorder (`usePointerReorder`) captured the pointer, did nothing on screen while it moved, and decided the
 * target on pointer-up by hit-testing the row under the pointer: the row did not lift, did not follow the hand, the
 * other rows did not make room, and a drop between two rows landed nowhere. This file decides, from the item boxes
 * measured when the drag starts:
 *   - a LIST (one axis): where the dragged item lands, from its own CENTER against the other items' midpoints, and how
 *     far every other item slides to open the gap (`listDropIndex`, `listShift`) — the sliding list of Shopify's and
 *     Linear's reorder;
 *   - a WRAP (chips that flow onto several lines): the nearest item to the pointer, and whether the insertion mark
 *     sits before or after it (`wrapDropIndex`) — sliding a wrapped line would reflow it under the hand.
 * Pure: the web's Vitest runs without a DOM.
 */

export interface SortRect { top: number; left: number; width: number; height: number }
export type SortAxis = 'x' | 'y'

const midOf = (r: SortRect, axis: SortAxis) => (axis === 'y' ? r.top + r.height / 2 : r.left + r.width / 2)

/**
 * Where the item dragged from `from` lands when its centre is at `center` (same axis, same coordinates as the rects).
 * Up: the FIRST item above whose midpoint the centre has passed. Down: the LAST item below whose midpoint it has passed.
 * Nothing passed ⇒ `from` (it goes back where it was).
 */
export function listDropIndex(rects: readonly SortRect[], from: number, center: number, axis: SortAxis = 'y'): number {
  let to = from
  for (let i = from - 1; i >= 0; i--) if (center < midOf(rects[i], axis)) to = i
  if (to !== from) return to
  for (let i = from + 1; i < rects.length; i++) if (center > midOf(rects[i], axis)) to = i
  return to
}

/** How far item `i` slides while `from` is dragged to `to`: one step toward the hole the dragged item left. */
export function listShift(i: number, from: number, to: number, step: number): number {
  if (i === from || from === to) return 0
  if (from < to && i > from && i <= to) return -step
  if (from > to && i >= to && i < from) return step
  return 0
}

/** One step = the dragged item's size plus the gap between items (measured, so a list's own spacing is kept). */
export function listStep(rects: readonly SortRect[], from: number, axis: SortAxis = 'y'): number {
  const size = (r: SortRect) => (axis === 'y' ? r.height : r.width)
  const start = (r: SortRect) => (axis === 'y' ? r.top : r.left)
  const self = rects[from]
  if (!self) return 0
  const next = rects[from + 1] ?? rects[from - 1]
  if (!next) return size(self)
  const [a, b] = start(next) > start(self) ? [self, next] : [next, self]
  return size(self) + Math.max(0, start(b) - (start(a) + size(a)))
}

/**
 * Wrap layout: the item nearest the pointer is the target. The mark goes BEFORE it when moving back, AFTER it when
 * moving forward — which is exactly where `moveChoice(values, from, to)` puts the item.
 */
export function wrapDropIndex(rects: readonly SortRect[], from: number, point: { x: number; y: number }): { to: number; side: 'before' | 'after' | null } {
  let best = from
  let bestDistance = Number.POSITIVE_INFINITY
  rects.forEach((r, i) => {
    /* Distance to the BOX, not its centre: inside a chip is distance 0, so a long chip is not out-voted by a short
       neighbour's closer centre. Ties go to the lower index, which keeps the answer stable at a shared edge. */
    const dx = Math.max(r.left - point.x, 0, point.x - (r.left + r.width))
    const dy = Math.max(r.top - point.y, 0, point.y - (r.top + r.height))
    const d = dx * dx + dy * dy
    if (d < bestDistance) { bestDistance = d; best = i }
  })
  if (best === from) return { to: from, side: null }
  return { to: best, side: best < from ? 'before' : 'after' }
}

/** A press becomes a drag only past this many pixels, so a click on a row stays a click. */
export const DRAG_THRESHOLD_PX = 4

/** Scroll the list's scroller when the pointer is this close to its top or bottom edge. */
export const AUTO_SCROLL_EDGE_PX = 28

/** How far to scroll per move event near an edge: faster the closer the pointer is to the edge. */
export function autoScrollDelta(pointer: number, edgeStart: number, edgeEnd: number, zone = AUTO_SCROLL_EDGE_PX, max = 14): number {
  if (pointer < edgeStart + zone) return -Math.ceil(max * (1 - Math.max(0, pointer - edgeStart) / zone))
  if (pointer > edgeEnd - zone) return Math.ceil(max * (1 - Math.max(0, edgeEnd - pointer) / zone))
  return 0
}
