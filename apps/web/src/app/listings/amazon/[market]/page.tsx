import { COUNTRY_NAMES } from '@/lib/country-names'
import AmazonListingsClient from '../AmazonListingsClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

// S.5 — per-market route locks the AmazonListingsClient to a specific
// marketplace; the marketplace tab strip is hidden in lockMarketplace
// mode (URL is the source of truth).

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
