/**
 * Whether a box scrolls sideways, and what kind of scrollbar it shows — the pure half of `useHorizontalOverflow`.
 *
 * A macOS (or iOS, Android) OVERLAY scrollbar takes no room: it is drawn over the bottom of the scroll box, on top of
 * whatever sits there — in a tab strip, the labels, the active underline and the focus ring (the Owner's Publish
 * window, 2026-10-05). A CLASSIC scrollbar (a mouse plugged into a Mac, Windows) takes its own room below the
 * content, so it covers nothing; only a host of fixed height must grow by it. The DS strips read the mark this
 * returns (`data-overflows="overlay" | "classic"`) and make room only while the strip really scrolls.
 */
export type HorizontalOverflow =
  | { kind: 'overlay' }
  /** `size` — the classic bar's measured height in px (it is part of the box: offsetHeight − clientHeight − borders). */
  | { kind: 'classic'; size: number }

/** What is read from the element: its sizes and two computed styles. Plain numbers, so the rule tests in node. */
export interface HorizontalOverflowBox {
  scrollWidth: number
  clientWidth: number
  offsetHeight: number
  clientHeight: number
  borderTopWidth: number
  borderBottomWidth: number
  /** The computed `overflow-x`. */
  overflowX: string
  /** The computed `scrollbar-width` (`auto` | `thin` | `none`; empty where the browser does not know it). */
  scrollbarWidth: string
}

/**
 * A classic bar is at least 8px tall on every platform measured (Chromium thin 11px, regular 15px); rounding of
 * `offsetHeight`, `clientHeight` and fractional borders leaves at most 1–2px on a box with an overlay bar.
 */
const CLASSIC_MIN = 3

/**
 * `null` while the box does not scroll sideways: it is not a scroll box (`overflow-x` visible, hidden or clip), it
 * hides its scrollbar (`scrollbar-width: none`), or its content fits. "Fits" is the browser's own test — the
 * scrollbar shows as soon as `scrollWidth` exceeds `clientWidth` (both whole pixels), so no tolerance is added: a
 * strip 1px over still shows a bar, and that bar still needs the room.
 */
export function horizontalOverflow(box: HorizontalOverflowBox): HorizontalOverflow | null {
  if (box.overflowX !== 'auto' && box.overflowX !== 'scroll') return null
  if (box.scrollbarWidth === 'none') return null
  if (!(box.scrollWidth > box.clientWidth)) return null
  const bar = Math.round(box.offsetHeight - box.clientHeight - box.borderTopWidth - box.borderBottomWidth)
  return bar >= CLASSIC_MIN ? { kind: 'classic', size: bar } : { kind: 'overlay' }
}

/**
 * How long to wait before writing a measurement, in ms (0 = write now).
 *
 * Only ADDING the mark waits, and only on a strip whose children may still rearrange themselves after they render:
 * a grid toolbar overflows for a frame or two on every load until its fold collapses the chips (`GridToolbarFold`
 * measures in a passive effect) — marking at once grew the sheet's toolbar by the band and shrank it back 1–4 frames
 * later (measured in Chromium, 5 of 5 loads). `settleMs` is the quiet time the strip must keep overflowing, with no
 * resize or child change, before it is marked. Removing a mark, or a change of kind, never waits.
 */
export function overflowMarkDelay(marked: boolean, next: HorizontalOverflow | null, sinceChangeMs: number, settleMs: number): number {
  if (marked || next === null || settleMs <= 0) return 0
  return Math.max(0, settleMs - sinceChangeMs)
}

/** The attribute the CSS reads, and the custom property that carries a classic bar's height. */
export const OVERFLOW_ATTR = 'data-overflows'
export const SCROLLBAR_SIZE_PROP = '--nds-scrollbar-size'

/** The few DOM calls the mark needs — an `HTMLElement` satisfies it; a test passes a stub. */
export interface OverflowTarget {
  getAttribute(name: string): string | null
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
  style: {
    getPropertyValue(name: string): string
    setProperty(name: string, value: string): void
    removeProperty(name: string): string
  }
}

/**
 * Write the mark — and ONLY what changed, so a measurement that finds the same state touches nothing (no style
 * recalculation, no observer callback, no loop). Returns whether anything was written.
 */
export function markHorizontalOverflow(el: OverflowTarget, state: HorizontalOverflow | null): boolean {
  let wrote = false
  const kind = state?.kind ?? null
  if (el.getAttribute(OVERFLOW_ATTR) !== kind) {
    if (kind) el.setAttribute(OVERFLOW_ATTR, kind)
    else el.removeAttribute(OVERFLOW_ATTR)
    wrote = true
  }
  const size = state?.kind === 'classic' ? `${state.size}px` : ''
  if (el.style.getPropertyValue(SCROLLBAR_SIZE_PROP) !== size) {
    if (size) el.style.setProperty(SCROLLBAR_SIZE_PROP, size)
    else el.style.removeProperty(SCROLLBAR_SIZE_PROP)
    wrote = true
  }
  return wrote
}
