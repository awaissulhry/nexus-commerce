/**
 * Motion tokens. H10 transitions are fast + intentional (.12–.18s ease). Mirror
 * the app's existing fast/base/slow scale (lib/theme/index.ts DURATION_MS) so JS
 * and CSS stay in sync; the H10-specific micro-durations are named separately.
 */

export const duration = {
  micro: '120ms', // color/background hover on nav + cells
  label: '140ms', // rail label/opacity fades
  control: '150ms', // chevrons, toggles
  panel: '180ms', // rail width, larger reveals
} as const

export const easing = {
  /** H10 uses the CSS default `ease` almost everywhere. */
  standard: 'ease',
  /** smooth decel for entrances (matches the app's `out` easing). */
  out: 'cubic-bezier(0.16, 1, 0.3, 1)',
} as const

/** Numeric ms for JS-driven transitions (e.g. unmount-after-fade). */
export const durationMs = { micro: 120, label: 140, control: 150, panel: 180 } as const
