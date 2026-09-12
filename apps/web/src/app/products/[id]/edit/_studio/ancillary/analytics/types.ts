/**
 * PES.7 — wire types for the Analytics · Ads tab.
 *
 * Transcribed from the LIVE responses (`GET /products/:id/analytics`, `…/analytics/trend`,
 * `GET /advertising/product-ads`), not from the old tab's local interfaces. Every optional and
 * every `null` below was observed on the wire, and the nullable ones carry meaning that a default
 * would erase — see `readAnalytics.ts`.
 */

export interface ChannelSales {
  channel: string
  marketplace: string | null
  units: number
  revenue: number
  orders: number
  conversionRate?: number | null
  buyBoxPercentage?: number | null
  sessions?: number | null
}

export interface AnalyticsPayload {
  productId: string
  sku: string
  days: number
  sales: {
    totalUnits: number
    totalRevenue: number
    totalOrders: number
    avgDailyUnits: number
    stockoutDays: number
    /** 🔴 Empty means NO ROWS, not "zero sales" — the totals are a sum over this list. */
    byChannel: ChannelSales[]
  }
  inventory: {
    totalAvailable: number
    /** `null` when it cannot be calculated (no run-rate). Not the same as 0 days of cover. */
    daysOfInventory: number | null
    /** Observed: `'UNKNOWN'` as well as HIGH/MEDIUM/LOW. */
    stockoutRisk: string
  }
  pricing: {
    currentPrices: Array<{ channel: string; marketplace: string | null; price: number | null }>
    latestBuyBoxPrices: Array<{ channel: string; marketplace: string | null; buyBoxPrice: number | null }>
    latestRepricingDecision: unknown | null
  }
  quality: {
    latestScore: number | null
    latestScoreAt: string | null
    byChannel: Array<{ channel: string; marketplace: string | null; score: number | null }>
  }
  reviews: {
    avgRating: number | null
    reviewCount: number
    recentSpikeCount: number
  }
}

export interface TrendPoint {
  date: string
  units: number
  revenue: number
}

/* ── ads ───────────────────────────────────────────────────────────────────────────────────── */

export interface AdCampaign {
  id: string
  externalCampaignId: string | null
  name: string
  adProduct: string | null
  marketplace: string | null
  status: string | null
  impressions: number
  clicks: number
  orders: number
  spendCents: number
  adSalesCents: number
  currencyCode: string | null
  /** 🔴 `null` when ad sales are zero — division by zero, NOT an ACOS of 0%. */
  acos: number | null
  hasV1Data?: boolean
}

export interface AdSearchTerm {
  query: string
  matchType: string | null
  adProduct: string | null
  marketplace: string | null
  impressions: number
  clicks: number
  orders: number
  spendCents: number
  adSalesCents: number
  acos: number | null
}

export interface AdsSummary {
  campaignCount: number
  productAdCount: number
  totalSpendCents: number
  totalAdSalesCents: number
  acos: number | null
  sbCreatives: number
  multiProductCreatives: number
  windowDays: number
}

export interface ProductAdsPayload {
  windowDays: number
  productAds: number
  campaigns: AdCampaign[]
  searchTerms: AdSearchTerm[]
  /** `null` when the product has no ad rows at all. */
  summary: AdsSummary | null
}
