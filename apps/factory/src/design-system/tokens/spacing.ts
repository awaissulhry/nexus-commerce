/**
 * Spacing tokens — H10 uses explicit px values (not a 4px-only grid). These are
 * the values that actually appear across the ads stylesheets, named by step.
 */

export const space = {
  px2: '2px',
  px4: '4px',
  px6: '6px',
  px7: '7px',
  px8: '8px',
  px10: '10px',
  px11: '11px',
  px12: '12px',
  px14: '14px',
  px16: '16px',
  px18: '18px',
  px20: '20px',
  px22: '22px',
  px26: '26px', // main content padding (top)
  px30: '30px', // main content padding (sides)
} as const

/** Fixed structural dimensions (measured off the H10 rail/rows). */
export const size = {
  railCollapsed: '66px',
  railExpanded: '344px',
  rowNav: '46px',
  rowGrid: '30px',
  iconZone: '50px',
} as const
