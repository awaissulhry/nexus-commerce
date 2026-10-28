/**
 * Builder scroll-spy — the pure rules (Reviews parts, 2026-10-26). No React, so Node tests cover them.
 *
 * In page mode the page scrolls (not the builder), so an `IntersectionObserver` reports how much of each section shows in
 * a band under the sticky section strip. The section the strip marks is the one that shows MOST in that band (the first
 * of equals); none showing keeps the last one marked; scrolled to the very end marks the last section, which a short
 * last section would otherwise never reach.
 */

export interface SectionVisibility {
  id: string
  /** How much of the section shows in the band, px (the intersection's height). */
  visible: number
}

export function spyActiveSection(
  order: readonly string[],
  seen: ReadonlyMap<string, number> | readonly SectionVisibility[],
  previous: string | undefined,
  atEnd = false,
): string | undefined {
  if (order.length === 0) return undefined
  if (atEnd) return order[order.length - 1]
  const visible = seen instanceof Map ? seen : new Map((seen as readonly SectionVisibility[]).map(s => [s.id, s.visible]))
  let best: string | undefined
  let most = 0
  for (const id of order) {
    const px = visible.get(id) ?? 0
    if (px > most) {
      best = id
      most = px
    }
  }
  if (best) return best
  return previous && order.includes(previous) ? previous : order[0]
}

/** True when a scroller is scrolled to its end (a pixel of slack for fractional zoom). */
export function scrolledToEnd(scrollTop: number, clientHeight: number, scrollHeight: number): boolean {
  return scrollHeight > clientHeight && scrollTop + clientHeight >= scrollHeight - 1
}

/** The id a section's element carries, so a strip button and an address hash can name it. */
export function builderSectionId(id: string): string {
  return `bsec-${id}`
}
