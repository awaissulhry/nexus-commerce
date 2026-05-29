/**
 * AD.2 — Campaign detail drawer.
 *
 * Server-renders the campaign + nested adGroups + productAds, plus the
 * BidHistory timeline. The history feed surfaces both operator + future
 * automation-rule writes (AD.3+).
 */

import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { AdvertisingNav } from '../../_shared/AdvertisingNav'
import { CampaignDetailCockpit } from './CampaignDetailCockpit'
import { getBackendUrl } from '@/lib/backend-url'

export const dynamic = 'force-dynamic'

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params
  const res = await fetch(`${getBackendUrl()}/api/advertising/campaigns/${id}`, { cache: 'no-store' }).catch(() => null)
  const data = res?.ok ? await res.json().catch(() => null) : null
  const name: string = data?.campaign?.name ?? 'Campaign'
  return { title: `${name} · Amazon Ads` }
}

interface CampaignDetail {
  campaign: {
    id: string
    name: string
    type: string
    status: string
    marketplace: string | null
    externalCampaignId: string | null
    dailyBudget: string
    biddingStrategy: string
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
    adGroups: Array<{
      id: string
      name: string
      defaultBidCents: number
      status: string
      impressions: number
      clicks: number
      spendCents: number
      salesCents: number
      targets: Array<{
        id: string
        kind: string
        expressionType: string
        expressionValue: string
        bidCents: number
        status: string
        impressions: number
        clicks: number
        spendCents: number
        salesCents: number
      }>
      productAds: Array<{
        id: string
        asin: string | null
        sku: string | null
        productId: string | null
        status: string
      }>
    }>
  } | null
}

interface BidHistoryRow {
  id: string
  entityType: string
  entityId: string
  field: string
  oldValue: string | null
  newValue: string | null
  changedAt: string
  changedBy: string
  reason: string | null
}

async function fetchDetail(id: string): Promise<CampaignDetail | null> {
  const res = await fetch(`${getBackendUrl()}/api/advertising/campaigns/${id}`, {
    cache: 'no-store',
  })
  if (res.status === 404) return null
  if (!res.ok) return null
  return (await res.json()) as CampaignDetail
}

async function fetchBidHistory(id: string): Promise<BidHistoryRow[]> {
  const res = await fetch(
    `${getBackendUrl()}/api/advertising/bid-history?campaignId=${id}&limit=100`,
    { cache: 'no-store' },
  )
  if (!res.ok) return []
  const json = (await res.json()) as { items: BidHistoryRow[] }
  return json.items
}

export default async function CampaignDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const [detail, history] = await Promise.all([
    fetchDetail(id),
    fetchBidHistory(id),
  ])
  if (!detail?.campaign) notFound()
  return (
    <>
      <div className="px-4 pt-4"><AdvertisingNav /></div>
      <CampaignDetailCockpit campaign={detail.campaign as never} history={history} />
    </>
  )
}
