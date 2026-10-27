// /marketing/reviews/etsy — Reviews › Etsy (build spec §3.5, PR I): the shop's reviews, read every 30 minutes; replies
// are written in the review's window and posted on Etsy.com within 100 days of the buyer's last edit.
import type { Metadata } from 'next'
import { Suspense } from 'react'
import { ShopChannelOverview } from '../_channel/ShopChannelPage'
import ChannelLoading from './loading'

export const metadata: Metadata = { title: 'Etsy · Reviews' }

export default function EtsyReviewsPage() {
  return (
    <Suspense fallback={<ChannelLoading />}>
      <ShopChannelOverview channel="ETSY" />
    </Suspense>
  )
}
