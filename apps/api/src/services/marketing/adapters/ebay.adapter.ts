/**
 * UM-series (P9) — eBay Promoted Listings channel adapter.
 *
 * Read-only SHADOW (like Amazon's P2): pullCampaigns sources from the
 * already-synced legacy EbayCampaign table, so the eBay lens populates
 * with NO new credentials. Live writes (applyMutation / setBudget) throw
 * until eBay write creds + the NEXUS_MARKETING_WRITES_EBAY gate are in
 * place — the mutation path keeps eBay sandbox until then.
 *
 * Funding strategies: STANDARD = bid % of sale (no daily budget);
 * ADVANCED = daily CPC budget. The unified row carries budgetKind
 * accordingly (BID_PCT vs DAILY).
 */

import type { EbayCampaign } from '@prisma/client'
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

// E1: status vocabulary single-sourced in ads-core (same mapping, one home).
import { EBAY_CAMPAIGN_STATUS_MAP as STATUS_MAP } from '../../ads-core/campaign-status.js'

const CAPABILITIES: AdapterCapabilities = {
  surfaces: ['PROMOTED_LISTINGS'],
  supportsKeywords: false,
  supportsNegativeTargets: false,
  supportsAudiences: false,
  supportsLifetimeBudget: false,
  supportsDailyBudget: true, // ADVANCED funding
  supportsMultiMarket: false, // per ChannelConnection + marketplace
  supportsBudgetRebalance: true,
}

const toCents = (d: { toString(): string } | null | undefined): number | null =>
  d == null ? null : Math.round(parseFloat(d.toString()) * 100)

export function normalizeEbayCampaign(c: EbayCampaign): NormalizedCampaign {
  const advanced = c.fundingStrategy === 'ADVANCED'
  return {
    channel: 'EBAY',
    surface: 'PROMOTED_LISTINGS',
    marketplace: c.marketplace,
    externalId: c.externalCampaignId,
    name: c.name,
    status: STATUS_MAP[c.status] ?? 'DRAFT',
    budgetCents: advanced ? toCents(c.dailyBudget) : null,
    budgetKind: advanced ? 'DAILY' : 'BID_PCT',
    currency: c.budgetCurrency ?? 'EUR',
    detail: {
      fundingStrategy: c.fundingStrategy,
      bidPercentage: c.bidPercentage?.toString() ?? null,
      channelConnectionId: c.channelConnectionId,
      spendCents: toCents(c.spend) ?? 0,
      salesCents: toCents(c.sales) ?? 0,
      impressions: c.impressions,
      clicks: c.clicks,
      metricsAt: c.metricsAt,
    },
  }
}

class EbayAdapter implements ChannelAdapter {
  readonly channel = 'EBAY' as const
  readonly capabilities = CAPABILITIES

  async pullCampaigns(ctx: AdapterCtx): Promise<NormalizedCampaign[]> {
    const rows = await prisma.ebayCampaign.findMany({ where: { marketplace: ctx.marketplace } })
    return rows.map(normalizeEbayCampaign)
  }

  async pullMetrics(_window: DateRange, _ctx: AdapterCtx): Promise<NormalizedMetric[]> {
    // EbayCampaign carries only aggregate metrics (no daily series); the
    // shadow backfill materializes one CampaignMetric per campaign at
    // metricsAt. Live daily ingestion lands with eBay write creds.
    return []
  }

  async applyMutation(_mutation: NormalizedMutation, _ctx: AdapterCtx): Promise<MutationResult> {
    throw new Error('EbayAdapter.applyMutation not enabled — needs eBay write creds + NEXUS_MARKETING_WRITES_EBAY (P9 live)')
  }

  async setBudget(_externalId: string, _cents: number, _ctx: AdapterCtx): Promise<MutationResult> {
    throw new Error('EbayAdapter.setBudget not enabled — needs eBay write creds (P9 live)')
  }
}

export const ebayAdapter = new EbayAdapter()
registerAdapter(ebayAdapter)
logger.debug('[UM] EbayAdapter registered (read-only shadow, P9)')
