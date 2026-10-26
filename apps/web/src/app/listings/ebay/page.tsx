// /listings/ebay — the Listings page for every eBay market
// (2026-10-24, docs/listings/LISTINGS-STORE-PAGES-2026-10-24.md).
import type { Metadata } from 'next'
import { ReadinessPage } from '../_readiness/ReadinessPage'
import { scopeTitle, type ReadinessLock } from '../_readiness/readinessScope'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

const LOCK: ReadinessLock = { channel: 'EBAY', marketplace: '' }
export const metadata: Metadata = { title: scopeTitle(LOCK) }

export default function EbayListingsPage() {
  return <ReadinessPage lock={LOCK} />
}
