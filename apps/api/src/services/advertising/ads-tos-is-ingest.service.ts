/**
 * Option C — Top-of-Search impression-share ingestion (isolated).
 *
 * Fetches Amazon's true `topOfSearchImpressionShare` (a campaign-level metric of
 * the v3 spCampaigns report) and stores it on the TOP_OF_SEARCH row of
 * AmazonAdsPlacementReport (column topOfSearchIS, normalised to a 0–1 fraction).
 *
 * SAFETY — fully isolated from the main metrics ingestion: it issues its OWN
 * campaigns report with the extra column (opt-in `extraColumns`), so if Amazon
 * rejects the metric this fetch fails on its own and the core campaign / ad-group
 * / keyword ingestion is untouched. It only UPDATES existing TOP rows (never
 * creates), so it can't produce malformed placement rows. Read path for the loop:
 * defendTopOfSearch reads the same TOP rows.
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { fetchReport, type ClientContext } from './ads-api-client.js'

const TOP_REPORT_PLACEMENT = 'Top of Search on-Amazon'

export interface TosIsIngestResult {
  profiles: number
  rowsFetched: number
  withIS: number
  rowsUpdated: number
  sample: Array<{ campaignId: string; date: string; tosIS: number }>
  errors: string[]
}

export async function ingestTopOfSearchIS(opts: { windowDays?: number } = {}): Promise<TosIsIngestResult> {
  const windowDays = Math.max(1, Math.min(60, opts.windowDays ?? 7))
  const end = new Date()
  const start = new Date(); start.setUTCDate(start.getUTCDate() - windowDays)
  const fmt = (d: Date) => d.toISOString().slice(0, 10)

  const conns = await prisma.amazonAdsConnection.findMany({
    where: { isActive: true, ...(opts.marketplace ? { marketplace: opts.marketplace } : {}) },
    select: { profileId: true, region: true },
  })

  // Per-profile reports run in PARALLEL (each is an independent async report) so
  // total wall-clock ≈ the slowest single report, not the sum over all profiles.
  const perProfile = await Promise.all(conns.map(async (conn) => {
    const local = { rowsFetched: 0, withIS: 0, rowsUpdated: 0, sample: [] as TosIsIngestResult['sample'], error: null as string | null }
    const ctx: ClientContext = { profileId: conn.profileId, region: conn.region as ClientContext['region'] }
    let rows: unknown[]
    try {
      // Campaign group-by only allows campaign-level columns — request a clean
      // minimal set (the base set's adGroupId/keywordId/adId/orders* are rejected
      // by the campaigns report). topOfSearchImpressionShare confirmed allowed.
      rows = (await fetchReport(ctx, { reportType: 'campaigns', startDate: fmt(start), endDate: fmt(end), columnsOverride: ['date', 'campaignId', 'impressions', 'topOfSearchImpressionShare'] })) as unknown[]
    } catch (e) {
      local.error = `${conn.profileId}: ${(e as Error).message}`
      return local
    }
    for (const raw of rows) {
      local.rowsFetched++
      const r = raw as Record<string, unknown>
      const cid = String(r.campaignId ?? '')
      const dateStr = String(r.date ?? '').slice(0, 10)
      const v = r.topOfSearchImpressionShare
      if (!cid || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr) || v == null || v === '') continue
      const num = Number(v)
      if (!Number.isFinite(num) || num < 0) continue
      const frac = num > 1 ? num / 100 : num // Amazon may return % (12.34) or fraction (0.1234) — normalise to 0–1
      local.withIS++
      const res = await prisma.amazonAdsPlacementReport.updateMany({
        where: { campaignId: cid, date: new Date(dateStr), placement: TOP_REPORT_PLACEMENT },
        data: { topOfSearchIS: frac },
      })
      local.rowsUpdated += res.count
      if (local.sample.length < 3) local.sample.push({ campaignId: cid, date: dateStr, tosIS: Number(frac.toFixed(4)) })
    }
    return local
  }))

  const out: TosIsIngestResult = { profiles: conns.length, rowsFetched: 0, withIS: 0, rowsUpdated: 0, sample: [], errors: [] }
  for (const p of perProfile) {
    out.rowsFetched += p.rowsFetched; out.withIS += p.withIS; out.rowsUpdated += p.rowsUpdated
    if (p.error) out.errors.push(p.error)
    for (const s of p.sample) if (out.sample.length < 5) out.sample.push(s)
  }
  logger.info('[tos-is-ingest] done', { profiles: out.profiles, rowsFetched: out.rowsFetched, withIS: out.withIS, rowsUpdated: out.rowsUpdated, errors: out.errors.length })
  return out
}
