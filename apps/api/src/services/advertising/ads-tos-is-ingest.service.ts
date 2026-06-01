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

  const conns = await prisma.amazonAdsConnection.findMany({ where: { isActive: true }, select: { profileId: true, region: true } })
  const out: TosIsIngestResult = { profiles: conns.length, rowsFetched: 0, withIS: 0, rowsUpdated: 0, sample: [], errors: [] }

  for (const conn of conns) {
    const ctx: ClientContext = { profileId: conn.profileId, region: conn.region as ClientContext['region'] }
    let rows: unknown[]
    try {
      rows = (await fetchReport(ctx, { reportType: 'campaigns', startDate: fmt(start), endDate: fmt(end), extraColumns: ['topOfSearchImpressionShare'] })) as unknown[]
    } catch (e) {
      out.errors.push(`${conn.profileId}: ${(e as Error).message}`)
      continue
    }
    for (const raw of rows) {
      out.rowsFetched++
      const r = raw as Record<string, unknown>
      const cid = String(r.campaignId ?? '')
      const dateStr = String(r.date ?? '').slice(0, 10)
      const v = r.topOfSearchImpressionShare
      if (!cid || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr) || v == null || v === '') continue
      const num = Number(v)
      if (!Number.isFinite(num) || num < 0) continue
      const frac = num > 1 ? num / 100 : num // Amazon may return % (12.34) or fraction (0.1234) — normalise to 0–1
      out.withIS++
      const res = await prisma.amazonAdsPlacementReport.updateMany({
        where: { campaignId: cid, date: new Date(dateStr), placement: TOP_REPORT_PLACEMENT },
        data: { topOfSearchIS: frac },
      })
      out.rowsUpdated += res.count
      if (out.sample.length < 5) out.sample.push({ campaignId: cid, date: dateStr, tosIS: Number(frac.toFixed(4)) })
    }
  }
  logger.info('[tos-is-ingest] done', { profiles: out.profiles, rowsFetched: out.rowsFetched, withIS: out.withIS, rowsUpdated: out.rowsUpdated, errors: out.errors.length })
  return out
}
