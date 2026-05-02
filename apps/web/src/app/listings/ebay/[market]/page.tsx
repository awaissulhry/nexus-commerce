import ChannelMarketView from '@/components/listings/ChannelMarketView'

export const dynamic = 'force-dynamic'

export default async function EbayMarketPage({
  params,
}: {
  params: Promise<{ market: string }>
}) {
  const { market } = await params
  return <ChannelMarketView channel="EBAY" channelLabel="eBay" marketCodeRaw={market} />
}
