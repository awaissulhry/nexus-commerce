/**
 * RPT.3 — the report registry: one declarative spec per runnable report.
 *
 * Two rules this file exists to enforce, both from the RPT plan's consistency
 * guarantees (docs/2026-08-04-ads-reporting-rpt.md §4.3):
 *
 * 1. ONE METRIC REGISTRY. ACOS is defined once, here, as SQL. Every caller — the
 *    grid, the totals row, and (RPT.4) the CSV and XLSX writers — runs that same
 *    expression. There is no second definition anywhere that could drift.
 *
 * 2. DERIVED METRICS ARE COMPUTED, NEVER SUMMED. ACOS, CTR, CPC, ROAS and CVR are
 *    ratios: summing them across rows is meaningless, and averaging them is wrong
 *    (it weights a 3-impression row equally with a 30,000-impression one). Each is
 *    expressed as an aggregate over the underlying sums, so it stays correct at
 *    every grouping AND in the totals row, which is computed by running the same
 *    expressions over the whole filtered set rather than by folding the page.
 */

import { MARKETPLACE_ID_TO_CODE } from '../../utils/marketplace-code.js'
import { excludeAmsDailySql } from '../ads-core/ams-daily.js'

/** How the client should render a value. The server never formats. */
export type ColumnFormat = 'text' | 'date' | 'int' | 'money' | 'pct' | 'ratio' | 'hour'

export interface ColumnMeta {
  id: string
  label: string
  kind: 'dimension' | 'metric'
  format: ColumnFormat
  align: 'left' | 'right'
  /** Longer explanation surfaced as a header tooltip. */
  help?: string
}

interface Dimension extends ColumnMeta {
  kind: 'dimension'
  /** SQL expression producing the value; also used verbatim in GROUP BY. */
  sql: string
}

interface Metric extends ColumnMeta {
  kind: 'metric'
  /** Aggregate SQL. Must be valid both grouped and ungrouped (totals). */
  sql: string
}

/**
 * Which direction is an improvement — used ONLY to colour a period-over-period
 * delta. Spend is deliberately `null`: spending more is neither good nor bad on
 * its own, and painting it red would editorialise. ACOS and CPC are 'lower',
 * everything else 'higher'. Getting this wrong is worse than omitting it — a
 * green +20% ACOS actively misleads.
 */
export type BetterWhen = 'higher' | 'lower' | null
export const METRIC_DIRECTION: Record<string, BetterWhen> = {
  impressions: 'higher', clicks: 'higher', sales: 'higher', orders: 'higher',
  units: 'higher', purchases: 'higher', roas: 'higher', ctr: 'higher', cvr: 'higher',
  volume: 'higher', impressionsBrand: 'higher', clicksBrand: 'higher',
  purchasesBrand: 'higher', impressionShare: 'higher', clickShare: 'higher',
  cartAddShare: 'higher', purchaseShare: 'higher', topOfSearchIS: 'higher',
  netProductSales: 'higher', netProceedsTotal: 'higher', unitsOrdered: 'higher',
  awarenessIndex: 'higher', considerationIndex: 'higher', salesIndex: 'higher',
  brandCustomers: 'higher', addToCarts: 'higher', customerConversionRate: 'higher',
  // BM.1 — Brand Metrics. Only OUR figures get a direction; the category median
  // and top performers deliberately get none, because a rising category median is
  // neither our win nor our loss and colouring it would say otherwise. A missing
  // key resolves to null in the summary service, which is the safe default.
  highValueCustomers: 'higher', brandedSearchesAndDetailPageViews: 'higher',
  newToBrandCustomerRate: 'higher',
  engagedShopperRateLow: 'higher', engagedShopperRateHigh: 'higher',
  roeAddToCarts: 'higher', roeBrandCustomers: 'higher', roeHighValueCustomers: 'higher',
  roeViewedDetailPage: 'higher', roeBrandedSearchesAndDetailPageViews: 'higher',
  // Deliberately absent, not overlooked: `viewedDetailPageOnly` and
  // `brandedSearchesOnly` count shoppers who engaged and went NO FURTHER. More of
  // them is reach without conversion — genuinely ambiguous, and this file's own
  // rule is that guessing a direction is worse than omitting one.
  // SPC.2 — same-SKU sales rising is good; HALO is deliberately null. Halo revenue
  // is real, but more of it is not automatically better: it can equally mean the ad
  // is failing to sell the product it advertises. Same reasoning as the two
  // Brand Metrics counters above — guessing a direction is worse than omitting one.
  salesSameSku: 'higher', ordersSameSku: 'higher', unitsSameSku: 'higher',
  sameSkuShare: 'higher', budget: null, budgetUsed: null, salesHalo: null,
  acos: 'lower', cpc: 'lower', feesTotal: 'lower', costOfGoodsSold: 'lower',
  cost: null, adsTotal: null,
}

/**
 * Shared ads metrics over a table exposing impressions / clicks / costMicros /
 * sales7dCents / orders7d / units7d. `t` is the aliased table.
 *
 * NULL rather than 0 on a zero denominator: a campaign with no clicks has an
 * UNDEFINED CPC, not a CPC of nothing. Rendering it as €0.00 would read as
 * "free clicks" and pollute any sort.
 */
/**
 * SPC.2 — the three attribution windows beyond 7 days, as ordinary columns.
 *
 * Amazon returns sales, orders and units at 1, 7, 14 and 30 days on the same row.
 * These are added as SELECTABLE COLUMNS rather than by re-pointing what `sales`
 * means: the default reading of this report stays the 7-day figure, so every saved
 * report, scheduled email and shared link written before today still means exactly
 * what it meant. Turning the window into a control that re-points `sales`, `acos`
 * and the rest is a deliberate, visible change to what a number on screen means,
 * and it is the operator's call to make rather than one to slip in here.
 *
 * 🔴 No COALESCE on any of them. These columns are nullable with no default
 * precisely so that "not requested for this row" stays distinguishable from
 * "Amazon said zero" — 1,092 campaign rows predate Amazon's 95-day retention wall
 * and can never be filled, and they must read as an em-dash rather than as a month
 * of zero sales.
 */
const WINDOWS = [
  { w: '1d', label: '1-day', sales: 'sales1dCents', orders: 'orders1d', units: 'units1d',
    same: 'salesSameSku1dCents', sameOrders: 'ordersSameSku1d', sameUnits: 'unitsSameSku1d' },
  { w: '14d', label: '14-day', sales: 'sales14dCents', orders: 'orders14d', units: 'units14d',
    same: 'salesSameSku14dCents', sameOrders: 'ordersSameSku14d', sameUnits: 'unitsSameSku14d' },
  { w: '30d', label: '30-day', sales: 'sales30dCents', orders: 'orders30d', units: 'units30d',
    same: 'salesSameSku30dCents', sameOrders: 'ordersSameSku30d', sameUnits: 'unitsSameSku30d' },
] as const

function coreMetrics(t: string, opts: { units?: boolean } = {}): Metric[] {
  const cost = `SUM(${t}."costMicros")::numeric / 1000000.0`
  const sales = `SUM(COALESCE(${t}."sales7dCents", 0))::numeric / 100.0`
  const clicks = `SUM(${t}."clicks")::numeric`
  const imps = `SUM(${t}."impressions")::numeric`
  const orders = `SUM(COALESCE(${t}."orders7d", 0))::numeric`
  const m = (id: string, label: string, format: ColumnFormat, sql: string, help?: string): Metric =>
    ({ id, label, kind: 'metric', format, align: 'right', sql, help })

  const out: Metric[] = [
    m('impressions', 'Impressions', 'int', `SUM(${t}."impressions")::bigint`),
    m('clicks', 'Clicks', 'int', `SUM(${t}."clicks")::bigint`),
    m('cost', 'Spend', 'money', cost),
    m('sales', 'Sales', 'money', sales, 'Attributed sales in the 7-day window.'),
    m('orders', 'Orders', 'int', `SUM(COALESCE(${t}."orders7d", 0))::bigint`),
  ]
  if (opts.units !== false) {
    out.push(m('units', 'Units', 'int', `SUM(COALESCE(${t}."units7d", 0))::bigint`))
  }
  out.push(
    m('ctr', 'CTR', 'pct', `CASE WHEN ${imps} > 0 THEN ${clicks} / ${imps} END`, 'Clicks ÷ impressions.'),
    m('cpc', 'CPC', 'money', `CASE WHEN ${clicks} > 0 THEN (${cost}) / ${clicks} END`, 'Spend ÷ clicks.'),
    m('acos', 'ACOS', 'pct', `CASE WHEN (${sales}) > 0 THEN (${cost}) / (${sales}) END`,
      'Spend ÷ attributed sales. Undefined when there are no sales — shown as “—”, never 0%.'),
    m('roas', 'ROAS', 'ratio', `CASE WHEN (${cost}) > 0 THEN (${sales}) / (${cost}) END`, 'Sales ÷ spend.'),
    m('cvr', 'CVR', 'pct', `CASE WHEN ${clicks} > 0 THEN ${orders} / ${clicks} END`, 'Orders ÷ clicks.'),
  )
  return out
}

const dim = (
  id: string, label: string, sql: string, format: ColumnFormat = 'text', help?: string,
): Dimension => ({
  id, label, kind: 'dimension', format, align: format === 'int' || format === 'hour' ? 'right' : 'left', sql, help,
})

/**
 * BM.1 — a Brand Metrics value read out of the raw payload.
 *
 * `AmazonAdsBrandBuildingMetric.metrics` is a jsonb column holding Amazon's map
 * verbatim (the ingest keeps it whole so a new Amazon field needs no migration).
 * Eleven of its keys were promoted to typed columns; the other 37 have only ever
 * been storage. This is how the rest of them reach the registry without one.
 *
 * Two facts this depends on, both measured across all 117 production rows rather
 * than assumed:
 *   · the column is `jsonb`, so `->>` is available and cheap;
 *   · EVERY value is a numeric STRING ("12", "0.6668", "548.23") — zero
 *     exceptions — so `::numeric` cannot throw. See the contract note in
 *     ads-brand-metrics.service.ts, trap 1.
 *
 * Keys are our own constants and never request input, so interpolating them is
 * safe; nothing here can reach user text.
 */
const bmJson = (key: string) => `(p."metrics"->>'${key}')::numeric`

/**
 * BM.1 — one benchmarked figure: ours, the category median, and the category's
 * top performers. Amazon sends all three for the same metric, on the same row.
 *
 * ── Why the benchmark takes the SAME aggregate as the metric it benchmarks ────
 *
 * A window holds several weeks. Our own count is SUMmed across them, so the
 * comparable median is the SUM of the weekly medians — not their average, which
 * would compare eight weeks of ours against one week of theirs and report us
 * doing 8× better than we are. Rates and ratios average on both sides for the
 * same reason. The pairing is the point: whatever we do to our number, we do to
 * the two it is being read against.
 *
 * ── No COALESCE, deliberately ─────────────────────────────────────────────────
 *
 * `SUM(COALESCE(x, 0))` over rows that are ALL absent returns 0, and 0 is a real
 * value for every metric here — Amazon omits what it cannot compute. Coverage is
 * genuinely uneven (branded searches appear on 22 of 117 rows, brand customers on
 * 77), so a fabricated zero would be common rather than theoretical. Plain SUM
 * returns NULL, which the client renders as an em-dash.
 */
export interface BenchmarkTrio {
  /** Metric id stem. The median and top get `<id>Median` and `<id>Top`. */
  id: string
  label: string
  format: ColumnFormat
  agg: 'sum' | 'avg'
  /** SQL for OUR value — a promoted column where one exists, else the payload. */
  own: string
  /**
   * The key OUR value lives under in Amazon's raw `metrics` payload.
   *
   * `own` is SQL and reads the promoted column where one exists, because a typed column beats
   * a jsonb cast inside an aggregate. A consumer that already holds the row in JavaScript —
   * the node-safe brand endpoint does — needs the payload key instead, and deriving it from the
   * SQL string would be a second, guessable spelling of the same fact. Two of these keys break
   * Amazon's own pattern (see the notes on `topKey` below), which is exactly why neither side
   * may infer it.
   */
  ownKey: string
  /** Payload keys for the two benchmarks. */
  medianKey: string
  topKey: string
  help?: string
}

function benchmarkTrio(t: BenchmarkTrio): Metric[] {
  const agg = (expr: string) => (t.agg === 'sum' ? `SUM(${expr})` : `AVG(${expr})`)
  const cast = t.format === 'int' ? '::bigint' : ''
  const m = (id: string, label: string, sql: string, help?: string): Metric =>
    ({ id, label, kind: 'metric', format: t.format, align: 'right', sql, help })
  return [
    m(t.id, t.label, `${agg(t.own)}${cast}`, t.help),
    m(`${t.id}Median`, `${t.label} — category median`, `${agg(bmJson(t.medianKey))}${cast}`,
      `The median brand in this category node, as Amazon computes it. Context for “${t.label}”, not our own performance.`),
    m(`${t.id}Top`, `${t.label} — category top`, `${agg(bmJson(t.topKey))}${cast}`,
      `The category's top performers. Context for “${t.label}”, not our own performance.`),
  ]
}

/**
 * BM.1 — the thirteen benchmarked Brand Metrics figures.
 *
 * 🔴 Two of Amazon's key names break their own pattern, and both were verified
 * against all 117 rows rather than inferred. Guessing either produces a column
 * that is silently null forever:
 *   · add-to-carts' top performers is `addToCartsCategoryPerformers` — no "Top",
 *     unlike the other twelve.
 *   · detail-page ROE is `viewedDetailPageOnlyReturnOnEngagement` for ours but
 *     `viewedDetailPageROECategoryMedian` for the benchmark — the "Only" is
 *     dropped on the benchmark side.
 */
export const BRAND_BENCHMARKS: BenchmarkTrio[] = [
  // ── engagement and conversion ───────────────────────────────────────────────
  {
    id: 'addToCarts', label: 'Add to carts', format: 'int', agg: 'sum',
    own: 'p."addToCarts"',
    ownKey: 'addToCarts',
    medianKey: 'addToCartsCategoryMedian',
    topKey: 'addToCartsCategoryPerformers', // 🔴 not ...CategoryTopPerformers
  },
  {
    id: 'brandCustomers', label: 'Brand customers', format: 'int', agg: 'sum',
    own: 'p."brandCustomers"',
    ownKey: 'brandCustomers',
    medianKey: 'brandCustomersCategoryMedian',
    topKey: 'brandCustomersCategoryTopPerformers',
  },
  {
    id: 'highValueCustomers', label: 'High-value customers', format: 'int', agg: 'sum',
    own: 'p."highValueCustomers"',
    ownKey: 'highValueCustomers',
    medianKey: 'highValueCustomersCategoryMedian',
    topKey: 'highValueCustomersCategoryTopPerformers',
  },
  {
    id: 'viewedDetailPageOnly', label: 'Viewed detail page only', format: 'int', agg: 'sum',
    own: 'p."viewedDetailPageOnly"',
    ownKey: 'viewedDetailPageOnly',
    medianKey: 'viewedDetailPageCategoryMedian',
    topKey: 'viewedDetailPageCategoryTopPerformers',
    help: 'Shoppers who reached the detail page and went no further. More of them is not automatically better — it is reach without conversion.',
  },
  {
    id: 'brandedSearchesOnly', label: 'Branded searches only', format: 'int', agg: 'sum',
    own: 'p."brandedSearchesOnly"',
    ownKey: 'brandedSearchesOnly',
    medianKey: 'brandedSearchesCategoryMedian',
    topKey: 'brandedSearchesCategoryTopPerformers',
    help: 'Searched the brand and viewed nothing. Present on 22 of 117 rows — an em-dash here means Amazon sent no figure, not zero.',
  },
  {
    id: 'brandedSearchesAndDetailPageViews', label: 'Branded search + detail page', format: 'int', agg: 'sum',
    own: 'p."brandedSearchesAndDetailPageViews"',
    ownKey: 'brandedSearchesAndDetailPageViews',
    medianKey: 'brandedSearchesAndDetailPageViewsCategoryMedian',
    topKey: 'brandedSearchesAndDetailPageViewsCategoryTopPerformers',
  },
  {
    id: 'customerConversionRate', label: 'Customer CVR', format: 'pct', agg: 'avg',
    own: 'p."customerConversionRate"',
    ownKey: 'customerConversionRate',
    medianKey: 'customerConversionRateCategoryMedian',
    topKey: 'customerConversionRateCategoryTopPerformers',
  },
  {
    id: 'newToBrandCustomerRate', label: 'New-to-brand rate', format: 'pct', agg: 'avg',
    own: 'p."newToBrandCustomerRate"',
    ownKey: 'newToBrandCustomerRate',
    medianKey: 'newToBrandCustomerRateCategoryMedian',
    topKey: 'newToBrandCustomerRateCategoryTopPerformers',
    help: 'Share of brand customers who had not bought from the brand before. Brand-level, and unrelated to the ad-level new-to-brand fields, which are Sponsored Brands and Display only.',
  },

  // ── return on engagement ────────────────────────────────────────────────────
  // Ratios, so they average. Amazon sends own/median/top for five engagement
  // types; Helium 10's card shows two figures and no benchmark at all.
  {
    id: 'roeAddToCarts', label: 'ROE · add to carts', format: 'ratio', agg: 'avg',
    own: bmJson('addToCartsReturnOnEngagement'),
    ownKey: 'addToCartsReturnOnEngagement',
    medianKey: 'addToCartsROECategoryMedian',
    topKey: 'addToCartsROECategoryTopPerformers',
  },
  {
    id: 'roeBrandCustomers', label: 'ROE · brand customers', format: 'ratio', agg: 'avg',
    own: bmJson('brandCustomersReturnOnEngagement'),
    ownKey: 'brandCustomersReturnOnEngagement',
    medianKey: 'brandCustomersROECategoryMedian',
    topKey: 'brandCustomersROECategoryTopPerformers',
  },
  {
    id: 'roeHighValueCustomers', label: 'ROE · high-value customers', format: 'ratio', agg: 'avg',
    own: bmJson('highValueCustomersReturnOnEngagement'),
    ownKey: 'highValueCustomersReturnOnEngagement',
    medianKey: 'highValueCustomersROECategoryMedian',
    topKey: 'highValueCustomersROECategoryTopPerformers',
  },
  {
    id: 'roeViewedDetailPage', label: 'ROE · detail page views', format: 'ratio', agg: 'avg',
    own: bmJson('viewedDetailPageOnlyReturnOnEngagement'), // 🔴 "Only" on ours…
    ownKey: 'viewedDetailPageOnlyReturnOnEngagement',
    medianKey: 'viewedDetailPageROECategoryMedian',        // …and not on the benchmark
    topKey: 'viewedDetailPageROECategoryTopPerformers',
  },
  {
    id: 'roeBrandedSearchesAndDetailPageViews', label: 'ROE · branded search + detail page', format: 'ratio', agg: 'avg',
    own: bmJson('brandedSearchesAndDetailPageViewsReturnOnEngagement'),
    ownKey: 'brandedSearchesAndDetailPageViewsReturnOnEngagement',
    medianKey: 'brandedSearchesAndDetailPageViewsROECategoryMedian',
    topKey: 'brandedSearchesAndDetailPageViewsROECategoryTopPerformers',
  },
]

/**
 * BM.1 — shopper engagement rate, which Amazon sends as a BOUNDED RANGE.
 *
 * 🔴 It is not a point value and must never be rendered as one. Amazon gives a
 * lower and an upper bound for ours, for the category median and for the top
 * performers — six numbers. Averaging them into "2.5%" would invent a precision
 * Amazon deliberately withheld. Helium 10's own card reads "0-0%", which is the
 * same acknowledgement.
 *
 * 🔴 And these are ALREADY IN PERCENT UNITS — measured range 0 to 22.5 across
 * production rows, where a 0..1 rate could not exceed 1. So the format is
 * `ratio`, not `pct`: `pct` multiplies by 100 and would render 22.5 as 2,250%.
 * Every other rate in this spec (CVR, new-to-brand) IS 0..1 and correctly uses
 * `pct`. The two live side by side, which is exactly how a unit bug gets shipped.
 */
export const BRAND_BAND_KEYS = [
  ['engagedShopperRateLow', 'Shopper engagement rate — low (%)', 'engagedShopperRateLowerBound'],
  ['engagedShopperRateHigh', 'Shopper engagement rate — high (%)', 'engagedShopperRateUpperBound'],
  ['engagedShopperRateMedianLow', 'Shopper engagement — category median low (%)', 'engagedShopperRateCategoryMedianLowerBound'],
  ['engagedShopperRateMedianHigh', 'Shopper engagement — category median high (%)', 'engagedShopperRateCategoryMedianUpperBound'],
  ['engagedShopperRateTopLow', 'Shopper engagement — category top low (%)', 'engagedShopperRateCategoryTopPerformersLowerBound'],
  ['engagedShopperRateTopHigh', 'Shopper engagement — category top high (%)', 'engagedShopperRateCategoryTopPerformersUpperBound'],
] as const

/** The three composite scores Amazon publishes beside the benchmarks. Not percentiles — see BM.0. */
export const BRAND_INDEX_KEYS = ['awarenessIndex', 'considerationIndex', 'salesIndex'] as const

const ENGAGEMENT_BAND: Metric[] = (BRAND_BAND_KEYS).map(([id, label, key]) => ({
  id, label, kind: 'metric' as const, format: 'ratio' as const, align: 'right' as const,
  sql: `AVG(${bmJson(key)})`,
  help: 'Already a percentage — Amazon reports engagement as a bounded range, never a single figure.',
}))

export interface ReportSpec {
  id: string
  title: string
  /** FROM clause, including any joins. `p` is always the fact table. */
  from: string
  /** Date column used by the range filter, qualified. */
  dateCol: string
  /** Marketplace column, qualified. Null when the table has none. */
  marketCol: string | null
  /** Ad-product column, qualified, when the table distinguishes them. */
  adProductCol: string | null
  /** Always-applied predicates (e.g. only campaign rows). */
  fixedWhere: string[]
  /** Columns the free-text search box matches against. */
  searchCols: string[]
  /**
   * RPX.1 — suppress the pinned Total row, with the reason stated in `noTotalsReason`.
   *
   * Only for grains where a whole-set aggregate is WRONG rather than merely coarse. Brand
   * Metrics is the one: its rows repeat the same brand-week at several category depths, so
   * every sum over them multiplies. Never set this to hide a slow query.
   */
  noTotals?: boolean
  noTotalsReason?: string
  dimensions: Dimension[]
  metrics: Metric[]
  /** Dimension ids forming the natural grain — the default grouping. */
  defaultGroupBy: string[]
  /** Column ids shown before the operator chooses. */
  defaultColumns: string[]
  defaultSort: { col: string; dir: 'asc' | 'desc' }
  /** Currency for money columns. Every Xavia ads table is EUR today. */
  currency: string
  /** False when rows are per-row aggregation windows rather than a time series. */
  timeSeries?: boolean
}

/**
 * Marketplace, normalised in SQL.
 *
 * 183 placement rows store raw SP-API marketplace ids (A1PA6795UKMFR9 …) instead
 * of country codes. Folding them only for display would not be enough here: the
 * same column is the GROUP BY key and the filter target, so without this the
 * operator sees eight markets for four, and filtering to "DE" silently drops the
 * 121 rows filed under its raw id.
 *
 * The CASE is generated from the shared MARKETPLACE_ID_TO_CODE map, so it stays
 * in step with the rest of the app. Values are our own constants, never request
 * input, so interpolating them is safe.
 */
const MARKET_CASE_BODY = Object.entries(MARKETPLACE_ID_TO_CODE)
  .filter(([id]) => !id.includes('_')) // skip forward-compat alias keys
  .map(([id, code]) => `WHEN '${id}' THEN '${code}'`)
  .join(' ')

export function marketExpr(col: string): string {
  return `(CASE ${col} ${MARKET_CASE_BODY} ELSE UPPER(${col}) END)`
}

/** Campaign name resolved by externalCampaignId ALONE — see the AF-series rule. */
const CAMPAIGN_JOIN = 'LEFT JOIN "Campaign" c ON c."externalCampaignId" = p."entityId"'
const CAMPAIGN_JOIN_BY_FIELD = (field: string) =>
  `LEFT JOIN "Campaign" c ON c."externalCampaignId" = p."${field}"`

const DAILY = 'AmazonAdsDailyPerformance'

/**
 * SPC.2 — everything the widened spCampaigns request made readable.
 *
 * Only for the campaign report: the targeting, search-term and advertised-product
 * reports offer the same-SKU split too, but they are not requested yet, and a
 * column that is null on every row of a report teaches the operator that the page
 * is broken. They join when their own ingest does.
 *
 * The one derived pair worth stating plainly: Amazon offers no `otherSku` column at
 * campaign grain, so HALO is `total − sameSku`. That is a subtraction of two sums,
 * which stays correct at every grouping and in the totals row — unlike a ratio,
 * which has to be recomputed. `sameSkuShare` IS a ratio, so it is expressed over
 * the sums rather than averaged.
 */
function spcCampaignMetrics(t: string): Metric[] {
  const m = (id: string, label: string, format: ColumnFormat, sql: string, help?: string): Metric =>
    ({ id, label, kind: 'metric', format, align: 'right', sql, help })
  const money = (col: string) => `SUM(${t}."${col}")::numeric / 100.0`
  const count = (col: string) => `SUM(${t}."${col}")::bigint`

  const total7 = `SUM(${t}."sales7dCents")::numeric`
  const same7 = `SUM(${t}."salesSameSku7dCents")::numeric`

  const out: Metric[] = [
    // ── same-SKU vs halo, at the default 7-day window ───────────────────────
    m('salesSameSku', 'Sales · same SKU', 'money', money('salesSameSku7dCents'),
      'Sales of the product the ad actually advertises, 7-day window. The plain Sales column counts these AND anything else of ours the shopper bought.'),
    m('salesHalo', 'Sales · halo', 'money',
      `(SUM(${t}."sales7dCents") - SUM(${t}."salesSameSku7dCents"))::numeric / 100.0`,
      'Sales the ad led to of OTHER products of ours — total minus same-SKU. Real revenue, but a different decision from the advertised product selling.'),
    m('sameSkuShare', 'Same-SKU share', 'pct',
      `CASE WHEN ${total7} > 0 THEN ${same7} / ${total7} END`,
      'Share of attributed sales that were the advertised product. Recomputed from the underlying sums at every grouping, never averaged.'),
    m('ordersSameSku', 'Orders · same SKU', 'int', count('ordersSameSku7d')),
    m('unitsSameSku', 'Units · same SKU', 'int', count('unitsSameSku7d')),

    // ── Amazon's own impression share, at campaign grain ────────────────────
    m('topOfSearchIS', 'Top-of-search IS', 'pct', `MAX(${t}."topOfSearchIS")`,
      'Amazon’s own top-of-search impression share for the campaign. MAX rather than AVG within a group: it is a campaign-day property, and averaging it across days would weight a quiet day like a busy one.'),

    // ── the campaign's settings on that day ─────────────────────────────────
    m('budget', 'Budget', 'money', `MAX(${t}."campaignBudgetCents")::numeric / 100.0`,
      'The daily budget as Amazon held it on that day — not today’s budget. MAX within a group because it is a per-day setting, not a quantity to add up.'),
    m('budgetUsed', 'Budget used', 'pct',
      `CASE WHEN SUM(${t}."campaignBudgetCents") > 0
            THEN (SUM(${t}."costMicros")::numeric / 10000.0) / SUM(${t}."campaignBudgetCents")::numeric END`,
      'Spend ÷ the budget in force that day, summed across the days in view. Computable over history for the first time — until now we could only compare today’s spend against today’s budget.'),
  ]

  // The other three windows. Generated so a fourth can never be added to one
  // measure and forgotten on the others.
  for (const w of WINDOWS) {
    out.push(
      m(`sales${w.w}`, `Sales · ${w.label}`, 'money', money(w.sales),
        `Attributed sales in the ${w.label} window. Empty on rows older than Amazon’s 95-day retention, which can never be filled.`),
      m(`orders${w.w}`, `Orders · ${w.label}`, 'int', count(w.orders)),
      m(`units${w.w}`, `Units · ${w.label}`, 'int', count(w.units)),
      m(`salesSameSku${w.w}`, `Sales · same SKU · ${w.label}`, 'money', money(w.same)),
    )
  }
  return out
}

/**
 * 🔴 AX2.3 — exclude the Marketing Stream's daily rows from every aggregate.
 *
 * Amazon Marketing Stream used to upsert the DAILY table as well as the hourly
 * one, under `profileId: 'ams'`, producing a second parallel set of rows for
 * campaign-days the report pipeline already owned. Ingestion stopped doing that
 * and the ~659 rows already written are excluded AT READ TIME rather than deleted,
 * via the `reportRunId` marker — five services already do this. **The reporting
 * engine never adopted it**, and it aggregates the same table.
 *
 * Measured on prod 2026-08-20, IT campaign report, 2026-05-21 → 2026-07-27:
 *   with the duplicates    5,501,397 impressions · €4,557.87 spend · €12,395.80 sales
 *   without them           3,846,669 impressions · €3,240.51 spend · €9,051.47 sales
 * — a **40% over-report of spend** and 37% of sales, on the report the whole console
 * is built from. 81 of those rows also carry NEGATIVE impressions (AMS sends
 * corrections as deltas), so they are not even a defensible second measurement.
 *
 * `IS DISTINCT FROM`, not `<>`: `reportRunId` is nullable and `NULL <> 'x'` is NULL,
 * which would silently drop every legitimate row that has no run id.
 */
const EXCLUDE_AMS_DAILY_SQL = excludeAmsDailySql('p')

function dailyPerfSpec(
  id: string, title: string, fixedWhere: string[], extraDims: Dimension[] = [],
): ReportSpec {
  return {
    id,
    title,
    from: `"${DAILY}" p ${CAMPAIGN_JOIN}`,
    dateCol: 'p."date"',
    marketCol: marketExpr('p."marketplace"'),
    adProductCol: 'p."adProduct"',
    fixedWhere: [...fixedWhere, EXCLUDE_AMS_DAILY_SQL],
    searchCols: ['c."name"', 'p."entityId"'],
    dimensions: [
      dim('date', 'Date', 'p."date"', 'date'),
      dim('campaign', 'Campaign', 'COALESCE(c."name", p."entityId")'),
      dim('marketplace', 'Market', marketExpr('p."marketplace"')),
      dim('adProduct', 'Ad product', 'p."adProduct"'),
      dim('entityId', 'Amazon ID', 'p."entityId"'),
      ...extraDims,
    ],
    metrics: coreMetrics('p'),
    defaultGroupBy: ['campaign', 'marketplace'],
    defaultColumns: ['campaign', 'marketplace', 'impressions', 'clicks', 'cost', 'sales', 'orders', 'acos', 'roas'],
    defaultSort: { col: 'cost', dir: 'desc' },
    currency: 'EUR',
  }
}

export const REPORT_SPECS: Record<string, ReportSpec> = {
  campaign: (() => {
    const base = dailyPerfSpec('campaign', 'Campaign performance', [`p."entityType" = 'CAMPAIGN'`])
    return {
      ...base,
      // SPC.2 — the widened column set. `defaultColumns` is untouched, so the grid
      // opens exactly as it did; these are reached through Customize.
      metrics: [...base.metrics, ...spcCampaignMetrics('p')],
      dimensions: [
        ...base.dimensions,
        // The name and status Amazon sent for that day. The existing `campaign`
        // dimension resolves through a join to our own Campaign table and falls back
        // to the raw id for the 13.7% of rows we hold no campaign for; this one is
        // what Amazon itself called it, and it is also a historical fact — a campaign
        // renamed last week was still called something else in June.
        dim('campaignNameAmazon', 'Campaign (as Amazon named it)', 'p."entityName"', 'text',
          'The name on Amazon’s own row for that day, rather than the current name from our campaign table.'),
        dim('campaignStatusThen', 'Status (that day)', 'p."entityStatus"', 'text',
          'The campaign’s status on that day, not now. A campaign paused yesterday was still enabled last month.'),
      ],
      searchCols: [...base.searchCols, 'p."entityName"'],
    }
  })(),

  'advertised-product': {
    ...dailyPerfSpec('advertised-product', 'Advertised product performance', [`p."entityType" = 'PRODUCT_AD'`]),
    // Product ads carry no campaignId on the fact row, so resolve ASIN/SKU through
    // the locally-tracked ad instead.
    from: `"${DAILY}" p LEFT JOIN "AdProductAd" a ON a."id" = p."localEntityId"`,
    searchCols: ['a."asin"', 'a."sku"', 'p."entityId"'],
    dimensions: [
      dim('date', 'Date', 'p."date"', 'date'),
      dim('asin', 'ASIN', 'COALESCE(a."asin", p."entityId")'),
      dim('sku', 'SKU', 'a."sku"'),
      dim('marketplace', 'Market', marketExpr('p."marketplace"')),
      dim('adProduct', 'Ad product', 'p."adProduct"'),
      dim('entityId', 'Amazon ad ID', 'p."entityId"'),
    ],
    defaultGroupBy: ['asin', 'marketplace'],
    defaultColumns: ['asin', 'sku', 'marketplace', 'impressions', 'clicks', 'cost', 'sales', 'orders', 'acos', 'roas'],
  },

  // RPT — targeting performance. Ingested via the spTargeting report; rows land
  // as entityType='AD_TARGET' joined to the local AdTarget by externalTargetId,
  // which is what makes the keyword TEXT (not just Amazon's id) reportable.
  targeting: {
    ...dailyPerfSpec('targeting', 'Targeting & keyword performance', [`p."entityType" = 'AD_TARGET'`]),
    from: `"${DAILY}" p LEFT JOIN "AdTarget" t ON t."id" = p."localEntityId"`,
    searchCols: ['t."expressionValue"', 'p."entityId"'],
    dimensions: [
      dim('date', 'Date', 'p."date"', 'date'),
      dim('target', 'Target', 'COALESCE(t."expressionValue", p."entityId")'),
      dim('kind', 'Type', `COALESCE(t."kind", 'UNKNOWN')`, 'text',
        'KEYWORD, PRODUCT, AUTO … — an auto clause is generated by Amazon, not by us.'),
      dim('matchType', 'Match type', `COALESCE(t."expressionType", '—')`),
      dim('marketplace', 'Market', marketExpr('p."marketplace"')),
      dim('entityId', 'Amazon target ID', 'p."entityId"'),
    ],
    defaultGroupBy: ['target', 'marketplace'],
    defaultColumns: ['target', 'kind', 'marketplace', 'impressions', 'clicks', 'cost', 'sales', 'orders', 'acos', 'roas'],
  },

  'sb-sd': {
    ...dailyPerfSpec('sb-sd', 'Sponsored Brands & Display', [
      `p."adProduct" IN ('SPONSORED_BRANDS', 'SPONSORED_DISPLAY')`,
    ]),
    defaultGroupBy: ['campaign', 'adProduct', 'marketplace'],
    defaultColumns: ['campaign', 'adProduct', 'marketplace', 'impressions', 'clicks', 'cost', 'sales', 'orders', 'acos'],
  },

  'search-term': {
    id: 'search-term',
    title: 'Search terms',
    from: `"AmazonAdsSearchTerm" p ${CAMPAIGN_JOIN_BY_FIELD('campaignId')}`,
    dateCol: 'p."date"',
    marketCol: marketExpr('p."marketplace"'),
    adProductCol: 'p."adProduct"',
    fixedWhere: [],
    searchCols: ['p."query"', 'c."name"'],
    dimensions: [
      dim('date', 'Date', 'p."date"', 'date'),
      dim('query', 'Search term', 'p."query"'),
      dim('campaign', 'Campaign', 'COALESCE(c."name", p."campaignId")'),
      dim('matchType', 'Match type', 'p."matchType"'),
      dim('marketplace', 'Market', marketExpr('p."marketplace"')),
    ],
    metrics: coreMetrics('p', { units: false }),
    defaultGroupBy: ['query'],
    defaultColumns: ['query', 'matchType', 'impressions', 'clicks', 'cost', 'sales', 'orders', 'ctr', 'cvr', 'acos'],
    defaultSort: { col: 'cost', dir: 'desc' },
    currency: 'EUR',
  },

  placement: {
    id: 'placement',
    title: 'Placement performance',
    from: `"AmazonAdsPlacementReport" p ${CAMPAIGN_JOIN_BY_FIELD('campaignId')}`,
    dateCol: 'p."date"',
    marketCol: marketExpr('p."marketplace"'),
    adProductCol: 'p."adProduct"',
    fixedWhere: [],
    searchCols: ['c."name"', 'p."placement"'],
    dimensions: [
      dim('date', 'Date', 'p."date"', 'date'),
      dim('placement', 'Placement', 'p."placement"'),
      dim('campaign', 'Campaign', 'COALESCE(c."name", p."campaignId")'),
      dim('marketplace', 'Market', marketExpr('p."marketplace"')),
    ],
    metrics: [
      ...coreMetrics('p', { units: false }),
      {
        id: 'topOfSearchIS', label: 'Top-of-search IS', kind: 'metric', format: 'pct', align: 'right',
        // Amazon reports this per campaign-day on the TOP row only, so averaging
        // it across placements would be meaningless — take the max within a group.
        sql: 'MAX(p."topOfSearchIS")',
        help: 'Amazon’s own top-of-search impression share. Recorded on the top-of-search row only.',
      },
    ],
    defaultGroupBy: ['placement'],
    defaultColumns: ['placement', 'impressions', 'clicks', 'cost', 'sales', 'orders', 'ctr', 'acos', 'topOfSearchIS'],
    defaultSort: { col: 'cost', dir: 'desc' },
    currency: 'EUR',
  },

  hourly: {
    id: 'hourly',
    title: 'Hourly performance',
    from: `"AmazonAdsHourlyPerformance" p ${CAMPAIGN_JOIN}`,
    dateCol: 'p."date"',
    marketCol: marketExpr('p."marketplace"'),
    adProductCol: 'p."adProduct"',
    fixedWhere: [],
    searchCols: ['c."name"', 'p."entityId"'],
    dimensions: [
      dim('date', 'Date', 'p."date"', 'date'),
      dim('hour', 'Hour (UTC)', 'p."hour"', 'hour', 'Hour of day in UTC, as Amazon Marketing Stream delivers it.'),
      dim('campaign', 'Campaign', 'COALESCE(c."name", p."entityId")'),
      dim('marketplace', 'Market', marketExpr('p."marketplace"')),
    ],
    metrics: coreMetrics('p'),
    defaultGroupBy: ['hour'],
    defaultColumns: ['hour', 'impressions', 'clicks', 'cost', 'sales', 'orders', 'ctr', 'cvr', 'acos'],
    defaultSort: { col: 'hour', dir: 'asc' },
    currency: 'EUR',
  },

  sqp: {
    id: 'sqp',
    title: 'Search Query Performance',
    from: '"SearchQueryPerformance" p',
    dateCol: 'p."startDate"',
    marketCol: marketExpr('p."marketplace"'),
    adProductCol: null,
    fixedWhere: [],
    searchCols: ['p."searchQuery"', 'p."asin"'],
    dimensions: [
      dim('startDate', 'Week of', 'p."startDate"', 'date'),
      dim('searchQuery', 'Search query', 'p."searchQuery"'),
      dim('asin', 'ASIN', 'p."asin"'),
      dim('marketplace', 'Market', marketExpr('p."marketplace"')),
    ],
    metrics: [
      { id: 'volume', label: 'Query volume', kind: 'metric', format: 'int', align: 'right', sql: 'SUM(p."searchQueryVolume")::bigint', help: 'Total searches for this query across the whole marketplace.' },
      { id: 'impressionsTotal', label: 'Impressions (market)', kind: 'metric', format: 'int', align: 'right', sql: 'SUM(p."impressionsTotal")::bigint' },
      { id: 'impressionsBrand', label: 'Impressions (ours)', kind: 'metric', format: 'int', align: 'right', sql: 'SUM(p."impressionsBrand")::bigint' },
      // Shares are recomputed from the underlying counts, not averaged: averaging
      // a stored share would weight a 10-impression week like a 10,000 one.
      { id: 'impressionShare', label: 'Impression share', kind: 'metric', format: 'pct', align: 'right', sql: 'CASE WHEN SUM(p."impressionsTotal") > 0 THEN SUM(p."impressionsBrand")::numeric / SUM(p."impressionsTotal") END' },
      { id: 'clicksBrand', label: 'Clicks (ours)', kind: 'metric', format: 'int', align: 'right', sql: 'SUM(p."clicksBrand")::bigint' },
      { id: 'clickShare', label: 'Click share', kind: 'metric', format: 'pct', align: 'right', sql: 'CASE WHEN SUM(p."clicksTotal") > 0 THEN SUM(p."clicksBrand")::numeric / SUM(p."clicksTotal") END' },
      { id: 'cartAddShare', label: 'Cart-add share', kind: 'metric', format: 'pct', align: 'right', sql: 'CASE WHEN SUM(p."cartAddsTotal") > 0 THEN SUM(p."cartAddsBrand")::numeric / SUM(p."cartAddsTotal") END' },
      { id: 'purchasesBrand', label: 'Purchases (ours)', kind: 'metric', format: 'int', align: 'right', sql: 'SUM(p."purchasesBrand")::bigint' },
      { id: 'purchaseShare', label: 'Purchase share', kind: 'metric', format: 'pct', align: 'right', sql: 'CASE WHEN SUM(p."purchasesTotal") > 0 THEN SUM(p."purchasesBrand")::numeric / SUM(p."purchasesTotal") END' },
    ],
    defaultGroupBy: ['searchQuery'],
    defaultColumns: ['searchQuery', 'volume', 'impressionsBrand', 'impressionShare', 'clickShare', 'purchasesBrand', 'purchaseShare'],
    defaultSort: { col: 'volume', dir: 'desc' },
    currency: 'EUR',
  },

  'brand-metrics': {
    id: 'brand-metrics',
    title: 'Brand Metrics',
    from: '"AmazonAdsBrandBuildingMetric" p',
    dateCol: 'p."computationDate"',
    marketCol: marketExpr('p."marketplace"'),
    adProductCol: null,
    fixedWhere: [],
    searchCols: ['p."brandName"', 'p."categoryNodeName"'],
    dimensions: [
      dim('computationDate', 'Week of', 'p."computationDate"', 'date'),
      dim('brandName', 'Brand', 'p."brandName"'),
      // The grain genuinely includes the category node — Amazon returns the same
      // brand-week at several category depths, each with its own benchmark.
      dim('categoryNodeName', 'Category node', 'p."categoryNodeName"', 'text',
        'Amazon returns the same brand-week at several category depths. Dropping this dimension double-counts.'),
      dim('marketplace', 'Market', marketExpr('p."marketplace"')),
    ],
    metrics: [
      { id: 'awarenessIndex', label: 'Awareness index', kind: 'metric', format: 'ratio', align: 'right', sql: 'AVG(p."awarenessIndex")' },
      { id: 'considerationIndex', label: 'Consideration index', kind: 'metric', format: 'ratio', align: 'right', sql: 'AVG(p."considerationIndex")' },
      { id: 'salesIndex', label: 'Sales index', kind: 'metric', format: 'ratio', align: 'right', sql: 'AVG(p."salesIndex")' },
      // BM.1 — 39 metrics from 13 trios. `brandCustomers`, `addToCarts` and
      // `customerConversionRate` were already here as bare figures and are now
      // generated with their two benchmarks, so their ids and labels are
      // unchanged and every saved report keeps working. The only difference to
      // the three that existed is that the two SUMs lost a `COALESCE(x, 0)`
      // which turned "Amazon sent nothing" into a real-looking zero.
      ...BRAND_BENCHMARKS.flatMap(benchmarkTrio),
      ...ENGAGEMENT_BAND,
    ],
    defaultGroupBy: ['computationDate', 'categoryNodeName', 'marketplace'],
    defaultColumns: ['computationDate', 'marketplace', 'categoryNodeName', 'awarenessIndex', 'considerationIndex', 'salesIndex', 'brandCustomers'],
    defaultSort: { col: 'computationDate', dir: 'desc' },
    currency: 'EUR',
    noTotals: true,
    noTotalsReason: 'Amazon reports the same brand-week at several category depths, so these rows cannot be added up — a total would count the same shoppers once per depth. Use the Brand tab, which reads one node at a time.',
  },

  economics: {
    id: 'economics',
    title: 'Amazon economics — net proceeds',
    from: '"AmazonEconomicsDaily" p',
    dateCol: 'p."date"',
    marketCol: marketExpr('p."marketplace"'),
    adProductCol: null,
    fixedWhere: [],
    searchCols: ['p."childAsin"', 'p."msku"', 'p."parentAsin"'],
    dimensions: [
      dim('date', 'Date', 'p."date"', 'date'),
      dim('childAsin', 'ASIN', 'p."childAsin"'),
      dim('msku', 'SKU', 'p."msku"'),
      dim('marketplace', 'Market', marketExpr('p."marketplace"')),
    ],
    metrics: [
      { id: 'unitsOrdered', label: 'Units', kind: 'metric', format: 'int', align: 'right', sql: 'SUM(COALESCE(p."unitsOrdered", 0))::bigint' },
      { id: 'netProductSales', label: 'Net sales', kind: 'metric', format: 'money', align: 'right', sql: 'SUM(COALESCE(p."netProductSales", 0))' },
      { id: 'feesTotal', label: 'Fees', kind: 'metric', format: 'money', align: 'right', sql: 'SUM(COALESCE(p."feesTotal", 0))' },
      { id: 'adsTotal', label: 'Ads', kind: 'metric', format: 'money', align: 'right', sql: 'SUM(COALESCE(p."adsTotal", 0))' },
      { id: 'costOfGoodsSold', label: 'COGS', kind: 'metric', format: 'money', align: 'right', sql: 'SUM(COALESCE(p."costOfGoodsSold", 0))' },
      {
        id: 'netProceedsTotal', label: 'Net proceeds', kind: 'metric', format: 'money', align: 'right',
        sql: 'SUM(COALESCE(p."netProceedsTotal", 0))',
        help: 'Amazon’s authoritative profitability figure. Do NOT derive it by subtracting the fee and ad columns — that array is unlabelled and incomplete, measured ~10% short.',
      },
    ],
    defaultGroupBy: ['childAsin'],
    defaultColumns: ['childAsin', 'msku', 'unitsOrdered', 'netProductSales', 'feesTotal', 'adsTotal', 'netProceedsTotal'],
    defaultSort: { col: 'netProceedsTotal', dir: 'desc' },
    currency: 'EUR',
  },
}

// RPT.7 — imported console data, readable through the SAME runner, exporter and
// scheduler as every API-sourced report. Only COMMITTED imports are visible, so a
// preview an operator abandoned never shows up as data.
//
// Its window columns are deliberately exposed as dimensions: these rows are
// LIFETIME AGGREGATES over per-row spans, not a daily series, and hiding that
// would invite someone to sum across overlapping windows.
REPORT_SPECS['console-import'] = {
  id: 'console-import',
  title: 'Imported Amazon console report',
  from: '"AdsConsoleRow" p JOIN "AdsConsoleImport" i ON i."id" = p."importId"',
  dateCol: 'p."windowStart"',
  marketCol: 'p."marketplace"',
  adProductCol: 'p."adProduct"',
  fixedWhere: [`i."status" = 'COMMITTED'`],
  searchCols: ['p."searchTerm"', 'p."campaignName"', 'p."asin"', 'p."sku"'],
  dimensions: [
    dim('searchTerm', 'Search term', 'p."searchTerm"'),
    dim('placement', 'Placement', 'p."placement"'),
    dim('campaignName', 'Campaign', 'COALESCE(p."campaignName", p."campaignId")'),
    dim('asin', 'ASIN', 'p."asin"'),
    dim('sku', 'SKU', 'p."sku"'),
    dim('matchType', 'Match type', 'p."matchType"'),
    dim('marketplace', 'Market', 'p."marketplace"'),
    dim('windowStart', 'Window start', 'p."windowStart"', 'date',
      'Each row aggregates its own window. Rows across overlapping windows must never be summed as a time series.'),
    dim('windowEnd', 'Window end', 'p."windowEnd"', 'date'),
  ],
  metrics: [
    { id: 'impressions', label: 'Impressions', kind: 'metric', format: 'int', align: 'right', sql: 'SUM(p."impressions")::bigint' },
    { id: 'clicks', label: 'Clicks', kind: 'metric', format: 'int', align: 'right', sql: 'SUM(p."clicks")::bigint' },
    { id: 'cost', label: 'Spend', kind: 'metric', format: 'money', align: 'right', sql: 'SUM(p."costCents")::numeric / 100.0' },
    { id: 'sales', label: 'Sales', kind: 'metric', format: 'money', align: 'right', sql: 'SUM(p."salesCents")::numeric / 100.0' },
    { id: 'purchases', label: 'Purchases', kind: 'metric', format: 'int', align: 'right', sql: 'SUM(p."purchases")::bigint' },
    { id: 'ctr', label: 'CTR', kind: 'metric', format: 'pct', align: 'right', sql: 'CASE WHEN SUM(p."impressions") > 0 THEN SUM(p."clicks")::numeric / SUM(p."impressions") END' },
    { id: 'cpc', label: 'CPC', kind: 'metric', format: 'money', align: 'right', sql: 'CASE WHEN SUM(p."clicks") > 0 THEN (SUM(p."costCents")::numeric / 100.0) / SUM(p."clicks") END' },
    { id: 'acos', label: 'ACOS', kind: 'metric', format: 'pct', align: 'right', sql: 'CASE WHEN SUM(p."salesCents") > 0 THEN SUM(p."costCents")::numeric / SUM(p."salesCents") END' },
  ],
  defaultGroupBy: ['searchTerm'],
  defaultColumns: ['searchTerm', 'impressions', 'clicks', 'cost', 'sales', 'purchases', 'ctr', 'acos'],
  defaultSort: { col: 'cost', dir: 'desc' },
  currency: 'EUR',
  // Each row aggregates its OWN window, so bucketing them into a timeline would
  // draw a trend that does not exist. The summary surface reads this and shows
  // KPI tiles without a chart rather than inventing one.
  timeSeries: false,
}

export const RUNNABLE_REPORT_IDS = Object.keys(REPORT_SPECS)

/** All selectable columns for a report, dimensions first. */
export function specColumns(spec: ReportSpec): ColumnMeta[] {
  return [
    ...spec.dimensions.map(({ sql: _sql, ...meta }) => meta),
    ...spec.metrics.map(({ sql: _sql, ...meta }) => meta),
  ]
}
