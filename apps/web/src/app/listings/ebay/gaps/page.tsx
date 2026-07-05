/**
 * /listings/ebay/gaps — Phase 3 eBay Listing Gap Analysis
 *
 * Shows products that are ACTIVE in Nexus but have no eBay listing
 * for the selected marketplace. Operator can:
 *   - Review the gap (count, product types, readiness)
 *   - Select products and schedule bulk listing creation
 *   - Set daily limit (default 50, max 200)
 *   - View scheduling progress
 *
 * page.tsx stays a server component because of generateMetadata; the
 * gap/progress data loads in EbayGapsLoader (client) because the API
 * session cookie lives on the API origin and server fetches 401.
 */

import type { Metadata } from 'next'
import { COUNTRY_NAMES } from '@/lib/country-names'
import EbayGapsLoader from './EbayGapsLoader'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>
}): Promise<Metadata> {
  const params = await searchParams
  const mp = (params.marketplace ?? 'IT').toUpperCase()
  const label = COUNTRY_NAMES[mp] ?? mp
  return { title: `eBay Listing Gaps · ${label}` }
}

export default async function EbayGapsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>
}) {
  const params = await searchParams
  const marketplace = params.marketplace ?? 'IT'

  return <EbayGapsLoader marketplace={marketplace} />
}
