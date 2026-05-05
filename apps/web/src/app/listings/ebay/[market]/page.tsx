import { COUNTRY_NAMES } from '@/lib/country-names'
import ListingsWorkspace from '../../ListingsWorkspace'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function EbayMarketPage({
  params,
}: {
  params: Promise<{ market: string }>
}) {
  const { market } = await params
  const code = market.toUpperCase()
  const label = COUNTRY_NAMES[code] ?? code
  return (
    <ListingsWorkspace
      lockChannel="EBAY"
      lockMarketplace={code}
      breadcrumbs={[
        { label: 'Listings', href: '/listings' },
        { label: 'eBay', href: '/listings/ebay' },
        { label },
      ]}
    />
  )
}
