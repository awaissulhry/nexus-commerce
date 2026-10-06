/**
 * ads-settled-window.ts — THE DAYS AN ADS DECISION MAY READ.
 *
 * 6c (2026-10-04; review G.2, Owner decision S9). Amazon keeps adding sales to a day for as long as
 * the ad product's attribution window: 7 days for Sponsored Products, 14 for Sponsored Brands and
 * Display. A decision window that ends 2 days ago reads days whose sales are still arriving, so a
 * keyword with spend and no sales on its newest days looks like waste. Every rule window, every
 * action that re-measures a target, the bid optimiser, Top-of-Search and the autopilot signals read
 * their days through here: same length as before, ending at the ad product's lag
 * (`settledLagDays` in @nexus/shared/data-vintage).
 *
 * Escape hatch: `NEXUS_ADS_SETTLED_LAG=provisional` on the API goes back to the old two-day tail for
 * every reader at once. The API's own sentences follow it (`settledEndText`); the web builder's
 * window note states the default, so set it only as a stop-gap.
 */
import { settledEndPhrase, settledWindowBounds, type RuleWindow, type SettledLag } from '@nexus/shared/data-vintage'

// 🔴 A LEAF: nothing here may import an API module. `rule-conditions-text.ts` imports this file and
// must never take part in an import cycle (see its header).

/**
 * PB-6c — how many days of search terms Nexus keeps (ads-reports.service.ts cleanupOldSearchTerms deletes older days):
 * a window that reaches further back reads days that are gone, so it cannot be compared.
 */
export const SEARCH_TERM_DAYS_KEPT = 90

/** The lag in force: the attribution window, unless the escape hatch is set. */
export function settledLag(): SettledLag {
  return (process.env.NEXUS_ADS_SETTLED_LAG ?? '').trim().toLowerCase() === 'provisional' ? 'provisional' : 'attribution'
}

/** The window's end in words, for a screen: "ending 7 days ago (14 for Sponsored Brands and Display)". */
export function settledEndText(): string {
  return settledEndPhrase(settledLag())
}

export interface SettledOpts {
  now?: Date
  /** Move the window this many days further back (the earlier half of a week-over-week comparison). */
  offsetDays?: number
}

/** One ad product's decision window. Sponsored Products unless told otherwise. */
export function settledBounds(windowDays: number, adProduct: string | null = 'SPONSORED_PRODUCTS', opts: SettledOpts = {}): RuleWindow {
  return settledWindowBounds(windowDays, adProduct, { ...opts, lag: settledLag() })
}

type DateRange = { gte: Date; lte: Date }
export type SettledWhere =
  | { date: DateRange }
  | { OR: [{ adProduct: string; date: DateRange }, { adProduct: { not: string }; date: DateRange }] }

/**
 * The `where` part for any table that carries `adProduct` and `date` (AmazonAdsDailyPerformance,
 * AmazonAdsSearchTerm, AmazonAdsPlacementReport): Sponsored Products rows over their window, every
 * other ad product over Brands/Display's 14-day lag — the longest, so an ad product this file does
 * not know never decides early. Spread it into the query in place of `date: { gte, lte }`; the
 * caller's `where` must not carry its own `OR`.
 */
export function settledWhere(windowDays: number, opts: SettledOpts = {}): SettledWhere {
  const sp = settledBounds(windowDays, 'SPONSORED_PRODUCTS', opts)
  const other = settledBounds(windowDays, 'SPONSORED_BRANDS', opts)
  if (sp.until.getTime() === other.until.getTime()) return { date: { gte: sp.since, lte: sp.until } }
  return {
    OR: [
      { adProduct: 'SPONSORED_PRODUCTS', date: { gte: sp.since, lte: sp.until } },
      { adProduct: { not: 'SPONSORED_PRODUCTS' }, date: { gte: other.since, lte: other.until } },
    ],
  }
}
