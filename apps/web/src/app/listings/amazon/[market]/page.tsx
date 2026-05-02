import ChannelMarketView from '@/components/listings/ChannelMarketView'

export const dynamic = 'force-dynamic'

export default async function AmazonMarketPage({
  params,
}: {
  params: Promise<{ market: string }>
}) {
  const { market } = await params
  return <ChannelMarketView channel="AMAZON" channelLabel="Amazon" marketCodeRaw={market} />
}
