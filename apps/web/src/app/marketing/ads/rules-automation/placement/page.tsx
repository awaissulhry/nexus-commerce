/**
 * PLC.0 — Placement, promoted from a tab to its own route.
 *
 * Same shape as ../keyword-tracker, ../negative-targeting, ../automations and ../dayparting:
 * force-dynamic, and a Suspense boundary because the client reads `useSearchParams` (every view on
 * this page is linkable, so the URL is the state).
 */
import { Suspense } from 'react'
import { PlacementClient } from './PlacementClient'

export const dynamic = 'force-dynamic'

export default function Page() {
  return (
    <Suspense fallback={null}>
      <PlacementClient />
    </Suspense>
  )
}
