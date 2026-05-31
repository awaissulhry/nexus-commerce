/**
 * Trading Desk — Campaigns (Ad Manager), native in the hub (P2).
 * Server-fetches the roster (with derived placement multipliers) and hands off
 * to the client grid, which refetches + merges 30d metrics and stays SSE-live.
 */
import type { Metadata } from 'next'
import { getBackendUrl } from '@/lib/backend-url'
import { CampaignsGrid } from './CampaignsGrid'

export const metadata: Metadata = { title: 'Campaigns · Trading Desk' }
export const dynamic = 'force-dynamic'

async function getInitial() {
  try {
    const res = await fetch(`${getBackendUrl()}/api/advertising/campaigns?limit=500`, { cache: 'no-store' })
    if (!res.ok) return []
    const data = await res.json()
    return data.items ?? []
  } catch {
    return []
  }
}

export default async function TradingDeskCampaignsPage() {
  const items = await getInitial()
  return <CampaignsGrid initial={items} />
}
