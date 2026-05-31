/** Ads Console — Campaigns (Amazon-faithful). Server-fetches the roster. */
import type { Metadata } from 'next'
import { getBackendUrl } from '@/lib/backend-url'
import { CampaignsTable } from './CampaignsTable'

export const metadata: Metadata = { title: 'Campaigns | Ads Console' }
export const dynamic = 'force-dynamic'

async function getInitial() {
  try {
    const r = await fetch(`${getBackendUrl()}/api/advertising/campaigns?limit=500`, { cache: 'no-store' })
    if (!r.ok) return []
    const d = await r.json()
    return d.items ?? []
  } catch {
    return []
  }
}

export default async function AdsConsoleCampaignsPage() {
  const items = await getInitial()
  return <CampaignsTable initial={items} />
}
