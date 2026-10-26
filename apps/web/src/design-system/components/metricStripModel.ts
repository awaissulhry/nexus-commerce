/**
 * MetricStrip — what a tile is (Reviews parts, 2026-10-26). No React, so Node tests cover it.
 *
 * A tile with `href` OPENS a page (a real link: new tab, middle-click and a copied address work); a tile with `onClick`
 * FILTERS the page it sits on (a toggle button with `aria-pressed`); any other tile is a plain card, never a focus stop
 * that leads nowhere. A tile cannot be both: the type says so, and `href` wins here if a caller forces both.
 */

export type MetricKind = 'link' | 'button' | 'static'

export function metricKind(m: { href?: string | null; onClick?: unknown }): MetricKind {
  if (typeof m.href === 'string' && m.href.length > 0) return 'link'
  if (typeof m.onClick === 'function') return 'button'
  return 'static'
}

/** The strip's narrowest tile, px (`--nds-metrics-min`). Default 150; a broken value falls back to it. */
export function metricMinWidth(px: number | null | undefined): number {
  return px != null && Number.isFinite(px) && px >= 64 ? Math.round(px) : 150
}
