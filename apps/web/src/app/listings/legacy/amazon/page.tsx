// /listings/legacy/amazon — the old Amazon page, kept for the jobs the new one (/listings/amazon) does not do
// (docs/listings/LISTINGS-STORE-PAGES-2026-10-24.md). The same component and storage key as before, so saved columns
// stay.
import type { Metadata } from 'next'
import AmazonListingsClient from '../../amazon/AmazonListingsClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'
export const metadata: Metadata = { title: 'Amazon · Listings (legacy)' }

export default function LegacyAmazonListingsPage() {
  return (
    <AmazonListingsClient
      legacy
      breadcrumbs={[{ label: 'Listings', href: '/listings' }, { label: 'Legacy listings', href: '/listings/legacy' }, { label: 'Amazon' }]}
    />
  )
}
