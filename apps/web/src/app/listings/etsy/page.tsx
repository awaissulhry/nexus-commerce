// /listings/etsy — the Listings page for Etsy (2026-10-25, docs/listings/LISTINGS-LIVE-LAYER-PLAN-2026-10-25.md, PR 1).
import type { Metadata } from 'next'
import { ReadinessPage } from '../_readiness/ReadinessPage'
import { scopeTitle, type ReadinessLock } from '../_readiness/readinessScope'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

const LOCK: ReadinessLock = { channel: 'ETSY', marketplace: '' }
export const metadata: Metadata = { title: scopeTitle(LOCK) }

export default function EtsyListingsPage() {
  return <ReadinessPage lock={LOCK} />
}
