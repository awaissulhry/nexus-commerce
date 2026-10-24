// /listings/legacy/amazon/<market> — the old Amazon page for one market (docs/listings/LISTINGS-STORE-PAGES-2026-10-24.md).
// The market is the listings' own code (`gb` stays GB): the old page reads listings.
import type { Metadata } from 'next'
import { COUNTRY_NAMES } from '@/app/_shared/app-nav'
import AmazonListingsClient from '../../../amazon/AmazonListingsClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

type Params = { params: Promise<{ market: string }> }

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const code = (await params).market.toUpperCase()
  return { title: `Amazon ${COUNTRY_NAMES[code] ?? code} · Listings (legacy)` }
}

export default async function LegacyAmazonMarketPage({ params }: Params) {
  const code = (await params).market.toUpperCase()
  return (
    <AmazonListingsClient
      legacy
      lockMarketplace={code}
      breadcrumbs={[
        { label: 'Listings', href: '/listings' },
        { label: 'Legacy listings', href: '/listings/legacy' },
        { label: 'Amazon', href: '/listings/legacy/amazon' },
        { label: COUNTRY_NAMES[code] ?? code },
      ]}
    />
  )
}
