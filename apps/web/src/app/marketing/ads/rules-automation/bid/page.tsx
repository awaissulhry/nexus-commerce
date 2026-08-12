/**
 * BID.S0 — Bid, promoted from a tab to its own route.
 *
 * Same shape as ../negative-targeting and ../keyword-tracker: force-dynamic, and a Suspense
 * boundary because the client reads `useSearchParams` (every view on this page is linkable — "why
 * is this keyword bidding that" should be a link pasted into a message, not a description of where
 * to click).
 */
import { Suspense } from 'react'
import { BidClient } from './BidClient'

export const dynamic = 'force-dynamic'

export default function Page() {
  return (
    <Suspense fallback={null}>
      <BidClient />
    </Suspense>
  )
}
