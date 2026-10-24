// /listings/legacy/shopify — the old Shopify page, kept for the jobs the new one (/listings/shopify) does not do
// (docs/listings/LISTINGS-STORE-PAGES-2026-10-24.md). The same component and storage key as before, so saved columns
// stay.
import type { Metadata } from 'next'
import ShopifyListingsClient from '../../shopify/ShopifyListingsClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'
export const metadata: Metadata = { title: 'Shopify · Listings (legacy)' }

export default function LegacyShopifyListingsPage() {
  return (
    <ShopifyListingsClient
      legacy
      breadcrumbs={[{ label: 'Listings', href: '/listings' }, { label: 'Legacy listings', href: '/listings/legacy' }, { label: 'Shopify' }]}
    />
  )
}
