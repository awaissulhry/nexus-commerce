// Shared types for the Command Center / dashboard overview surface.
//
// Lifted out of OverviewClient.tsx in DO.8 so per-section components
// can import them without dragging the orchestrator's full dependency
// graph along.

import type { useTranslations } from '@/lib/i18n/use-translations'

/**
 * Translator function from `useTranslations()`. The orchestrator owns
 * the hook and threads `t` down so leaf components don't have to
 * import the hook themselves.
 */
export type T = ReturnType<typeof useTranslations>['t']

export interface TotalEntry {
  current: number
  previous: number
  deltaPct: number | null
  // DO.10 — per-bucket series for the in-card sparkline. Same
  // bucket count as the main Sparkline component (24 hourly for
  // Today, N daily for the other windows). Optional so older
  // server responses degrade gracefully (cards just hide the
  // sparkline).
  series?: number[]
}

export interface OverviewPayload {
  window: { from: string; to: string; label: string; key: string }
  // DO.11 — backend echoes the comparison range so the client can
  // tooltip "vs Mar 1 – Apr 1" without recomputing the shift.
  compare: { key: CompareKey; from: string; to: string }
  // DO.1 — backend reports the primary currency (highest-revenue
  // currency in the window, EUR fallback) plus a per-currency
  // breakdown. The KPI strip renders headline numbers in `primary`
  // and surfaces a secondary line when more than one currency
  // contributed real revenue.
  currency: {
    primary: string
    breakdown: Array<{ code: string; current: number; previous: number }>
  }
  totals: {
    revenue: TotalEntry
    orders: TotalEntry
    aov: TotalEntry
    units: TotalEntry
    // DO.12 — operational KPIs.
    //
    // pendingShipments / lateShipments are point-in-time counts: the
    // backend returns previous=0 and deltaPct=null since "pending
    // right now" has no natural previous-period analog without
    // historical snapshots (W12).
    //
    // returnsRate is a percentage 0–100 (returns / orders × 100 in
    // the active window). refundValue is in primary-currency major
    // units (€ not cents).
    pendingShipments: TotalEntry
    lateShipments: TotalEntry
    returnsRate: TotalEntry
    refundValue: TotalEntry
  }
  byChannel: Array<{
    channel: string
    revenue: number
    orders: number
    units: number
    aov: number
    listings: { total: number; live: number; draft: number; failed: number }
  }>
  byMarketplace: Array<{
    channel: string
    marketplace: string
    listings: number
  }>
  topProducts: Array<{
    sku: string
    productId: string | null
    units: number
    revenue: number
  }>
  sparkline: Array<{ date: string; revenue: number; orders: number }>
  recentActivity: Array<{ type: string; ts: string; summary: string }>
  catalog: {
    totalProducts: number
    totalParents: number
    totalVariants: number
    liveListings: number
    draftListings: number
    failedListings: number
    lowStockCount: number
    outOfStockCount: number
  }
  alerts: {
    lowStock: number
    outOfStock: number
    failedListings: number
    draftListings: number
    pendingOrders: number
    ebayConnected: boolean
    channelConnections: Array<{
      channelType: string
      isActive: boolean
      lastSyncStatus: string | null
    }>
  }
}

export const WINDOWS = [
  { id: 'today' },
  { id: '7d' },
  { id: '30d' },
  { id: '90d' },
  { id: 'ytd' },
] as const

export type WindowKey = (typeof WINDOWS)[number]['id']

// DO.11 — comparison-period options. `prev` shifts by the window's
// own length (legacy default); the rest shift by a fixed number of
// days (1 / 7 / 30 / 365).
export const COMPARES = [
  { id: 'prev' },
  { id: 'dod' },
  { id: 'wow' },
  { id: 'mom' },
  { id: 'yoy' },
] as const

export type CompareKey = (typeof COMPARES)[number]['id']

export const CHANNEL_TONES: Record<string, { bg: string; text: string }> = {
  AMAZON: { bg: 'bg-orange-50 border-orange-200', text: 'text-orange-700' },
  EBAY: { bg: 'bg-blue-50 border-blue-200', text: 'text-blue-700' },
  SHOPIFY: { bg: 'bg-emerald-50 border-emerald-200', text: 'text-emerald-700' },
  WOOCOMMERCE: { bg: 'bg-violet-50 border-violet-200', text: 'text-violet-700' },
  ETSY: { bg: 'bg-rose-50 border-rose-200', text: 'text-rose-700' },
}

export const CHANNEL_LABELS: Record<string, string> = {
  AMAZON: 'Amazon',
  EBAY: 'eBay',
  SHOPIFY: 'Shopify',
  WOOCOMMERCE: 'WooCommerce',
  ETSY: 'Etsy',
}
