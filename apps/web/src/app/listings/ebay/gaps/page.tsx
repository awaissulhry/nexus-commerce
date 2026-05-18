/**
 * /listings/ebay/gaps — Phase 3 eBay Listing Gap Analysis
 *
 * Shows products that are ACTIVE in Nexus but have no eBay listing
 * for the selected marketplace. Operator can:
 *   - Review the gap (count, product types, readiness)
 *   - Select products and schedule bulk listing creation
 *   - Set daily limit (default 50, max 200)
 *   - View scheduling progress
 */

import type { Metadata } from 'next'
import { getBackendUrl } from '@/lib/backend-url'
import { COUNTRY_NAMES } from '@/lib/country-names'
import EbayGapsClient from './EbayGapsClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Record<string, string>
}): Promise<Metadata> {
  const mp = (searchParams.marketplace ?? 'IT').toUpperCase()
  const label = COUNTRY_NAMES[mp] ?? mp
  return { title: `eBay Listing Gaps · ${label}` }
}

async function fetchGapData(marketplace: string) {
  const backend = getBackendUrl()
  const [gapRes, progressRes] = await Promise.all([
    fetch(`${backend}/api/ebay/phase3/gap?marketplace=${marketplace}`, { cache: 'no-store' }).catch(() => null),
    fetch(`${backend}/api/ebay/phase3/progress?marketplace=${marketplace}`, { cache: 'no-store' }).catch(() => null),
  ])
  return {
    gap: gapRes?.ok ? await gapRes.json().catch(() => null) : null,
    progress: progressRes?.ok ? await progressRes.json().catch(() => null) : null,
  }
}

export default async function EbayGapsPage({
  searchParams,
}: {
  searchParams: Record<string, string>
}) {
  const marketplace = searchParams.marketplace ?? 'IT'
  const { gap, progress } = await fetchGapData(marketplace)

  return <EbayGapsClient marketplace={marketplace} initialGap={gap} initialProgress={progress} />
}
