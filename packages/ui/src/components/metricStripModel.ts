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

/** A delta's colour. `neutral` is a change that is neither good nor bad ("same as the month before"). */
export type MetricDeltaTone = 'positive' | 'negative' | 'neutral'

/**
 * The class a delta wears (`.dlt.up` success, `.dlt.down` danger, `.dlt.neutral` `--nds-text-2`). `tone` wins; without
 * it `positive` decides, as before: true → up, anything else → down.
 */
export function metricDeltaClass(delta: { positive?: boolean; tone?: MetricDeltaTone }): 'up' | 'down' | 'neutral' {
  const tone = delta.tone ?? (delta.positive ? 'positive' : 'negative')
  return tone === 'positive' ? 'up' : tone === 'negative' ? 'down' : 'neutral'
}
