/**
 * B4 (2026-08-20) — Suspense, because `SuggestionsClient` now reads `?rule=`.
 *
 * The Rules & Automation grid's Activity cell links here with the rule's name so a count like
 * "125 waiting" lands on those 125 rather than on all 306. `useSearchParams` suspends during
 * prerender, so the boundary is required; `force-dynamic` matches every other ads route.
 */
import { Suspense } from 'react'
import { SuggestionsClient } from './SuggestionsClient'

export const dynamic = 'force-dynamic'

export default function Page() {
  return (
    <Suspense fallback={null}>
      <SuggestionsClient />
    </Suspense>
  )
}
