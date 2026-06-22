/**
 * Token barrel — the single import surface for JS/TS consumers.
 *
 *   import { color, space, radius, shadow } from '@/design-system/tokens'
 *
 * CSS consumers use the matching `var(--h10-*)` from ../styles/tokens.css.
 */

export * from './colors'
export * from './typography'
export * from './spacing'
export * from './radius'
export * from './shadow'
export * from './motion'
export * from './zindex'
export * from './breakpoints'

import { palette, color, pill, badge } from './colors'
import { fontFamily, fontSize, fontWeight, letterSpacing, lineHeight, fontSmoothing } from './typography'
import { space, size } from './spacing'
import { radius } from './radius'
import { shadow, focusRing, shadowColor } from './shadow'
import { duration, easing, durationMs } from './motion'
import { zIndex } from './zindex'
import { breakpoint, mediaQuery } from './breakpoints'

/** Aggregate accessor for ergonomic destructuring: `const { color } = tokens`. */
export const tokens = {
  palette,
  color,
  pill,
  badge,
  fontFamily,
  fontSize,
  fontWeight,
  letterSpacing,
  lineHeight,
  fontSmoothing,
  space,
  size,
  radius,
  shadow,
  focusRing,
  shadowColor,
  duration,
  easing,
  durationMs,
  zIndex,
  breakpoint,
  mediaQuery,
} as const
