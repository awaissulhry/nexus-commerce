/**
 * Elevation + focus tokens. All H10 shadows are tinted with the same navy base
 * (`20 28 38`) at increasing blur/alpha; the focus ring uses the primary blue.
 */

/** Shadow base color as an "R G B" triple (for rgb(var(--x) / <a>) usage). */
export const shadowColor = '20 28 38'

export const shadow = {
  /** resting cards, edit bar */
  card: '0 6px 22px rgba(20, 28, 38, 0.16)',
  /** dropdowns, popovers, menus */
  menu: '0 12px 30px rgba(20, 28, 38, 0.16)',
  /** larger popovers (library, date picker) */
  pop: '0 16px 40px rgba(20, 28, 38, 0.2)',
  /** modal panel */
  modal: '0 18px 48px rgba(20, 28, 38, 0.28)',
  /** rail hover overlay (horizontal) */
  rail: '8px 0 30px rgba(20, 28, 38, 0.13)',
  /** dark tooltip */
  tip: '0 10px 26px rgba(20, 28, 38, 0.3)',
} as const

/** Focus ring — primary blue @ 12% (the dominant variant; some controls use 3px/15%). */
export const focusRing = '0 0 0 2px rgba(31, 111, 222, 0.12)'
