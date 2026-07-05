/**
 * UM-series (P14) — Unified Marketing OS · Cross-channel analytics.
 *
 * EUR-normalized rollups across all channels from CampaignMetric. Spend is
 * comparable (frozen-FX costEurCents); ROAS/ACOS are labeled channel-
 * reported because attribution models differ per channel.
 *
 * Data loads client-side (AnalyticsLoader): the API session cookie lives on
 * the API origin (cross-site), so server-side fetches can never authenticate.
 * page.tsx stays a server component for the metadata export.
 */

import type { Metadata } from 'next'
import { AnalyticsLoader } from './AnalyticsLoader'

export const metadata: Metadata = { title: 'Marketing · Analytics' }
export const dynamic = 'force-dynamic'

export default function MarketingAnalyticsPage() {
  return <AnalyticsLoader />
}
