import EbayListingsClient from './EbayListingsClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default function EbayListingsPage() {
  return (
    <EbayListingsClient
      breadcrumbs={[{ label: 'Listings', href: '/listings' }, { label: 'eBay' }]}
    />
  )
}
