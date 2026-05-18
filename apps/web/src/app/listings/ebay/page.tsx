import type { Metadata } from 'next'
import EbayListingsClient from './EbayListingsClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const metadata: Metadata = { title: 'eBay · Listings' }

export default function EbayListingsPage() {
  return (
    <EbayListingsClient
      breadcrumbs={[{ label: 'Listings', href: '/listings' }, { label: 'eBay' }]}
    />
  )
}
