import type { Metadata } from 'next'
import { COUNTRY_NAMES } from '@/lib/country-names'
import EbayListingsClient from '../EbayListingsClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function generateMetadata({
  params,
}: {
  params: Promise<{ market: string }>
}): Promise<Metadata> {
  const { market } = await params
  const label = COUNTRY_NAMES[market.toUpperCase()] ?? market.toUpperCase()
  return { title: `eBay ${label} · Listings` }
}

export default async function EbayMarketPage({
  params,
}: {
  params: Promise<{ market: string }>
}) {
  const { market } = await params
  const code = market.toUpperCase()
  const label = COUNTRY_NAMES[code] ?? code
  return (
    <EbayListingsClient
      lockMarketplace={code}
      breadcrumbs={[
        { label: 'Listings', href: '/listings' },
        { label: 'eBay', href: '/listings/ebay' },
        { label },
      ]}
    />
  )
}
