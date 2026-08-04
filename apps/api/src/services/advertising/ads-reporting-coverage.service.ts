/**
 * RPT.2 — live coverage for the Reporting library.
 *
 * Answers, for every report the console offers: how many rows do we hold, over
 * what window, how many distinct days inside it, and — the part RPT.0 proved
 * matters — how stale is each MARKET individually.
 *
 * Why per-market and not one global figure: measured 2026-08-04, Italy (52% of
 * all rows, and the primary market) was six to seven days behind DE and FR on
 * both daily performance and search terms. A single "as of" would have reported
 * the freshest market and quietly hidden that. See docs/2026-08-04-ads-reporting-rpt.md §6.
 *
 * Why campaign counts are included: an empty report is not automatically a
 * broken one. All 4 Sponsored Brands and all 15 Sponsored Display campaigns are
 * PAUSED, so those reports correctly return nothing. The library needs the
 * campaign census to tell "idle" apart from "broken" instead of showing six
 * healthy reports as failures.
 *
 * Read-only. Every query is a grouped aggregate — no table scan returns rows to
 * the client.
 */
import prisma from '../../db.js'
import { normalizeMarketplaceCode } from '../../utils/marketplace-code.js'

export interface MarketCoverage {
  marketplace: string
  rows: number
  firstDay: string | null
  lastDay: string | null
  days: number
  /** Whole days between lastDay and today (UTC). null when there are no rows. */
  lagDays: number | null
}

export interface ReportCoverage {
  rows: number
  firstDay: string | null
  lastDay: string | null
  /** Distinct days that actually carry rows. */
  days: number
  /** Calendar days spanned by firstDay→lastDay inclusive — `days` over this is the density. */
  spanDays: number
  lagDays: number | null
  byMarket: MarketCoverage[]
}

export interface ReportingCoverage {
  asOf: string
  reports: Record<string, ReportCoverage>
  /** Campaign census by ad product — the idle-vs-broken discriminator. */
  campaigns: Array<{ adProduct: string; enabled: number; paused: number; other: number }>
  /**
   * eBay economics rows by data status. Every row was MISSING_COGS on 2026-08-04,
   * which makes margin and break-even meaningless — but that is a data condition,
   * not a permanent truth, so the library derives "Blocked" from this instead of
   * hard-coding it. Load COGS and the card clears itself.
   */
  ebayEconomicsStatus: Array<{ status: string; rows: number }>
  pipeline: {
    reportJobs: Array<{ status: string; jobs: number; rowsIngested: number }>
    /** Distinct report types we request, with what each has ever produced. */
    reportTypes: Array<{ adProduct: string; reportTypeId: string; jobs: number; rowsIngested: number }>
    exportJobFailures: number
    dataKioskJobs: number
  }
  /** Non-fatal problems worth showing rather than swallowing. */
  warnings: string[]
}

/**
 * One raw grouped row: bucket + marketplace + the four aggregates.
 *
 * `is_total` marks the GROUPING SETS rollup row (marketplace collapsed). It
 * exists because distinct-day counts CANNOT be combined across markets — the
 * same calendar day appears in several — so the report-level day count has to
 * come from the database, not from folding the per-market rows. Taking the max
 * across markets would under-report, and under-reported density is what drives
 * the "Partial coverage" badge, so it would raise false alarms.
 */
interface RawRow {
  bucket: string
  mkt: string | null
  rows: number
  first_day: string | null
  last_day: string | null
  days: number
  is_total?: number
}

const EMPTY: ReportCoverage = {
  rows: 0, firstDay: null, lastDay: null, days: 0, spanDays: 0, lagDays: null, byMarket: [],
}

const MS_PER_DAY = 86_400_000

/** Whole days from `day` (YYYY-MM-DD) to today, both taken as UTC dates. */
function lagFrom(day: string | null): number | null {
  if (!day) return null
  const then = Date.parse(`${day}T00:00:00Z`)
  if (Number.isNaN(then)) return null
  const today = new Date()
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  return Math.max(0, Math.round((todayUtc - then) / MS_PER_DAY))
}

function spanBetween(first: string | null, last: string | null): number {
  if (!first || !last) return 0
  const a = Date.parse(`${first}T00:00:00Z`)
  const b = Date.parse(`${last}T00:00:00Z`)
  if (Number.isNaN(a) || Number.isNaN(b)) return 0
  return Math.round((b - a) / MS_PER_DAY) + 1
}

const minDay = (a: string | null, b: string | null) => (!a ? b : !b ? a : a < b ? a : b)
const maxDay = (a: string | null, b: string | null) => (!a ? b : !b ? a : a > b ? a : b)

/**
 * Fold raw grouped rows into one ReportCoverage, normalising the marketplace on
 * the way in. Normalisation is not cosmetic: 183 placement rows hold raw SP-API
 * marketplace ids (A1PA6795UKMFR9 …) instead of country codes, so grouping on the
 * stored value produces eight buckets for four markets.
 *
 * Rollup rows (`is_total`) supply the exact report-level distinct-day count and
 * are excluded from the per-market breakdown.
 */
function fold(rows: RawRow[]): ReportCoverage {
  if (!rows.length) return { ...EMPTY, byMarket: [] }

  const byMarket = new Map<string, MarketCoverage>()
  let total = 0
  let first: string | null = null
  let last: string | null = null
  let exactDays: number | null = null

  for (const r of rows) {
    const n = Number(r.rows) || 0
    const d = Number(r.days) || 0

    if (r.is_total) {
      // The database's own answer for "distinct days across every market".
      // Several buckets can roll up (e.g. campaign spans two ad products), so
      // take the largest rather than assuming one row.
      exactDays = Math.max(exactDays ?? 0, d)
      first = minDay(first, r.first_day)
      last = maxDay(last, r.last_day)
      total += n
      continue
    }

    const code = normalizeMarketplaceCode(r.mkt, 'UNKNOWN')
    first = minDay(first, r.first_day)
    last = maxDay(last, r.last_day)

    const prev = byMarket.get(code)
    if (prev) {
      prev.rows += n
      prev.firstDay = minDay(prev.firstDay, r.first_day)
      prev.lastDay = maxDay(prev.lastDay, r.last_day)
      // A market can appear in several buckets (entity types, ad products), and
      // distinct days still cannot be summed — largest is the honest floor here,
      // and it is only ever shown per market, never used as arithmetic.
      prev.days = Math.max(prev.days, d)
    } else {
      byMarket.set(code, {
        marketplace: code,
        rows: n,
        firstDay: r.first_day,
        lastDay: r.last_day,
        days: d,
        lagDays: null,
      })
    }
  }

  const markets = [...byMarket.values()].sort((a, b) => b.rows - a.rows)
  let fallbackDays = 0
  for (const m of markets) {
    m.lagDays = lagFrom(m.lastDay)
    fallbackDays = Math.max(fallbackDays, m.days)
  }
  // No rollup row (a bucket with no rows at all) → fall back to the per-market max.
  if (exactDays === null) {
    exactDays = fallbackDays
    total = markets.reduce((s, m) => s + m.rows, 0)
  }

  return {
    rows: total,
    firstDay: first,
    lastDay: last,
    days: exactDays,
    spanDays: spanBetween(first, last),
    lagDays: lagFrom(last),
    byMarket: markets,
  }
}

/**
 * Grouped aggregate over any table with a marketplace column and a date column.
 *
 * GROUPING SETS emits both the per-market rows AND a rollup row, so the exact
 * cross-market distinct-day count comes from Postgres in the same single scan
 * rather than from a second query or a wrong client-side combination.
 */
async function groupTable(table: string, dateCol: string, marketCol = 'marketplace'): Promise<RawRow[]> {
  return prisma.$queryRawUnsafe<RawRow[]>(`
    SELECT 'all' AS bucket,
           "${marketCol}" AS mkt,
           GROUPING("${marketCol}")::int AS is_total,
           COUNT(*)::int AS rows,
           TO_CHAR(MIN("${dateCol}"), 'YYYY-MM-DD') AS first_day,
           TO_CHAR(MAX("${dateCol}"), 'YYYY-MM-DD') AS last_day,
           COUNT(DISTINCT "${dateCol}"::date)::int AS days
    FROM "${table}"
    GROUP BY GROUPING SETS (("${marketCol}"), ())`)
}

export async function getReportingCoverage(): Promise<ReportingCoverage> {
  const warnings: string[] = []

  /** Never let one unavailable table blank the whole page. */
  const safe = async <T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn()
    } catch (err) {
      warnings.push(`${label}: ${(err as Error).message.split('\n')[0]}`)
      return fallback
    }
  }

  // One query covers five reports — daily performance is bucketed by entity type
  // and ad product, so campaign / advertised-product / targeting / ad-group /
  // SB-SD all come out of a single grouped scan rather than five.
  const daily = await safe('daily performance', () => prisma.$queryRawUnsafe<Array<RawRow & { adProduct: string }>>(`
    SELECT "entityType" AS bucket,
           "adProduct" AS "adProduct",
           "marketplace" AS mkt,
           GROUPING("marketplace")::int AS is_total,
           COUNT(*)::int AS rows,
           TO_CHAR(MIN("date"), 'YYYY-MM-DD') AS first_day,
           TO_CHAR(MAX("date"), 'YYYY-MM-DD') AS last_day,
           COUNT(DISTINCT "date"::date)::int AS days
    FROM "AmazonAdsDailyPerformance"
    GROUP BY GROUPING SETS (("entityType", "adProduct", "marketplace"), ("entityType", "adProduct"))`), [])

  const SPONSORED = new Set(['SPONSORED_BRANDS', 'SPONSORED_DISPLAY'])
  const dailyWhere = (pred: (r: RawRow & { adProduct: string }) => boolean) => fold(daily.filter(pred))

  const [searchTerm, placement, hourly, sqp, brand, economics, ebayEcon] = await Promise.all([
    safe('search terms', () => groupTable('AmazonAdsSearchTerm', 'date'), []),
    safe('placements', () => groupTable('AmazonAdsPlacementReport', 'date'), []),
    safe('hourly', () => groupTable('AmazonAdsHourlyPerformance', 'date'), []),
    safe('sqp', () => groupTable('SearchQueryPerformance', 'startDate'), []),
    safe('brand metrics', () => groupTable('AmazonAdsBrandBuildingMetric', 'computationDate'), []),
    safe('economics', () => groupTable('AmazonEconomicsDaily', 'date'), []),
    safe('ebay economics', () => groupTable('EbayListingEconomics', 'computedAt'), []),
  ])

  const [campaigns, reportJobs, reportTypes, exportFailures, kioskJobs] = await Promise.all([
    safe('campaign census', () => prisma.$queryRawUnsafe<Array<{ adProduct: string | null; status: string | null; n: number }>>(`
      SELECT "adProduct", "status", COUNT(*)::int AS n FROM "Campaign" GROUP BY 1, 2`), []),
    safe('report jobs', () => prisma.$queryRawUnsafe<Array<{ status: string; jobs: number; rowsIngested: number }>>(`
      SELECT "status", COUNT(*)::int AS jobs, COALESCE(SUM("rowsIngested"), 0)::int AS "rowsIngested"
      FROM "AmazonAdsReportJob" GROUP BY 1 ORDER BY 2 DESC`), []),
    safe('report types', () => prisma.$queryRawUnsafe<Array<{ adProduct: string; reportTypeId: string; jobs: number; rowsIngested: number }>>(`
      SELECT "adProduct", "reportTypeId", COUNT(*)::int AS jobs,
             COALESCE(SUM("rowsIngested"), 0)::int AS "rowsIngested"
      FROM "AmazonAdsReportJob" GROUP BY 1, 2 ORDER BY 3 DESC`), []),
    safe('export failures', async () => {
      const r = await prisma.$queryRawUnsafe<Array<{ n: number }>>(`
        SELECT COUNT(*)::int AS n FROM "AmazonAdsExportJob" WHERE "errorMessage" IS NOT NULL`)
      return Number(r[0]?.n ?? 0)
    }, 0),
    safe('data kiosk jobs', async () => {
      const r = await prisma.$queryRawUnsafe<Array<{ n: number }>>(`
        SELECT COUNT(*)::int AS n FROM "DataKioskQueryJob"`)
      return Number(r[0]?.n ?? 0)
    }, 0),
  ])

  const ebayEconomicsStatus = await safe('ebay economics status', () =>
    prisma.$queryRawUnsafe<Array<{ status: string; rows: number }>>(`
      SELECT COALESCE("dataStatus", 'UNKNOWN') AS status, COUNT(*)::int AS rows
      FROM "EbayListingEconomics" GROUP BY 1 ORDER BY 2 DESC`), [])

  // Collapse the campaign census to enabled / paused / other per ad product.
  const census = new Map<string, { adProduct: string; enabled: number; paused: number; other: number }>()
  for (const row of campaigns) {
    const key = row.adProduct ?? 'UNKNOWN'
    const entry = census.get(key) ?? { adProduct: key, enabled: 0, paused: 0, other: 0 }
    const n = Number(row.n) || 0
    if (row.status === 'ENABLED') entry.enabled += n
    else if (row.status === 'PAUSED') entry.paused += n
    else entry.other += n
    census.set(key, entry)
  }

  return {
    asOf: new Date().toISOString(),
    reports: {
      campaign: dailyWhere((r) => r.bucket === 'CAMPAIGN'),
      'advertised-product': dailyWhere((r) => r.bucket === 'PRODUCT_AD'),
      targeting: dailyWhere((r) => r.bucket === 'AD_TARGET'),
      'ad-group': dailyWhere((r) => r.bucket === 'AD_GROUP'),
      'sb-sd': dailyWhere((r) => SPONSORED.has(r.adProduct)),
      'search-term': fold(searchTerm),
      placement: fold(placement),
      hourly: fold(hourly),
      sqp: fold(sqp),
      'brand-metrics': fold(brand),
      economics: fold(economics),
      'ebay-economics': fold(ebayEcon),
    },
    campaigns: [...census.values()].sort((a, b) => b.enabled + b.paused - (a.enabled + a.paused)),
    ebayEconomicsStatus: ebayEconomicsStatus.map((r) => ({ status: r.status, rows: Number(r.rows) || 0 })),
    pipeline: {
      reportJobs,
      reportTypes,
      exportJobFailures: Number(exportFailures) || 0,
      dataKioskJobs: Number(kioskJobs) || 0,
    },
    warnings,
  }
}
