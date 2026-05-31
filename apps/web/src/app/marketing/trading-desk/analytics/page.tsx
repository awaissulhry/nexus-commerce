/** Trading Desk — Analytics (native): profit-native trend dashboard. */
import type { Metadata } from 'next'
import { getBackendUrl } from '@/lib/backend-url'
import { AnalyticsClient } from './AnalyticsClient'

export const metadata: Metadata = { title: 'Analytics · Trading Desk' }
export const dynamic = 'force-dynamic'

async function getTrends() {
  try {
    const r = await fetch(`${getBackendUrl()}/api/advertising/trends?preset=last-30d&compare=true`, { cache: 'no-store' })
    if (!r.ok) return null
    return await r.json()
  } catch {
    return null
  }
}

export default async function TradingDeskAnalyticsPage() {
  const initial = await getTrends()
  return <AnalyticsClient initial={initial} />
}
