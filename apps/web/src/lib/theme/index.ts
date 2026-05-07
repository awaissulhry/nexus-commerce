/**
 * U.1 — App-wide design system constants (JS side).
 *
 * Companion to apps/web/tailwind.config.ts. Anything that's a Tailwind
 * utility class lives in the config; anything that needs to be a JS
 * value (string templates, numeric durations for setTimeout sync,
 * z-index inline styles, semantic enums) lives here.
 *
 * Renamed from apps/web/src/lib/products/theme.ts so the whole catalog
 * workflow can import from `@/lib/theme` instead of the misleading
 * `@/lib/products/theme` path. The original file is preserved as a
 * one-liner re-export shim so existing imports keep working.
 *
 * Keep this file token-only — no React, no DOM. Components import
 * what they need; the bundler tree-shakes per call site.
 */

// ── Density tokens (P.4 originals) ──────────────────────────────────

/** Display density for grid + table rows. */
export type Density = 'compact' | 'comfortable' | 'spacious'

/** Tailwind padding / font size classes per density for table cells. */
export const DENSITY_CELL_CLASS: Record<Density, string> = {
  compact:     'px-3 py-1 text-sm',         // U.1: was text-sm
  comfortable: 'px-3 py-2',
  spacious:    'px-3 py-3 text-md',         // U.1: was text-md
}

/**
 * Estimated row height per density. Drives the virtualizer's initial
 * sizing; actual heights are measured + corrected by
 * useVirtualizer.measureElement when content (e.g. wrapped tag chips)
 * overflows. Generous estimates skew toward fewer mid-scroll jumps
 * over tighter packing.
 */
export const DENSITY_ROW_HEIGHT: Record<Density, number> = {
  compact:     44,
  comfortable: 52,
  spacious:    64,
}

// ── Status / channel mappings (P.4 originals, preserved verbatim) ──

/** Map a Product.status to a Badge variant. */
export const STATUS_VARIANT: Record<
  string,
  'success' | 'warning' | 'danger' | 'default' | 'info'
> = {
  ACTIVE:   'success',
  DRAFT:    'default',
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
  AMAZON:      'bg-orange-50 text-orange-700 border-orange-200',
  EBAY:        'bg-blue-50 text-blue-700 border-blue-200',
  SHOPIFY:     'bg-emerald-50 text-emerald-700 border-emerald-200',
  WOOCOMMERCE: 'bg-violet-50 text-violet-700 border-violet-200',
  ETSY:        'bg-rose-50 text-rose-700 border-rose-200',
}

// ── New U.1 additions ──────────────────────────────────────────────

/**
 * Programmatic status palette. Mirrors the Tailwind semantic colours
 * (success, warning, danger, info, neutral) for places where utility
 * classes can't go (e.g. computed className templates per row, props
 * passed to third-party charting libraries).
 *
 * Use the bg/text/border triple at the call site:
 *
 *   <span className={`${STATUS_PALETTE.danger.bg} ${STATUS_PALETTE.danger.text}`}>
 *
 * For most uses prefer the utility classes directly (`bg-danger-50
 * text-danger-700`) — this constant is the escape hatch.
 */
export const STATUS_PALETTE = {
  success: { bg: 'bg-success-50', text: 'text-success-700', border: 'border-success-200' },
  warning: { bg: 'bg-warning-50', text: 'text-warning-700', border: 'border-warning-200' },
  danger:  { bg: 'bg-danger-50',  text: 'text-danger-700',  border: 'border-danger-200' },
  info:    { bg: 'bg-info-50',    text: 'text-info-700',    border: 'border-info-200' },
  neutral: { bg: 'bg-neutral-100', text: 'text-neutral-700', border: 'border-neutral-200' },
} as const

export type StatusTone = keyof typeof STATUS_PALETTE

/**
 * Z-index numeric values for inline styles where Tailwind utilities
 * don't reach (e.g. `style={{ zIndex: Z_INDEX.toast + 1 }}` for a
 * one-off raise above a toast).
 */
export const Z_INDEX = {
  dropdown: 10,
  sticky:   20,
  drawer:   30,
  modal:    40,
  toast:    50,
  popover:  60,
} as const

/**
 * Animation durations in milliseconds, mirroring the Tailwind
 * `duration-fast/base/slow` utilities. For JS-driven transitions
 * (e.g. waiting for a fade-out before unmounting) keep the JS sync'd
 * to the CSS via this constant rather than hard-coding the number.
 */
export const DURATION_MS = {
  fast: 150,
  base: 200,
  slow: 300,
} as const
