/**
 * NEG.1 — Negative Targeting, promoted from a tab to its own route.
 *
 * Same shape as ../keyword-tracker and ../automations: force-dynamic, and a Suspense boundary
 * because the client reads `useSearchParams` (every view on this page is linkable — a conflict
 * found here should be a link pasted into a message, not a description of where to click).
 */
import { Suspense } from 'react'
import { NegativeTargetingClient } from './NegativeTargetingClient'

export const dynamic = 'force-dynamic'

export default function Page() {
  return (
    <Suspense fallback={null}>
      <NegativeTargetingClient />
    </Suspense>
  )
}
