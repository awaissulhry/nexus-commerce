/**
 * UM-series (P14) — Unified Marketing OS · Cross-channel analytics.
 *
 * EUR-normalized rollups across all channels from CampaignMetric. Spend is
 * comparable (frozen-FX costEurCents); ROAS/ACOS are labeled channel-
 * reported because attribution models differ per channel.
 */

import type { Metadata } from 'next'
import { AnalyticsClient, type AnalyticsData } from './AnalyticsClient'
import { getBackendUrl } from '@/lib/backend-url'

export const metadata: Metadata = { title: 'Marketing · Analytics' }
export const dynamic = 'force-dynamic'

const EMPTY: AnalyticsData = {
  from: '', to: '', attributionNote: '',
  totals: { spendEurCents: 0, salesCents: 0, impressions: 0, clicks: 0, orders7d: 0 },
  byChannel: [], byMarketplace: [], daily: [],
}

export default async function MarketingAnalyticsPage() {
  let data = EMPTY
  try {
    const res = await fetch(`${getBackendUrl()}/api/marketing/os/analytics`, { cache: 'no-store' })
    if (res.ok) data = await res.json()
  } catch {
    // empty
  }
  return <AnalyticsClient initial={data} />
}
