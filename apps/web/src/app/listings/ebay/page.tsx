import ListingsWorkspace from '../ListingsWorkspace'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default function EbayListingsPage() {
  return (
    <ListingsWorkspace
      lockChannel="EBAY"
      breadcrumbs={[{ label: 'Listings', href: '/listings' }, { label: 'eBay' }]}
    />
  )
}
