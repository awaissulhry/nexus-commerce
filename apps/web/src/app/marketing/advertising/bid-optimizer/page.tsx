/** AX.8 — Target-ACOS bid optimizer page. */
import type { Metadata } from 'next'
import { AdvertisingNav } from '../_shared/AdvertisingNav'
import { BidOptimizerClient } from './BidOptimizerClient'

export const metadata: Metadata = { title: 'Amazon Ads · Bid optimizer' }
export const dynamic = 'force-dynamic'

export default function BidOptimizerPage() {
  return (
    <div className="px-4 py-4">
      <AdvertisingNav />
      <BidOptimizerClient />
    </div>
  )
}
