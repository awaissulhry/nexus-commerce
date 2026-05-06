/**
 * P.4 — design tokens shared across the /products surface.
 *
 * Extracted from the previous monolithic ProductsWorkspace.tsx so the
 * grid, lenses, drawer, and per-product cells all reach for the same
 * source of truth. Adding a new channel or status here propagates
 * automatically; before this module the same colour mappings were
 * duplicated in multiple components and drifted (Etsy was rose in the
 * grid but slate in the coverage lens, etc.).
 *
 * Keep this file token-only — no React, no DOM. Components import
 * what they need; the bundler tree-shakes per call site.
 */

/** Display density for grid + table rows. */
export type Density = 'compact' | 'comfortable' | 'spacious'

/** Tailwind padding / font size classes per density for table cells. */
export const DENSITY_CELL_CLASS: Record<Density, string> = {
  compact: 'px-3 py-1 text-[11px]',
  comfortable: 'px-3 py-2',
  spacious: 'px-3 py-3 text-[13px]',
}

/**
 * Estimated row height per density. Drives the virtualizer's initial
 * sizing; actual heights are measured + corrected by
 * useVirtualizer.measureElement when content (e.g. wrapped tag chips)
 * overflows. Generous estimates skew toward fewer mid-scroll jumps
 * over tighter packing.
 */
export const DENSITY_ROW_HEIGHT: Record<Density, number> = {
  compact: 44,
  comfortable: 52,
  spacious: 64,
}

/** Map a Product.status to a Badge variant. */
export const STATUS_VARIANT: Record<
  string,
  'success' | 'warning' | 'danger' | 'default' | 'info'
> = {
  ACTIVE: 'success',
  DRAFT: 'default',
  INACTIVE: 'default',
}

/**
 * Per-channel chip styling. Each value is a Tailwind class triple
 * (`bg`, `text`, `border`) so a span can render a tinted rounded
 * pill with no extra wrapper. New channels added here surface
 * automatically wherever a chip uses CHANNEL_TONE[c] — adding the
 * row is the only change needed.
 */
export const CHANNEL_TONE: Record<string, string> = {
  AMAZON: 'bg-orange-50 text-orange-700 border-orange-200',
  EBAY: 'bg-blue-50 text-blue-700 border-blue-200',
  SHOPIFY: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  WOOCOMMERCE: 'bg-violet-50 text-violet-700 border-violet-200',
  ETSY: 'bg-rose-50 text-rose-700 border-rose-200',
}
