import { COUNTRY_NAMES } from '@/lib/country-names'
import ListingsWorkspace from '../../ListingsWorkspace'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function AmazonMarketPage({
  params,
}: {
  params: Promise<{ market: string }>
}) {
  const { market } = await params
  const code = market.toUpperCase()
  const label = COUNTRY_NAMES[code] ?? code
  return (
    <ListingsWorkspace
      lockChannel="AMAZON"
      lockMarketplace={code}
      breadcrumbs={[
        { label: 'Listings', href: '/listings' },
        { label: 'Amazon', href: '/listings/amazon' },
        { label },
      ]}
    />
  )
}
