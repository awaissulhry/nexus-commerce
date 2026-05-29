/**
 * UM-series (P3 completion) — campaign detail / builder.
 *
 * Capability-aware detail for any channel: header + metrics, channel-
 * specific detail (Amazon ad-product / eBay funding / discount / etc.),
 * per-market links, targets, and the CampaignAction audit trail. Pause/
 * resume + budget edit inline (sandbox-gated, same as the roster).
 */

import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { CampaignDetailClient, type CampaignDetail, type ActionsBundle } from './CampaignDetailClient'
import { getBackendUrl } from '@/lib/backend-url'

export const metadata: Metadata = { title: 'Marketing · Campaign' }
export const dynamic = 'force-dynamic'

export default async function CampaignDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const base = getBackendUrl()
  let campaign: CampaignDetail | null = null
  let actions: ActionsBundle = { actions: [], metrics: [] }
  try {
    const [cRes, aRes] = await Promise.all([
      fetch(`${base}/api/marketing/os/campaigns/${id}`, { cache: 'no-store' }),
      fetch(`${base}/api/marketing/os/campaigns/${id}/actions`, { cache: 'no-store' }),
    ])
    if (cRes.ok) campaign = await cRes.json()
    if (aRes.ok) actions = await aRes.json()
  } catch {
    // fall through
  }
  if (!campaign) notFound()
  return <CampaignDetailClient campaign={campaign} initialActions={actions} />
}
