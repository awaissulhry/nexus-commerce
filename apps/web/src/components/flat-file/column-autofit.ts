/**
 * UFX P7 (item 6) — pure width math for resize-handle double-click auto-fit.
 *
 * Double-clicking a column's resize handle now sizes the column to its
 * RENDERED content (visible cells + header) instead of resetting the width.
 * The DOM measuring lives in the grid; this module owns the testable part:
 * take the measured content widths, add breathing room, clamp to sane bounds.
 */

export const AUTOFIT_MIN = 60
export const AUTOFIT_MAX = 600
/** Slack over the widest measured content (borders, corner markers, chevron). */
export const AUTOFIT_PADDING = 16

/**
 * Widest measurement + padding, clamped to [min, max].
 * Non-finite / non-positive entries (e.g. rows skipped by
 * content-visibility) are ignored; returns null when nothing was measurable
 * so the caller keeps the current width.
 */
export function computeAutoFitWidth(
  measured: number[],
  opts: { min?: number; max?: number; padding?: number } = {},
): number | null {
  const min = opts.min ?? AUTOFIT_MIN
  const max = opts.max ?? AUTOFIT_MAX
  const padding = opts.padding ?? AUTOFIT_PADDING
  let widest = 0
  for (const w of measured) {
    if (Number.isFinite(w) && w > widest) widest = w
  }
  if (widest <= 0) return null
  return Math.max(min, Math.min(max, Math.ceil(widest) + padding))
}
