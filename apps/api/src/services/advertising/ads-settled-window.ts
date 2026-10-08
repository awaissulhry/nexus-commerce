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
 *
 * BB-14 (2026-10-08, design BRAIN-UPGRADES-DESIGN.md U1a) — a day counts as settled only when Nexus holds a pull of it
 * asked at least the attribution window after the day (BB-13 re-reads the last 8 / 15 days every night). Before a
 * decision runs, `ads-settled-facts.ts` reads from the report jobs the newest settled day of each ad product for the
 * business (`setSettledFacts`); the window then ends there, one or two days earlier than the clock rule. Without that
 * fact — none read, older than a day, or the newest settled day more than `MAX_SETTLED_SHIFT_DAYS` behind (the nightly
 * re-read is failing) — the window keeps the clock rule, and `settledEnd` / `settledEndText` say the newest days may
 * still be filling.
 */
import { LEGACY_WORKSPACE_ID, workspaceContext } from '@nexus/database/workspace-context'
import { settledEndPhrase, settledLagDays, settledWindowBounds, type RuleWindow, type SettledLag } from '@nexus/shared/data-vintage'

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

/**
 * The window's end in words, for a screen: "ending 7 days ago (14 for Sponsored Brands and Display)". BB-14: with a
 * settled fact for the business, "ending 8 days ago (15 for …), the newest day Amazon has settled"; with a fact that
 * shows the nightly re-read failing, the clock rule plus "the newest days may still be filling". Nothing read: as before.
 */
export function settledEndText(opts: SettledOpts = {}): string {
  const lag = settledLag()
  const sp = settledEnd('SPONSORED_PRODUCTS', opts)
  const other = settledEnd('SPONSORED_BRANDS', opts)
  if (!sp.known) return settledEndPhrase(lag)
  const spAgo = settledLagDays('SPONSORED_PRODUCTS', lag) + sp.shiftDays
  const otherAgo = settledLagDays('SPONSORED_BRANDS', lag) + other.shiftDays
  const days = spAgo === otherAgo ? `ending ${spAgo} days ago` : `ending ${spAgo} days ago (${otherAgo} for Sponsored Brands and Display)`
  return sp.stillFilling || other.stillFilling
    ? `${days}; the newest days may still be filling (no settled re-read of them yet)`
    : `${days}, the newest days Amazon has settled`
}

export interface SettledOpts {
  now?: Date
  /** Move the window this many days further back (the earlier half of a week-over-week comparison). */
  offsetDays?: number
}

// ── BB-14: what the report jobs say has settled ──────────────────────────────────────────────────────

/** The newest settled day per ad-product group, for one business, and when it was read. */
export interface SettledFacts {
  /** Sponsored Products. */
  spThrough: Date | null
  /** Sponsored Brands and Display (the older of the two). */
  otherThrough: Date | null
}

/** A fact older than this is not used (the clock rule applies, said as "still filling"). */
export const SETTLED_FACTS_TTL_MS = 26 * 3_600_000
/** The window moves at most this many days back to reach the newest settled day; further back, the re-read is failing. */
export const MAX_SETTLED_SHIFT_DAYS = 3

const DAY_MS = 86_400_000
const factsByBusiness = new Map<string, SettledFacts & { readAt: number }>()
const businessId = () => workspaceContext()?.workspaceId ?? LEGACY_WORKSPACE_ID

/** Set by ads-settled-facts.ts for the business in context. */
export function setSettledFacts(facts: SettledFacts, readAt: number = Date.now()): void {
  factsByBusiness.set(businessId(), { ...facts, readAt })
}

/** Tests: forget every business's facts. */
export function clearSettledFacts(): void {
  factsByBusiness.clear()
}

/** Where one ad product's window ends, and why. */
export interface SettledEnd {
  /** The window's last day (23:59:59.999 UTC). */
  until: Date
  /** The newest settled day the report jobs show, null when unknown. */
  settledThrough: Date | null
  /** Days the window moved back from the clock rule to reach `settledThrough`. */
  shiftDays: number
  /** True when the window's newest days may still gain sales: no usable settled fact, or it is too far behind. */
  stillFilling: boolean
  /** Whether a fact for this business was read at all (false: nothing is known beyond the clock rule). */
  known: boolean
}

const dayIndex = (d: Date) => Math.floor(d.getTime() / DAY_MS)

/** One ad product's window end (Sponsored Products unless told otherwise). Pure apart from the facts set above. */
export function settledEnd(adProduct: string | null = 'SPONSORED_PRODUCTS', opts: SettledOpts = {}): SettledEnd {
  const now = opts.now ?? new Date()
  const lag = settledLag()
  const clock = settledWindowBounds(1, adProduct, { now, lag }).until
  const facts = factsByBusiness.get(businessId())
  // The escape hatch reads days still filling by design; with nothing read, only the clock rule is known.
  if (lag === 'provisional' || !facts) return { until: clock, settledThrough: null, shiftDays: 0, stillFilling: lag === 'provisional', known: false }
  const fresh = now.getTime() - facts.readAt <= SETTLED_FACTS_TTL_MS
  const through = fresh ? (adProduct === 'SPONSORED_PRODUCTS' ? facts.spThrough : facts.otherThrough) : null
  if (!through) return { until: clock, settledThrough: null, shiftDays: 0, stillFilling: true, known: true }
  const shift = dayIndex(clock) - dayIndex(through)
  if (shift <= 0) return { until: clock, settledThrough: through, shiftDays: 0, stillFilling: false, known: true }
  if (shift > MAX_SETTLED_SHIFT_DAYS) return { until: clock, settledThrough: through, shiftDays: 0, stillFilling: true, known: true }
  return { until: new Date(clock.getTime() - shift * DAY_MS), settledThrough: through, shiftDays: shift, stillFilling: false, known: true }
}

/** One ad product's decision window. Sponsored Products unless told otherwise. */
export function settledBounds(windowDays: number, adProduct: string | null = 'SPONSORED_PRODUCTS', opts: SettledOpts = {}): RuleWindow {
  const { shiftDays } = settledEnd(adProduct, opts)
  return settledWindowBounds(windowDays, adProduct, { ...opts, lag: settledLag(), offsetDays: Math.max(0, opts.offsetDays ?? 0) + shiftDays })
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
