/** Trading Desk — native campaign cockpit ([id]), in-hub drill-down. */
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getBackendUrl } from '@/lib/backend-url'
import { CampaignCockpit } from './CampaignCockpit'

export const metadata: Metadata = { title: 'Campaign · Trading Desk' }
export const dynamic = 'force-dynamic'

export default async function TradingDeskCampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let detail: any = null
  try {
    const r = await fetch(`${getBackendUrl()}/api/advertising/campaigns/${id}`, { cache: 'no-store' })
    if (r.ok) detail = await r.json()
  } catch { /* ignore */ }
  if (!detail?.campaign) notFound()
  return <CampaignCockpit campaign={detail.campaign} />
}
