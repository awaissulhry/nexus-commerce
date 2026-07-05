/**
 * Breakpoint tokens — the two reflow points H10 uses (the filter grid drops from
 * 6 → 3 → 2 columns). Max-width (the ads CSS is desktop-first).
 */

export const breakpoint = {
  md: '1320px', // filter grid 6 → 3 columns
  sm: '760px', //  filter grid 3 → 2 columns
} as const

export const mediaQuery = {
  belowMd: `(max-width: ${breakpoint.md})`,
  belowSm: `(max-width: ${breakpoint.sm})`,
} as const
