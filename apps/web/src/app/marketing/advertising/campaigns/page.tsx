/**
 * AD.2 — Campaign list workspace.
 *
 * Server-renders the campaign roster + hands off to CampaignsListClient
 * for inline editing of dailyBudget + status. PATCH writes go through
 * /api/advertising/campaigns/:id which queues a 5-min grace-period sync
 * to Amazon Ads (sandbox-mode short-circuit in dev).
 */

import { Suspense } from 'react'
import { AdvertisingNav } from '../_shared/AdvertisingNav'
import { CampaignsListClient } from './CampaignsListClient'
import { getBackendUrl } from '@/lib/backend-url'

export const dynamic = 'force-dynamic'

interface CampaignsResponse {
  items: Array<{
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
  }>
  count: number
}

async function fetchCampaigns(): Promise<CampaignsResponse> {
  const res = await fetch(`${getBackendUrl()}/api/advertising/campaigns?limit=500`, {
    cache: 'no-store',
  })
  if (!res.ok) return { items: [], count: 0 }
  return (await res.json()) as CampaignsResponse
}

export default async function AdvertisingCampaignsPage() {
  const initial = await fetchCampaigns()
  return (
    <div className="px-4 py-4">
      <div className="mb-3">
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
          Campagne
        </h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Modifica inline di budget + stato. Le scritture vengono inviate ad Amazon Ads
          tramite OutboundSyncQueue (finestra di 5 min per annullare).
        </p>
      </div>
      <AdvertisingNav />
      <Suspense fallback={<div className="text-sm text-slate-500">Caricamento…</div>}>
        <CampaignsListClient initial={initial} />
      </Suspense>
    </div>
  )
}
