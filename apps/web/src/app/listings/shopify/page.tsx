import ShopifyListingsClient from './ShopifyListingsClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default function ShopifyListingsPage() {
  return (
    <ShopifyListingsClient
      breadcrumbs={[{ label: 'Listings', href: '/listings' }, { label: 'Shopify' }]}
    />
  )
}
