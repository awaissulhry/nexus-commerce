/**
 * StarRating — the pure rules (Reviews parts, 2026-10-26). No React, so Node tests cover them.
 *
 * Rounding is the one `MetafieldValue` always used: whole stars, then a half star for a remainder of a half or more,
 * so a value is never drawn HIGHER than it is (4.3 shows four, 4.7 shows four and a half). The words keep the real
 * number to one decimal ("4.3 out of 5 stars"): the picture rounds, the name does not.
 */

export type StarFill = 'full' | 'half' | 'empty'

const DEFAULT_MAX = 5

function cleanMax(max: number | undefined): number {
  return max != null && Number.isFinite(max) && max >= 1 ? Math.floor(max) : DEFAULT_MAX
}

/** The value inside 0…max; `null` (and anything not a number) stays `null` — no rating is not a zero rating. */
export function clampRating(value: number | null | undefined, max?: number): number | null {
  if (value == null || !Number.isFinite(value)) return null
  return Math.max(0, Math.min(cleanMax(max), value))
}

/** One entry per star: whole stars, then a half for a remainder ≥ 0.5, then empty ones. */
export function starFills(value: number | null | undefined, max?: number): StarFill[] {
  const stars = cleanMax(max)
  const v = clampRating(value, stars) ?? 0
  const whole = Math.floor(v)
  const half = v - whole >= 0.5
  return Array.from({ length: stars }, (_, i) => (i < whole ? 'full' : i === whole && half ? 'half' : 'empty'))
}

/** The accessible name of a read-only rating: "4.5 out of 5 stars", "No rating". */
export function starWords(value: number | null | undefined, max?: number): string {
  const stars = cleanMax(max)
  const v = clampRating(value, stars)
  if (v == null) return 'No rating'
  const shown = Math.round(v * 10) / 10
  return `${shown} out of ${stars} ${stars === 1 ? 'star' : 'stars'}`
}

/** "1 rating", "1,284 ratings" — the count beside the stars. */
export function ratingCountWords(count: number): string {
  const n = Math.max(0, Math.round(count))
  return `${n.toLocaleString('en-US')} ${n === 1 ? 'rating' : 'ratings'}`
}

/** One input star's name: "1 star", "4 stars". */
export function starChoiceWords(n: number): string {
  return `${n} ${n === 1 ? 'star' : 'stars'}`
}

/** The star an input holds: the value rounded to a whole star, 0 when there is none yet. */
export function starInputValue(value: number | null | undefined, max?: number): number {
  const v = clampRating(value, max)
  return v == null ? 0 : Math.round(v)
}

/** The one input star that takes Tab (roving tabindex): the chosen star, or the first when none is chosen. */
export function starTabStop(value: number | null | undefined, max?: number): number {
  return starInputValue(value, max) || 1
}

/**
 * The star a key moves to in input mode, or `null` for a key the group does not use.
 * ←/↓ one fewer, →/↑ one more (stops at the ends, as radio groups in this DS do), Home the first, End the last.
 */
export function starKeyTarget(key: string, current: number, max?: number): number | null {
  const stars = cleanMax(max)
  const from = Math.max(1, Math.min(stars, current || 1))
  switch (key) {
    case 'ArrowLeft':
    case 'ArrowDown':
      return Math.max(1, from - 1)
    case 'ArrowRight':
    case 'ArrowUp':
      return Math.min(stars, current ? from + 1 : 1)
    case 'Home':
      return 1
    case 'End':
      return stars
    default:
      return null
  }
}
