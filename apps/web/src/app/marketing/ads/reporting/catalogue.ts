/**
 * RPT.1/RPT.2 — the report catalogue.
 *
 * The single list of every ads report this console can produce. Everything in
 * here is STRUCTURAL — source, grain, cadence, whether we request it from Amazon
 * at all — the kind of fact that only changes when we change the ingest. It does
 * not go stale between deploys.
 *
 * Everything MEASURED — row counts, windows, per-market freshness — comes from
 * GET /api/advertising/reporting/coverage at render time, and the card's state is
 * DERIVED from the two together (see deriveState). RPT.1 hard-coded those states
 * from a one-off audit; RPT.2 replaced that with live data so the page cannot
 * drift from reality.
 *
 * `state` exists at all because of the single most important RPT.0 finding: a
 * report with no rows is not automatically broken. Sponsored Brands and Display
 * return nothing because every one of those campaigns is PAUSED — the ingest is
 * working perfectly. Collapsing "idle" and "broken" into one empty state would
 * make six healthy reports look failed.
 */
import type { Tone } from '@/design-system/primitives/tone'
import type { ReportCoverage, ReportingCoverage } from './coverage'

/** Why a report has the data it has — never "empty" without a reason. */
export type ReportState =
  | 'ready' // ingested, current, dense enough to rely on
  | 'sparse' // ingested, but with a freshness or coverage gap you must know about
  | 'idle' // pipeline healthy; nothing is running to produce rows
  | 'not-ingested' // we never request this from Amazon — needs new ingest
  | 'blocked' // a dependency is missing, so the numbers would be meaningless
  | 'unknown' // coverage not loaded yet

export const STATE_META: Record<ReportState, { label: string; tone: Tone }> = {
  ready: { label: 'Ready', tone: 'success' },
  sparse: { label: 'Partial coverage', tone: 'warning' },
  idle: { label: 'Idle — nothing running', tone: 'neutral' },
  'not-ingested': { label: 'Not ingested', tone: 'danger' },
  blocked: { label: 'Blocked', tone: 'danger' },
  unknown: { label: 'Checking…', tone: 'neutral' },
}

export type ReportGroup = 'Performance' | 'Market & brand' | 'Economics' | 'Pipeline'

/**
 * How often new rows should appear. This is what stops a weekly report being
 * badged stale for behaving exactly as designed: Search Query Performance runs
 * weekly and Amazon publishes it roughly two weeks late, so a 16-day lag is
 * healthy there and alarming on a daily feed.
 */
export type Cadence = 'daily' | 'weekly' | 'snapshot'

/** Lag (days) past which a feed of this cadence is genuinely behind. */
const STALE_AFTER: Record<Cadence, number> = { daily: 3, weekly: 21, snapshot: 30 }
/** Minimum share of expected periods that must carry rows before we call it dense. */
const MIN_DENSITY = 0.6

export interface ReportEntry {
  id: string
  title: string
  /** The question this report answers, in the operator's words. */
  answers: string
  /** Where the numbers come from. */
  source: string
  /** The row grain — what one row of this report IS. */
  grain: string
  group: ReportGroup
  cadence: Cadence
  /** Key into the coverage payload. Absent = nothing to measure (Pipeline). */
  coverageKey?: string
  /** False when we never ask Amazon for it — no amount of waiting produces rows. */
  ingested?: boolean
  /** Ad products this report depends on; used to tell idle from broken. */
  adProducts?: string[]
  /** A standing caveat that is true regardless of the live numbers. */
  note?: string
  /**
   * NAV.1 — a report that lives on another page.
   *
   * The library's job is choosing a report, and it was listing only the ones the
   * runner happens to execute. Market share and page-one coverage are reports by
   * any operator's definition; they simply live under Analytics, because the
   * standing split puts data here and meaning there. An operator who does not
   * already know that has no way to find them from the page whose whole purpose
   * is finding them.
   *
   * So the row links OUT rather than the page moving in. Setting this makes the
   * row openable and marks where it goes; nothing is relocated and no route
   * changes. See `livesIn` for the label.
   */
  externalHref?: string
  /** Section name shown on the row, e.g. `Analytics`. Only with `externalHref`. */
  livesIn?: string
}

export const REPORT_CATALOGUE: ReportEntry[] = [
  // ── Performance ───────────────────────────────────────────────────────────
  {
    id: 'campaign',
    title: 'Campaign performance',
    answers: 'Which campaigns spend, sell, and at what ACOS.',
    source: 'Ads API v3 · spCampaigns / sdCampaigns / sbCampaigns',
    grain: 'campaign × day',
    group: 'Performance',
    cadence: 'daily',
    coverageKey: 'campaign',
    adProducts: ['SPONSORED_PRODUCTS', 'SPONSORED_DISPLAY', 'SPONSORED_BRANDS'],
  },
  {
    id: 'advertised-product',
    title: 'Advertised product performance',
    answers: 'Which ASINs and SKUs the spend actually went to.',
    source: 'Ads API v3 · spAdvertisedProduct',
    grain: 'product ad × day',
    group: 'Performance',
    cadence: 'daily',
    coverageKey: 'advertised-product',
    adProducts: ['SPONSORED_PRODUCTS'],
  },
  {
    id: 'search-term',
    title: 'Search terms',
    answers: 'What shoppers actually typed to reach us — the harvest and negation source.',
    source: 'Ads API v3 · spSearchTerm',
    grain: 'campaign × search term × day',
    group: 'Performance',
    cadence: 'daily',
    coverageKey: 'search-term',
    adProducts: ['SPONSORED_PRODUCTS'],
  },
  {
    id: 'placement',
    title: 'Placement performance',
    answers: 'Top of Search vs Product Page vs Rest of Search — where the money works.',
    source: 'Ads API v3 · spCampaigns grouped by placement',
    grain: 'campaign × placement × day',
    group: 'Performance',
    cadence: 'daily',
    coverageKey: 'placement',
    adProducts: ['SPONSORED_PRODUCTS'],
    note: '183 early rows stored raw Amazon marketplace IDs instead of country codes. They are folded back to the right market for display, but the stored values are still wrong.',
  },
  {
    id: 'hourly',
    title: 'Hourly performance',
    answers: 'Which hour of which weekday converts — the dayparting substrate.',
    source: 'Amazon Marketing Stream',
    grain: 'campaign × day × hour (UTC)',
    group: 'Performance',
    cadence: 'daily',
    coverageKey: 'hourly',
    adProducts: ['SPONSORED_PRODUCTS'],
    note: 'Coverage is per campaign, not per account — Italy dominates, and the other markets only began delivering at the end of July. Check the per-market counts before trusting any ratio.',
  },
  {
    id: 'targeting',
    title: 'Targeting & keyword performance',
    answers: 'How each keyword and product target performed over time.',
    source: 'Ads API v3 · spTargeting',
    grain: 'target × day',
    group: 'Performance',
    cadence: 'daily',
    coverageKey: 'targeting',
    adProducts: ['SPONSORED_PRODUCTS'],
    note: 'Keyword text comes from the local AdTarget; rows Amazon reports for targets we do not hold are still kept, since auto-targeting clauses are created by Amazon rather than by us.',
  },
  {
    id: 'ad-group',
    title: 'Ad group performance',
    answers: 'Performance rolled up to the ad group.',
    source: 'Ads API v3 — never requested',
    grain: 'ad group × day',
    group: 'Performance',
    cadence: 'daily',
    coverageKey: 'ad-group',
    ingested: false,
    note: 'Daily performance holds only campaign and product-ad rows. Same ingest gap as Targeting.',
  },
  {
    id: 'sb-sd',
    title: 'Sponsored Brands & Display',
    answers: 'SB and SD performance, when they run.',
    source: 'Ads API v3 · sbCampaigns / sbSearchTerm / sdCampaigns',
    grain: 'campaign × day',
    group: 'Performance',
    cadence: 'daily',
    coverageKey: 'sb-sd',
    adProducts: ['SPONSORED_BRANDS', 'SPONSORED_DISPLAY'],
  },

  // ── Market & brand ────────────────────────────────────────────────────────
  {
    id: 'sqp',
    title: 'Search Query Performance',
    answers: 'Our share of the whole market for a query — impressions, clicks, cart adds, purchases.',
    source: 'SP-API Brand Analytics',
    grain: 'marketplace × query × ASIN × week',
    group: 'Market & brand',
    cadence: 'weekly',
    coverageKey: 'sqp',
  },
  {
    id: 'brand-metrics',
    title: 'Brand Metrics',
    answers: 'Awareness, consideration and purchase indices against the category median.',
    source: 'Ads API · Brand Metrics',
    grain: 'brand × category node × week',
    group: 'Market & brand',
    cadence: 'weekly',
    coverageKey: 'brand-metrics',
    note: 'Amazon returns the same brand-week at several category depths, and every value arrives as a string.',
  },

  // ── Economics ─────────────────────────────────────────────────────────────
  {
    id: 'economics',
    title: 'Amazon economics — net proceeds',
    answers: 'True per-ASIN profitability after real Amazon fees and COGS.',
    source: 'SP-API Data Kiosk · economics',
    grain: 'ASIN / MSKU × day',
    group: 'Economics',
    cadence: 'daily',
    coverageKey: 'economics',
    note: 'Trust net proceeds, not the sum of the parts — Amazon’s fee array is unlabelled and incomplete.',
  },
  {
    id: 'ebay-economics',
    title: 'eBay listing economics',
    answers: 'Contribution margin, break-even ad rate and break-even CPC per listing.',
    source: 'eBay ads + local cost data',
    grain: 'listing',
    group: 'Economics',
    cadence: 'snapshot',
    coverageKey: 'ebay-economics',
  },

  // NAV.1 — lives under Analytics, listed here because it is a report and this is
  // where reports are chosen. It reads the same Brand Analytics feed as Search
  // Query Performance above, so its freshness is measured rather than asserted.
  {
    id: 'coverage',
    title: 'Coverage — page-one share',
    answers: 'How much of page one we hold on a keyword, against the whole market.',
    source: 'Brand Analytics · search query performance',
    grain: 'keyword × week × market',
    group: 'Market & brand',
    cadence: 'weekly',
    coverageKey: 'sqp',
    externalHref: '/marketing/ads/analytics',
    livesIn: 'Analytics',
    note: 'Amazon reports on a fraction of our ASINs’ queries — coverage is 12.8% in IT and 4.4% in FR — so this answers for the terms it can see, not for every term we bid on.',
  },

  // ── Pipeline ──────────────────────────────────────────────────────────────
  {
    id: 'pipeline',
    title: 'Ingest & job health',
    answers: 'Did every feed land, how late is it, and what failed.',
    source: 'Report jobs · export jobs · Data Kiosk jobs · cron history',
    grain: 'job',
    group: 'Pipeline',
    cadence: 'daily',
  },
]

export const REPORT_GROUPS: ReportGroup[] = ['Performance', 'Market & brand', 'Economics', 'Pipeline']

/** Expected number of reporting periods inside a span, for this cadence. */
function expectedPeriods(cadence: Cadence, spanDays: number): number {
  if (spanDays <= 0) return 0
  if (cadence === 'weekly') return Math.max(1, spanDays / 7)
  if (cadence === 'snapshot') return 1
  return spanDays
}

export interface DerivedState {
  state: ReportState
  /** Why, in one sentence — shown only when it adds something the card lacks. */
  reason: string | null
  /** The market that is furthest behind, when one is. */
  worstMarket: { marketplace: string; lagDays: number } | null
  density: number | null
  /**
   * Lag past which THIS report's cadence counts as behind. The card highlights a
   * market only when it exceeds this — highlighting the merely-worst market would
   * paint a healthy 2-day-old Italy amber on a report that is sparse for an
   * entirely different reason (too few days covered).
   */
  staleAfterDays: number
}

/**
 * Decide a report's state from its structural facts plus live coverage.
 *
 * Freshness is judged on the WORST market, not the overall figure. RPT.0 measured
 * Italy — 52% of all rows and the primary market — running six to seven days
 * behind Germany and France; the overall lag showed 2 days and hid it entirely.
 */
export function deriveState(
  entry: ReportEntry,
  coverage: ReportingCoverage | null,
): DerivedState {
  const staleAfter = STALE_AFTER[entry.cadence]
  const none: DerivedState = { state: 'unknown', reason: null, worstMarket: null, density: null, staleAfterDays: staleAfter }
  if (!coverage) return none
  if (entry.ingested === false) {
    return { ...none, state: 'not-ingested' }
  }
  if (!entry.coverageKey) {
    return { ...none, state: 'ready' }
  }

  const c: ReportCoverage | undefined = coverage.reports[entry.coverageKey]
  if (!c) return none

  // eBay economics is only meaningful with cost data behind it. Derived from the
  // live status split, so loading COGS clears the card without a code change.
  if (entry.id === 'ebay-economics') {
    const total = coverage.ebayEconomicsStatus.reduce((s, r) => s + r.rows, 0)
    const usable = coverage.ebayEconomicsStatus
      .filter((r) => r.status !== 'MISSING_COGS')
      .reduce((s, r) => s + r.rows, 0)
    if (total > 0 && usable === 0) {
      return {
        ...none,
        state: 'blocked',
        reason: `All ${total} rows are missing COGS, so margin and break-even would be meaningless.`,
      }
    }
  }

  if (c.rows === 0) {
    // No rows is only a fault if something was supposed to be producing them.
    const enabled = (entry.adProducts ?? [])
      .map((p) => coverage.campaigns.find((x) => x.adProduct === p))
      .reduce((s, x) => s + (x?.enabled ?? 0), 0)
    const paused = (entry.adProducts ?? [])
      .map((p) => coverage.campaigns.find((x) => x.adProduct === p))
      .reduce((s, x) => s + (x?.paused ?? 0), 0)
    if (enabled === 0) {
      return {
        ...none,
        state: 'idle',
        reason: paused > 0
          ? `Nothing to report — all ${paused} campaigns of this type are paused. The ingest is working.`
          : 'Nothing to report — no campaigns of this type exist.',
      }
    }
    return {
      ...none,
      state: 'sparse',
      reason: `${enabled} campaigns are running but no rows have landed — worth checking the pipeline.`,
    }
  }

  const worst = c.byMarket.reduce<{ marketplace: string; lagDays: number } | null>(
    (acc, m) => (m.lagDays != null && (!acc || m.lagDays > acc.lagDays)
      ? { marketplace: m.marketplace, lagDays: m.lagDays }
      : acc),
    null,
  )
  const expected = expectedPeriods(entry.cadence, c.spanDays)
  const density = expected > 0 ? Math.min(1, c.days / expected) : null

  // An idle ad product that still holds history reads as idle, not stale: SB/SD
  // stopped months ago because the campaigns were paused, which is not a fault.
  const enabledNow = (entry.adProducts ?? [])
    .map((p) => coverage.campaigns.find((x) => x.adProduct === p))
    .reduce((s, x) => s + (x?.enabled ?? 0), 0)
  if ((entry.adProducts?.length ?? 0) > 0 && enabledNow === 0) {
    return {
      ...none,
      state: 'idle',
      reason: 'Holds history, but nothing of this type is running now, so it will not advance.',
      worstMarket: worst, density,
    }
  }

  if (worst && worst.lagDays > staleAfter) {
    return {
      ...none,
      state: 'sparse',
      reason: `${worst.marketplace} is ${worst.lagDays} days behind${
        c.lagDays != null && c.lagDays < worst.lagDays ? ` while the newest row overall is ${c.lagDays} days old` : ''
      }.`,
      worstMarket: worst, density,
    }
  }
  if (density != null && density < MIN_DENSITY) {
    return {
      ...none,
      state: 'sparse',
      reason: `Only ${c.days} of ${Math.round(expected)} expected ${entry.cadence === 'weekly' ? 'weeks' : 'days'} carry rows.`,
      worstMarket: worst, density,
    }
  }
  return { ...none, state: 'ready', worstMarket: worst, density }
}
