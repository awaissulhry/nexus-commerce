/**
 * Spacing tokens — H10 uses explicit px values (not a 4px-only grid). These are
 * the values that actually appear across the ads stylesheets, named by step.
 */

export const space = {
  // Steps below px2 and the four odd steps were added 2026-08-24 from a full
  // measurement of apps/web (15,377 padding/margin/gap numbers). This scale is
  // descriptive by design — see the header — and these are values the product
  // genuinely uses, not a widening of the vocabulary:
  //   1px 544x · 3px 501x · 5px 990x · 9px 800x · 24px 89x · 40px 34x · 32px 17x · 48px 22x
  // Coverage of all measured spacing: 71.4% -> 90.8%.
  px1: '1px', //      hairline offsets, 1px nudges
  px2: '2px',
  px3: '3px',
  px4: '4px',
  px5: '5px', //      the densest real gap in the ads grid
  px6: '6px',
  px7: '7px',
  px8: '8px',
  px9: '9px',
  px10: '10px',
  px11: '11px',
  px12: '12px',
  px14: '14px',
  px16: '16px',
  px18: '18px',
  px20: '20px',
  px22: '22px',
  px24: '24px',
  px26: '26px', // main content padding (top)
  px30: '30px', // main content padding (sides)
  px32: '32px',
  px40: '40px', // page-level block rhythm
  px48: '48px', // page-level block rhythm
} as const

/** Fixed structural dimensions (measured off the H10 rail/rows). */
export const size = {
  railCollapsed: '66px',
  railExpanded: '344px',
  rowNav: '46px',
  rowGrid: '30px',
  iconZone: '50px',
} as const
