// /marketing/reviews/amazon/<market> — Reviews › Amazon for one market ("Amazon Italy · Reviews"). The market is two
// letters (`gb` is the UK) or the page does not exist.
import type { Metadata } from 'next'
import { Suspense } from 'react'
import { ChannelOverview } from '../../_channel/ChannelOverview'
import { marketLock } from '../../_channel/marketLock'
import { scopeTitle } from '../../_channel/reviewsScope'
import ChannelLoading from '../loading'

type Params = { params: Promise<{ market: string }> }

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  return { title: scopeTitle(await marketLock('AMAZON', params)) }
}

export default async function AmazonMarketReviewsPage({ params }: Params) {
  const lock = await marketLock('AMAZON', params)
  return (
    <Suspense fallback={<ChannelLoading />}>
      <ChannelOverview lock={lock} />
    </Suspense>
  )
}
