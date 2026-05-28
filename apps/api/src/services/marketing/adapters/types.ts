/**
 * Unified Marketing OS (UM-series, P1) — channel adapter interface.
 *
 * One interface, one implementation per channel, registered in a map
 * (mirrors the ACTION_HANDLERS registry idiom in
 * advertising/automation-action-handlers.ts). The cockpit + automation
 * engine + budget rebalancer are channel-agnostic: they call the adapter,
 * never a channel API directly. Channel-specific quirks — Amazon's SigV4
 * write constraint (v1 reads, v3 writes), eBay funding strategies, Shopify
 * discount mechanics, external-network OAuth — are fully encapsulated
 * inside each adapter and never leak above this seam.
 *
 * P1 lands the interface + an empty registry. Adapters arrive per phase:
 *   P2  AmazonAdapter   (read-only shadow — façade over shipped ads-* services)
 *   P9  EbayAdapter     (Promoted Listings + markdown)
 *   P10 InternalAdapter (content push → MC publish; outreach → RV pipeline)
 *   P11 ShopifyAdapter  (discounts + channel-app metrics)
 *   P12 GoogleAdapter   (first external network)
 *   P13 Meta + TikTok   (remaining external networks)
 *
 * Sandbox-first everywhere: AdapterCtx.mode is the per-channel seam, the
 * same one adsMode() already uses. A live mutation additionally requires
 * the per-channel write gate (P5, marketing-write-gate.ts).
 */

import type { MktChannel, MktSurface } from '@prisma/client'

// ── Execution context handed to every adapter call ───────────────────────
export type AdapterMode = 'sandbox' | 'live'

export interface AdapterCtx {
  /** ChannelConnection / AmazonAdsConnection / ad-account scope. */
  connectionId: string
  /** Amazon Ads profile (Amazon only). */
  profileId?: string
  /** Region routing where the channel needs it (Amazon: EU | NA | FE). */
  region?: string
  /** The market this call targets (e.g. 'IT', 'EBAY_IT', 'GB'). */
  marketplace: string
  /** sandbox short-circuits all external writes; live requires the gate. */
  mode: AdapterMode
}

// ── Normalized shapes (channel-agnostic; adapters map to/from native) ─────

/** Structure pulled from a channel, ready to upsert into MarketingCampaign. */
export interface NormalizedCampaign {
  channel: MktChannel
  surface: MktSurface
  marketplace: string
  externalId: string
  externalParentId?: string | null
  name: string
  status: string
  /** DELIVERING | NOT_DELIVERING */
  deliveryStatus?: string | null
  deliveryReasons?: string[]
  budgetCents?: number | null
  budgetKind?: string | null
  currency: string
  /** Channel-specific payload destined for the matching detail table. */
  detail?: Record<string, unknown>
}

/** A daily performance row, ready to upsert into CampaignMetric. */
export interface NormalizedMetric {
  channel: MktChannel
  marketplace: string
  /** ISO date (yyyy-mm-dd) — the metric's calendar day. */
  date: string
  entityType: string // CAMPAIGN | TARGET | AD_GROUP | PRODUCT | SEARCH_TERM | ...
  entityId: string
  localEntityId?: string | null
  impressions: number
  clicks: number
  costMicros: bigint
  currencyCode: string
  sales7dCents?: number | null
  sales14dCents?: number | null
  sales30dCents?: number | null
  orders7d?: number | null
  units7d?: number | null
  ntbOrders14d?: number | null
  viewableImpressions?: number | null
  detailPageViews7d?: number | null
  /** How this channel attributes sales — labels cross-channel ROAS. */
  attributionModel?: string | null
  extra?: Record<string, unknown> | null
  reportRunId?: string | null
}

/** A mutation to push to a channel, drained from OutboundSyncQueue (P5). */
export interface NormalizedMutation {
  /** MKT_BUDGET_UPDATE | MKT_BID_UPDATE | MKT_STATE_UPDATE | MKT_DISCOUNT_CREATE | ... */
  syncType: string
  /** External id of the entity being mutated (null on create). */
  externalId?: string | null
  /** Entity grain: CAMPAIGN | TARGET | BUDGET | DISCOUNT | ... */
  entityType: string
  /** Type-specific payload (e.g. { budgetCents } | { status } | { bidCents }). */
  payload: Record<string, unknown>
}

export interface MutationResult {
  ok: boolean
  /** External id assigned on create, or echoed on update. */
  externalId?: string | null
  /** Raw channel response id for the audit log. */
  channelResponseId?: string | null
  /** SUCCESS | FAILED | PENDING */
  status: 'SUCCESS' | 'FAILED' | 'PENDING'
  error?: string | null
  /** In sandbox / dry-run: what WOULD have changed (no external write). */
  wouldChange?: Record<string, unknown> | null
}

export interface DateRange {
  /** ISO date inclusive. */
  start: string
  /** ISO date inclusive. */
  end: string
}

/**
 * Capabilities drive cockpit UI gating (does this channel support
 * keywords? lifetime budgets? multi-market? negative targets?) and let
 * the automation/budget layers skip actions a channel can't honor.
 */
export interface AdapterCapabilities {
  surfaces: MktSurface[]
  supportsKeywords: boolean
  supportsNegativeTargets: boolean
  supportsAudiences: boolean
  supportsLifetimeBudget: boolean
  supportsDailyBudget: boolean
  /** A single campaign object can natively serve >1 marketplace. */
  supportsMultiMarket: boolean
  /** Channel exposes a budget setter the rebalancer can drive. */
  supportsBudgetRebalance: boolean
}

// ── The adapter interface ─────────────────────────────────────────────────
export interface ChannelAdapter {
  readonly channel: MktChannel
  readonly capabilities: AdapterCapabilities

  /** Pull canonical campaign structure (Amazon: v1 export; others: list APIs). */
  pullCampaigns(ctx: AdapterCtx): Promise<NormalizedCampaign[]>

  /** Push a mutation. Throws → caller marks the queue row FAILED. */
  applyMutation(mutation: NormalizedMutation, ctx: AdapterCtx): Promise<MutationResult>

  /** Ingest daily metrics (Amazon: v3 Reports; others: insights/analytics APIs). */
  pullMetrics(window: DateRange, ctx: AdapterCtx): Promise<NormalizedMetric[]>

  /** Set a campaign's budget (used by the cross-channel rebalancer, P7). */
  setBudget(externalId: string, cents: number, ctx: AdapterCtx): Promise<MutationResult>
}

// ── Registry ──────────────────────────────────────────────────────────────
// Adapters self-register by side-effect import (the ACTION_HANDLERS pattern).
const REGISTRY = new Map<MktChannel, ChannelAdapter>()

export function registerAdapter(adapter: ChannelAdapter): void {
  REGISTRY.set(adapter.channel, adapter)
}

/** Resolve the adapter for a channel. Returns undefined if none registered. */
export function adapterFor(channel: MktChannel): ChannelAdapter | undefined {
  return REGISTRY.get(channel)
}

/** All registered adapters (for capability discovery in the cockpit). */
export function registeredAdapters(): ChannelAdapter[] {
  return [...REGISTRY.values()]
}
