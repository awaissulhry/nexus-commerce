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

import { randomUUID } from 'node:crypto'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { liveCall, adsMode, type AdsRegion } from './ads-api-client.js'

// AME.9 — the AWS destination Amazon pushes AMS messages to (an SQS queue ARN
// or a Firehose delivery-stream ARN the operator provisions + grants Amazon
// access to). Until this is set, subscriptions cannot be created and the live
// feed stays dormant (the ingest endpoint simply receives nothing).
const AMS_DESTINATION_ARN = process.env.NEXUS_AMS_DESTINATION_ARN || ''

// AMS performance datasets — *-traffic = impressions/clicks/cost by hour,
// *-conversion = attributed sales/orders. SP/SD/SB share the same message
// shape; only the dataset_id (→ ad product) differs. Budget-usage + entity
// change-streams (campaigns/adgroups/ads/targets) have DIFFERENT shapes and
// are intentionally NOT subscribed here yet (they need dedicated ingest).
export const AMS_DATASETS = [
  'sp-traffic', 'sp-conversion',
  'sd-traffic', 'sd-conversion',
  'sb-traffic', 'sb-conversion',
] as const
export type AmsDataset = (typeof AMS_DATASETS)[number]

/** Map an AMS dataset_id to our ad-product enum. Returns 'SKIP' for datasets
 *  this performance-ingest doesn't model (budget-usage, entity streams, …) so
 *  an unexpected message is dropped cleanly instead of polluting metrics.
 *  Null = no dataset_id supplied → treat as legacy SP (back-compat). */
function adProductFromDataset(ds?: string): 'SPONSORED_PRODUCTS' | 'SPONSORED_DISPLAY' | 'SPONSORED_BRANDS' | 'SKIP' | null {
  if (!ds) return null
  const d = ds.toLowerCase()
  const isPerf = d.includes('traffic') || d.includes('conversion')
  if (!isPerf) return 'SKIP'
  if (d.startsWith('sp-')) return 'SPONSORED_PRODUCTS'
  if (d.startsWith('sd-')) return 'SPONSORED_DISPLAY'
  if (d.startsWith('sb-')) return 'SPONSORED_BRANDS'
  return 'SKIP'
}

export interface AmsSubscriptionInput { profileId: string; region: AdsRegion; dataSetId: string; destinationArn?: string; notes?: string }

/**
 * Create an Amazon Marketing Stream subscription for a dataset, pointing at the
 * operator's AWS destination. Idempotency is the caller's responsibility (list
 * first). Sandbox mode is a no-op so the flow is exercisable without AWS.
 */
export async function createAmsSubscription(input: AmsSubscriptionInput): Promise<unknown> {
  const arn = input.destinationArn || AMS_DESTINATION_ARN
  if (!arn) throw new Error('No AMS destination ARN configured — set NEXUS_AMS_DESTINATION_ARN (SQS/Firehose ARN) or pass destinationArn.')
  if (adsMode() === 'sandbox') return { sandbox: true, dataSetId: input.dataSetId, destinationArn: arn, status: 'SANDBOX_NOOP' }
  return liveCall({
    profileId: input.profileId,
    region: input.region,
    method: 'POST',
    path: '/streams/subscriptions',
    // clientRequestToken — Amazon requires this idempotency token (a unique
    // UUID per create). Without it the API 400s "Value null at clientRequestToken".
    body: { dataSetId: input.dataSetId, destinationArn: arn, clientRequestToken: randomUUID(), notes: input.notes ?? 'Nexus AMS subscription' },
  })
}

export async function listAmsSubscriptions(profileId: string, region: AdsRegion): Promise<unknown> {
  if (adsMode() === 'sandbox') return { subscriptions: [] }
  return liveCall({ profileId, region, method: 'GET', path: '/streams/subscriptions' })
}

export async function deleteAmsSubscription(profileId: string, region: AdsRegion, subscriptionId: string): Promise<unknown> {
  if (adsMode() === 'sandbox') return { sandbox: true, subscriptionId }
  return liveCall({ profileId, region, method: 'DELETE', path: `/streams/subscriptions/${encodeURIComponent(subscriptionId)}` })
}

/** Health: is AMS configured, and is hourly data actually flowing in? */
export async function amsStatus(): Promise<{ configured: boolean; mode: string; hourlyRows: number; lastReportedAt: Date | null; lastDate: Date | null }> {
  const agg = await prisma.amazonAdsHourlyPerformance.aggregate({ _count: { _all: true }, _max: { reportedAt: true, date: true } }).catch(() => null)
  return {
    configured: !!AMS_DESTINATION_ARN,
    mode: adsMode(),
    hourlyRows: agg?._count._all ?? 0,
    lastReportedAt: agg?._max.reportedAt ?? null,
    lastDate: agg?._max.date ?? null,
  }
}

interface AmsTrafficMsg { dataset_id?: string; marketplace_id?: string; currency?: string; campaign_id?: string; profileId?: string; time_window_start?: string; impressions?: number; clicks?: number; cost?: number }
interface AmsConversionMsg { dataset_id?: string; campaign_id?: string; profileId?: string; time_window_start?: string; attributed_sales_1d?: number; attributed_conversions_1d?: number; attributed_units_ordered_1d?: number }
export type AmsMessage = AmsTrafficMsg & AmsConversionMsg & { marketplace?: string }

export interface AmsIngestResult { received: number; upserted: number; skipped: number }

// Diagnostic ring buffer — the last few raw messages + ingest results seen, so
// we can confirm the real AMS field shape once data flows (the ingest field
// mapping was written speculatively). In-memory, best-effort.
const _amsDebug: { samples: unknown[]; lastResult: AmsIngestResult | null; lastAt: string | null } = { samples: [], lastResult: null, lastAt: null }
export function amsDebugSnapshot() { return _amsDebug }

/** Ingest a batch of AMS messages. Idempotent-ish: accumulates into the
 *  (profile, adProduct=SP, CAMPAIGN, campaign_id, day) daily row. */
export async function ingestMarketingStream(messages: AmsMessage[]): Promise<AmsIngestResult> {
  const result: AmsIngestResult = { received: messages.length, upserted: 0, skipped: 0 }
  // Capture a couple of raw samples for diagnostics (cap 5).
  try { if (messages.length) { _amsDebug.samples = [...messages.slice(0, 5)]; _amsDebug.lastAt = new Date().toISOString() } } catch { /* ignore */ }
  // CD.11 — resolve local Campaign.id per (externalCampaignId, marketplace)
  // once so hourly rows carry localEntityId for cheap indexed campaign-scoped
  // reads (dayparting). Cached across the batch.
  const localIdCache = new Map<string, string | null>()
  const resolveLocalId = async (extId: string, marketplace: string): Promise<string | null> => {
    void marketplace // AF.1d — resolve by externalCampaignId alone (representation-agnostic)
    const key = extId
    if (localIdCache.has(key)) return localIdCache.get(key)!
    const c = await prisma.campaign.findFirst({ where: { externalCampaignId: extId }, select: { id: true } }).catch(() => null)
    const id = c?.id ?? null
    localIdCache.set(key, id)
    return id
  }
  for (const m of messages) {
    const ap = adProductFromDataset(m.dataset_id)
    if (ap === 'SKIP') { result.skipped++; continue }
    const adProduct = ap ?? 'SPONSORED_PRODUCTS'
    const campaignId = m.campaign_id
    const profileId = m.profileId ?? 'ams'
    const tw = m.time_window_start ? new Date(m.time_window_start) : new Date()
    if (!campaignId || Number.isNaN(tw.getTime())) { result.skipped++; continue }
    const date = new Date(Date.UTC(tw.getUTCFullYear(), tw.getUTCMonth(), tw.getUTCDate()))
    const hour = tw.getUTCHours()
    const marketplace = m.marketplace ?? m.marketplace_id ?? 'IT'
    const isTraffic = m.impressions != null || m.clicks != null || m.cost != null
    const costMicros = m.cost != null ? BigInt(Math.round(m.cost * 1_000_000)) : 0n
    const salesCents = m.attributed_sales_1d != null ? Math.round(m.attributed_sales_1d * 100) : 0
    try {
      await prisma.amazonAdsDailyPerformance.upsert({
        where: { profileId_adProduct_entityType_entityId_date: { profileId, adProduct, entityType: 'CAMPAIGN', entityId: campaignId, date } },
        create: {
          profileId, marketplace, adProduct, date, entityType: 'CAMPAIGN', entityId: campaignId,
          impressions: m.impressions ?? 0, clicks: m.clicks ?? 0, costMicros, currencyCode: m.currency ?? 'EUR',
          sales7dCents: salesCents,
          orders7d: m.attributed_conversions_1d ?? 0, units7d: m.attributed_units_ordered_1d ?? 0,
          reportRunId: 'ams-stream', reportedAt: new Date(),
        },
        update: isTraffic
          ? { impressions: { increment: m.impressions ?? 0 }, clicks: { increment: m.clicks ?? 0 }, costMicros: { increment: costMicros }, reportedAt: new Date() }
          : { sales7dCents: { increment: salesCents }, orders7d: { increment: m.attributed_conversions_1d ?? 0 }, units7d: { increment: m.attributed_units_ordered_1d ?? 0 }, reportedAt: new Date() },
      })
      // CD.11 — also write the hourly row (the genuine AMS edge: hour grain).
      const localEntityId = await resolveLocalId(campaignId, marketplace)
      await prisma.amazonAdsHourlyPerformance.upsert({
        where: { profileId_adProduct_entityType_entityId_date_hour: { profileId, adProduct, entityType: 'CAMPAIGN', entityId: campaignId, date, hour } },
        create: {
          profileId, marketplace, adProduct, date, hour, entityType: 'CAMPAIGN', entityId: campaignId, localEntityId,
          impressions: m.impressions ?? 0, clicks: m.clicks ?? 0, costMicros, currencyCode: m.currency ?? 'EUR',
          sales7dCents: salesCents, orders7d: m.attributed_conversions_1d ?? 0, units7d: m.attributed_units_ordered_1d ?? 0,
          reportRunId: 'ams-stream', reportedAt: new Date(),
        },
        update: isTraffic
          ? { impressions: { increment: m.impressions ?? 0 }, clicks: { increment: m.clicks ?? 0 }, costMicros: { increment: costMicros }, reportedAt: new Date(), ...(localEntityId ? { localEntityId } : {}) }
          : { sales7dCents: { increment: salesCents }, orders7d: { increment: m.attributed_conversions_1d ?? 0 }, units7d: { increment: m.attributed_units_ordered_1d ?? 0 }, reportedAt: new Date(), ...(localEntityId ? { localEntityId } : {}) },
      })
      result.upserted++
    } catch (e) { logger.warn('[AX.12] AMS ingest row failed', { campaignId, error: (e as Error).message }); result.skipped++ }
  }
  logger.info('[AX.12] AMS ingest', result)
  _amsDebug.lastResult = result
  return result
}
