/**
 * Apex E.1 — Brand Analytics Search Query Performance (SQP) ingest + probe.
 *
 * Competitive intel: for each search query, the WHOLE-MARKET counts vs OUR
 * brand's counts at each funnel stage (impressions → clicks → cart-adds →
 * purchases), so we know our SHARE of the query and where competitors beat us.
 * Pulled from SP-API Brand Analytics (request → poll → download, reusing
 * fetchSpApiJsonReport) and upserted into SearchQueryPerformance.
 *
 * Two unknowns are handled honestly: (1) Brand Analytics ACCESS may not be
 * granted on the account → probeSqpAccess() resolves that before we rely on it;
 * (2) the SQP report FIELD SHAPE varies / isn't reliably documented → parseSqp
 * is defensive (tries common field names) + logs a raw sample so we can tighten
 * it against the first real report. Both mirror the C.1 bid-rec approach.
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { fetchSpApiJsonReport } from '../sp-api-reports.service.js'

export const SQP_REPORT_TYPE = process.env.NEXUS_SQP_REPORT_TYPE || 'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT'
export type SqpPeriod = 'WEEK' | 'MONTH' | 'QUARTER'
// How many completed periods back to request. SQP data for the just-finished
// period isn't queryable for a few days, so default to 2 (env-overridable).
const SQP_LOOKBACK = Math.max(1, Number(process.env.NEXUS_SQP_LOOKBACK) || 2)

export interface SqpRow {
  searchQuery: string
  asin: string | null
  searchQueryVolume: number
  searchQueryRank: number | null
  impressionsTotal: number; impressionsBrand: number
  clicksTotal: number; clicksBrand: number
  cartAddsTotal: number; cartAddsBrand: number
  purchasesTotal: number; purchasesBrand: number
}

function num(v: unknown): number { const n = Number(v); return Number.isFinite(n) ? n : 0 }

/**
 * SQP requires the data window to align to a COMPLETED reporting period —
 * Amazon weeks are Sunday→Saturday; an arbitrary range yields a FATAL report.
 * Returns the most recently completed period (offset full periods back via
 * `lookback`, default 1 = the latest finished one). `end` is the INCLUSIVE last
 * day of the period — SQP requires dataEndTime to be the period's last day
 * (a Saturday for WEEK; month-end / quarter-end otherwise), not the next
 * period's start. Pure + unit-tested.
 */
export function periodWindow(period: SqpPeriod, now: Date, lookback = 1): { start: Date; end: Date } {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  if (period === 'WEEK') {
    // Current (in-progress) week's Sunday, then step back `lookback` weeks.
    const sunday = new Date(d); sunday.setUTCDate(d.getUTCDate() - d.getUTCDay())
    const start = new Date(sunday); start.setUTCDate(sunday.getUTCDate() - 7 * lookback)
    const end = new Date(start); end.setUTCDate(start.getUTCDate() + 6) // Saturday (inclusive)
    return { start, end }
  }
  if (period === 'MONTH') {
    const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - lookback, 1))
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)) // last day of month
    return { start, end }
  }
  // QUARTER
  const q = Math.floor(d.getUTCMonth() / 3) - lookback
  const start = new Date(Date.UTC(d.getUTCFullYear(), q * 3, 1))
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 3, 0)) // last day of quarter
  return { start, end }
}
/** Brand share of a funnel stage, clamped to [0,1]. Pure. */
export function share(brand: number, total: number): number { return total > 0 ? Math.max(0, Math.min(1, brand / total)) : 0 }

/**
 * Defensively map an SQP report payload to flat rows. The report nests counts
 * under per-stage objects with brandCount/totalCount (or asinCount); field names
 * differ across report versions, so we try the common spellings and fall back to
 * 0. Pure + unit-tested.
 */
export function parseSqp(payload: unknown): SqpRow[] {
  const root = (payload ?? {}) as Record<string, unknown>
  const rowsRaw =
    (root.dataByDepartmentAndSearchQuery as unknown[]) ??
    (root.dataByAsin as unknown[]) ??
    (root.searchQueryPerformanceData as unknown[]) ??
    (root.records as unknown[]) ??
    (Array.isArray(payload) ? (payload as unknown[]) : [])
  if (!Array.isArray(rowsRaw)) return []
  const out: SqpRow[] = []
  for (const raw of rowsRaw) {
    const r = (raw ?? {}) as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
    const sqd = (r.searchQueryData ?? {}) as Record<string, unknown>
    const sq = r.searchQuery ?? r.search_query ?? r.query ?? sqd.searchQuery
    if (!sq) continue
    const imp = (r.impressionData ?? r.impressions ?? {}) as Record<string, unknown>
    const clk = (r.clickData ?? r.clicks ?? {}) as Record<string, unknown>
    const cart = (r.cartAddData ?? r.cartAdds ?? {}) as Record<string, unknown>
    const pur = (r.purchaseData ?? r.purchases ?? {}) as Record<string, unknown>
    out.push({
      searchQuery: String(sq),
      asin: (r.asin ?? r.childAsin ?? r.parentAsin ?? null) as string | null,
      searchQueryVolume: num(r.searchQueryVolume ?? sqd.searchQueryVolume),
      searchQueryRank: r.searchQueryScore != null ? num(r.searchQueryScore) : sqd.searchQueryScore != null ? num(sqd.searchQueryScore) : null,
      impressionsTotal: num(imp.totalCount ?? imp.totalQueryImpressionCount ?? imp.total),
      impressionsBrand: num(imp.brandCount ?? imp.asinCount ?? imp.brand),
      clicksTotal: num(clk.totalCount ?? clk.totalClickCount ?? clk.total),
      clicksBrand: num(clk.brandCount ?? clk.asinCount ?? clk.brand),
      cartAddsTotal: num(cart.totalCount ?? cart.totalCartAddCount ?? cart.total),
      cartAddsBrand: num(cart.brandCount ?? cart.asinCount ?? cart.brand),
      purchasesTotal: num(pur.totalCount ?? pur.totalPurchaseCount ?? pur.total),
      purchasesBrand: num(pur.brandCount ?? pur.asinCount ?? pur.brand),
    })
  }
  return out
}

async function resolveMarketplaceId(code: string): Promise<string | null> {
  const row = await prisma.marketplace.findUnique({ where: { channel_code: { channel: 'AMAZON', code } } }).catch(() => null)
  return row?.marketplaceId ?? null
}

/**
 * Our Amazon ASINs for a marketplace — SQP is requested per ASIN. Prefers PARENT
 * ASINs (family-level, fewer reports) and falls back to the child/listing ASIN.
 * Active listings first; capped.
 */
export async function ourAsinsForMarketplace(marketplace: string, limit = 25): Promise<string[]> {
  const listings = await prisma.channelListing.findMany({
    where: { channel: 'AMAZON', OR: [{ marketplace }, { region: marketplace }] },
    select: { externalParentId: true, externalListingId: true, listingStatus: true },
    orderBy: { listingStatus: 'asc' }, // ACTIVE sorts before others alphabetically? keep stable; we de-dup below
    take: 1000,
  })
  const asins: string[] = []
  const seen = new Set<string>()
  // Active listings first so a small limit covers what's actually selling.
  const ordered = [...listings].sort((a, b) => (a.listingStatus === 'ACTIVE' ? -1 : 1) - (b.listingStatus === 'ACTIVE' ? -1 : 1))
  for (const l of ordered) {
    const asin = l.externalParentId || l.externalListingId
    if (asin && !seen.has(asin)) { seen.add(asin); asins.push(asin) }
    if (asins.length >= limit) break
  }
  return asins
}

export interface SqpProbeResult { available: boolean; reportType: string; marketplace: string; detail: string }

/**
 * Resolve THE gating unknown: does this account have Brand Analytics SQP access?
 * Requests a tiny SQP report; an auth/permission error (401/403/"not authorized"
 * / "access") → not available. Anything else (incl. an empty report) → available.
 */
export async function probeSqpAccess(marketplaceCode: string, period: SqpPeriod = 'WEEK'): Promise<SqpProbeResult> {
  const marketplaceId = await resolveMarketplaceId(marketplaceCode)
  if (!marketplaceId) return { available: false, reportType: SQP_REPORT_TYPE, marketplace: marketplaceCode, detail: `no Marketplace row for AMAZON:${marketplaceCode}` }
  // SQP is ASIN-level — pick one of our ASINs to test against.
  const asin = (await ourAsinsForMarketplace(marketplaceCode, 1))[0]
  if (!asin) return { available: false, reportType: SQP_REPORT_TYPE, marketplace: marketplaceCode, detail: `no Amazon ASIN found for ${marketplaceCode} (ChannelListing externalParentId/externalListingId)` }
  const { start, end } = periodWindow(period, new Date(), SQP_LOOKBACK)
  try {
    await fetchSpApiJsonReport({ reportType: SQP_REPORT_TYPE, marketplaceId, dataStartTime: start, dataEndTime: end, reportOptions: { reportPeriod: period, asin } })
    return { available: true, reportType: SQP_REPORT_TYPE, marketplace: marketplaceCode, detail: 'report request accepted' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const denied = /401|403|unauthori|not authori|access|forbidden|brand/i.test(msg)
    return { available: !denied, reportType: SQP_REPORT_TYPE, marketplace: marketplaceCode, detail: msg.slice(0, 300) }
  }
}

export interface SqpIngestResult { marketplace: string; period: SqpPeriod; startDate: string; asinsRequested: number; rows: number; upserted: number; failedAsins: number }

/**
 * SQP is per-ASIN, so we request one report per ASIN and store its query rows
 * scoped to that ASIN. `asins` pins the set; otherwise the top-N of our ASINs
 * for the marketplace (per-ASIN reports are slow + rate-limited, so keep the
 * batch bounded — the cron cycles coverage over days).
 */
export async function ingestSqp(args: { marketplaceCode: string; period?: SqpPeriod; asins?: string[]; limit?: number; startDate?: Date; endDate?: Date }): Promise<SqpIngestResult> {
  const period = args.period ?? 'WEEK'
  const marketplaceId = await resolveMarketplaceId(args.marketplaceCode)
  if (!marketplaceId) throw new Error(`ingestSqp: no Marketplace row for AMAZON:${args.marketplaceCode}`)
  const asins = args.asins?.length ? args.asins : await ourAsinsForMarketplace(args.marketplaceCode, args.limit ?? 10)
  if (asins.length === 0) throw new Error(`ingestSqp: no Amazon ASINs for ${args.marketplaceCode}`)
  const win = periodWindow(period, new Date(), SQP_LOOKBACK)
  const start = args.startDate ?? win.start
  const end = args.endDate ?? win.end
  const startDateOnly = new Date(start); startDateOnly.setUTCHours(0, 0, 0, 0)

  let totalRows = 0
  let upserted = 0
  let failedAsins = 0
  let loggedSample = false
  for (const asin of asins) {
    let payload: object
    let reportId: string
    try {
      const r = await fetchSpApiJsonReport<object>({ reportType: SQP_REPORT_TYPE, marketplaceId, dataStartTime: start, dataEndTime: end, reportOptions: { reportPeriod: period, asin } })
      payload = r.payload; reportId = r.reportId
    } catch (err) {
      failedAsins += 1
      logger.warn('[sqp] asin report failed', { marketplace: args.marketplaceCode, asin, error: err instanceof Error ? err.message : String(err) })
      continue
    }
    const rows = parseSqp(payload)
    if (rows.length === 0 && !loggedSample) {
      loggedSample = true
      logger.info('[sqp] empty/unrecognised payload — sample logged for parser tuning', { marketplace: args.marketplaceCode, asin, sample: JSON.stringify(payload)?.slice(0, 800) })
    }
    totalRows += rows.length
    for (const row of rows) {
      const a = row.asin || asin // report is scoped to this asin; trust it if the row omits it
      await prisma.searchQueryPerformance.upsert({
        where: { marketplace_reportPeriod_startDate_searchQuery_asin: { marketplace: args.marketplaceCode, reportPeriod: period, startDate: startDateOnly, searchQuery: row.searchQuery, asin: a } },
        create: {
          marketplace: args.marketplaceCode, reportPeriod: period, startDate: startDateOnly,
          searchQuery: row.searchQuery, asin: a,
          searchQueryVolume: row.searchQueryVolume, searchQueryRank: row.searchQueryRank,
          impressionsTotal: row.impressionsTotal, impressionsBrand: row.impressionsBrand, impressionShare: share(row.impressionsBrand, row.impressionsTotal),
          clicksTotal: row.clicksTotal, clicksBrand: row.clicksBrand, clickShare: share(row.clicksBrand, row.clicksTotal),
          cartAddsTotal: row.cartAddsTotal, cartAddsBrand: row.cartAddsBrand, cartAddShare: share(row.cartAddsBrand, row.cartAddsTotal),
          purchasesTotal: row.purchasesTotal, purchasesBrand: row.purchasesBrand, purchaseShare: share(row.purchasesBrand, row.purchasesTotal),
          sourceReportId: reportId,
        },
        update: {
          searchQueryVolume: row.searchQueryVolume, searchQueryRank: row.searchQueryRank,
          impressionsTotal: row.impressionsTotal, impressionsBrand: row.impressionsBrand, impressionShare: share(row.impressionsBrand, row.impressionsTotal),
          clicksTotal: row.clicksTotal, clicksBrand: row.clicksBrand, clickShare: share(row.clicksBrand, row.clicksTotal),
          cartAddsTotal: row.cartAddsTotal, cartAddsBrand: row.cartAddsBrand, cartAddShare: share(row.cartAddsBrand, row.cartAddsTotal),
          purchasesTotal: row.purchasesTotal, purchasesBrand: row.purchasesBrand, purchaseShare: share(row.purchasesBrand, row.purchasesTotal),
          sourceReportId: reportId,
        },
      })
      upserted += 1
    }
  }
  return { marketplace: args.marketplaceCode, period, startDate: startDateOnly.toISOString().slice(0, 10), asinsRequested: asins.length, rows: totalRows, upserted, failedAsins }
}
