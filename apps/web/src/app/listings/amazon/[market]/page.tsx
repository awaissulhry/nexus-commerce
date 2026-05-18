import type { Metadata } from 'next'
import { COUNTRY_NAMES } from '@/lib/country-names'
import AmazonListingsClient from '../AmazonListingsClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function generateMetadata({
  params,
}: {
  params: Promise<{ market: string }>
}): Promise<Metadata> {
  const { market } = await params
  const label = COUNTRY_NAMES[market.toUpperCase()] ?? market.toUpperCase()
  return { title: `Amazon ${label} · Listings` }
}

export default async function AmazonMarketPage({
  params,
}: {
  params: Promise<{ market: string }>
}) {
  const { market } = await params
  const code = market.toUpperCase()
  const label = COUNTRY_NAMES[code] ?? code
  return (
    <AmazonListingsClient
      lockMarketplace={code}
      breadcrumbs={[
        { label: 'Listings', href: '/listings' },
        { label: 'Amazon', href: '/listings/amazon' },
        { label },
      ]}
    />
  )
}
