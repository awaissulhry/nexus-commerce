import type { Metadata } from 'next'
import ShopifyListingsClient from './ShopifyListingsClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const metadata: Metadata = { title: 'Shopify · Listings' }

export default function ShopifyListingsPage() {
  return (
    <ShopifyListingsClient
      breadcrumbs={[{ label: 'Listings', href: '/listings' }, { label: 'Shopify' }]}
    />
  )
}
