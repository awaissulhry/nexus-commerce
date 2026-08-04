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
    fixedWhere,
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
  campaign: dailyPerfSpec('campaign', 'Campaign performance', [`p."entityType" = 'CAMPAIGN'`]),

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
      { id: 'brandCustomers', label: 'Brand customers', kind: 'metric', format: 'int', align: 'right', sql: 'SUM(COALESCE(p."brandCustomers", 0))::bigint' },
      { id: 'addToCarts', label: 'Add to carts', kind: 'metric', format: 'int', align: 'right', sql: 'SUM(COALESCE(p."addToCarts", 0))::bigint' },
      { id: 'customerConversionRate', label: 'Customer CVR', kind: 'metric', format: 'pct', align: 'right', sql: 'AVG(p."customerConversionRate")' },
    ],
    defaultGroupBy: ['computationDate', 'categoryNodeName', 'marketplace'],
    defaultColumns: ['computationDate', 'marketplace', 'categoryNodeName', 'awarenessIndex', 'considerationIndex', 'salesIndex', 'brandCustomers'],
    defaultSort: { col: 'computationDate', dir: 'desc' },
    currency: 'EUR',
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
