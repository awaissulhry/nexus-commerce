// /listings/legacy/ebay — the old eBay page, kept for the jobs the new one (/listings/ebay) does not do
// (docs/listings/LISTINGS-STORE-PAGES-2026-10-24.md). The same component and storage key as before, so saved columns
// stay.
import type { Metadata } from 'next'
import EbayListingsClient from '../../ebay/EbayListingsClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'
export const metadata: Metadata = { title: 'eBay · Listings (legacy)' }

export default function LegacyEbayListingsPage() {
  return (
    <EbayListingsClient
      legacy
      breadcrumbs={[{ label: 'Listings', href: '/listings' }, { label: 'Legacy listings', href: '/listings/legacy' }, { label: 'eBay' }]}
    />
  )
}
