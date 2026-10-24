// /listings/amazon/<market> — the Listings page for one Amazon market
// (2026-10-24, docs/listings/LISTINGS-STORE-PAGES-2026-10-24.md).
// The old page is /listings/legacy/amazon/<market>.
import type { Metadata } from 'next'
import { ReadinessPage, marketLock } from '../../_readiness/ReadinessPage'
import { scopeTitle } from '../../_readiness/readinessScope'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

type Params = { params: Promise<{ market: string }> }

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  return { title: scopeTitle(await marketLock('AMAZON', params)) }
}

export default async function AmazonMarketListingsPage({ params }: Params) {
  return <ReadinessPage lock={await marketLock('AMAZON', params)} />
}
