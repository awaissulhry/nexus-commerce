/**
 * AX.12 — Amazon Marketing Stream (AMS) ingest.
 *
 * AMS pushes near-real-time HOURLY performance (sp-traffic + sp-conversion
 * datasets) to a subscriber's AWS Firehose → endpoint, vs Seller Central's
 * once-daily reports. This is the genuine edge: hourly data powers intraday
 * bid moves + accurate dayparting (AX.8/AX.9).
 *
 * This service ingests delivered AMS messages into AmazonAdsDailyPerformance
 * (accumulated at day grain, reusing existing infra — no new table). The
 * LIVE feed requires the operator to create an AMS subscription via the Ads
 * API pointing at their AWS resources (see docs/MARKETING-OS.md); until
 * then this endpoint simply has nothing pushed to it. Sandbox/manual posts
 * exercise it end-to-end.
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'

interface AmsTrafficMsg { dataset_id?: string; marketplace_id?: string; currency?: string; campaign_id?: string; profileId?: string; time_window_start?: string; impressions?: number; clicks?: number; cost?: number }
interface AmsConversionMsg { dataset_id?: string; campaign_id?: string; profileId?: string; time_window_start?: string; attributed_sales_1d?: number; attributed_conversions_1d?: number; attributed_units_ordered_1d?: number }
export type AmsMessage = AmsTrafficMsg & AmsConversionMsg & { marketplace?: string }

export interface AmsIngestResult { received: number; upserted: number; skipped: number }

/** Ingest a batch of AMS messages. Idempotent-ish: accumulates into the
 *  (profile, adProduct=SP, CAMPAIGN, campaign_id, day) daily row. */
export async function ingestMarketingStream(messages: AmsMessage[]): Promise<AmsIngestResult> {
  const result: AmsIngestResult = { received: messages.length, upserted: 0, skipped: 0 }
  for (const m of messages) {
    const campaignId = m.campaign_id
    const profileId = m.profileId ?? 'ams'
    const tw = m.time_window_start ? new Date(m.time_window_start) : new Date()
    if (!campaignId || Number.isNaN(tw.getTime())) { result.skipped++; continue }
    const date = new Date(Date.UTC(tw.getUTCFullYear(), tw.getUTCMonth(), tw.getUTCDate()))
    const marketplace = m.marketplace ?? m.marketplace_id ?? 'IT'
    const isTraffic = m.impressions != null || m.clicks != null || m.cost != null
    const costMicros = m.cost != null ? BigInt(Math.round(m.cost * 1_000_000)) : 0n
    try {
      await prisma.amazonAdsDailyPerformance.upsert({
        where: { profileId_adProduct_entityType_entityId_date: { profileId, adProduct: 'SPONSORED_PRODUCTS', entityType: 'CAMPAIGN', entityId: campaignId, date } },
        create: {
          profileId, marketplace, adProduct: 'SPONSORED_PRODUCTS', date, entityType: 'CAMPAIGN', entityId: campaignId,
          impressions: m.impressions ?? 0, clicks: m.clicks ?? 0, costMicros, currencyCode: m.currency ?? 'EUR',
          sales7dCents: m.attributed_sales_1d != null ? Math.round(m.attributed_sales_1d * 100) : 0,
          orders7d: m.attributed_conversions_1d ?? 0, units7d: m.attributed_units_ordered_1d ?? 0,
          reportRunId: 'ams-stream', reportedAt: new Date(),
        },
        update: isTraffic
          ? { impressions: { increment: m.impressions ?? 0 }, clicks: { increment: m.clicks ?? 0 }, costMicros: { increment: costMicros }, reportedAt: new Date() }
          : { sales7dCents: { increment: m.attributed_sales_1d != null ? Math.round(m.attributed_sales_1d * 100) : 0 }, orders7d: { increment: m.attributed_conversions_1d ?? 0 }, units7d: { increment: m.attributed_units_ordered_1d ?? 0 }, reportedAt: new Date() },
      })
      result.upserted++
    } catch (e) { logger.warn('[AX.12] AMS ingest row failed', { campaignId, error: (e as Error).message }); result.skipped++ }
  }
  logger.info('[AX.12] AMS ingest', result)
  return result
}
