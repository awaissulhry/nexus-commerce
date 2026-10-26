// /marketing/reviews/ebay — Reviews › eBay, every eBay market (build spec §3.5, PR F). The page is ChannelOverview
// with its lock: no channel or market filter, every link it writes keeps eBay.
import type { Metadata } from 'next'
import { Suspense } from 'react'
import { ChannelOverview } from '../_channel/ChannelOverview'
import { scopeTitle, type ReviewsLock } from '../_channel/reviewsScope'
import ChannelLoading from './loading'

const LOCK: ReviewsLock = { channel: 'EBAY', marketplace: '' }
export const metadata: Metadata = { title: scopeTitle(LOCK) }

export default function EbayReviewsPage() {
  return (
    <Suspense fallback={<ChannelLoading />}>
      <ChannelOverview lock={LOCK} />
    </Suspense>
  )
}
