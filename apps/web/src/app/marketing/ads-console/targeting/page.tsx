/** Ads Console — Targeting (keywords/targets + search-term harvesting). */
import type { Metadata } from 'next'
import { getBackendUrl } from '@/lib/backend-url'
import { TargetingClient } from './TargetingClient'

export const metadata: Metadata = { title: 'Targeting | Ads Console' }
export const dynamic = 'force-dynamic'

async function getTargets() {
  try {
    const r = await fetch(`${getBackendUrl()}/api/advertising/targets?windowDays=30&limit=500`, { cache: 'no-store' })
    if (!r.ok) return []
    const d = await r.json()
    return d.rows ?? []
  } catch {
    return []
  }
}

export default async function AdsConsoleTargetingPage() {
  const rows = await getTargets()
  return <TargetingClient initialTargets={rows} />
}
