/**
 * ER1 — eBay ads payload types (API mirrors of ebay-ads.routes.ts) + the ONE
 * metric-name mapping (D2/C8): payloads keep server names (acosPct,
 * avgCpcCents — cents-safe); UI surfaces consume Amazon-style names via
 * mapMetrics(). Split out of the former _shared.tsx (C1).
 */

export interface Derived {
  impressions: number; clicks: number; adFeesCents: number; salesCents: number; soldQty: number
  ctrPct: number | null; acosPct: number | null; avgCpcCents: number | null
}

/** D2/C8 — Amazon-style metric names at the UI boundary (+ ROAS, new on eBay). */
export interface UiMetrics {
  impressions: number; clicks: number; spendCents: number; salesCents: number; sold: number
  ctr: number | null; acos: number | null; roas: number | null; cpcCents: number | null
}
export const mapMetrics = (d: Derived): UiMetrics => ({
  impressions: d.impressions, clicks: d.clicks, spendCents: d.adFeesCents, salesCents: d.salesCents, sold: d.soldQty,
  ctr: d.ctrPct, acos: d.acosPct, roas: d.adFeesCents > 0 ? d.salesCents / d.adFeesCents : null, cpcCents: d.avgCpcCents,
})

export interface Freshness { factsReportedAt: string | null; entitySyncAt: string | null; listingSeenAt: string | null }

export interface SummaryPayload {
  window: { preset: string; since: string; until: string; days: number; includesToday: boolean }
  currency: string
  current: Derived
  prior: Derived
  deltas: { adFeesPct: number | null; salesPct: number | null; clicksPct: number | null; impressionsPct: number | null }
  campaignCounts: Record<string, number>
  economicsStatus: Record<string, number>
  attributionModel: string
  coverage?: { liveListings: number; promoted: number; pct: number | null }
  freshness: Freshness
}
export interface TrendPayload {
  window: { since: string; until: string; bucket: string }
  points: Array<Derived & { date: string }>
  freshness: Freshness
}

export interface AutomationPolicy {
  posture: 'INHERIT' | 'OFF' | 'SUGGEST' | 'AUTO' | string
  protected: boolean
  rateCapPct: number | null; rateFloorPct: number | null
  bidCapCents: number | null; bidFloorCents: number | null
}

export interface CampaignRow {
  id: string; externalCampaignId: string; name: string; marketplace: string
  fundingModel: string; targetingType: string | null; channels: string[]; status: string
  adRateStrategy: string | null; bidPercentage: number | null; dailyBudgetCents: number | null
  budgetCurrency: string; isRulesBased: boolean; nexusManaged: boolean
  startDate: string; endDate: string | null; lastEntitySyncAt: string | null
  budgetUpdatesToday?: number
  ads: { total: number; stale: number; hidden?: number }
  // ER3.1 — Ad Manager automation column + budget-cap heuristic
  automation?: { rules: number; protected: boolean; posture: string }
  limitedByBudget?: boolean
  metrics: Derived
}
export interface AdRow {
  id: string; listingId: string | null; inventoryReference: string | null; status: string
  adGroupId: string | null; hiddenReason: string | null; productId: string | null
  bidPercentage: number | null; createdVia: string; title: string | null; priceCents: number | null
  quantity: number | null; listingEnded: boolean | null
  breakEvenAdRatePct: number | null; economicsStatus: string | null
  metrics: Derived
}
export interface KeywordRow {
  id: string; adGroupId: string; adGroupName: string | null; externalKeywordId: string
  text: string; matchType: string; bidCents: number | null; status: string; metrics: Derived
}
export interface AdGroupRow { id: string; externalAdGroupId: string; name: string; status: string; defaultBidCents: number | null }
export interface NegativeKeywordRow { id: string; adGroupId?: string | null; text: string; matchType: string; status: string }

export interface CampaignDetailPayload {
  window: { preset: string; since: string; until: string }
  currency: string
  campaign: CampaignRow & {
    dynamicAdRatePrefs: Record<string, unknown> | Array<Record<string, unknown>> | null
    campaignCriterion: Record<string, unknown> | null
    budgetUpdatesToday: number
    automationPolicy: AutomationPolicy | null
  }
  ads: AdRow[]
  adGroups: AdGroupRow[]
  keywords: KeywordRow[]
  negativeKeywords: NegativeKeywordRow[]
  freshness: Freshness
}

export interface AdGroupDetailPayload {
  window: { preset: string; since: string; until: string }
  currency: string
  adGroup: AdGroupRow
  campaign: { id: string; externalCampaignId: string; name: string; marketplace: string; fundingModel: string; targetingType: string | null; status: string }
  ads: Array<Pick<AdRow, 'id' | 'listingId' | 'status' | 'hiddenReason' | 'productId' | 'bidPercentage' | 'title' | 'priceCents' | 'quantity' | 'metrics'>>
  keywords: KeywordRow[]
  negativeKeywords: NegativeKeywordRow[]
  freshness: Freshness
}

export interface ProposalRow {
  id: string; kind: string; status: string
  entityRef: { campaignId?: string; campaignName?: string; listingId?: string; keywordText?: string; marketplace?: string }
  proposedAction: { from?: unknown; to?: unknown }
  reasoning?: { clampNote?: string | null } | null
  createdAt: string; decidedAt?: string | null
}
export interface DriftRow {
  campaignId: string; externalCampaignId: string; campaignName: string; marketplace: string
  kind: 'ad_rate' | 'budget' | 'ad_removed'; listingId: string | null
  nexusValue: number; ebayValue: number | null; setAt: string; sourceAction: string
}
export interface CampaignAutomationPayload {
  policy: AutomationPolicy
  globalMode: string; halted: boolean
  rules: Array<{ id: string; name: string; enabled: boolean; mode: string; marketplace: string | null; lastEvaluatedAt: string | null; scoped: boolean; global: boolean }>
  proposals: ProposalRow[]
  applied: ProposalRow[]
  drifts: DriftRow[]
}

export interface SearchTermRow {
  query: string; adGroupId: string | null
  impressions: number; clicks: number; adFeesCents: number; salesCents: number; soldQty: number; acosPct: number | null
}
export interface SearchTermsPayload { window: { until: string; trailingDays: number } | null; terms: SearchTermRow[]; freshness: Freshness }

export interface ActionRow {
  id: string; actionType: string; channelResponseStatus: string; createdAt: string
  payloadBefore: Record<string, unknown> | null; payloadAfter: Record<string, unknown> | null
}

export interface ProductListingRow {
  itemId: string; marketplace: string; title: string | null; priceCents: number | null; currency: string
  quantity: number | null; matchStatus: string; breakEvenAdRatePct: number | null; economicsStatus: string | null
  metrics: Derived
}
export interface ProductsPayload {
  window: { preset: string; since: string; until: string }
  currency: string
  products: Array<{ productId: string; sku: string | null; name: string | null; hasCost: boolean; costPriceCents: number | null; listings: ProductListingRow[]; metrics: Derived }>
  unmatchedListings: ProductListingRow[]
  freshness: Freshness
}

export interface WriteItemOutcome { key: string; ok: boolean; mode: string; id?: string | null; error?: string | null; warning?: string | null; blocked?: string | null }
