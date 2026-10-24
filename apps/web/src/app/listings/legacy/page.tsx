// /listings/legacy — the old Listings page, kept for the jobs the new page (`/listings`) does not do: live status,
// prices, stock, bulk edits and one listing's drawer (`?drawer=<listingId>`). docs/listings/LISTINGS-SWAP-2026-10-24.md.
// Same component and same storage key as before, so saved columns and views stay.
import type { Metadata } from 'next'
import ListingsWorkspace from '../ListingsWorkspace'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'
export const metadata: Metadata = { title: 'Listings (legacy)' }

export default function LegacyListingsPage() {
  return (
    <ListingsWorkspace
      legacy
      titleOverride="Listings (legacy)"
      breadcrumbs={[{ label: 'Listings', href: '/listings' }, { label: 'Legacy' }]}
    />
  )
}
