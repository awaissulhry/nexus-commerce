/** Trading Desk — Competitive (native): Share of Voice + Brand Analytics SQP. */
import type { Metadata } from 'next'
import { getBackendUrl } from '@/lib/backend-url'
import { CompetitiveClient } from './CompetitiveClient'

export const metadata: Metadata = { title: 'Competitive · Trading Desk' }
export const dynamic = 'force-dynamic'

async function getSov() {
  try {
    const r = await fetch(`${getBackendUrl()}/api/advertising/share-of-voice?windowDays=30&limit=200`, { cache: 'no-store' })
    if (!r.ok) return null
    return await r.json()
  } catch {
    return null
  }
}

export default async function TradingDeskCompetitivePage() {
  const initialSov = await getSov()
  return <CompetitiveClient initialSov={initialSov} />
}
