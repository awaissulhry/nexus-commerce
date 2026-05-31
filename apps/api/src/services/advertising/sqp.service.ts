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

export interface SqpProbeResult { available: boolean; reportType: string; marketplace: string; detail: string }

/**
 * Resolve THE gating unknown: does this account have Brand Analytics SQP access?
 * Requests a tiny SQP report; an auth/permission error (401/403/"not authorized"
 * / "access") → not available. Anything else (incl. an empty report) → available.
 */
export async function probeSqpAccess(marketplaceCode: string, period: SqpPeriod = 'WEEK'): Promise<SqpProbeResult> {
  const marketplaceId = await resolveMarketplaceId(marketplaceCode)
  if (!marketplaceId) return { available: false, reportType: SQP_REPORT_TYPE, marketplace: marketplaceCode, detail: `no Marketplace row for AMAZON:${marketplaceCode}` }
  const end = new Date(); end.setUTCHours(0, 0, 0, 0)
  const start = new Date(end); start.setUTCDate(start.getUTCDate() - 8)
  try {
    await fetchSpApiJsonReport({ reportType: SQP_REPORT_TYPE, marketplaceId, dataStartTime: start, dataEndTime: end, reportOptions: { reportPeriod: period } })
    return { available: true, reportType: SQP_REPORT_TYPE, marketplace: marketplaceCode, detail: 'report request accepted' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const denied = /401|403|unauthori|not authori|access|forbidden|brand/i.test(msg)
    return { available: !denied, reportType: SQP_REPORT_TYPE, marketplace: marketplaceCode, detail: msg.slice(0, 300) }
  }
}

export interface SqpIngestResult { marketplace: string; period: SqpPeriod; startDate: string; rows: number; upserted: number }

export async function ingestSqp(args: { marketplaceCode: string; period?: SqpPeriod; startDate?: Date; endDate?: Date }): Promise<SqpIngestResult> {
  const period = args.period ?? 'WEEK'
  const marketplaceId = await resolveMarketplaceId(args.marketplaceCode)
  if (!marketplaceId) throw new Error(`ingestSqp: no Marketplace row for AMAZON:${args.marketplaceCode}`)
  const end = args.endDate ?? (() => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d })()
  const start = args.startDate ?? (() => { const d = new Date(end); d.setUTCDate(d.getUTCDate() - (period === 'MONTH' ? 31 : period === 'QUARTER' ? 92 : 8)); return d })()

  const { payload, reportId } = await fetchSpApiJsonReport<object>({ reportType: SQP_REPORT_TYPE, marketplaceId, dataStartTime: start, dataEndTime: end, reportOptions: { reportPeriod: period } })
    .then((r) => ({ payload: r.payload, reportId: r.reportId }))
  const rows = parseSqp(payload)
  if (rows.length === 0) {
    logger.info('[sqp] empty/unrecognised payload — sample logged for parser tuning', { marketplace: args.marketplaceCode, sample: JSON.stringify(payload)?.slice(0, 600) })
  }
  const startDateOnly = new Date(start); startDateOnly.setUTCHours(0, 0, 0, 0)
  let upserted = 0
  for (const row of rows) {
    await prisma.searchQueryPerformance.upsert({
      where: { marketplace_reportPeriod_startDate_searchQuery_asin: { marketplace: args.marketplaceCode, reportPeriod: period, startDate: startDateOnly, searchQuery: row.searchQuery, asin: row.asin } },
      create: {
        marketplace: args.marketplaceCode, reportPeriod: period, startDate: startDateOnly,
        searchQuery: row.searchQuery, asin: row.asin,
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
  return { marketplace: args.marketplaceCode, period, startDate: startDateOnly.toISOString().slice(0, 10), rows: rows.length, upserted }
}
