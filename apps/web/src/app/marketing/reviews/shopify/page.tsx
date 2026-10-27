// /marketing/reviews/shopify — Reviews › Shopify (build spec §3.5, PR I): the store's review app (Judge.me) — connect
// it, then its reviews with photos, read every 30 minutes; a reply goes out to Judge.me from the review's window.
import type { Metadata } from 'next'
import { Suspense } from 'react'
import { ShopChannelOverview } from '../_channel/ShopChannelPage'
import ChannelLoading from './loading'

export const metadata: Metadata = { title: 'Shopify · Reviews' }

export default function ShopifyReviewsPage() {
  return (
    <Suspense fallback={<ChannelLoading />}>
      <ShopChannelOverview channel="SHOPIFY" />
    </Suspense>
  )
}
