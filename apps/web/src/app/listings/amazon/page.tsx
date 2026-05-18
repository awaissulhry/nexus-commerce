import type { Metadata } from 'next'
import AmazonListingsClient from './AmazonListingsClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const metadata: Metadata = { title: 'Amazon · Listings' }

export default function AmazonListingsPage() {
  return (
    <AmazonListingsClient
      breadcrumbs={[{ label: 'Listings', href: '/listings' }, { label: 'Amazon' }]}
    />
  )
}
