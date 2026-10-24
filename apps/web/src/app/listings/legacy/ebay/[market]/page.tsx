// /listings/legacy/ebay/<market> — the old eBay page for one market (docs/listings/LISTINGS-STORE-PAGES-2026-10-24.md).
// The market is the listings' own code (`gb` stays GB): the old page reads listings.
import type { Metadata } from 'next'
import { COUNTRY_NAMES } from '@/app/_shared/app-nav'
import EbayListingsClient from '../../../ebay/EbayListingsClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

type Params = { params: Promise<{ market: string }> }

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const code = (await params).market.toUpperCase()
  return { title: `eBay ${COUNTRY_NAMES[code] ?? code} · Listings (legacy)` }
}

export default async function LegacyEbayMarketPage({ params }: Params) {
  const code = (await params).market.toUpperCase()
  return (
    <EbayListingsClient
      legacy
      lockMarketplace={code}
      breadcrumbs={[
        { label: 'Listings', href: '/listings' },
        { label: 'Legacy listings', href: '/listings/legacy' },
        { label: 'eBay', href: '/listings/legacy/ebay' },
        { label: COUNTRY_NAMES[code] ?? code },
      ]}
    />
  )
}
