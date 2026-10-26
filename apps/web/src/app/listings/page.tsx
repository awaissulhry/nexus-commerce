// /listings — the Listings page (2026-10-24: the readiness page took over the menu entry,
// docs/listings/LISTINGS-SWAP-2026-10-24.md; 2026-10-26: the old page is gone and `/listings/legacy…` sends here, step 8
// of docs/listings/LISTINGS-LIVE-LAYER-PLAN-2026-10-25.md). The frame is `_readiness/ReadinessPage.tsx`; the store
// pages (`/listings/amazon`, …) are the same page with a lock.
import type { Metadata } from 'next'
import { ReadinessPage } from './_readiness/ReadinessPage'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'
export const metadata: Metadata = { title: 'Listings' }

export default function ListingsPage() {
  return <ReadinessPage lock={null} />
}
