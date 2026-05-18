/**
 * AD.2 — Campaign list workspace.
 *
 * Server-renders the campaign roster + hands off to CampaignsListClient
 * for inline editing of dailyBudget + status. PATCH writes go through
 * /api/advertising/campaigns/:id which queues a 5-min grace-period sync
 * to Amazon Ads (sandbox-mode short-circuit in dev).
 *
 * Phase 5b: server merges in v1 metrics from AmazonAdsDailyPerformance
 * (last 7 days) — overriding the running aggregates on Campaign with
 * fresh report-API-derived numbers when available. The client component
 * sees the same field shape; it just gets accurate numbers.
 */

import { Suspense } from 'react'
import { AdvertisingNav } from '../_shared/AdvertisingNav'
import { CampaignsListClient } from './CampaignsListClient'
import { getBackendUrl } from '@/lib/backend-url'

export const dynamic = 'force-dynamic'

interface Campaign {
  id: string
  name: string
  type: 'SP' | 'SB' | 'SD'
  status: 'ENABLED' | 'PAUSED' | 'ARCHIVED' | 'DRAFT'
  marketplace: string | null
  externalCampaignId: string | null
  dailyBudget: string
  biddingStrategy: 'LEGACY_FOR_SALES' | 'AUTO_FOR_SALES' | 'MANUAL'
  impressions: number
  clicks: number
  spend: string
  sales: string
  acos: string | null
  roas: string | null
  trueProfitCents: number
  trueProfitMarginPct: string | null
  lastSyncedAt: string | null
  lastSyncStatus: string | null
}

interface CampaignsResponse {
  items: Campaign[]
  count: number
}

interface V1MetricsResponse {
  windowDays: number
  count: number
  byCampaign: Record<
    string,
    {
      impressions: number
      clicks: number
      costUnits: number
      salesCents: number
      orders: number
      acos: number | null
      roas: number | null
      currencyCode: string
      adProduct: string
      marketplace: string
    }
  >
}

async function fetchJson<T>(url: string, fallback: T): Promise<T> {
  try {
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) return fallback
    return (await res.json()) as T
  } catch {
    return fallback
  }
}

/**
 * Merge v1 metrics into the campaign roster. When a campaign has
 * Reports-API-derived performance in AmazonAdsDailyPerformance for the
 * last 7 days, override the legacy running counters on Campaign so the
 * UI shows fresh numbers without any client-side changes.
 */
function mergeV1Metrics(
  campaigns: Campaign[],
  v1: V1MetricsResponse,
): Campaign[] {
  if (v1.count === 0) return campaigns
  return campaigns.map((c) => {
    if (!c.externalCampaignId) return c
    const m = v1.byCampaign[c.externalCampaignId]
    if (!m) return c
    return {
      ...c,
      impressions: m.impressions,
      clicks: m.clicks,
      spend: m.costUnits.toFixed(2),
      sales: (m.salesCents / 100).toFixed(2),
      acos: m.acos != null ? m.acos.toFixed(2) : c.acos,
      roas: m.roas != null ? m.roas.toFixed(4) : c.roas,
    }
  })
}

export default async function AdvertisingCampaignsPage() {
  const backend = getBackendUrl()
  const [campaigns, v1] = await Promise.all([
    fetchJson<CampaignsResponse>(`${backend}/api/advertising/campaigns?limit=500`, {
      items: [], count: 0,
    }),
    fetchJson<V1MetricsResponse>(
      `${backend}/api/advertising/campaigns/v1-metrics?windowDays=7`,
      { windowDays: 7, count: 0, byCampaign: {} },
    ),
  ])

  const merged = mergeV1Metrics(campaigns.items, v1)
  const initial: CampaignsResponse = { items: merged, count: campaigns.count }

  return (
    <div className="px-4 py-4">
      <div className="mb-3">
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
          Campaigns
        </h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Inline edit of budget + status. Writes are queued to Amazon Ads via
          OutboundSyncQueue (5-min undo window).
        </p>
        {v1.count > 0 && (
          <p className="text-xs text-emerald-700 dark:text-emerald-300 mt-1">
            Showing {v1.count} campaign{v1.count === 1 ? '' : 's'} with live
            performance from last {v1.windowDays} days (Reports API).
          </p>
        )}
      </div>
      <AdvertisingNav />
      <Suspense fallback={<div className="text-sm text-slate-500">Loading…</div>}>
        <CampaignsListClient initial={initial} />
      </Suspense>
    </div>
  )
}
