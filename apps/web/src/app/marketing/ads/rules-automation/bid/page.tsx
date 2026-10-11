/**
 * Bid — the Rules & Automation tab for bids (2026-10-10, Bid page programme wave 2).
 *
 * Mounts `BidRulesClient`: header · tab bar · [Rules | Bids] · the view. The Rules view lists every bid rule with the
 * brain first (tiles that filter, a side panel per rule, New rule, every change reviewed before it is saved); the Bids
 * view lists every keyword bid with its one owner (lane BIDS, `bid/bids/`).
 *
 * Suspense stays: the client reads `useSearchParams`.
 */
import { Suspense } from 'react'
import { BidRulesClient } from './BidRulesClient'

export const dynamic = 'force-dynamic'

export default function Page() {
  return (
    <Suspense fallback={null}>
      <BidRulesClient />
    </Suspense>
  )
}
