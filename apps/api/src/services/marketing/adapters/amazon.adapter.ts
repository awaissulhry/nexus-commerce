/**
 * Unified Marketing OS (UM-series, P2) — Amazon channel adapter.
 *
 * Read-only SHADOW in P2: pullCampaigns / pullMetrics source from the
 * already-synced local legacy tables (Campaign, AmazonAdsDailyPerformance)
 * — the shipped AD-series sync (ads-v1-sync / ads-reports) keeps those
 * current from Amazon, so the adapter never re-hits the API here. The
 * one-shot historical backfill (amazon-backfill.service) populates the new
 * MarketingCampaign tables from the same source.
 *
 * Writes (applyMutation / setBudget) throw until P5 wires the generalized
 * marketing-sync worker + write gate. The SigV4 constraint (Amazon v1
 * writes blocked → v3 SP batch PUT) will be encapsulated here in P5 and
 * never leaks above this seam.
 *
 * Mapping note: this normalization is mirrored by scripts/um2-amazon-
 * backfill.mjs (the standalone bulk migration). The two are kept in sync
 * deliberately — adapter = forward per-marketplace shadow sync; script =
 * one-shot historical bulk. See SURFACE_BY_TYPE / STATUS_MAP below.
 */

import type { Campaign, AmazonAdsDailyPerformance, MktSurface } from '@prisma/client'
import prisma from '../../../db.js'
import { logger } from '../../../utils/logger.js'
import {
  registerAdapter,
  type ChannelAdapter,
  type AdapterCtx,
  type AdapterCapabilities,
  type NormalizedCampaign,
  type NormalizedMetric,
  type NormalizedMutation,
  type MutationResult,
  type DateRange,
} from './types.js'

// Legacy CampaignType (SP|SB|SD) → MktSurface. type is non-null on
// Campaign so it's the reliable surface source; adProduct (which may
// carry SPONSORED_TELEVISION) is preserved on the detail row.
const SURFACE_BY_TYPE: Record<string, MktSurface> = {
  SP: 'SP',
  SB: 'SB',
  SD: 'SD',
}

// Legacy CampaignStatus → MktStatus.
const STATUS_MAP: Record<string, string> = {
  ENABLED: 'ACTIVE',
  PAUSED: 'PAUSED',
  ARCHIVED: 'ENDED',
  DRAFT: 'DRAFT',
}

const CAPABILITIES: AdapterCapabilities = {
  surfaces: ['SP', 'SB', 'SD'],
  supportsKeywords: true,
  supportsNegativeTargets: true,
  supportsAudiences: true, // SD audience targeting
  supportsLifetimeBudget: true, // SB/SD
  supportsDailyBudget: true,
  supportsMultiMarket: true, // v1 MULTI_MARKETPLACE budgets
  supportsBudgetRebalance: true,
}

/** Decimal-or-null → integer cents. */
function toCents(d: { toString(): string } | null | undefined): number | null {
  if (d == null) return null
  return Math.round(parseFloat(d.toString()) * 100)
}

/** Map a legacy Campaign row to the channel-agnostic shape. */
export function normalizeCampaign(c: Campaign): NormalizedCampaign {
  const surface = SURFACE_BY_TYPE[c.type] ?? 'SD'
  const marketplaces = [
    ...(c.marketplace ? [c.marketplace] : []),
    ...c.linkedMarketplaces.filter((m) => m !== c.marketplace),
  ]
  return {
    channel: 'AMAZON',
    surface,
    marketplace: c.marketplace ?? marketplaces[0] ?? 'IT',
    externalId: c.externalCampaignId ?? `legacy:${c.id}`,
    externalParentId: c.portfolioId,
    name: c.name,
    status: STATUS_MAP[c.status] ?? 'DRAFT',
    deliveryStatus: c.deliveryStatus,
    deliveryReasons: c.deliveryReasons,
    budgetCents: toCents(c.dailyBudget),
    budgetKind: 'DAILY',
    currency: c.dailyBudgetCurrency,
    detail: {
      legacyCampaignId: c.id,
      marketplaces,
      budgetScope: c.budgetScope === 'MULTI_MARKETPLACE' ? 'MULTI_MARKET' : 'SINGLE_MARKET',
      acos: c.acos?.toString() ?? null,
      roas: c.roas?.toString() ?? null,
      spendCents: toCents(c.spend) ?? 0,
      salesCents: toCents(c.sales) ?? 0,
      lastSyncedAt: c.lastSyncedAt,
      lastSyncStatus: c.lastSyncStatus,
      lastSyncError: c.lastSyncError,
      // → AmazonAdsCampaignDetail
      adProduct: c.adProduct ?? c.type,
      portfolioId: c.portfolioId,
      bidStrategyJson: c.bidStrategyJson,
      dynamicBidding: c.dynamicBidding,
      tactic: c.tactic,
      costType: c.costType,
      deliveryProfileNative: c.deliveryProfile,
      creativeAssetJson: c.creativeAssetJson,
      brandEntityId: c.brandEntityId,
    },
  }
}

/** Map a legacy daily-performance row to the unified metric shape. */
export function normalizeMetric(p: AmazonAdsDailyPerformance): NormalizedMetric {
  return {
    channel: 'AMAZON',
    marketplace: p.marketplace,
    date: p.date.toISOString().slice(0, 10),
    entityType: p.entityType,
    entityId: p.entityId,
    localEntityId: p.localEntityId,
    impressions: p.impressions,
    clicks: p.clicks,
    costMicros: p.costMicros,
    currencyCode: p.currencyCode,
    sales7dCents: p.sales7dCents,
    sales14dCents: p.sales14dCents,
    sales30dCents: p.sales30dCents,
    orders7d: p.orders7d,
    units7d: p.units7d,
    ntbOrders14d: p.ntbOrders14d,
    viewableImpressions: p.viewableImpressions,
    detailPageViews7d: p.detailPageViews7d,
    attributionModel: 'amazon-windowed',
    reportRunId: p.reportRunId,
    extra: null,
  }
}

class AmazonAdapter implements ChannelAdapter {
  readonly channel = 'AMAZON' as const
  readonly capabilities = CAPABILITIES

  /**
   * Shadow read: campaigns whose home (primary) marketplace is
   * ctx.marketplace, so multi-market campaigns are returned exactly once
   * (by their home market). The marketplaces[] list on the detail drives
   * per-market link creation.
   */
  async pullCampaigns(ctx: AdapterCtx): Promise<NormalizedCampaign[]> {
    const rows = await prisma.campaign.findMany({
      where: { marketplace: ctx.marketplace },
    })
    return rows.map(normalizeCampaign)
  }

  async pullMetrics(window: DateRange, ctx: AdapterCtx): Promise<NormalizedMetric[]> {
    const rows = await prisma.amazonAdsDailyPerformance.findMany({
      where: {
        marketplace: ctx.marketplace,
        date: { gte: new Date(window.start), lte: new Date(window.end) },
      },
    })
    return rows.map(normalizeMetric)
  }

  /**
   * P8 cutover — route unified writes through the SHIPPED live Amazon path
   * (ads-api-client.updateCampaign, which is itself sandbox-safe via
   * adsMode). Triple-gated: this only fires when the marketing write gate
   * already returned mode='live' (NEXUS_MARKETING_AMAZON_LIVE=1 + adsMode
   * live), AND here we additionally require an active production
   * AmazonAdsConnection with writesEnabledAt (the AD.4 two-key). Any miss →
   * sandbox-style success (no external write).
   */
  async applyMutation(mutation: NormalizedMutation, ctx: AdapterCtx): Promise<MutationResult> {
    const conn = await prisma.amazonAdsConnection.findFirst({
      where: { marketplace: ctx.marketplace, isActive: true },
      select: { profileId: true, region: true, mode: true, writesEnabledAt: true },
    })
    const writeReady = conn && conn.mode === 'production' && conn.writesEnabledAt != null
    if (!writeReady || !mutation.externalId) {
      logger.info('[UM][AMAZON] write not ready — sandbox no-op', { marketplace: ctx.marketplace, hasConn: !!conn })
      return { ok: true, status: 'SUCCESS', externalId: mutation.externalId ?? null, wouldChange: mutation.payload }
    }

    const { updateCampaign } = await import('../../advertising/ads-api-client.js')
    const patch: { state?: 'enabled' | 'paused' | 'archived'; dailyBudget?: number } = {}
    if (mutation.syncType === 'MKT_STATE_UPDATE') {
      const s = mutation.payload.status as string
      patch.state = s === 'ACTIVE' ? 'enabled' : s === 'PAUSED' ? 'paused' : 'archived'
    }
    if (mutation.syncType === 'MKT_BUDGET_UPDATE' && typeof mutation.payload.budgetCents === 'number') {
      patch.dailyBudget = (mutation.payload.budgetCents as number) / 100 // Amazon expects EUR units
    }
    if (Object.keys(patch).length === 0) return { ok: true, status: 'SUCCESS', wouldChange: { noop: mutation.syncType } }

    const res = await updateCampaign(
      { profileId: conn.profileId, region: (conn.region as 'EU' | 'NA' | 'FE') ?? 'EU' },
      mutation.externalId,
      patch,
    )
    return { ok: res.ok, status: res.ok ? 'SUCCESS' : 'FAILED', externalId: mutation.externalId, channelResponseId: `amzn:${res.mode}` }
  }

  async setBudget(externalId: string, cents: number, ctx: AdapterCtx): Promise<MutationResult> {
    return this.applyMutation({ syncType: 'MKT_BUDGET_UPDATE', externalId, entityType: 'CAMPAIGN', payload: { budgetCents: cents } }, ctx)
  }
}

export const amazonAdapter = new AmazonAdapter()
registerAdapter(amazonAdapter)
logger.debug('[UM] AmazonAdapter registered (read-only shadow, P2)')
