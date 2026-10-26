// /marketing/reviews/ebay/<market> — Reviews › eBay for one market ("eBay Germany · Reviews"). The market is two
// letters (`gb` is the UK) or the page does not exist.
import type { Metadata } from 'next'
import { Suspense } from 'react'
import { ChannelOverview } from '../../_channel/ChannelOverview'
import { marketLock } from '../../_channel/marketLock'
import { scopeTitle } from '../../_channel/reviewsScope'
import ChannelLoading from '../loading'

type Params = { params: Promise<{ market: string }> }

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  return { title: scopeTitle(await marketLock('EBAY', params)) }
}

export default async function EbayMarketReviewsPage({ params }: Params) {
  const lock = await marketLock('EBAY', params)
  return (
    <Suspense fallback={<ChannelLoading />}>
      <ChannelOverview lock={lock} />
    </Suspense>
  )
}
