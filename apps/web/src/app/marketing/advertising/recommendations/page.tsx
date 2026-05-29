/** AX2.7 — Unified AI + rules recommendations page. */
import type { Metadata } from 'next'
import { AdvertisingNav } from '../_shared/AdvertisingNav'
import { RecommendationsClient } from './RecommendationsClient'

export const metadata: Metadata = { title: 'Amazon Ads · Recommendations' }
export const dynamic = 'force-dynamic'

export default function RecommendationsPage() {
  return (
    <div className="px-4 py-4">
      <AdvertisingNav />
      <RecommendationsClient />
    </div>
  )
}
