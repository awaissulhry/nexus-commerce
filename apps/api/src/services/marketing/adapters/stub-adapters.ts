/**
 * UM-series (P11/P12/P13) — sandbox-stub channel adapters for Shopify,
 * Google Ads, Meta, and TikTok.
 *
 * These register the channels so the cockpit lens tabs, capabilities, and
 * the create-campaign flow work for them NOW — but they have no live
 * integration yet (each needs its own OAuth app + API credentials the
 * operator provisions). Until then:
 *   - pullCampaigns returns [] (nothing to shadow without creds)
 *   - applyMutation sandbox-finalizes (returns wouldChange, no external call)
 *     and throws if a live write is attempted without the channel's gate
 *   - setBudget likewise
 *
 * When credentials land, each stub graduates to a real adapter (live
 * pull/push) — the unified layer above is unchanged.
 */

import type { MktChannel, MktSurface } from '@prisma/client'
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

interface StubSpec {
  channel: MktChannel
  capabilities: AdapterCapabilities
  /** env flag that must be '1' for live writes (else sandbox). */
  liveFlag: string
}

class StubAdapter implements ChannelAdapter {
  readonly channel: MktChannel
  readonly capabilities: AdapterCapabilities
  private readonly liveFlag: string

  constructor(spec: StubSpec) {
    this.channel = spec.channel
    this.capabilities = spec.capabilities
    this.liveFlag = spec.liveFlag
  }

  async pullCampaigns(_ctx: AdapterCtx): Promise<NormalizedCampaign[]> {
    return [] // no creds → nothing to shadow yet
  }
  async pullMetrics(_window: DateRange, _ctx: AdapterCtx): Promise<NormalizedMetric[]> {
    return []
  }
  async applyMutation(mutation: NormalizedMutation, ctx: AdapterCtx): Promise<MutationResult> {
    if (ctx.mode === 'sandbox' || process.env[this.liveFlag] !== '1') {
      logger.info(`[MKT-SANDBOX][${this.channel}] would apply ${mutation.syncType}`, { payload: mutation.payload })
      return { ok: true, status: 'SUCCESS', externalId: mutation.externalId ?? null, wouldChange: mutation.payload }
    }
    throw new Error(`${this.channel} live writes need an integration — provision creds + ${this.liveFlag}=1`)
  }
  async setBudget(externalId: string, cents: number, ctx: AdapterCtx): Promise<MutationResult> {
    return this.applyMutation({ syncType: 'MKT_BUDGET_UPDATE', externalId, entityType: 'CAMPAIGN', payload: { budgetCents: cents } }, ctx)
  }
}

const PAID_CAPS = (surfaces: MktSurface[]): AdapterCapabilities => ({
  surfaces,
  supportsKeywords: true,
  supportsNegativeTargets: true,
  supportsAudiences: true,
  supportsLifetimeBudget: true,
  supportsDailyBudget: true,
  supportsMultiMarket: false,
  supportsBudgetRebalance: true,
})

const STUBS: StubSpec[] = [
  { channel: 'SHOPIFY', capabilities: { ...PAID_CAPS(['DISCOUNT', 'MARKDOWN']), supportsKeywords: false, supportsNegativeTargets: false }, liveFlag: 'NEXUS_MARKETING_WRITES_SHOPIFY' },
  { channel: 'GOOGLE', capabilities: PAID_CAPS(['SHOPPING_FEED']), liveFlag: 'NEXUS_MARKETING_WRITES_GOOGLE' },
  { channel: 'META', capabilities: PAID_CAPS(['SHOPPING_FEED']), liveFlag: 'NEXUS_MARKETING_WRITES_META' },
  { channel: 'TIKTOK', capabilities: PAID_CAPS(['SHOPPING_FEED']), liveFlag: 'NEXUS_MARKETING_WRITES_TIKTOK' },
]

for (const spec of STUBS) registerAdapter(new StubAdapter(spec))
logger.debug('[UM] stub adapters registered (sandbox)', { channels: STUBS.map((s) => s.channel) })
